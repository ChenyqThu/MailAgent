"""admin health 的**共享读侧组装块**（CLI ↔ serve-api 单源，issue #68）。

``mailagent admin health`` 与 ``GET /api/admin/health`` 是同一份诊断的两个传输端。
在此之前两侧各持一份逐字副本（``REQUIRED_TABLES`` / ``_parse_worker_rows`` /
``_mark_stale_workers`` / ``_build_davmail_summary`` + note 组装体），注释里写着
「本文件惯例: 平行实现不共享 import」—— 而这正是 issue #68 的病根：token 老化门槛
同样按此惯例复刻，CLI 那份**漏了 critical 档**，于是同一个 87 天 token 在 web 面报
critical、CLI 只报 warning，且两侧测试各自恒绿。

同语言、同进程、无循环依赖 → **零借口，直接单源**（CLAUDE.md「能单源化就单源化，
闸是妥协不是首选」）。登录到期判据的真源在 ``src.mail.davmail_watchdog``（level 由它
live 计算不落盘），本模块只转发，不再持第二份数字。

两端**有意保留的差异**（不是漂移，勿收敛）：
- notes：CLI 面额外前置 E1 的静态 davmail watch note（CLI-only 设计，web 面历史上
  只发动态行）→ 故本模块出的是 ``compose_dynamic_health_notes``（纯动态段），
  静态段由 CLI 自己拼在前面。
- error 文案：CLI 回 ``"{类型}: {消息}"``（本机排查，路径可见）；web 面按 C9
  redaction 只回类型名，且不回显 ``db_path``。这条差异在各自的端点里，不在本模块。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

# 登录到期判据的唯一真源（watchdog 里 live 计算 level 用的就是这些）。
from src.mail.davmail_watchdog import (
    AUTH_EXPIRES_AT_KEY,
    AUTH_REMIND_DAYS,
    REAUTH_HINT,
    auth_days_left,
    auth_expiry_level,
    parse_auth_expires_at,
)

__all__ = [
    "REQUIRED_TABLES",
    "AUTH_REMIND_DAYS",
    "parse_worker_rows",
    "mark_stale_workers",
    "build_davmail_summary",
    "compose_dynamic_health_notes",
    "auth_expiry_note",
]


# ``schema_ok`` 判定用的必备表清单。加表 = 改这一处（此前 CLI 与 router 各一份，
# 加表漏改一侧 → 一端报 schema_ok=false 另一端 true）。
REQUIRED_TABLES: tuple[str, ...] = (
    "email_metadata",
    "email_body",
    "email_attachment",
    "email_body_fts",
    "cli_checkpoints",
    "v4_rollout_stats",
    "island_dispatch",  # v7: ping-island Sprint 2 派发审计
    "email_outbox",     # v10: SQLite SSoT inversion (Sprint 15)
    "llm_processing",   # v37: 纳入版本化建表 (前端 listEnriched 无条件 LEFT JOIN)
)


def parse_worker_rows(rows) -> dict:
    """sync_state ``worker.<name>.<field>`` 行 → ``{name: {field: value}}`` (E4 WP1 心跳).

    supervise (src/utils/supervise.py) 在状态跃迁时写这些键; 这里跨进程反解。
    """
    workers: dict[str, dict] = {}
    for key, value in rows:
        rest = key[len("worker."):]
        if "." not in rest:
            continue
        name, field = rest.rsplit(".", 1)
        if field == "restart_count":
            try:
                value = int(value)
            except (TypeError, ValueError):
                pass
        workers.setdefault(name, {})[field] = value
    return workers


def mark_stale_workers(workers: dict, start_history_raw: Optional[str]) -> None:
    """E4 第二批 (D3): ``last_started_at`` 早于本次 boot 的 worker 条目加 ``stale=True``.

    last_boot_at = max(sync_state['service.start_history']) (JSON 数组, epoch 秒,
    service._record_start_history 每次 start() 追加)。worker 心跳的 last_started_at
    是 ISO 8601 字符串 (supervise._utcnow_iso), fromisoformat→timestamp 转 epoch 后
    比较。**秒粒度对齐**: 心跳 ISO 是 timespec="seconds" 截断值而 boot 是带小数的
    time.time() —— worker 在 start() 后几 ms 内就启动, 直接 float 比较会把「boot
    同一秒启动」的 worker 几乎恒误标 stale (floor(T+ms) < T), 故 boot 也 floor 到
    整秒再比 (同秒 = 不 stale)。缺失 / parse 失败静默跳过 (health 绝不因此 500);
    不 stale **不写字段** (减少噪音)。
    """
    if not start_history_raw:
        return
    try:
        history = json.loads(start_history_raw)
    except (ValueError, TypeError):
        return
    if not isinstance(history, list):
        return
    epochs = [float(t) for t in history if isinstance(t, (int, float))]
    if not epochs:
        return
    last_boot_sec = int(max(epochs))
    for w in workers.values():
        raw = w.get("last_started_at")
        if not isinstance(raw, str):
            continue
        try:
            started_at = datetime.fromisoformat(raw).timestamp()
        except (ValueError, TypeError, OverflowError, OSError):
            continue
        if started_at < last_boot_sec:
            w["stale"] = True


def build_davmail_summary(state: dict) -> Optional[dict]:
    """``davmail.*`` 键 → ``{token_age_days, auth_days_left, imap_reachable, last_probe_at}``
    摘要 (E4 WP2)。

    DavMailWatchdog 每 60s 落盘这些键; watchdog 从未 tick (非 davmail 模式) →
    None。token_age_days 的 "-1" 哨兵 (token 文件不可读) → None; 它只是信息, 不参与
    分级。auth_days_left 按调用时刻从 ``davmail.auth.expires_at`` 现算, 无交互认证
    记录 → None。
    """
    if not state.get("davmail.last_probe_at"):
        return None
    token_age_days: Optional[float] = None
    raw = state.get("davmail.token_age_days")
    if raw is not None:
        try:
            parsed = float(raw)
            token_age_days = None if parsed < 0 else parsed
        except (TypeError, ValueError):
            token_age_days = None
    days_left = auth_days_left(parse_auth_expires_at(state.get(AUTH_EXPIRES_AT_KEY)))
    return {
        "token_age_days": token_age_days,
        "auth_days_left": None if days_left is None else round(days_left, 2),
        "imap_reachable": state.get("davmail.imap_reachable") == "1",
        "last_probe_at": state.get("davmail.last_probe_at"),
    }


def auth_expiry_note(days_left: Optional[float]) -> Optional[str]:
    """登录到期提示行; 未进提醒区间 / 无记录 → None。

    🔴 issue #68: 此前 CLI 侧只判 warning 一档, 同一事实在 web 面与 CLI 报不同严重度。
    两档都在这里判, 分档同源 ``auth_expiry_level`` (与 watchdog / router 同一函数)。
    """
    level = auth_expiry_level(days_left)
    if level is None:
        return None
    if level == "critical":
        return (
            f"DavMail 登录已过期 (critical), 邮件收发已停止；{REAUTH_HINT}"
        )
    return (
        f"DavMail 登录约 {days_left:.1f} 天后过期 (≤{AUTH_REMIND_DAYS:.0f} 天提醒)；"
        f"{REAUTH_HINT}"
    )


def compose_dynamic_health_notes(
    workers: dict, davmail_summary: Optional[dict]
) -> list:
    """crashloop 停摆 / 登录到期 → 提示行 (E4 WP1/WP2, 不影响 healthy 语义).

    只出**动态**行。CLI 面把 E1 的静态 watch note 拼在返回值前面（那是 CLI-only
    设计，web 面历史上无该行）。
    """
    notes: list = []
    for wname in sorted(workers):
        w = workers[wname]
        if w.get("status") == "crashloop_stopped":
            last_error = str(w.get("last_error") or "")[:120]
            notes.append(
                f"worker '{wname}' 已 crash-loop 停摆 (supervise 停止重启), "
                f"该功能不可用直到服务重启 — last_error: {last_error}"
            )
    if davmail_summary is not None:
        note = auth_expiry_note(davmail_summary.get("auth_days_left"))
        if note:
            notes.append(note)
    return notes
