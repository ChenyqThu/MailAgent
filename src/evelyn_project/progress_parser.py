"""解析 xlsx `Project Progress` 字段。

实际数据格式（分隔用换行）:
    [04/17] Testing is in progress...
    [04/10] The request ticket has been issued...
    （3.20）稳定性测试中。
    [01/16/2026] Order placed...

每个块 = 日期头 [MM/DD] (或 [M/D] / [MM/DD/YYYY] / （MM.DD） 等) + 正文。
块之间以换行分隔，有时是一段连续文本（多换行）。

本模块只做纯字符串解析，不涉及 I/O。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

# 日期头：支持 [...] / (...) / （...）作为括号；日期分隔支持 / 和 .
# 允许 MM/DD、M/D、MM/DD/YYYY
_DATE_HEAD = re.compile(
    r"[\[\(（]\s*(?P<m>\d{1,2})[./](?P<d>\d{1,2})(?:[./](?P<y>\d{2,4}))?\s*[\]\)）】]"
)

# 用于在多行文本里切分 —— 每遇到行首日期头就切
_SPLIT_DATE_HEAD = re.compile(
    r"(?m)^\s*[\[\(（]\s*\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\s*[\]\)）】]"
)


@dataclass
class ProgressBlock:
    """一条 Progress 记录（解析结果）。"""

    month: int  # 1-12
    day: int  # 1-31
    year: Optional[int]  # 四位年份；xlsx 常缺省
    body: str  # 去掉日期头后的正文（可多行）

    @property
    def head_key(self) -> str:
        """用于 Notion heading，稳定形如 '[MM/DD]' 或 '[MM/DD/YYYY]'。"""
        if self.year is not None:
            return f"[{self.month:02d}/{self.day:02d}/{self.year}]"
        return f"[{self.month:02d}/{self.day:02d}]"


def parse_progress(raw: Optional[str]) -> List[ProgressBlock]:
    """把 Progress 原文切分成有序的 [ProgressBlock]。

    返回顺序即原文顺序（Evelyn 邮件里最新在最前）。

    非字符串 / 空 / "-" / "/" 返回 []。
    若原文中没有任何日期头，整段文本作为 body 返回（month=0, day=0）—— 调用方可忽略这种块。
    """
    if raw is None:
        return []
    text = str(raw).strip()
    if not text or text in {"-", "/"}:
        return []

    # 用 finditer 逐段切
    matches = list(_SPLIT_DATE_HEAD.finditer(text))
    blocks: List[ProgressBlock] = []

    if not matches:
        # 无日期头：整段视作一块（body 保留）。调用方可按需过滤掉这种。
        return [ProgressBlock(month=0, day=0, year=None, body=text)]

    for i, m in enumerate(matches):
        head_match = _DATE_HEAD.search(m.group())
        if not head_match:
            continue
        mo = int(head_match.group("m"))
        dy = int(head_match.group("d"))
        yr_raw = head_match.group("y")
        yr: Optional[int] = None
        if yr_raw:
            y = int(yr_raw)
            yr = y + 2000 if y < 100 else y

        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if not _valid_date(mo, dy):
            continue
        blocks.append(ProgressBlock(month=mo, day=dy, year=yr, body=body))

    return blocks


def _valid_date(m: int, d: int) -> bool:
    return 1 <= m <= 12 and 1 <= d <= 31


def iso_week_of(dt: date) -> str:
    """返回 ISO week 字符串，形如 `2026-W17`。"""
    year, week, _ = dt.isocalendar()
    return f"{year}-W{week:02d}"


def iso_week_range(iso_week: str) -> Tuple[date, date]:
    """把 `YYYY-WXX` 解成该周的起止日期（Mon ~ Sun，含两端）。"""
    if not re.match(r"^\d{4}-W\d{2}$", iso_week):
        raise ValueError(f"bad iso week: {iso_week}")
    y = int(iso_week[:4])
    w = int(iso_week[-2:])
    # ISO week day 1 = Monday
    monday = datetime.strptime(f"{y}-W{w:02d}-1", "%G-W%V-%u").date()
    return monday, monday + timedelta(days=6)


def assign_years_descending(
    blocks: List[ProgressBlock], reference_date: date
) -> None:
    """按 xlsx 出现顺序（最新在前）给缺省年份的块推断年份，保证时间单调递减。

    xlsx 维护者通常把最新进度放最前。所以当遇到只有 MM/DD 的块时：
      - 第一个块（最上）：用 reference_date.year；若推出的日期 > ref + 7d，年份 -1
      - 之后的块：年份不能让该块日期 > 上一个块日期；若大于则 -1 继续试
    这样保证同一项目的历史块严格时间倒序。

    原地修改 blocks（给 `b.year` 赋值）。已经有 year 的块不动。
    """
    prev_d: Optional[date] = None
    for b in blocks:
        if b.month == 0:
            continue
        if b.year is not None:
            try:
                prev_d = date(b.year, b.month, b.day)
            except ValueError:
                prev_d = None
            continue

        # 无年份：初始候选年
        if prev_d is None:
            y = reference_date.year
            try:
                cand = date(y, b.month, b.day)
            except ValueError:
                continue
            if cand > reference_date + timedelta(days=7):
                y -= 1
                try:
                    cand = date(y, b.month, b.day)
                except ValueError:
                    continue
        else:
            y = prev_d.year
            try:
                cand = date(y, b.month, b.day)
            except ValueError:
                continue
            # 必须 ≤ prev_d；不满足就往前回溯
            while cand > prev_d:
                y -= 1
                if y < 1970 or reference_date.year - y > 20:
                    # 保险：防止无限回溯
                    break
                try:
                    cand = date(y, b.month, b.day)
                except ValueError:
                    break
        b.year = y
        prev_d = cand


def pick_this_week(
    blocks: List[ProgressBlock], reference_date: date
) -> List[ProgressBlock]:
    """从 blocks 中挑日期落在 reference_date 所在 ISO 周的。

    xlsx 里的日期多数缺省年份。策略：
      - 有年份：用原年份
      - 无年份：默认为 reference_date 的年份；若推出的日期 > reference_date + 7 天，
        说明跨年（如 1 月的邮件提到了 12 月的旧块），把年份 -1 再判

    若没有命中的块，返回 []。调用方可 fallback 到首块（blocks[0]）。

    **前置**：blocks 应已调用 `assign_years_descending` 推断年份；
    但若 block.year 仍为 None 会就近推断一次（不修改原 blocks）。
    """
    monday, sunday = iso_week_range(iso_week_of(reference_date))
    picked: List[ProgressBlock] = []
    for b in blocks:
        if b.month == 0:
            continue
        y = b.year if b.year is not None else reference_date.year
        try:
            block_date = date(y, b.month, b.day)
        except ValueError:
            continue
        if b.year is None and block_date > reference_date + timedelta(days=7):
            try:
                block_date = date(y - 1, b.month, b.day)
            except ValueError:
                continue
        if monday <= block_date <= sunday:
            picked.append(b)
    return picked


def format_block_markdown(block: ProgressBlock, week_tag: str) -> str:
    """生成一个 progress 块的 markdown 片段:

        ### 2026-W17 [04/17]

        body text

    """
    body = block.body.strip() if block.body else "_(无说明)_"
    head = f"{week_tag} {block.head_key}"
    return f"### {head}\n\n{body}\n"


def format_all_history_markdown(
    blocks: List[ProgressBlock], reference_date: date
) -> str:
    """首次创建页面时一次性把全部历史块渲染为 markdown。

    **前置**：blocks 应已调用 `assign_years_descending(blocks, ref)` 推断年份，
    这样 heading 的 ISO 周 tag 才准确。未推断的块会按 reference_date 年兜底。
    保持 xlsx 原顺序（最新在前）。
    """
    parts: List[str] = []
    for b in blocks:
        if b.month == 0:
            body = b.body.strip()
            if body:
                parts.append(body + "\n")
            continue
        y = b.year if b.year is not None else reference_date.year
        try:
            bd = date(y, b.month, b.day)
        except ValueError:
            continue
        parts.append(format_block_markdown(b, iso_week_of(bd)))
    return "\n".join(parts).strip()
