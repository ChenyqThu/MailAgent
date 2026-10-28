"""admin health 的 CLI ↔ serve-api **同源钉**（issue #68）。

两个传输端（`mailagent admin health` / `GET /api/admin/health` + `/api/admin/davmail-health`）
此前各持一份逐字副本的组装逻辑与阈值常量，注释里还把「平行实现不共享 import」写成惯例 ——
结果 token 老化门槛复刻时 CLI 那份**漏了 critical 档**：同一个 87 天 token，web 面重算出
`level='critical'`、CLI 只提示 `≥80d` 的 warning 措辞。两侧测试各自恒绿。

现在共享块单源到 ``src/services/admin_health``。本文件不是"闸"（同语言单源之后没有镜像可
对撞了），而是**钉住这个结构**：谁把某个 helper 复制回某一端，或谁只给一端加档位，这里红。

登录到期分档的真源在 ``src.mail.davmail_watchdog``（level 由它 live 计算）——下面直接与它
对撞，不持任何字面量副本。
"""

from __future__ import annotations

import re
from pathlib import Path

from src.cli.commands import admin as cli_admin
from src.mail import davmail_watchdog
from src.mail.davmail_watchdog import AUTH_REMIND_DAYS, LOGIN_FAIL_THRESHOLD
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
    assert r._auth_expiry_level is davmail_watchdog.auth_expiry_level
    assert r._auth_days_left is davmail_watchdog.auth_days_left
    assert r._DEFAULT_LOGIN_FAIL_THRESHOLD == LOGIN_FAIL_THRESHOLD


def test_no_transport_hardcodes_the_auth_thresholds():
    """两个适配器的源码里都不许出现到期阈值的比较字面量（只能 import 分档函数）。

    上面的 `is` 断言挡的是「换成本地函数」；这条从源码文本堵「就地写 `days_left <= 3`」
    那条退路 —— 正是 issue #68 的复发形态。
    """
    for path in (_ROUTER_SOURCE, _CLI_SOURCE):
        body = "\n".join(
            line
            for line in path.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("#")
        )
        assert not re.search(r"days_left\s*(<=|<|>=|>)\s*[0-9]", body), (
            f"{path.name} 又就地写了登录到期阈值 —— 必须用 "
            "src.mail.davmail_watchdog.auth_expiry_level（复刻正是 issue #68 的病根）"
        )


# ── 严重度分档：两端同一句话，且 critical 档真的存在 ─────────────────────────

def test_auth_note_has_both_tiers():
    assert admin_health.auth_expiry_note(None) is None
    assert admin_health.auth_expiry_note(AUTH_REMIND_DAYS + 0.1) is None
    warn = admin_health.auth_expiry_note(AUTH_REMIND_DAYS)
    crit = admin_health.auth_expiry_note(0)
    assert warn and crit and warn != crit, (
        "warning 与 critical 必须给出不同措辞 —— 合成一句 = 又回到「CLI 只有一档」"
    )
    assert "critical" in crit


def test_cli_and_web_agree_on_an_expired_login():
    """issue #68 的复现形态换到新模型：已过期在两端必须是同一个严重度判断。"""
    r = _router()
    summary = {"auth_days_left": -0.4, "token_age_days": 0.1, "imap_reachable": True}

    level = r._compute_level(
        imap_ok=True,
        smtp_ok=True,
        auth_days_left=summary["auth_days_left"],
        oauth_error_active=False,
        throttle_burst=False,
    )
    assert level == "critical"

    cli_notes = cli_admin._compose_health_notes({}, summary)
    web_notes = admin_health.compose_dynamic_health_notes({}, summary)
    auth_line = admin_health.auth_expiry_note(summary["auth_days_left"])
    assert auth_line in cli_notes, "CLI 侧没给出 critical 措辞"
    assert auth_line in web_notes
    # CLI 额外前置 E1 静态 note，这是有意差异；动态段必须逐条一致。
    assert cli_notes == list(cli_admin.HEALTH_WATCH_NOTES) + web_notes


def test_token_age_no_longer_drives_level():
    """token.dat 每小时随 refresh 重写，按它的天数判断到期永远不会触发 —— 已退出分级。"""
    r = _router()
    level = r._compute_level(
        imap_ok=True,
        smtp_ok=True,
        auth_days_left=None,
        oauth_error_active=False,
        throttle_burst=False,
    )
    assert level == "ok"
    assert admin_health.compose_dynamic_health_notes(
        {}, {"token_age_days": 120.0, "auth_days_left": None}
    ) == []


def test_davmail_summary_reads_auth_expiry():
    import time

    expires = int(time.time() + 2 * 86400)
    summary = admin_health.build_davmail_summary(
        {
            "davmail.last_probe_at": "2026-10-28T10:00:00",
            "davmail.token_age_days": "0.04",
            "davmail.imap_reachable": "1",
            "davmail.auth.expires_at": str(expires),
        }
    )
    assert summary is not None
    assert 1.9 < summary["auth_days_left"] <= 2.0
    no_record = admin_health.build_davmail_summary(
        {"davmail.last_probe_at": "x", "davmail.auth.expires_at": ""}
    )
    assert no_record is not None and no_record["auth_days_left"] is None
