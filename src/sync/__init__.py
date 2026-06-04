"""src/sync — Sprint 15 SQLite SSoT inversion 派发层.

OutboxRepository (outbox.py):
    所有 mutating 操作（前端 flag / processing_status 变更、Notion webhook 反向同步）
    以 intent 形式写入 email_outbox 表（DB v10 起）。

FanoutWorker (fanout.py):
    异步消费 outbox，按 target 分流到 MailAppFanout / NotionFanout。
    每条 op 执行前查 sync_store 当前状态 vs payload 实现幂等。

详见 SPRINT15-HANDOFF.md §3 + plan
    .claude/plans/ultrathink-sprint-15-handoff-twinkly-nebula.md
"""

from src.sync.async_jobs import AsyncJob, AsyncJobRepository
from src.sync.fanout import FanoutWorker
from src.sync.job_worker import JobWorker
from src.sync.mailapp_fanout import MailAppFanout
from src.sync.notion_fanout import NotionFanout
from src.sync.outbox import (
    OutboxEntry,
    OutboxRepository,
    OutboxStats,
)

__all__ = [
    "AsyncJob",
    "AsyncJobRepository",
    "FanoutWorker",
    "JobWorker",
    "MailAppFanout",
    "NotionFanout",
    "OutboxEntry",
    "OutboxRepository",
    "OutboxStats",
]
