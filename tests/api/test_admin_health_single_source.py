"""admin health 的 CLI ↔ serve-api **同源钉**（issue #68）。

两个传输端（`mailagent admin health` / `GET /api/admin/health` + `/api/admin/davmail-health`）
此前各持一份逐字副本的组装逻辑与阈值常量，注释里还把「平行实现不共享 import」写成惯例 ——
结果 token 老化门槛复刻时 CLI 那份**漏了 critical 档**：同一个 87 天 token，web 面重算出
`level='critical'`、CLI 只提示 `≥80d` 的 warning 措辞。两侧测试各自恒绿。

现在共享块单源到 ``src/services/admin_health``。本文件不是"闸"（同语言单源之后没有镜像可
对撞了），而是**钉住这个结构**：谁把某个 helper 复制回某一端，或谁只给一端加档位，这里红。

阈值本身的真源在 ``src.mail.davmail_watchdog``（level 由它 live 计算）——下面直接与它对撞，
不持任何字面量副本。
"""

from __future__ import annotations

import re
from pathlib import Path

from src.cli.commands import admin as cli_admin
from src.mail.davmail_watchdog import (
    LOGIN_FAIL_THRESHOLD,
    TOKEN_CRITICAL_DAYS,
    TOKEN_WARN_DAYS,
)
from src.services import admin_health

_REPO_ROOT = Path(__file__).resolve().parents[2]
_ROUTER_SOURCE = _REPO_ROOT / "src/api/routers/admin.py"
_CLI_SOURCE = _REPO_ROOT / "src/cli/commands/admin.py"


def _router():
    """router 模块（先 import app 触发 include_router，避开该文件既有的循环 import）。"""
    import src.api.app  # noqa: F401
    from src.api.routers import admin as router_admin

    return router_admin


# ── 共享块：两端必须是**同一个对象**，不是"值相等的两份" ──────────────────────

def test_required_tables_is_one_object_across_transports():
    r = _router()
    assert cli_admin.REQUIRED_TABLES is admin_health.REQUIRED_TABLES
    assert r.REQUIRED_TABLES is admin_health.REQUIRED_TABLES


def test_health_helpers_are_one_object_across_transports():
    r = _router()
    for name, shared in (
        ("_parse_worker_rows", admin_health.parse_worker_rows),
        ("_build_davmail_summary", admin_health.build_davmail_summary),
        ("_mark_stale_workers", admin_health.mark_stale_workers),
    ):
        assert getattr(cli_admin, name) is shared, f"CLI 的 {name} 又变回本地副本了"
        assert getattr(r, name) is shared, f"router 的 {name} 又变回本地副本了"


def test_router_thresholds_are_the_watchdog_constants():
    r = _router()
    assert r._TOKEN_WARN_DAYS == TOKEN_WARN_DAYS
    assert r._TOKEN_CRITICAL_DAYS == TOKEN_CRITICAL_DAYS
    assert r._DEFAULT_LOGIN_FAIL_THRESHOLD == LOGIN_FAIL_THRESHOLD


def test_no_transport_hardcodes_the_token_thresholds():
    """两个适配器的源码里都不许再出现阈值字面量（只能 import）。

    上面的 `==` 断言在有人写回 `_TOKEN_WARN_DAYS = 80.0` 时仍然绿（值相等），
    所以这条从源码文本堵那条退路 —— 正是本 issue 的复发形态。
    """
    for path in (_ROUTER_SOURCE, _CLI_SOURCE):
        body = "\n".join(
            line
            for line in path.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("#")
        )
        for literal in (f"{TOKEN_WARN_DAYS}", f"{TOKEN_CRITICAL_DAYS}"):
            assert not re.search(rf"=\s*{re.escape(literal)}\b", body), (
                f"{path.name} 又硬编码了 token 阈值 {literal} —— 必须 import "
                "src.mail.davmail_watchdog 的常量（复刻正是 issue #68 的病根）"
            )


# ── 严重度分档：两端同一句话，且 critical 档真的存在 ─────────────────────────

def test_token_note_has_both_tiers():
    assert admin_health.token_age_note(TOKEN_WARN_DAYS - 0.1) is None
    warn = admin_health.token_age_note(TOKEN_WARN_DAYS)
    crit = admin_health.token_age_note(TOKEN_CRITICAL_DAYS)
    assert warn and crit and warn != crit, (
        "warning 与 critical 必须给出不同措辞 —— 合成一句 = 又回到「CLI 只有一档」"
    )
    assert "critical" in crit


def test_cli_and_web_agree_on_an_87_day_token():
    """本 issue 的原始复现：87 天 token 在两端必须是同一个严重度判断。"""
    r = _router()
    summary = {"token_age_days": TOKEN_CRITICAL_DAYS + 0.4, "imap_reachable": True}

    level = r._compute_level(
        imap_ok=True,
        smtp_ok=True,
        token_age_days=summary["token_age_days"],
        oauth_error_active=False,
        throttle_burst=False,
    )
    assert level == "critical"

    cli_notes = cli_admin._compose_health_notes({}, summary)
    web_notes = admin_health.compose_dynamic_health_notes({}, summary)
    token_line = admin_health.token_age_note(summary["token_age_days"])
    assert token_line in cli_notes, "CLI 侧没给出 critical 措辞（修复前它只说 ≥80d warning）"
    assert token_line in web_notes
    # CLI 额外前置 E1 静态 note，这是有意差异；动态段必须逐条一致。
    assert cli_notes == list(cli_admin.HEALTH_WATCH_NOTES) + web_notes


# ── issue #67 遗留②：web 面补发 login_fail_threshold ─────────────────────────

def test_web_davmail_health_emits_login_fail_threshold():
    r = _router()
    payload = r._build_davmail_health(
        {
            "davmail.last_probe_at": "2026-07-28T00:00:00",
            "davmail.consecutive_login_failures": "2",
            "davmail.login_fail_threshold": "5",
        }
    )
    assert payload["login_fail_threshold"] == 5, (
        "web 面必须外发生效阈值 —— 少了它前端只能显示「×2」而不是「×2/5」，"
        "用户看不出离 degraded 还有多远（桌面 IPC 侧一直有）"
    )
    # 键缺失时回落 watchdog 默认，而不是消失。
    fallback = r._build_davmail_health({"davmail.last_probe_at": "2026-07-28T00:00:00"})
    assert fallback["login_fail_threshold"] == LOGIN_FAIL_THRESHOLD
