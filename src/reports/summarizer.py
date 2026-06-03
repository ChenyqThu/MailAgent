"""报告 LLM 生成器 —— 单次 tool_use 出 ReportDraft（headline/overview/分组/要点）。

镜像 src/llm_agent/digest_summarizer 结构（复用 LLMClient tool_use + cache_control）。
**LLM 只产文案 + 分组（email_refs=internal_id）**；counts 与邮件事实数据由代码
（data + assembler）确定，LLM 不碰 —— 防幻觉。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional


from src.llm_agent.client import LLMClient, LLMResult
from src.llm_agent.processor import _build_cache_control
from src.reports.data import ReportEmailBrief, group_for_report
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
                    "**必须从给定邮件清单里选，绝不能编造**。建议分组："
                    "需要你亲自关注 / Jarvis 已处理 / FYI 已汇总。空组不要给。"
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
                "description": "你必须知道的关键信息，0-5 条，每条带来源语境。",
                "items": {"type": "string", "maxLength": 160},
            },
            "highlights": {
                "type": "array",
                "maxItems": 3,
                "description": "高亮提示（截止 / 风险），0-3 条；无则空数组。",
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
    # meta
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str = ""


def _build_system(persona: str, now: datetime) -> List[Dict[str, Any]]:
    weekday_cn = "一二三四五六日"[now.weekday()]
    body = (
        persona.rstrip()
        + f"\n\n当前时间：{now.isoformat()}（周{weekday_cn}，时区 +08:00 北京）。"
        + _FIXED_RULES
    )
    block: Dict[str, Any] = {"type": "text", "text": body}
    cc = _build_cache_control()
    if cc is not None:
        block["cache_control"] = cc
    return [block]


def _build_user(
    *,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    groups: Dict[str, List[ReportEmailBrief]],
    ai_summary_max_chars: int = 100,
) -> str:
    parts: List[str] = [f"把下面的邮件策展成报告，调用 {_TOOL_NAME}。"]

    by_cat = counts.get("by_category") or {}
    cat_line = "、".join(f"{k}:{v}" for k, v in by_cat.items()) or "(无)"
    parts.append(
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

    # 代码分组提示（参考，LLM 可调整 —— 但 id 仍须来自清单）
    hint = {k: [b.internal_id for b in v] for k, v in groups.items()}
    parts.append(
        "\n## 代码分组提示（参考，可调整）\n"
        f"- 需关注: {hint.get('attention', [])}\n"
        f"- 已处理: {hint.get('handled', [])}\n"
        f"- FYI: {hint.get('fyi', [])}"
    )

    # 只枚举收件类邮件供 LLM 引用（email_refs）；发件箱仅参与上面的「已发出」统计，
    # 不进清单（避免 LLM 把你自己发的邮件铺成条目）。
    inbound = [b for b in briefs if not b.is_outbound]
    if inbound:
        lines = ["\n## 邮件清单（按优先级排序；用 internal_id 引用；不含正文）"]
        for b in inbound:
            ai = b.ai_summary.strip()
            if len(ai) > ai_summary_max_chars:
                ai = ai[:ai_summary_max_chars] + "…"
            # 当前状态标记 —— LLM 据此判断哪些已处理（已回复/已读/旗标）。
            marks = ["已读" if b.is_read else "未读"]
            if b.replied:
                marks.append("已回复")
            if b.is_flagged:
                marks.append("旗标")
            if b.is_pinned:
                marks.append("置顶")
            if b.is_important:
                marks.append("重要")
            lines.append(
                f"- id={b.internal_id} [{' '.join(marks)}] {b.subject or '(无主题)'}"
                f" | 发件人：{b.sender_name or b.sender_addr or '(未知)'}"
                f" | 分类：{b.category or '-'}"
                f" | 优先级：{b.priority or '-'}"
                f" | 类型：{b.action_type or '-'}"
                + (f" | 摘要：{ai}" if ai else "")
            )
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
    cadence: str = "daily",
    now: Optional[datetime] = None,
    persona_prompt: Optional[str] = None,
    model: Optional[str] = None,
    client: Optional[LLMClient] = None,
) -> ReportDraft:
    """LLM 单次 tool_use：邮件 → ReportDraft。raises LLMCallError on failure（caller 降级）。

    persona_prompt 为 None → 用 cadence 对应的内置默认 persona。
    model 为 agent 选定模型（空 → DEFAULT_REPORT_MODEL=opus 4.8），接全局 fallback 链。
    """
    now = now or datetime.now(_BEIJING)
    persona = persona_prompt if (persona_prompt and persona_prompt.strip()) else get_default_prompt(cadence)
    groups = group_for_report(briefs)

    own_client = client is None
    client = client or LLMClient()
    try:
        result = await client.classify(
            system_blocks=_build_system(persona, now),
            user_content=_build_user(briefs=briefs, counts=counts, groups=groups),
            tool_schema=REPORT_TOOL_SCHEMA,
            tool_name=_TOOL_NAME,
            model_chain=_model_chain(model),
        )
    finally:
        if own_client:
            await client.close()
    return _parse(result)


def _parse(result: LLMResult) -> ReportDraft:
    ti = result.tool_input or {}

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

    return ReportDraft(
        headline=(ti.get("headline") or "").strip()[:50],
        overview=(ti.get("overview") or "").strip()[:400],
        sections=sections,
        key_points=key_points,
        highlights=highlights,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_input_tokens=result.cache_read_input_tokens,
        model=result.model,
    )
