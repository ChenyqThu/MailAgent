"""报告组装器 —— LLM draft + 邮件 brief → 完整 ReportDoc 块（**代码权威回填**）。

防幻觉纪律（同 DailyDigest）：LLM 只写文案（headline/overview/section intro/
key_points/highlights）+ 分组（email_refs = internal_id）。**邮件的事实数据
（主题/发件人/链接/时间）+ counts 统计卡，全部由代码从 brief 回填**；LLM 给的
email_refs 必须命中真实 brief，否则丢弃。LLM 出错爆炸半径限定在文案。
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Set

from src.reports import models as m
from src.reports.data import ReportEmailBrief, group_for_report
from src.reports.summarizer import ReportDraft

# section.summary 内的跳转标记：[锚文本](#email-<internal_id>)。
_SUMMARY_LINK_RE = re.compile(r"\[([^\]]+)\]\(#email-(\d+)\)")

_WEEKDAY_CN = "一二三四五六日"

_TITLE_BY_CADENCE = {"daily": "邮件日报", "weekly": "邮件周报", "monthly": "邮件月报"}
# 滚动窗口（遵循 window_hours，跑的时刻往前推 N 小时）→ 标"过去 N"。
_SPAN_BY_CADENCE = {"daily": "过去 24 小时", "weekly": "过去 7 天", "monthly": "过去 30 天"}

# stat_row 规格（key 与 compute_report_counts 对齐）。
_STAT_SPEC = [
    ("total", "总邮件", m.TONE_NEUTRAL),
    ("unread", "未读", m.TONE_INFO),
    ("urgent", "需关注", m.TONE_CRITICAL),
    ("ai_handled", "AI 已处理", m.TONE_SUCCESS),
    ("todo", "待你处理", m.TONE_WARN),
]

_ALLOWED_ICONS = {"alert", "check", "info", "inbox", "star", "archive"}
_SECTION_ICON_FALLBACK = {"attention": "alert", "handled": "check", "fyi": "inbox"}

# fallback（LLM 不可用）模式每组明细上限，避免 FYI 刷屏。
_FALLBACK_SECTION_CAP = 25


def _subtitle(report_date: str, cadence: str, now: datetime) -> tuple[str, str]:
    # weekday 从 report_date（覆盖日，通常是昨天）推导 —— 不用 now（生成日），
    # 否则"昨天的报告"会标成今天的星期。
    weekday = ""
    try:
        dt = datetime.strptime(report_date, "%Y-%m-%d")
        date_str = f"{dt.year}年{dt.month}月{dt.day}日"
        weekday = f"周{_WEEKDAY_CN[dt.weekday()]}"
    except (ValueError, TypeError):
        date_str = report_date
    span = _SPAN_BY_CADENCE.get(cadence, "")
    subtitle = f"{date_str} · {span}" if span else date_str
    return subtitle, weekday


def _stat_row(counts: Dict[str, Any]) -> Dict[str, Any]:
    return m.stat_row(
        [m.stat(key, label, int(counts.get(key, 0)), tone) for key, label, tone in _STAT_SPEC]
    )


def _sanitize_summary(summary: str, valid_ids: Set[int]) -> str:
    """防幻觉：把 summary 里指向不存在邮件的 [锚文本](#email-<id>) 降级为纯锚文本。

    valid_ids = 本报告候选集（真实 brief 的 internal_id）。命中 → 保留跳转；
    未命中（LLM 编造的 id）→ 去掉 [..](#email-..) 包裹只留锚文本（§3.3）。
    **bold** 等其他标记原样保留（前端 renderSummary 解析）。
    """

    def _repl(match: "re.Match[str]") -> str:
        anchor, sid = match.group(1), match.group(2)
        try:
            iid = int(sid)
        except ValueError:
            return anchor
        return match.group(0) if iid in valid_ids else anchor

    return _SUMMARY_LINK_RE.sub(_repl, summary)


def _email_item(b: ReportEmailBrief) -> Dict[str, Any]:
    return m.email_item(
        internal_id=b.internal_id,
        subject=b.subject,
        sender_name=b.sender_name,
        time=b.date_received,
        sender_addr=b.sender_addr or None,
        category=b.category or None,
        priority=b.priority or None,
        ai_summary=b.ai_summary or None,
        ai_action=b.action_type or None,
        notion_page_id=b.notion_page_id,
    )


def assemble_report_doc(
    *,
    draft: ReportDraft,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    agent_id: str,
    cadence: str,
    report_date: str,
    window_start: str,
    window_end: str,
    generated_at: str,
    model: str,
    now: datetime,
) -> m.ReportDoc:
    """LLM draft → ReportDoc。email_refs 校验回真实 brief，每封最多出现一次。"""
    brief_map = {b.internal_id: b for b in briefs}
    subtitle, weekday = _subtitle(report_date, cadence, now)

    blocks: List[Dict[str, Any]] = [
        m.header(_TITLE_BY_CADENCE.get(cadence, "邮件报告"), subtitle, weekday)
    ]
    if draft.overview.strip():
        blocks.append(m.overview(draft.overview.strip()))
    blocks.append(_stat_row(counts))

    valid_ids = set(brief_map.keys())
    used: set = set()
    for sec in draft.sections:
        ids: List[int] = []
        for iid in sec.get("email_refs") or []:
            if isinstance(iid, int) and iid in brief_map and iid not in used:
                ids.append(iid)
                used.add(iid)
        intro = (sec.get("intro") or "").strip() or None
        summary = (sec.get("summary") or "").strip()
        # summary 里的跳转链接对齐到真实候选集；幻觉 id 降级为纯文本。
        summary = (_sanitize_summary(summary, valid_ids) or None) if summary else None
        # 空 section（无有效邮件且无 intro/summary）跳过。
        if not ids and not intro and not summary:
            continue
        icon = sec.get("icon")
        if icon not in _ALLOWED_ICONS:
            icon = _SECTION_ICON_FALLBACK.get(sec.get("id", ""), "info")
        blocks.append(
            m.section(
                sec.get("id") or "section",
                (sec.get("title") or "").strip() or "邮件",
                icon,
                intro,
                summary,
            )
        )
        for iid in ids:
            blocks.append(_email_item(brief_map[iid]))

    kps = [k.strip() for k in (draft.key_points or []) if k and k.strip()]
    if kps:
        blocks.append(m.key_points(kps, "你必须知道的关键信息"))

    for h in draft.highlights or []:
        body = (h.get("body") or "").strip()
        if body:
            tone = h.get("tone") if h.get("tone") in {
                m.TONE_INFO, m.TONE_WARN, m.TONE_CRITICAL, m.TONE_SUCCESS
            } else m.TONE_INFO
            blocks.append(m.callout(body, tone, (h.get("title") or "").strip() or None))

    return m.ReportDoc(
        agent_id=agent_id,
        cadence=cadence,
        report_date=report_date,
        window_start=window_start,
        window_end=window_end,
        generated_at=generated_at,
        model=model,
        blocks=blocks,
    )


def assemble_fallback_doc(
    *,
    briefs: List[ReportEmailBrief],
    counts: Dict[str, Any],
    agent_id: str,
    cadence: str,
    report_date: str,
    window_start: str,
    window_end: str,
    generated_at: str,
    model: str,
    now: datetime,
) -> m.ReportDoc:
    """LLM 不可用时的降级报告：纯代码分组（group_for_report）+ 模板文案，无 LLM prose。"""
    groups = group_for_report(briefs)
    subtitle, weekday = _subtitle(report_date, cadence, now)
    blocks: List[Dict[str, Any]] = [
        m.header(_TITLE_BY_CADENCE.get(cadence, "邮件报告"), subtitle, weekday),
        m.overview(
            f"过去窗口共 {counts.get('total', 0)} 封邮件，"
            f"{counts.get('urgent', 0)} 封需关注，{counts.get('unread', 0)} 封未读。"
            f"（AI 摘要暂不可用，以下为按规则分组的明细。）"
        ),
        _stat_row(counts),
    ]
    section_spec = [
        ("attention", "需要你亲自关注", "alert"),
        ("handled", "Jarvis 已处理", "check"),
        ("fyi", "FYI / 系统通知", "inbox"),
    ]
    for sid, title, icon in section_spec:
        items = groups.get(sid, [])
        if not items:
            continue
        capped = items[:_FALLBACK_SECTION_CAP]
        more = len(items) - len(capped)
        intro = f"共 {len(items)} 封" + (f"（仅列前 {len(capped)} 封）" if more > 0 else "")
        blocks.append(m.section(sid, title, icon, intro))
        for b in capped:
            blocks.append(_email_item(b))

    return m.ReportDoc(
        agent_id=agent_id,
        cadence=cadence,
        report_date=report_date,
        window_start=window_start,
        window_end=window_end,
        generated_at=generated_at,
        model=model,
        blocks=blocks,
    )
