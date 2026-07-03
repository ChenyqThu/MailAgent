"""flag_sync intent 共享入队层 (E2-D 反向写收编).

历史上 flag→outbox 入队逻辑有三份人肉镜像: `src/services/mail_write.py::set_flags`
(前端直写, dual-target mailapp+notion) / `src/events/handlers.py` 各反向 handler
(target=mailapp-only 防回环) / `src/mail/reverse_sync.py::_enqueue_outbox`
(轮询路径, target=mailapp-only)。E2-D 把「update_local_flags (echo prevention)
+ outbox.enqueue」骨架收编到这里, 三处消费同一入队函数, payload/target 语义差异
由参数承载:

- ``mailapp_payload``: 只含 is_read/is_flagged; 空/None → 不入 mailapp 队。
- ``notion_payload``: 可带 processing_status; None → 不入 notion 队
  (Notion 端是 intent 来源的路径防回环不回写)。
- echo prevention (source='notion_webhook' + target='notion' silent skip)
  仍在 OutboxRepository.enqueue 内, 本层不重复。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from src.sync.outbox import OutboxRepository


@dataclass
class FlagSyncEnqueueResult:
    """单封邮件 flag_sync 入队结果。id 为 None = 该 target 未入队。"""

    mailapp_outbox_id: Optional[int] = None
    notion_outbox_id: Optional[int] = None


def enqueue_flag_sync(
    outbox_repo: OutboxRepository,
    internal_id: int,
    *,
    mailapp_payload: Optional[Dict[str, Any]] = None,
    notion_payload: Optional[Dict[str, Any]] = None,
    source: str,
) -> FlagSyncEnqueueResult:
    """flag_sync outbox 入队 (不碰 SQLite mirror) —— op_type='flag_sync' 唯一常量点。

    mailapp_payload 空/None → 跳过 mailapp target (与历史 mail_write
    ``if mailapp_payload`` truthiness 判定一致); notion_payload None → 跳过
    notion target (空 dict 仍入队, 保持 mail_write notion 恒入队语义)。
    """
    result = FlagSyncEnqueueResult()
    if mailapp_payload:
        result.mailapp_outbox_id = outbox_repo.enqueue(
            internal_id=internal_id,
            op_type="flag_sync",
            target="mailapp",
            payload=mailapp_payload,
            source=source,
        )
    if notion_payload is not None:
        result.notion_outbox_id = outbox_repo.enqueue(
            internal_id=internal_id,
            op_type="flag_sync",
            target="notion",
            payload=notion_payload,
            source=source,
        )
    return result


def mirror_and_enqueue_flag_sync(
    sync_store: Any,
    outbox_repo: OutboxRepository,
    internal_id: int,
    *,
    local_read: bool,
    local_flagged: bool,
    local_processing_status: Optional[str] = None,
    mailapp_payload: Optional[Dict[str, Any]] = None,
    notion_payload: Optional[Dict[str, Any]] = None,
    source: str,
) -> FlagSyncEnqueueResult:
    """update_local_flags (echo prevention, SQLite 立即镜像目标态) + flag_sync 入队。

    local_* 是 SQLite 侧的**目标状态** (非 diff): 立即镜像让下一轮 SQLite Radar /
    前端 listEnriched 不把 fanout 即将派发的状态当新 diff 触发反向链路。
    """
    sync_store.update_local_flags(
        internal_id,
        local_read,
        local_flagged,
        processing_status=local_processing_status,
    )
    return enqueue_flag_sync(
        outbox_repo,
        internal_id,
        mailapp_payload=mailapp_payload,
        notion_payload=notion_payload,
        source=source,
    )
