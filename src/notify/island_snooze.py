"""``snooze_1h`` 选项的本地队列 + 到期 re-emit.

存储：``~/.mailagent/snooze.json``，schema::

    [
      {
        "internal_id": 53675,
        "snooze_until": 1715900000.0,
        "mailbox": "收件箱",
        "subject": "...",
        "sender": "john@example.com",
        "sender_name": "John",
        "page_id": "31a153...",
        "ai_action": "需要回复",
        "ai_priority": "🔴 紧急",
        "created_at": 1715896400.0
      },
      ...
    ]

主循环每 60s tick：
- 读 json → 找 ``snooze_until <= now`` 的 entry
- 给每条调 ``island_dispatch.dispatch_llm_reviewed(..., urgent=True)`` re-emit envelope
- 成功的 entry 从 json 移除
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.notify import island_dispatch

log = logging.getLogger(__name__)

SNOOZE_FILE = Path.home() / ".mailagent" / "snooze.json"
DEFAULT_DURATION_SEC = 3600
TICK_INTERVAL_SEC = 60


def _ensure_parent() -> None:
    try:
        SNOOZE_FILE.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.warning("[island-snooze] failed to ensure dir %s: %s", SNOOZE_FILE.parent, e)


def _read_all() -> List[Dict[str, Any]]:
    if not SNOOZE_FILE.exists():
        return []
    try:
        raw = SNOOZE_FILE.read_text(encoding="utf-8") or "[]"
        data = json.loads(raw)
        if isinstance(data, list):
            return [d for d in data if isinstance(d, dict)]
        return []
    except (OSError, json.JSONDecodeError) as e:
        log.warning("[island-snooze] failed to read %s: %s", SNOOZE_FILE, e)
        return []


def _write_all(entries: List[Dict[str, Any]]) -> None:
    _ensure_parent()
    try:
        # 原子写：先 tmp 再 replace，避免崩溃留半文件
        tmp = SNOOZE_FILE.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        tmp.replace(SNOOZE_FILE)
    except OSError as e:
        log.warning("[island-snooze] failed to write %s: %s", SNOOZE_FILE, e)


def add(
    *,
    internal_id: int,
    snooze_until: Optional[float] = None,
    duration_sec: int = DEFAULT_DURATION_SEC,
    mailbox: str = "",
    subject: str = "",
    sender: str = "",
    sender_name: str = "",
    page_id: str = "",
    ai_action: str = "",
    ai_priority: str = "",
) -> float:
    """追加一条 snooze 记录；返回到期时间戳."""
    until = snooze_until if snooze_until is not None else time.time() + max(duration_sec, 60)
    entries = _read_all()
    # 同 internal_id 更新而非追加
    entries = [e for e in entries if int(e.get("internal_id", -1)) != internal_id]
    entries.append({
        "internal_id": int(internal_id),
        "snooze_until": float(until),
        "mailbox": mailbox,
        "subject": subject,
        "sender": sender,
        "sender_name": sender_name,
        "page_id": page_id,
        "ai_action": ai_action,
        "ai_priority": ai_priority,
        "created_at": time.time(),
    })
    _write_all(entries)
    log.info(
        "[island-snooze] added internal_id=%d until=%s (in %.1fs)",
        internal_id, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(until)),
        until - time.time(),
    )
    return until


def remove(internal_id: int) -> bool:
    """删除指定 internal_id 的 entry；返回是否删过."""
    entries = _read_all()
    new_entries = [e for e in entries if int(e.get("internal_id", -1)) != internal_id]
    if len(new_entries) == len(entries):
        return False
    _write_all(new_entries)
    return True


def due_now(now: Optional[float] = None) -> List[Dict[str, Any]]:
    """返回 ``snooze_until <= now`` 的 entries（不删除）."""
    threshold = now if now is not None else time.time()
    return [e for e in _read_all() if float(e.get("snooze_until", 0)) <= threshold]


def list_all() -> List[Dict[str, Any]]:
    return _read_all()


def clear_all() -> None:
    """单测 / 维护用."""
    if SNOOZE_FILE.exists():
        try:
            SNOOZE_FILE.unlink()
        except OSError:
            pass


def _email_handled(internal_id: int) -> bool:
    """契约 §9-3: 到期 re-emit 前 re-check —— 邮件在 snooze 期间已被处理 → 跳过 re-emit。

    ``processing_status='已完成'`` 或邮件已删除 (``get`` 返回 None) → True。
    无 sync_store / 任何异常 → False（fail-open：不因 re-check bug 漏提醒）。
    """
    store = island_dispatch._state.sync_store
    if store is None:
        return False
    try:
        email = store.get(int(internal_id))
    except Exception as exc:  # noqa: BLE001
        log.debug("[island-snooze] re-check failed (fail-open): %s", exc)
        return False
    if email is None:
        return True
    return (email.get("processing_status") or "") == "已完成"


def fire_due(now: Optional[float] = None) -> int:
    """到期 entries 全部走 ``dispatch_llm_reviewed``（Urgent 路径）re-emit；返回真正 re-emit 数.

    契约 §9-3: 每条 re-emit 前 re-check, 邮件已完成/已删 → 跳过 re-emit (仍从队列移除,
    不反复刷屏)。
    """
    due = due_now(now)
    if not due:
        return 0
    fired = 0
    for e in due:
        iid = int(e.get("internal_id"))
        if _email_handled(iid):
            log.info("[island-snooze] skip re-emit internal_id=%d (email done/deleted)", iid)
            continue
        try:
            island_dispatch.dispatch_llm_reviewed(
                internal_id=iid,
                page_id=str(e.get("page_id") or ""),
                subject=str(e.get("subject") or ""),
                sender_email=str(e.get("sender") or ""),
                sender_name=str(e.get("sender_name") or ""),
                mailbox=str(e.get("mailbox") or ""),
                priority=str(e.get("ai_priority") or "🔴 紧急"),
                action=str(e.get("ai_action") or "需要回复"),
            )
            fired += 1
        except Exception as exc:  # noqa: BLE001
            log.warning("[island-snooze] re-emit failed for %s: %s",
                        e.get("internal_id"), exc)
            continue
    # 全部移除（即使个别 emit 失败 / 跳过也不能反复刷屏；用户可手动再 snooze）
    remaining = [
        x for x in _read_all()
        if int(x.get("internal_id", -1)) not in {int(e.get("internal_id", -1)) for e in due}
    ]
    _write_all(remaining)
    return fired


async def tick_loop(
    *, interval_sec: int = TICK_INTERVAL_SEC,
    shutdown_event: Optional[asyncio.Event] = None,
) -> None:
    """主循环每 ``interval_sec`` 秒检查到期 entry."""
    log.debug("[island-snooze] tick_loop started (interval=%ds)", interval_sec)
    while shutdown_event is None or not shutdown_event.is_set():
        try:
            fired = fire_due()
            if fired:
                log.info("[island-snooze] re-emitted %d entries", fired)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("[island-snooze] tick error: %s", e)
        try:
            if shutdown_event is None:
                await asyncio.sleep(interval_sec)
            else:
                await asyncio.wait_for(shutdown_event.wait(), timeout=interval_sec)
                break
        except asyncio.TimeoutError:
            continue
