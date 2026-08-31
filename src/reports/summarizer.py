"""报告 LLM 生成器 —— 单次 tool_use 出 ReportDraft（headline/overview/分组/要点）。

镜像 src/llm_agent/digest_summarizer 结构（复用 LLMClient tool_use + cache_control）。
**LLM 只产文案 + 分组（email_refs=internal_id）**；counts 与邮件事实数据由代码
（data + assembler）确定，LLM 不碰 —— 防幻觉。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from loguru import logger

from src.connectors.llm_tools import build_connector_llm_tools
from src.llm_agent.client import LLMClient, LLMResult
from src.llm_agent.processor import _build_cache_control
from src.reports.agent_tools import build_report_tools
from src.reports.data import (
    ReportEmailBrief,
    ThreadGroup,
    _parse_dt,
    build_thread_groups,
    group_for_report,
)
from src.reports.matter_data import MatterBrief, fmt_due
from src.reports.prompts import get_default_prompt

_BEIJING = timezone(timedelta(hours=8))

# 报告默认模型：opus 4.8（比全局 llm_model 的 sonnet 更强，用户指定）。agent.model
# 为空时兜底用它；后面接全局 llm_fallback_models 作降级链。1M+64k 由 client 统一加。
DEFAULT_REPORT_MODEL = "claude-opus-4-8"

_TOOL_NAME = "build_report"

# email_refs / section.icon / highlight.tone 的取值约束。
_ALLOWED_ICONS = ["alert", "check", "info", "inbox", "star", "archive"]
_ALLOWED_TONES = ["info", "warn", "critical", "success"]

REPORT_TOOL_SCHEMA: Dict[str, Any] = {
    "name": _TOOL_NAME,
    "description": "把最近的邮件策展成一份结构化报告。只调用一次。",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["headline", "overview", "sections"],
        "properties": {
            "headline": {
                "type": "string",
                "maxLength": 50,
                "description": "一句话概括邮件态势，简体中文，≤ 40 字。",
            },
            "overview": {
                "type": "string",
                "maxLength": 400,
                "description": (
                    "2-3 句总览，点出最该关注的 1-2 件事 + 整体态势，≤ 300 字。"
                    "仅 inline markdown（**bold** / *italic* / `code`），禁 heading / list。"
                ),
            },
            "sections": {
                "type": "array",
                "maxItems": 6,
                "description": (
                    "把邮件分组。每组 email_refs 是该组邮件的 internal_id，"
                    "**必须从给定邮件清单里选，绝不能编造**。建议分组（按行动优先级）："
                    "需要你亲自关注 / 已自动处理 / FYI 已汇总。**FYI / 通知类"
                    "必须用 id='fyi'、icon='inbox'**（报告据此把它整组排到最末尾，"
                    "避免淹没上面的关键信息）。空组不要给。"
                ),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "title", "email_refs"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "分组 id，如 attention / handled / fyi。",
                        },
                        "title": {"type": "string", "maxLength": 30},
                        "icon": {"type": "string", "enum": _ALLOWED_ICONS},
                        "intro": {"type": "string", "maxLength": 120},
                        "summary": {
                            "type": "string",
                            "maxLength": 400,
                            "description": (
                                "本组整体汇总概要（1-2 句）：先讲这组整体在说什么、"
                                "要你做什么，再用 [锚文本](#email-<internal_id>) 的形式点名"
                                "其中最关键的 1-3 封邮件。只引用本组 email_refs 里真实存在的"
                                " internal_id；其余邮件在下方列表展开，不要在 summary 里逐封"
                                "复述。仅支持 **加粗** 与 [文本](#email-<id>) 两种标记。"
                            ),
                        },
                        "email_refs": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "该组邮件 internal_id（来自给定清单）。",
                        },
                    },
                },
            },
            "key_points": {
                "type": "array",
                "maxItems": 6,
                "description": (
                    "你必须知道的关键信息，0-5 条，每条带来源语境。"
                    "报告会把它紧跟 highlights 置于报告顶部「必看信息区」。"
                ),
                "items": {"type": "string", "maxLength": 160},
            },
            "matter_digest": {
                "type": "object",
                "additionalProperties": False,
                "required": ["matter_refs"],
                "description": (
                    "「事项进展」区的策展（有事项档案时才填）。事项 = 用户脑子里的"
                    "「一件件事」，邮件只是它的料 —— 报告会把这一区排在邮件分组之前。"
                ),
                "properties": {
                    "summary": {
                        "type": "string",
                        "maxLength": 400,
                        "description": (
                            "事项区的整体汇总（1-3 句）：本窗口哪条主线推进了、哪件卡住了、"
                            "球在谁那边。只讲档案里有的事实，不编进度。仅支持 **加粗** 与"
                            " [文本](#email-<internal_id>) 两种标记。"
                        ),
                    },
                    "matter_refs": {
                        "type": "array",
                        "maxItems": 12,
                        "items": {"type": "string"},
                        "description": (
                            "要在事项区展开的事项 public_id（形如 MAT-0012），按你判断的"
                            "重要度排序。**必须从给定事项档案里选，绝不能编造**；"
                            "没有事项档案 / 无事可讲时给空数组。事项的状态、进度、在等谁、"
                            "下一步由代码回填，你只负责挑哪几件、怎么讲。"
                        ),
                    },
                },
            },
            "highlights": {
                "type": "array",
                "maxItems": 3,
                "description": (
                    "高亮提示（截止 / 风险），0-3 条；无则空数组。"
                    "报告会把它置顶到统计卡正下方，只放最该第一眼看到的。"
                ),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["body"],
                    "properties": {
                        "tone": {"type": "string", "enum": _ALLOWED_TONES},
                        "title": {"type": "string", "maxLength": 40},
                        "body": {"type": "string", "maxLength": 200},
                    },
                },
            },
        },
    },
}

_FIXED_RULES = (
    "\n\n## 硬规则（不可违反）\n"
    f"- 调用 {_TOOL_NAME} 工具 EXACTLY ONCE，绝不输出纯文本。\n"
    "- 邮件清单 + counts 是代码算好的**已知事实**：sections 里的 email_refs 必须从"
    "给定清单的 internal_id 里选，**绝不能编造 id**；不要复述 / 修改 counts 数字"
    "（统计卡由代码填）。\n"
    "- 每封邮件最多归入一个 section。\n"
    "- 清单里标【发】的是用户自己发出的邮件，仅作「你已表态」的上下文 —— email_refs"
    "只能引收件（【收】或无方向标记）的 id，绝不引【发】的。\n"
    "- 事项档案（若有）同样是**已知事实**：matter_digest.matter_refs 只能填档案里"
    "出现过的 public_id（MAT-xxxx），**绝不能编造**；事项的状态 / 进度 / 在等谁由代码"
    "回填，不要在文案里改写或杜撰这些字段。\n"
    "- 标了「已回复」的邮件用户已答复过 —— **不得列入需要亲自关注 / 紧急答复类"
    " section**，也不要在 overview / summary 里点名要求用户处理；对方在你回复后又有"
    "新来信、确需再表态时，引用对方**新来的那封**（它未标已回复）。\n"
    "- 全程简体中文（mainland 用法）；人名 / 产品名 / 公司名 / 邮箱保留原文。"
)


@dataclass
class ReportDraft:
    """build_report 解析后的 LLM 草稿（供 assembler 回填权威数据）。"""

    headline: str = ""
    overview: str = ""
    sections: List[Dict[str, Any]] = field(default_factory=list)
    key_points: List[str] = field(default_factory=list)
    highlights: List[Dict[str, Any]] = field(default_factory=list)
    # 事项策展（S5）：LLM 只给「讲哪几件 + 一句汇总」，事项的事实数据由 assembler
    # 从 MatterBrief 回填；幻觉 public_id 在 assembler 丢弃（同 email_refs 纪律）。
    matter_summary: str = ""
    matter_refs: List[str] = field(default_factory=list)
    # meta
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str = ""
    # agentic 日报的工具轨迹（ToolLoopResult.tool_calls 原样透传，形状
    # [{name, input, output_preview, ms}]）——落 agent_run_log 步骤表用（task 08-27
    # P4a run transcript）。单发 classify 路径（周/月报）恒空列表。
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)


def _build_system(
    persona: str, now: datetime, context_docs: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    weekday_cn = "一二三四五六日"[now.weekday()]
    from src.agent_config.task_context import build_task_identity_context

    # context_docs：None = 行未设 → 默认文档集（soul+user）；[] = 用户显式取消 → 不注入；
    # 非法文档名由函数内 PROFILE_DOC_NAMES 过滤（与 preprocess 的行级勾选语义一致）。
    identity = (
        build_task_identity_context()
        if context_docs is None
        else build_task_identity_context(context_docs)
    )
    body = (
        identity
        + persona.rstrip()
        + f"\n\n当前时间：{now.isoformat()}（周{weekday_cn}，偏移量即本地时区）。"
        + _FIXED_RULES
    )
    block: Dict[str, Any] = {"type": "text", "text": body}
    cc = _build_cache_control()
    if cc is not None:
        block["cache_control"] = cc
    return [block]


def _status_marks(b: ReportEmailBrief) -> str:
    """邮件当前状态标记（LLM 据此判断已处理 / 待办）。"""
    marks = ["已读" if b.is_read else "未读"]
    if b.replied:
        marks.append("已回复")
    if b.is_flagged:
        marks.append("旗标")
    if b.is_pinned:
        marks.append("置顶")
    if b.is_important:
        marks.append("重要")
    return " ".join(marks)


def _counts_block(counts: Dict[str, Any]) -> str:
    by_cat = counts.get("by_category") or {}
    cat_line = "、".join(f"{k}:{v}" for k, v in by_cat.items()) or "(无)"
    return (
        "\n## 已知 counts（代码算好，勿改）\n"
        f"- 总数（收件）：{counts.get('total', 0)}\n"
        f"- 未读：{counts.get('unread', 0)}\n"
        f"- 需关注（urgent，已排除已回复，含置顶）：{counts.get('urgent', 0)}\n"
        f"- 已回复（收到且你已回复的）：{counts.get('replied', 0)}\n"
        f"- 已发出（本窗口你发出的邮件数）：{counts.get('sent', 0)}\n"
        f"- 已标旗：{counts.get('flagged', 0)}\n"
        f"- AI 已处理：{counts.get('ai_handled', 0)}\n"
        f"- 各分类：{cat_line}"
    )


def _groups_hint_block(groups: Dict[str, List[ReportEmailBrief]]) -> str:
    hint = {k: [b.internal_id for b in v] for k, v in groups.items()}
    return (
        "\n## 代码分组提示（参考，可调整）\n"
        f"- 需关注: {hint.get('attention', [])}\n"
        f"- 已处理: {hint.get('handled', [])}\n"
        f"- FYI: {hint.get('fyi', [])}"
    )


def _matters_block(briefs: Sequence[MatterBrief], now: datetime) -> str:
    """事项档案段（结构化**可读文本**，不是 JSON dump —— 与邮件段同款形态）。

    只描述事实（状态 / 进度 / 窗口内动静 / 待办 / 在等谁 / 信号 / 关联邮件），
    策展留给模型。空列表 → 空串（整段不出现，prompt 里不留一个"（无）"的空壳）。
    """
    if not briefs:
        return ""
    lines = [
        "\n## 事项档案（代码取自事项库的已知事实，勿改）",
        "（状态：inbox 收件 / planned 计划中 / active 进行中 / waiting 等待中 / "
        "blocked 受阻 / monitoring 监控中；健康：on_track 正常 / at_risk 有风险 / "
        "off_track 偏离；优先级 p0 最高、p3 最低）",
    ]
    for b in briefs:
        head = f"\n### {b.public_id} {b.title}（{b.status} / {b.health} / {b.priority}）"
        due = fmt_due(b.due_at, now)
        if due:
            head += f"｜到期 {due}"
        lines.append(head)
        if b.current_summary:
            lines.append(f"- 当前进展：{b.current_summary}")
        if b.goal_total:
            lines.append(f"- 完成标志：{b.goal_done}/{b.goal_total} 已达成")
        lines.append(
            f"- 本窗口动静：{'；'.join(b.event_lines)}" if b.event_lines else "- 本窗口动静：无"
        )
        if b.open_actions:
            lines.append(f"- 未完成行动项：{'；'.join(b.open_actions)}")
        if b.waiting_on:
            lines.append(f"- 在等：{'、'.join(b.waiting_on)}")
        if b.signals:
            lines.append(f"- 关注信号（{b.signal_count} 条 open）：{'；'.join(b.signals)}")
        if b.pending_updates:
            lines.append(f"- 待你审阅的提案：{b.pending_updates} 条")
        if b.email_ids:
            # 事项↔邮件的连接点：模型据此写「X 事项本周 N 封往来，球在对方」。
            lines.append(
                "- 本窗口关联邮件 internal_id："
                + "、".join(str(i) for i in b.email_ids)
            )
    return "\n".join(lines)


def _email_line(
    b: ReportEmailBrief,
    ai_summary_max_chars: int,
    *,
    direction: str = "",
    time_str: str = "",
) -> str:
    """单封收件行。direction / time_str 为空时输出与旧版逐字节一致（单封线程沿用）；
    线程组内成员传 direction='【收】' + 短时间戳，供 LLM 按时序串事件。"""
    ai = b.ai_summary.strip()
    if len(ai) > ai_summary_max_chars:
        ai = ai[:ai_summary_max_chars] + "…"
    reply = b.reply_suggestion.strip()
    if len(reply) > 200:
        reply = reply[:200] + "…"
    head = f"- {direction}id={b.internal_id}"
    if time_str:
        head += f" {time_str}"
    return (
        head
        + f" [{_status_marks(b)}] {b.subject or '(无主题)'}"
        + f" | 发件人：{b.sender_name or b.sender_addr or '(未知)'}"
        + f" | 分类：{b.category or '-'}"
        + f" | 优先级：{b.priority or '-'}"
        + f" | 类型：{b.action_type or '-'}"
        + (f" | 摘要：{ai}" if ai else "")
        + (f" | 建议回复：{reply}" if reply else "")
    )


def _outbound_line(b: ReportEmailBrief, time_str: str = "") -> str:
    """我方发件的元数据行（不预载正文、不可进 email_refs，仅让 LLM 看到「你已表态」）。"""
    head = f"- 【发】id={b.internal_id}"
    if time_str:
        head += f" {time_str}"
    line = head + f" 你发出：{b.subject or '(无主题)'}"
    ai = b.ai_summary.strip()
    if ai:
        line += f" | 摘要：{ai[:80]}"
    return line


def _fmt_short_time(date_received: str) -> str:
    """date_received（混合时区 ISO）→ 'MM-DD HH:MM'；解析失败给空串。"""
    dt = _parse_dt(date_received)
    return dt.strftime("%m-%d %H:%M") if dt else ""


def _thread_status_marks(g: ThreadGroup) -> str:
    """线程状态标记（**全历史**算，不只报告窗口）：

    - 你回过 → ``[你最后回复于 MM-DD]``；
    - 最新一封是对方发来（未回 / 回后又来信）→ ``[最新一封是对方 MM-DD 发来]``；
    - 「回过 + 对方又来信」两个标记并列 = 「待跟进」信号（软信号，LLM 叙事用）。
    """
    marks: List[str] = []
    if g.last_sent_at is not None:
        marks.append(f"[你最后回复于 {g.last_sent_at.strftime('%m-%d')}]")
    if g.last_inbound_at is not None and not g.latest_is_outbound:
        marks.append(f"[最新一封是对方 {g.last_inbound_at.strftime('%m-%d')} 发来]")
    return " ".join(marks)


def _thread_lines(groups: List[ThreadGroup], ai_summary_max_chars: int) -> List[str]:
    """线程分组渲染成邮件清单行（agentic 日报 payload）。

    - 单封收件线程退化为现状单行（格式不变，含正文附带 / 下钻提示）；
    - 多封线程：线程头（根主题 + 收发计数 + 全历史状态标记）+ 组内按时刻升序逐封
      （【收】/【发】方向标记）；正文只附在预载那封（每线程 ≤1 封）下面；
    - 我方发件（outbound）以【发】元数据行进清单。
    """
    lines: List[str] = []
    for g in groups:
        if len(g.emails) == 1:
            b = g.emails[0]
            if b.is_outbound:
                lines.append(_outbound_line(b, _fmt_short_time(b.date_received)))
                continue
            lines.append(_email_line(b, ai_summary_max_chars))
            if b.body_text:
                lines.append(f"  【正文已附】{b.body_text}")
            else:
                lines.append(f"  （仅摘要；需细节用 get_email_body({b.internal_id}) 取正文）")
            continue
        subject = next((e.subject for e in g.emails if e.subject), "") or "(无主题)"
        status = _thread_status_marks(g)
        lines.append(
            f"### 线程：{subject}（收 {g.inbound_count} 发 {g.outbound_count}）"
            + (f" {status}" if status else "")
        )
        for b in g.emails:
            t = _fmt_short_time(b.date_received)
            if b.is_outbound:
                lines.append(_outbound_line(b, t))
            else:
                lines.append(_email_line(b, ai_summary_max_chars, direction="【收】", time_str=t))
                if b.body_text:
                    lines.append(f"  【正文已附】{b.body_text}")
    return lines


def _build_user(
    *,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    groups: Dict[str, List[ReportEmailBrief]],
    matter_briefs: Sequence[MatterBrief] = (),
    now: Optional[datetime] = None,
    ai_summary_max_chars: int = 100,
) -> str:
    """单次 classify 的 user prompt（全摘要，不带正文）。"""
    parts: List[str] = [f"把下面的邮件策展成报告，调用 {_TOOL_NAME}。"]
    parts.append(_counts_block(counts))
    parts.append(_groups_hint_block(groups))
    matters = _matters_block(matter_briefs, now or datetime.now(_BEIJING))
    if matters:
        parts.append(matters)
    # 只枚举收件类邮件供 LLM 引用（email_refs）；发件箱仅参与「已发出」统计，不进清单。
    inbound = [b for b in briefs if not b.is_outbound]
    if inbound:
        lines = ["\n## 邮件清单（按优先级排序；用 internal_id 引用；不含正文）"]
        for b in inbound:
            lines.append(_email_line(b, ai_summary_max_chars))
        parts.append("\n".join(lines))
    else:
        parts.append("\n## 邮件清单\n(窗口内无收件邮件)")
    return "\n".join(parts)


def _build_system_agentic(
    persona: str, now: datetime, kos_enabled: bool, context_docs: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """agentic 日报 system：persona + 工具说明 + 收尾约束。"""
    weekday_cn = "一二三四五六日"[now.weekday()]
    from src.agent_config.task_context import build_task_identity_context
    kos_tool = "- kos_query(query)：查 Gbrain 知识库里跨人 / 项目 / 历史的背景\n" if kos_enabled else ""
    identity = (
        build_task_identity_context()
        if context_docs is None
        else build_task_identity_context(context_docs)
    )
    body = (
        identity
        + persona.rstrip()
        + f"\n\n当前时间：{now.isoformat()}（周{weekday_cn}，偏移量即本地时区）。"
        + "\n\n## 工具（按需调用，别为每封都查）\n"
        + "邮件清单含 AI 摘要 + 回复建议（若有）+ 命中优先级邮件的正文；其余仅摘要。"
        + "某封需要更多细节才能正确策展时再下钻：\n"
        + "- get_email_body(internal_id)：取单封完整正文\n"
        + "- search_emails(query)：全文搜相关邮件（清单外 / 跨线程）\n"
        + "- search_attachments(query)：搜附件文本里的事实 / 数字\n"
        + kos_tool
        + f"**先读摘要、只在确有必要时下钻**；信息够了就调 {_TOOL_NAME} 收尾产出报告。"
        + _FIXED_RULES
    )
    block: Dict[str, Any] = {"type": "text", "text": body}
    cc = _build_cache_control()
    if cc is not None:
        block["cache_control"] = cc
    return [block]


def _build_user_agentic(
    *,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    groups: Dict[str, List[ReportEmailBrief]],
    thread_groups: List[ThreadGroup],
    matter_briefs: Sequence[MatterBrief] = (),
    now: Optional[datetime] = None,
    ai_summary_max_chars: int = 120,
) -> str:
    """agentic 日报 user prompt：邮件清单**按线程分组**（同线程收发串成一个事件，
    含线程状态标记 + 我方发件【发】行）；每线程 ≤1 封预载正文，其余摘要 + 可下钻。"""
    parts: List[str] = [
        f"把下面的邮件策展成报告。先看摘要，必要时用工具下钻，最后调 {_TOOL_NAME}。"
    ]
    parts.append(_counts_block(counts))
    parts.append(_groups_hint_block(groups))
    matters = _matters_block(matter_briefs, now or datetime.now(_BEIJING))
    if matters:
        parts.append(matters)
    if any(not b.is_outbound for b in briefs):
        lines = [
            "\n## 邮件清单（按线程分组 = 同一件事；组内按时刻升序；"
            "标【发】的是你已发出的邮件，仅作上下文；用 internal_id 引用）"
        ]
        lines.extend(_thread_lines(thread_groups, ai_summary_max_chars))
        parts.append("\n".join(lines))
    else:
        parts.append("\n## 邮件清单\n(窗口内无收件邮件)")
    return "\n".join(parts)


def _model_chain(model: Optional[str]) -> List[str]:
    """[agent.model 或 opus-4.8 默认, *全局 llm_fallback_models]（去重，保序）。"""
    from src.config import config as _cfg

    primary = (model or "").strip() or DEFAULT_REPORT_MODEL
    chain = [primary]
    for m in (_cfg.llm_fallback_models or "").split(","):
        m = m.strip()
        if m and m not in chain:
            chain.append(m)
    return chain


async def summarize_report(
    *,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    matter_briefs: Sequence[MatterBrief] = (),
    cadence: str = "daily",
    now: Optional[datetime] = None,
    persona_prompt: Optional[str] = None,
    model: Optional[str] = None,
    context_docs: Optional[List[str]] = None,
    client: Optional[LLMClient] = None,
) -> ReportDraft:
    """LLM 单次 tool_use：邮件 → ReportDraft。raises LLMCallError on failure（caller 降级）。

    persona_prompt 为 None → 用 cadence 对应的内置默认 persona。
    model 为 agent 选定模型（空 → DEFAULT_REPORT_MODEL=opus 4.8），接全局 fallback 链。
    context_docs 为行级身份文档勾选（None=默认 soul+user；[]=不注入）。
    """
    now = now or datetime.now(_BEIJING)
    persona = persona_prompt if (persona_prompt and persona_prompt.strip()) else get_default_prompt(cadence)
    groups = group_for_report(briefs)

    own_client = client is None
    client = client or LLMClient()
    try:
        result = await client.classify(
            system_blocks=_build_system(persona, now, context_docs=context_docs),
            user_content=_build_user(
                briefs=briefs,
                counts=counts,
                groups=groups,
                matter_briefs=matter_briefs,
                now=now,
            ),
            tool_schema=REPORT_TOOL_SCHEMA,
            tool_name=_TOOL_NAME,
            model_chain=_model_chain(model),
        )
    finally:
        if own_client:
            await client.close()
    return _parse(result)


async def summarize_report_agentic(
    *,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    db_path: str,
    matter_briefs: Sequence[MatterBrief] = (),
    cadence: str = "daily",
    now: Optional[datetime] = None,
    persona_prompt: Optional[str] = None,
    model: Optional[str] = None,
    context_docs: Optional[List[str]] = None,
    kos_enabled: bool = False,
    connector_grants: Sequence[Tuple[str, str]] = (),
    client: Optional[LLMClient] = None,
    max_iter: int = 8,
) -> ReportDraft:
    """agentic 日报：喂摘要清单（重要邮件附正文）+ 工具（按需查正文/附件/Gbrain），
    多轮后调 build_report 收尾 → ReportDraft。raises LLMCallError on failure（caller 降级）。

    与 summarize_report（单次 classify）的区别：走 LLMClient.run_tool_loop，模型可下钻查
    任意邮件细节，从而控制上下文体积（不全量塞正文）。build_report 作为 final_tool。

    ``connector_grants``（MCP connector PR3）= 该报告 Agent 行的 ``grant_connectors`` 对；
    非空且灰度开关开时额外挂 ``mcp__<connector>__<tool>`` 工具（周报可带 Jira 进展）。
    空 / flag off → 工具集与本 task 前逐字节相同。
    """
    now = now or datetime.now(_BEIJING)
    persona = persona_prompt if (persona_prompt and persona_prompt.strip()) else get_default_prompt(cadence)
    groups = group_for_report(briefs)
    # 线程聚合投影（含全历史状态）——payload 按事件串联，LLM 才能看到「你已表态」。
    thread_groups = build_thread_groups(db_path, briefs)
    aux_tools, handlers = build_report_tools(db_path, kos_enabled=kos_enabled)
    conn_tools, conn_handlers = build_connector_llm_tools(
        connector_grants, caller="report_agent"
    )
    aux_tools = [*aux_tools, *conn_tools]
    handlers = {**handlers, **conn_handlers}
    tools = [*aux_tools, REPORT_TOOL_SCHEMA]  # build_report = final_tool（命中即收尾）

    own_client = client is None
    client = client or LLMClient()
    try:
        result = await client.run_tool_loop(
            system_blocks=_build_system_agentic(persona, now, kos_enabled, context_docs=context_docs),
            user_content=_build_user_agentic(
                briefs=briefs,
                counts=counts,
                groups=groups,
                thread_groups=thread_groups,
                matter_briefs=matter_briefs,
                now=now,
            ),
            tools=tools,
            tool_handlers=handlers,
            final_tool=_TOOL_NAME,
            model_chain=_model_chain(model),
            max_iter=max_iter,
        )
    finally:
        if own_client:
            await client.close()
    if result.tool_calls:
        logger.info(
            f"[report] agentic daily: {result.iterations} 轮 / "
            f"{len(result.tool_calls)} 次工具调用 → "
            + ", ".join(tc.get("name", "?") for tc in result.tool_calls)
        )
    return ReportDraft(
        **_parse_draft_fields(result.final_input),
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_input_tokens=result.cache_read_input_tokens,
        model=result.model,
        # 此前这份轨迹只被上面那行 logger.info 打一句就丢（r10 §3.2 的核心发现）；
        # 现在透传给 worker 落 agent_run_log 步骤表。
        tool_calls=list(result.tool_calls),
    )


def _parse_draft_fields(ti: Dict[str, Any]) -> Dict[str, Any]:
    """build_report 的 tool input → ReportDraft 内容字段（headline/overview/sections/
    key_points/highlights）。单次 classify 与 agentic loop 共用（过滤非法 email_refs/空白）。"""
    ti = ti or {}
    sections: List[Dict[str, Any]] = []
    raw_sections = ti.get("sections")
    if isinstance(raw_sections, list):
        for s in raw_sections:
            if not isinstance(s, dict):
                continue
            refs = [r for r in (s.get("email_refs") or []) if isinstance(r, int)]
            sections.append(
                {
                    "id": (s.get("id") or "section").strip(),
                    "title": (s.get("title") or "").strip(),
                    "icon": s.get("icon"),
                    "intro": (s.get("intro") or "").strip(),
                    "summary": (s.get("summary") or "").strip(),
                    "email_refs": refs,
                }
            )

    key_points = [
        str(k).strip()
        for k in (ti.get("key_points") or [])
        if isinstance(k, str) and k.strip()
    ]

    highlights: List[Dict[str, Any]] = []
    for h in ti.get("highlights") or []:
        if isinstance(h, dict) and (h.get("body") or "").strip():
            highlights.append(
                {
                    "tone": h.get("tone"),
                    "title": (h.get("title") or "").strip(),
                    "body": (h.get("body") or "").strip(),
                }
            )

    # matter_digest：只留字符串型 ref（public_id）与汇总文案；命中校验在 assembler
    # （它才拿得到真实 brief 集合），这里只做形状过滤。
    digest = ti.get("matter_digest")
    digest = digest if isinstance(digest, dict) else {}
    matter_refs = [
        r.strip() for r in (digest.get("matter_refs") or []) if isinstance(r, str) and r.strip()
    ]

    return {
        "headline": (ti.get("headline") or "").strip()[:50],
        "overview": (ti.get("overview") or "").strip()[:400],
        "sections": sections,
        "key_points": key_points,
        "highlights": highlights,
        "matter_summary": (digest.get("summary") or "").strip()[:400],
        "matter_refs": matter_refs,
    }


def _parse(result: LLMResult) -> ReportDraft:
    return ReportDraft(
        **_parse_draft_fields(result.tool_input or {}),
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_input_tokens=result.cache_read_input_tokens,
        model=result.model,
    )


# ── 层级聚合（周报 / 月报均综合日报 —— 方案 A：月报不综合周报，避免跨月周错位）────────

def _extract_sub_summary(row: Dict[str, Any]) -> Dict[str, Any]:
    """从子报告行（含 blocks_json）抽 date / headline / overview / key_points 供综合。"""
    out: Dict[str, Any] = {
        "date": row.get("report_date", "") or "",
        "headline": row.get("headline", "") or "",
        "overview": "",
        "key_points": [],
    }
    try:
        blocks = json.loads(row.get("blocks_json") or "[]")
    except (json.JSONDecodeError, TypeError):
        blocks = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "overview" and not out["overview"]:
            out["overview"] = (b.get("text") or "")[:500]
        elif b.get("type") == "key_points":
            out["key_points"] = [str(x) for x in (b.get("items") or [])][:6]
    return out


def _build_user_aggregate(
    subs: List[Dict[str, Any]],
    cadence: str,
    missing_note: str,
    matter_briefs: Sequence[MatterBrief] = (),
    now: Optional[datetime] = None,
) -> str:
    # 方案 A：周报/月报都综合「日报」（月报不再综合周报，避免跨月周归属错位）。
    sub_unit = "日报"
    out_unit = "周报" if cadence == "weekly" else "月报"
    parts: List[str] = [
        f"下面是这段时间的 {len(subs)} 份{sub_unit}。把它们综合成一份{out_unit}，调用 {_TOOL_NAME}。"
        "聚合层不要逐封罗列邮件，sections 用文字概述即可（email_refs 留空数组）。"
    ]
    if missing_note:
        parts.append(f"\n⚠️ {missing_note}（请在 overview 里如实提及覆盖不完整）")
    # 🔴 事项档案**直接来自本周期的事项库**，不是从日报文本里重新归纳出来的 ——
    # 二次转述会把「推进到哪、卡在哪」压成模糊印象，而库里本来就躺着结构化的主线。
    matters = _matters_block(matter_briefs, now or datetime.now(_BEIJING))
    if matters:
        parts.append(matters)
    for s in subs:
        block = f"\n### {s['date']} {s['headline']}".rstrip()
        if s["overview"]:
            block += f"\n{s['overview']}"
        if s["key_points"]:
            block += "\n要点：" + "；".join(s["key_points"])
        parts.append(block)
    return "\n".join(parts)


async def summarize_aggregate(
    *,
    sub_reports: List[Dict[str, Any]],
    cadence: str,
    matter_briefs: Sequence[MatterBrief] = (),
    now: Optional[datetime] = None,
    persona_prompt: Optional[str] = None,
    model: Optional[str] = None,
    context_docs: Optional[List[str]] = None,
    missing_note: str = "",
    client: Optional[LLMClient] = None,
) -> ReportDraft:
    """层级聚合：日报综合成上层（周报 / 月报）。单次 classify（输入已是
    浓缩摘要，无需 agentic）。raises LLMCallError on failure（caller 降级）。"""
    now = now or datetime.now(_BEIJING)
    persona = persona_prompt if (persona_prompt and persona_prompt.strip()) else get_default_prompt(cadence)
    subs = [_extract_sub_summary(r) for r in sub_reports]

    own_client = client is None
    client = client or LLMClient()
    try:
        result = await client.classify(
            system_blocks=_build_system(persona, now, context_docs=context_docs),
            user_content=_build_user_aggregate(
                subs, cadence, missing_note, matter_briefs, now
            ),
            tool_schema=REPORT_TOOL_SCHEMA,
            tool_name=_TOOL_NAME,
            model_chain=_model_chain(model),
        )
    finally:
        if own_client:
            await client.close()
    return _parse(result)
