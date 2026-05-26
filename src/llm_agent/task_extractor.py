"""LLM 决策: 邮件 → 日程库 task fields (Phase 2 convert_to_notion_task).

灵动岛"转 Notion 任务"按钮 → ``mailagent notion create-task`` → 本模块 LLM 单次
tool_use 读邮件内容 + 日程库 (GTD 时间块) 字段操作指南, 输出结构化 task fields
(精炼 title / 智能 time 建议 / 日程类型分类 / 优先级 / description). 代码侧
(notion CLI) 拿 fields 确定性写 Notion + Email Inbox relation.

**LLM 介入决策, 不介入执行** — 区别于 agent loop (PRD 灵动岛轻量非目标: 不做
tool_use 跨域多轮). 单次 call (~2-3s, ~$0.005), 复用 LLMClient tool_use 基础设施.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from loguru import logger

from .client import LLMClient, LLMResult

_BEIJING = timezone(timedelta(hours=8))


# 日程库 `日程类型` / `优先级` select 的规范子集 — 库里有重复脏 options
# (如 '💼工作·会议' 无空格 / 'P0' / '中' 裸值), 这里只暴露规范集给 LLM 选,
# 写 Notion 时按这些 exact 字符串匹配已有 option (不新建).
SCHEDULE_TYPE_ENUM: List[str] = [
    "💼 工作·会议",
    "🎯 工作·专注",
    "📚 阅读",
    "🏃 运动",
    "🏠 个人事项",
    "🚗 生活·出行",
]
TASK_PRIORITY_ENUM: List[str] = ["🔴 紧急", "🟠 高", "🟡 中", "🟢 低"]

# 邮件 AI priority → 日程库优先级 默认映射 (LLM 可微调)
_PRIORITY_HINT = {
    "🔴 紧急": "🔴 紧急",
    "🟡 重要": "🟠 高",
    "🟢 一般": "🟡 中",
    "⚪ 低": "🟢 低",
}


TASK_TOOL_SCHEMA: Dict[str, Any] = {
    "name": "extract_task",
    "description": (
        "把一封需跟进的邮件转成 Lucien 日程库 (GTD 时间块 + 任务) 里的一个 task。"
        "只调用一次。"
    ),
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["task_title", "schedule_type", "priority"],
        "properties": {
            "task_title": {
                "type": "string",
                "maxLength": 100,
                "description": (
                    "精炼成『动词开头的行动项』，简体中文，≤ 100 字。"
                    "例：『Review PCI 合规文档高亮部分』『回复 Gary 关于 Q3 预算』。"
                    "不要照搬邮件主题，不要带 Re:/Fwd: 前缀。"
                ),
            },
            "schedule_type": {
                "type": "string",
                "enum": SCHEDULE_TYPE_ENUM,
                "description": (
                    "按邮件性质选日程类型：💼 工作·会议=需开会讨论；"
                    "🎯 工作·专注=需独立深度处理(review/写方案/决策)；"
                    "📚 阅读=主要读材料；🏠 个人事项=个人事务；"
                    "🏃 运动 / 🚗 生活·出行=个人生活类。"
                ),
            },
            "priority": {
                "type": "string",
                "enum": TASK_PRIORITY_ENUM,
                "description": (
                    "参考邮件原 AI 优先级微调：🔴紧急→🔴紧急，🟡重要→🟠高，"
                    "🟢一般→🟡中，⚪低→🟢低。"
                ),
            },
            "suggested_time_iso": {
                "type": "string",
                "description": (
                    "建议 Lucien 何时处理，ISO 8601 本地时间含时区 (如 "
                    "2026-05-27T14:00:00+08:00)。按紧急度：🔴紧急=今天剩余工作时间；"
                    "🟠高=明天工作时间(9-18)；🟡中=本周内合适时段；🟢低/不确定=留空字符串。"
                    "避免排到周末/深夜；默认 1 小时时间块的起始时间。不确定就留空字符串。"
                ),
            },
            "is_all_day": {
                "type": "boolean",
                "description": "一般 false (时间块)；全天事项 (如『某天截止』) 才 true。",
            },
            "description": {
                "type": "string",
                "maxLength": 500,
                "description": (
                    "1-2 句行动要点 (做什么 + 关键背景: 人名/deadline/数据)，"
                    "简体中文，≤ 500 字。"
                ),
            },
        },
    },
}


@dataclass
class TaskFields:
    """extract_task 解析后的结构化 task 字段 (供 notion CLI 写日程库)."""

    task_title: str
    schedule_type: str
    priority: str
    suggested_time_iso: str = ""  # 空 = 不写 Time (Lucien 手动排)
    is_all_day: bool = False
    description: str = ""
    # meta
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


def _build_system(now: datetime, as_meeting: bool = False) -> List[Dict[str, Any]]:
    now_str = now.isoformat()
    weekday_cn = "一二三四五六日"[now.weekday()]
    if as_meeting:
        # add_to_calendar 场景: 抽邮件提到的会议实际时间 (非建议处理时间)
        body = (
            "你帮 Lucien 把一封含会议信息的邮件加到他的日程库 (日历)。调用 extract_task "
            "工具 EXACTLY ONCE，绝不输出纯文本。\n\n"
            f"当前时间：{now_str}（周{weekday_cn}，时区 +08:00 北京）。\n"
            "这是会议邀请场景，注意：\n"
            "- schedule_type 选『💼 工作·会议』。\n"
            "- suggested_time_iso 填**邮件正文里提到的会议实际开始时间**（不是建议处理时间！）。"
            "邮件说『周五 10:00』『明天下午 2 点』等就以当前时间推算成具体 ISO；"
            "抽不到明确会议时间就留空字符串。\n"
            "- description 填会议要点（议程 / 参会人 / 地点 / 会议链接）。"
        )
    else:
        # convert_to_notion_task 场景: 建议何时处理这个任务
        body = (
            "你帮 Lucien 把一封需跟进的邮件转成他日程库 (GTD 时间块 + 任务) 里的"
            "一个 task。调用 extract_task 工具 EXACTLY ONCE，绝不输出纯文本。\n\n"
            f"当前时间：{now_str}（周{weekday_cn}，时区 +08:00 北京）。\n"
            "排 suggested_time 时以此为基准，避免排到已过去的时间 / 周末 / 深夜 "
            "(22:00-08:00)。"
        )
    return [{"type": "text", "text": body}]


def _build_user(
    *,
    subject: str,
    body_markdown: str,
    ai_summary: str,
    ai_priority: str,
    sender: str,
    body_max_chars: int = 4000,
) -> str:
    body = (body_markdown or "").strip()
    if len(body) > body_max_chars:
        body = body[:body_max_chars] + "\n...[truncated]"
    hint = _PRIORITY_HINT.get(ai_priority, "")
    parts = [
        "把下面这封邮件转成日程库 task，调用 extract_task：",
        f"\n## 邮件主题\n{subject or '(无主题)'}",
        f"\n## 发件人\n{sender or '(未知)'}",
    ]
    if ai_summary:
        parts.append(f"\n## AI 摘要\n{ai_summary}")
    if ai_priority:
        prio_line = f"\n## 邮件 AI 优先级\n{ai_priority}"
        if hint:
            prio_line += f"（建议映射到 {hint}，可微调）"
        parts.append(prio_line)
    if body:
        parts.append(f"\n## 邮件正文\n{body}")
    return "\n".join(parts)


async def extract_task_fields(
    *,
    subject: str,
    body_markdown: str,
    ai_summary: str = "",
    ai_priority: str = "",
    sender: str = "",
    as_meeting: bool = False,
    now: Optional[datetime] = None,
    client: Optional[LLMClient] = None,
) -> TaskFields:
    """LLM 单次 tool_use: 邮件 → TaskFields。raises LLMCallError on failure.

    ``as_meeting=True`` (add_to_calendar): 抽邮件提到的会议实际时间 + schedule_type
    会议。``False`` (convert_to_notion_task): LLM 建议何时处理 task。
    """
    now = now or datetime.now(_BEIJING)
    own_client = client is None
    client = client or LLMClient()
    try:
        result = await client.classify(
            system_blocks=_build_system(now, as_meeting=as_meeting),
            user_content=_build_user(
                subject=subject, body_markdown=body_markdown,
                ai_summary=ai_summary, ai_priority=ai_priority, sender=sender,
            ),
            tool_schema=TASK_TOOL_SCHEMA,
            tool_name="extract_task",
        )
    finally:
        if own_client:
            await client.close()
    return _parse(result, now)


def _parse(result: LLMResult, now: datetime) -> TaskFields:
    ti = result.tool_input or {}

    task_title = (ti.get("task_title") or "").strip()[:100]
    if not task_title:
        task_title = "(未命名任务)"

    schedule_type = ti.get("schedule_type", "")
    if schedule_type not in SCHEDULE_TYPE_ENUM:
        logger.warning(f"[task-extract] schedule_type out-of-enum: {schedule_type!r}; → 🎯 工作·专注")
        schedule_type = "🎯 工作·专注"

    priority = ti.get("priority", "")
    if priority not in TASK_PRIORITY_ENUM:
        logger.warning(f"[task-extract] priority out-of-enum: {priority!r}; → 🟡 中")
        priority = "🟡 中"

    # suggested_time: 校验 ISO + 不在过去 (过去 → 清空让用户手排)
    suggested_time_iso = _sanitize_time(ti.get("suggested_time_iso"), now)

    return TaskFields(
        task_title=task_title,
        schedule_type=schedule_type,
        priority=priority,
        suggested_time_iso=suggested_time_iso,
        is_all_day=bool(ti.get("is_all_day")),
        description=(ti.get("description") or "").strip()[:500],
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        model=result.model,
    )


def _sanitize_time(raw: Any, now: datetime) -> str:
    """校验 LLM 给的 suggested_time_iso: 必须是合法 ISO + 不在过去.

    不合法 / 过去 / 空 → 返回 "" (notion CLI 不写 Time, Lucien 手动排).
    返回时统一带时区 (无时区的按北京补).
    """
    if not isinstance(raw, str) or not raw.strip():
        return ""
    s = raw.strip()
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        logger.warning(f"[task-extract] suggested_time_iso 非法 ISO: {s!r}; 清空")
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_BEIJING)
    # 过去时间 (留 5 分钟容差) → 清空
    if dt < now - timedelta(minutes=5):
        logger.info(f"[task-extract] suggested_time {dt.isoformat()} 在过去; 清空让用户手排")
        return ""
    return dt.isoformat()
