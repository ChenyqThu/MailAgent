"""报告块模型（ReportDoc DSL）—— LLM 输出 + 后端组装的结构化报告 SSoT。

前端 BlockRenderer 是这套 JSON 的消费方；契约见
docs/archive/2026-06/report-agent-frontend-handoff.md §5。下面的 block builder 函数保证字段名
与前端 TS 类型 1:1 对齐 —— **改字段名必须同步改 handoff 文档 + 前端**。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

REPORT_DOC_VERSION = 1

# Tone enum（与前端 TS Tone 一致）
TONE_NEUTRAL = "neutral"
TONE_INFO = "info"
TONE_SUCCESS = "success"
TONE_WARN = "warn"
TONE_CRITICAL = "critical"


def notion_url(page_id: Optional[str]) -> Optional[str]:
    """notion_page_id → 可点链接（与 repo 全仓一致公式）。"""
    if not page_id:
        return None
    return f"https://www.notion.so/{page_id.replace('-', '')}"


def app_deeplink(internal_id: int) -> str:
    """app 内打开某封邮件的 deeplink 提示（前端可直接用 internal_id 路由）。"""
    return f"mailagent://email/{internal_id}"


# ──────────────────────────────────────────────────────────────────────────
# Block builders —— 返回 dict，字段名 = 前端 TS 契约。空字段省略（前端按可选处理）。
# ──────────────────────────────────────────────────────────────────────────

def header(title: str, subtitle: Optional[str] = None, date_label: Optional[str] = None) -> Dict[str, Any]:
    b: Dict[str, Any] = {"type": "header", "title": title}
    if subtitle:
        b["subtitle"] = subtitle
    if date_label:
        b["date_label"] = date_label
    return b


def overview(text: str) -> Dict[str, Any]:
    return {"type": "overview", "text": text}


def stat(key: str, label: str, value: int, tone: str = TONE_NEUTRAL) -> Dict[str, Any]:
    return {"key": key, "label": label, "value": value, "tone": tone}


def stat_row(stats: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"type": "stat_row", "stats": stats}


def section(
    id: str,
    title: str,
    icon: Optional[str] = None,
    intro: Optional[str] = None,
    summary: Optional[str] = None,
) -> Dict[str, Any]:
    b: Dict[str, Any] = {"type": "section", "id": id, "title": title}
    if icon:
        b["icon"] = icon
    if intro:
        b["intro"] = intro
    # summary: 本组整体汇总（可含 [锚文本](#email-<internal_id>) 跳转 + **bold**）。
    # 前端解析 → 下划线跳转链接 / 加粗；缺省则该 section 行为不变（向后兼容）。
    if summary:
        b["summary"] = summary
    return b


def email_item(
    *,
    internal_id: int,
    subject: str,
    sender_name: str,
    time: str,
    sender_addr: Optional[str] = None,
    category: Optional[str] = None,
    priority: Optional[str] = None,
    ai_summary: Optional[str] = None,
    ai_action: Optional[str] = None,
    notion_page_id: Optional[str] = None,
    badges: Optional[List[str]] = None,
) -> Dict[str, Any]:
    b: Dict[str, Any] = {
        "type": "email_item",
        "internal_id": internal_id,
        "subject": subject or "(无主题)",
        "sender_name": sender_name or "",
        "time": time,
    }
    if sender_addr:
        b["sender_addr"] = sender_addr
    if category:
        b["category"] = category
    if priority:
        b["priority"] = priority
    if ai_summary:
        b["ai_summary"] = ai_summary
    if ai_action:
        b["ai_action"] = ai_action
    b["source"] = {
        "notion_url": notion_url(notion_page_id),
        "app_deeplink": app_deeplink(internal_id),
    }
    if badges:
        b["badges"] = badges
    return b


def key_points(items: List[str], title: Optional[str] = None) -> Dict[str, Any]:
    b: Dict[str, Any] = {"type": "key_points", "items": items}
    if title:
        b["title"] = title
    return b


def callout(body: str, tone: str = TONE_INFO, title: Optional[str] = None) -> Dict[str, Any]:
    b: Dict[str, Any] = {"type": "callout", "tone": tone, "body": body}
    if title:
        b["title"] = title
    return b


def kos_context(entity_slug: str, title: str, snippet: str, source: str = "KOS") -> Dict[str, Any]:
    return {
        "type": "kos_context",
        "entity_slug": entity_slug,
        "title": title,
        "snippet": snippet,
        "source": source,
    }


def action_suggestion(
    id: str, title: str, internal_ids: List[int], action_type: str, detail: Optional[str] = None
) -> Dict[str, Any]:
    # v1 动作按钮禁用态展示（enabled:false），不执行。
    b: Dict[str, Any] = {
        "type": "action_suggestion",
        "id": id,
        "title": title,
        "internal_ids": internal_ids,
        "action_type": action_type,
        "enabled": False,
    }
    if detail:
        b["detail"] = detail
    return b


def trend(metric: str, points: List[Dict[str, Any]], compare: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    b: Dict[str, Any] = {"type": "trend", "metric": metric, "points": points}
    if compare:
        b["compare"] = compare
    return b


def divider() -> Dict[str, Any]:
    return {"type": "divider"}


@dataclass
class ReportDoc:
    """一份报告的完整块模型。to_dict() 即前端拿到的 JSON。"""

    agent_id: str
    cadence: str
    report_date: str
    window_start: str
    window_end: str
    generated_at: str
    model: str
    blocks: List[Dict[str, Any]] = field(default_factory=list)
    version: int = REPORT_DOC_VERSION

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "agent_id": self.agent_id,
            "cadence": self.cadence,
            "report_date": self.report_date,
            "window": {"start": self.window_start, "end": self.window_end},
            "generated_at": self.generated_at,
            "model": self.model,
            "blocks": self.blocks,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)

    def derive_headline(self) -> str:
        """列表展示用的一句话摘要：优先 overview 首句，否则 header.title。"""
        for b in self.blocks:
            if b.get("type") == "overview" and b.get("text"):
                return str(b["text"]).strip()[:80]
        for b in self.blocks:
            if b.get("type") == "header" and b.get("title"):
                return str(b["title"]).strip()[:80]
        return ""
