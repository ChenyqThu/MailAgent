"""报告 Agent 系统（src/reports）.

每天/每周/每月由 report_worker 定时跑：取数（data）→ LLM 结构化生成
（summarizer）→ 代码组装（assembler，权威数据回填防幻觉）→ ReportDoc 块
模型（models）→ 存 report 表（store）→ Electron main 直读展示。

设计见 docs/reference/remote-chat-report/report-agent-prd.md；前端契约见 docs/archive/2026-06/report-agent-frontend-handoff.md。
"""

from src.reports.models import ReportDoc
from src.reports.store import ReportStore

__all__ = ["ReportDoc", "ReportStore"]
