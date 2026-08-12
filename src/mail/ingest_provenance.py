"""邮件入库来源 (provenance) 与基于它的通知门控 —— **判定单源**。

2026-08-11 丢邮件事故的配套: 对账 (`_reconcile_inbox`) 补回来的**老**邮件不该推飞书,
因为通知是实时性语义 —— 批量补捞 (故障恢复后可能几十封) 会直接刷屏。

🔴 **判据必须是「补抓来源 AND 年龄超阈值」, 不能只判年龄。**
``FeishuNotifier._is_recent()`` 是所有通知路径共享的全局 3 天过滤, 把它改成 2h 会
连带误伤: 正常实时邮件、**服务停机后由正常增量补上的积压**、LLM 重试、
reverse sync / webhook 路径。停机 3 小时后恢复, 正常增量同步到的邮件年龄虽超 2h,
但语义上**应该**通知。

🔴 **provenance 必须持久化**, 不能用内存 ``set[internal_id]``:
保存 pending 后进程可能重启、飞书通知是 LLM hook 的后台 task、
merge guard 还可能把新 internal_id 合并进另一个旧 internal_id —— 三种情况内存态都会丢。
故落在 ``email_metadata.ingest_reason`` 列 (v51)。

🔴 **三个通知入口共用本模块**, 不许各写一份:
  - ``new_watcher._maybe_notify_feishu``      (本地 LLM 直推)
  - ``events.handlers.handle_ai_reviewed``    (Redis 事件路径)
  - ``mail.reverse_sync._try_notify``         (Redis 关闭时的轮询路径)
``service.py`` 会按配置在后两者之间切换, 只堵一个入口 = 换个配置就漏。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger

# email_metadata.ingest_reason 值域 (v51)。NULL = 存量/未知, 语义等同 REALTIME。
INGEST_REALTIME = "realtime"
INGEST_STARTUP_CATCHUP = "startup_catchup"
INGEST_RECONCILE = "inbox_reconcile"


def _parse_iso(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def should_suppress_reconcile_notify(
    sync_store: Any,
    internal_id: Optional[int],
    max_age_sec: int,
    *,
    now: Optional[datetime] = None,
) -> bool:
    """对账补抓的**老**邮件是否应抑制飞书通知。

    判据 = ``ingest_reason == 'inbox_reconcile'`` **AND** 邮件年龄 > ``max_age_sec``。

    年龄取 ``email_metadata.date_received`` (库里已归一成 ISO UTC), 而不是各调用方
    自己手上的日期字段 —— 三个入口拿到的形态各不相同 (datetime / Notion page 属性 /
    事件 payload), 用同一列才能保证判定一致。

    任何读取失败一律返回 ``False`` (照常通知): 宁可多推一条, 不可因为读不到
    provenance 就把真该通知的邮件吞掉。
    """
    if not internal_id or sync_store is None:
        return False
    max_age = int(max_age_sec or 0)
    if max_age <= 0:
        return False
    try:
        row = sync_store.get(internal_id)
    except Exception as e:
        logger.debug(f"[provenance] read failed for internal_id={internal_id}: {e}")
        return False
    if not row:
        return False
    if (row.get("ingest_reason") if hasattr(row, "get") else None) != INGEST_RECONCILE:
        return False        # 非对账补抓 (含 NULL 存量) → 一律照常通知
    received = _parse_iso(row.get("date_received"))
    if received is None:
        return False        # 日期不可用 → 保守通知
    ref_now = now or datetime.now(timezone.utc)
    if ref_now.tzinfo is None:
        ref_now = ref_now.replace(tzinfo=timezone.utc)
    age = (ref_now - received).total_seconds()
    if age <= max_age:
        return False
    logger.info(
        f"[feishu] skip internal_id={internal_id}: 对账补抓的老邮件 "
        f"(age={int(age)}s > {max_age}s) —— 通知是实时性语义, 补回来的老邮件推送"
        f"只是噪音; 邮件本身已正常入库"
    )
    return True
