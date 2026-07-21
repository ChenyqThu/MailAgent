"""LLM 决策: 最近 24h 邮件 → 灵动岛"今日总结" (DailyDigest Phase A summarizer).

灵动岛每天 9:00 / 18:00 跨邮件巡检 → 本模块 LLM 单次 tool_use 读取已分类邮件的
AI 字段 (subject + category/priority/action_type/ai_summary, **不读正文**) + 代码算好
的 counts + 代码确定性选出的 bulk 候选, 输出灵动岛展示文案 (headline / summary_md) +
从固定 enum 里挑出要展示的 bulk action (≤ 3).

**LLM 介入决策文案, 不介入数据** — counts 由代码算 (LLM 数数不可靠), bulk action 的
internal_id 列表由代码确定性控制, LLM 只能从 3 个固定 action enum 里选 + 写文案. 即使
LLM 乱来, 爆炸半径也限定在"文案质量", 不影响"点了归档到底归档哪几封"的正确性.

照 ``task_extractor.py`` 结构 1:1 (单次 call, 复用 LLMClient tool_use 基础设施 +
cache_control). 区别于 agent loop (PRD 灵动岛轻量非目标: 不做 tool_use 跨域多轮).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from loguru import logger

from .client import LLMClient, LLMResult
from .processor import _build_cache_control

_BEIJING = timezone(timedelta(hours=8))

# bulk action id 固定 enum — LLM 只能从这 3 个里选. 与
# ``island_action_whitelist.BULK_ACTION_IDS`` (Phase B 新增) 一致.
# 改这里 → schema enum 同步收紧 → LLM 输出超集 id 被 JSON schema 校验拒.
BULK_ACTION_IDS: List[str] = [
    "bulk_archive_newsletter",  # 归档一批 newsletter / FYI
    "bulk_mark_done",           # 批量标完成 (处理完一批)
    "bulk_mark_read",           # 批量标已读 (不动 flag)
]


DIGEST_TOOL_SCHEMA: Dict[str, Any] = {
    "name": "summarize_digest",
    "description": "把最近 24h 邮件汇总成一条灵动岛今日总结。只调用一次。",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["headline", "summary_md"],
        "properties": {
            "headline": {
                "type": "string",
                "maxLength": 30,
                "description": (
                    "一句话概括今天邮件态势，简体中文，≤ 30 字。"
                    "例：『3封紧急待回复，5封newsletter可清理』。"
                ),
            },
            "summary_md": {
                "type": "string",
                "maxLength": 400,
                "description": (
                    "2-4 句简体中文摘要，点出最该关注的 1-2 封 + 整体态势，≤ 400 字。"
                    "仅限 inline markdown：**bold**, *italic*, `code`, [text](url)；"
                    "禁止 heading / code block / 真 list。"
                ),
            },
            "confirmed_bulk_actions": {
                "type": "array",
                "maxItems": 3,
                "description": (
                    "从代码给的候选 bulk 里挑 1-3 个值得在灵动岛一键执行的；"
                    "候选为空就返回空数组。id 必须从固定 enum 选。"
                ),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "title"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "enum": BULK_ACTION_IDS,
                            "description": (
                                "bulk action 类型，只能从候选里挑；不在 enum 的会被拒。"
                            ),
                        },
                        "title": {
                            "type": "string",
                            "maxLength": 24,
                            "description": (
                                "按钮文案，动词+数量，简体中文，≤ 24 字。"
                                "数量必须等于代码给的候选数，不要瞎编。"
                            ),
                        },
                        "detail": {
                            "type": "string",
                            "maxLength": 40,
                            "description": "button 第二行副标题，简体中文，≤ 40 字。可选。",
                        },
                    },
                },
            },
        },
    },
}


@dataclass
class DigestBulkAction:
    """summarize_digest 挑出的一个 bulk action (id + 文案; 代码侧再附 internal_ids)."""

    id: str
    title: str
    detail: str = ""


@dataclass
class DigestSummary:
    """summarize_digest 解析后的灵动岛今日总结文案 (供 dispatch 构造 envelope)."""

    headline: str
    summary_md: str
    confirmed_actions: List[DigestBulkAction] = field(default_factory=list)
    # meta
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str = ""


def _build_system(now: datetime) -> List[Dict[str, Any]]:
    now_str = now.isoformat()
    weekday_cn = "一二三四五六日"[now.weekday()]
    from src.agent_config.task_context import build_task_identity_context

    body = (
        build_task_identity_context()
        + "你帮用户写一条灵动岛『今日总结』通知，汇总用户最近 24h 的邮件态势。"
        "调用 summarize_digest 工具 EXACTLY ONCE，绝不输出纯文本。\n\n"
        f"当前时间：{now_str}（周{weekday_cn}，偏移量即本地时区）。\n\n"
        "规则：\n"
        "- counts（未读 / 紧急 / 总数 / 各分类数）是代码算好的**已知事实**，"
        "你只能在文案里引用它，绝不能改它、也不要在 tool output 里复述 counts 字段。\n"
        "- bulk action 只能从代码给你的『候选 bulk』里挑（id 从固定 enum 选）；"
        "候选里没有的 action 绝不能编。候选为空就返回空 confirmed_bulk_actions 数组。\n"
        "- bulk action 的 title 里写的数量必须等于代码给的该候选的 count，不要瞎编数量。\n"
        "- headline ≤ 30 字，summary_md 2-4 句、≤ 400 字、仅 inline markdown。\n"
        "- 全程简体中文（mainland 用法）；URL / 邮件地址 / 人名 / 产品名保留 verbatim。"
    )
    block: Dict[str, Any] = {"type": "text", "text": body}
    cc = _build_cache_control()
    if cc is not None:
        block["cache_control"] = cc
    return [block]


def _build_user(
    *,
    emails_brief: List[Dict[str, Any]],
    counts: Dict[str, Any],
    bulk_candidates: List[Dict[str, Any]],
    ai_summary_max_chars: int = 80,
) -> str:
    """拼 user message: 每封邮件只给 metadata + AI 字段精华 (**不传正文**)."""
    parts: List[str] = ["把下面最近 24h 的邮件汇总成灵动岛今日总结，调用 summarize_digest。"]

    # counts (已知事实)
    by_cat = counts.get("by_category") or {}
    cat_line = "、".join(f"{k}:{v}" for k, v in by_cat.items()) or "(无)"
    parts.append(
        "\n## 已知 counts（代码算好，勿改）\n"
        f"- 未读：{counts.get('unread', 0)}\n"
        f"- 紧急：{counts.get('urgent', 0)}\n"
        f"- 总数：{counts.get('total', 0)}\n"
        f"- 各分类：{cat_line}"
    )

    # bulk 候选 (代码确定性选好的)
    if bulk_candidates:
        cand_lines = ["\n## 候选 bulk action（只能从这里挑）"]
        for c in bulk_candidates:
            samples = "；".join((c.get("sample_subjects") or [])[:3]) or "(无样例)"
            cand_lines.append(
                f"- id={c.get('id')} count={c.get('count', 0)} 样例主题：{samples}"
            )
        parts.append("\n".join(cand_lines))
    else:
        parts.append("\n## 候选 bulk action\n(无候选，confirmed_bulk_actions 返回空数组)")

    # 邮件 brief (不含正文)
    if emails_brief:
        lines = ["\n## 邮件清单（最该关注的在前；不含正文）"]
        for i, e in enumerate(emails_brief, 1):
            ai = (e.get("ai_summary") or "").strip()
            if len(ai) > ai_summary_max_chars:
                ai = ai[:ai_summary_max_chars] + "…"
            read_mark = "已读" if e.get("is_read") else "未读"
            lines.append(
                f"{i}. [{read_mark}] {e.get('subject') or '(无主题)'}"
                f" | 发件人：{e.get('sender_name') or '(未知)'}"
                f" | 分类：{e.get('category') or '-'}"
                f" | 优先级：{e.get('priority') or '-'}"
                f" | 类型：{e.get('action_type') or '-'}"
                + (f" | 摘要：{ai}" if ai else "")
            )
        parts.append("\n".join(lines))
    else:
        parts.append("\n## 邮件清单\n(最近 24h 无已分类邮件)")

    return "\n".join(parts)


async def summarize_digest(
    *,
    emails_brief: List[Dict[str, Any]],
    counts: Dict[str, Any],
    bulk_candidates: List[Dict[str, Any]],
    now: Optional[datetime] = None,
    client: Optional[LLMClient] = None,
) -> DigestSummary:
    """LLM 单次 tool_use: 邮件汇总 → DigestSummary。raises LLMCallError on failure.

    counts / bulk_candidates 由代码确定性算好传入；LLM 只产 headline / summary_md +
    从候选里挑 confirmed bulk action 文案。
    """
    now = now or datetime.now(_BEIJING)
    own_client = client is None
    client = client or LLMClient()
    try:
        result = await client.classify(
            system_blocks=_build_system(now),
            user_content=_build_user(
                emails_brief=emails_brief,
                counts=counts,
                bulk_candidates=bulk_candidates,
            ),
            tool_schema=DIGEST_TOOL_SCHEMA,
            tool_name="summarize_digest",
        )
    finally:
        if own_client:
            await client.close()
    return _parse(result)


def _parse(result: LLMResult) -> DigestSummary:
    ti = result.tool_input or {}

    headline = (ti.get("headline") or "").strip()[:30]
    summary_md = (ti.get("summary_md") or "").strip()[:400]

    confirmed: List[DigestBulkAction] = []
    seen_ids: set = set()
    raw_actions = ti.get("confirmed_bulk_actions")
    if isinstance(raw_actions, list):
        for item in raw_actions:
            if not isinstance(item, dict):
                continue
            action_id = (item.get("id") or "").strip()
            # enum 校验兜底: id 不在 3 enum 内 → 丢弃该 action
            if action_id not in BULK_ACTION_IDS:
                logger.warning(
                    f"[digest] confirmed bulk action id out-of-enum: {action_id!r}; 丢弃"
                )
                continue
            title = (item.get("title") or "").strip()[:24]
            # title 缺失 → 丢弃 (无文案的按钮无意义)
            if not title:
                logger.warning(
                    f"[digest] confirmed bulk action {action_id!r} 缺 title; 丢弃"
                )
                continue
            # 同 id 去重 (一个 action 类型最多展示一次)
            if action_id in seen_ids:
                continue
            seen_ids.add(action_id)
            confirmed.append(
                DigestBulkAction(
                    id=action_id,
                    title=title,
                    detail=(item.get("detail") or "").strip()[:40],
                )
            )
            if len(confirmed) >= 3:
                break

    return DigestSummary(
        headline=headline,
        summary_md=summary_md,
        confirmed_actions=confirmed,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_input_tokens=result.cache_read_input_tokens,
        model=result.model,
    )
