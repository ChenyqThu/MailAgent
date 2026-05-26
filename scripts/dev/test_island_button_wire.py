"""Phase 1·T7 follow-up — 临时验证 button real action wire 真触发 plugin handler.

用法:
    source venv/bin/activate
    python scripts/dev/test_island_button_wire.py

脚本会:
1. init plugin (PING_ISLAND_ENABLED 仅本进程, 不影响 PM2 mail-sync)
2. 模拟 dispatch_llm_reviewed 发紧急 envelope 给 ping-island (走 plugin 完整 _fire 路径)
3. 等待 60s 让用户在灵动岛点 button (open_mail / snooze_1h / mark_done / etc)
4. plugin _fire._bg 收到 socket response → _extract_choice → island_response.handle_response
5. 打印 handler 触发 + 实际 subprocess action

完成后 Ctrl-C 退出.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

# 拉长 ping_island socket recv timeout 让用户有时间点 button
# (默认 ISLAND_SOCKET_TIMEOUT=3.0, 用户点击都来不及)
os.environ.setdefault("ISLAND_SOCKET_TIMEOUT", "60")
os.environ.setdefault("PING_ISLAND_ENABLED", "true")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    log = logging.getLogger("test_island_button_wire")

    from src.notify import island_dispatch

    island_dispatch.init(
        enabled=True,
        sync_store=None,
        account_name="test-button-wire",
        accent="coral",
        theme="dark",
    )
    log.info("plugin initialized (enabled=True, no sync_store)")

    async def run_scenario() -> None:
        log.info("dispatching urgent envelope to ping-island...")
        island_dispatch.dispatch_llm_reviewed(
            internal_id=99999,
            page_id="test-page-id",
            subject="webhook 8100 HTTP 502 持续 14m",
            sender_email="alerts@pagerduty.com",
            sender_name="PagerDuty",
            mailbox="工作邮箱",
            priority="🔴 紧急",
            action="需要回复",
            ai_summary="生产环境 webhook 报 502, oncall 已被点名, 急需介入。",
        )
        log.info("envelope sent; plugin _fire is now awaiting socket response (3s default timeout)")
        log.info("⚠️  ping_island.send_async timeout 默认 3s — 若想给用户长时间点击, 需要 patch timeout")
        log.info(
            "现在请在灵动岛点 button. 60s 后退出. 如果 plugin 收到 response handler 会打印 log."
        )
        for i in range(60, 0, -5):
            log.info(f"等待用户点击... {i}s 剩余")
            await asyncio.sleep(5)
        log.info("test session 结束 (退出后 plugin task 会自动 cancel)")

    try:
        asyncio.run(run_scenario())
    except KeyboardInterrupt:
        log.info("Ctrl-C: 退出")
        sys.exit(0)


if __name__ == "__main__":
    main()
