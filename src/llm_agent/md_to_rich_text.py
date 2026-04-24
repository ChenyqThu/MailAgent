"""Markdown inline → Notion rich_text JSON array.

Handles: **bold**, *italic* or _italic_, ~~strike~~, `code`, [text](url), line breaks.

Notion rich_text properties store INLINE content only — no real headings,
lists, or code blocks. We model Markdown list syntax as plain-text prefixes
("- ", "1. ") kept verbatim on the line. Each output text item is capped at
Notion's 2000-char rich_text segment limit.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional


_SEG_LIMIT = 1900  # keep headroom below Notion's 2000 rich_text content limit

# Ordered by decreasing specificity so the scanner prefers the longest match.
_TOKEN_RE = re.compile(
    r"(?P<b>\*\*(?P<b_t>[^*\n][^*]*?)\*\*)"
    r"|(?P<s>~~(?P<s_t>[^~\n][^~]*?)~~)"
    r"|(?P<c>`(?P<c_t>[^`\n]+?)`)"
    r"|(?P<lnk>\[(?P<lnk_t>[^\]\n]+?)\]\((?P<lnk_u>[^)\s]+?)\))"
    r"|(?P<i1>\*(?P<i1_t>[^*\n]+?)\*)"
    r"|(?P<i2>_(?P<i2_t>[^_\n]+?)_)"
)


def _text_item(
    content: str,
    *,
    bold: bool = False,
    italic: bool = False,
    strikethrough: bool = False,
    code: bool = False,
    link: Optional[str] = None,
) -> Dict:
    text_obj: Dict = {"content": content}
    if link:
        text_obj["link"] = {"url": link}
    item: Dict = {"type": "text", "text": text_obj}
    ann: Dict = {}
    if bold:
        ann["bold"] = True
    if italic:
        ann["italic"] = True
    if strikethrough:
        ann["strikethrough"] = True
    if code:
        ann["code"] = True
    if ann:
        item["annotations"] = ann
    return item


def _split_long(content: str) -> List[str]:
    """Split long plain-text content along newlines, fallback to hard cut."""
    if len(content) <= _SEG_LIMIT:
        return [content]
    parts: List[str] = []
    remaining = content
    while len(remaining) > _SEG_LIMIT:
        # prefer cutting at a newline
        cut = remaining.rfind("\n", 0, _SEG_LIMIT)
        if cut <= 0:
            cut = _SEG_LIMIT
        parts.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        parts.append(remaining)
    return parts


def _emit_plain(out: List[Dict], text: str) -> None:
    if not text:
        return
    for chunk in _split_long(text):
        out.append(_text_item(chunk))


def md_to_rich_text(md: str) -> List[Dict]:
    """Convert a Markdown snippet (inline + \\n) to Notion rich_text array.

    Empty input → empty list.
    """
    if not md:
        return []

    out: List[Dict] = []
    pos = 0
    for m in _TOKEN_RE.finditer(md):
        if m.start() > pos:
            _emit_plain(out, md[pos : m.start()])

        if m.group("b") is not None:
            out.append(_text_item(m.group("b_t"), bold=True))
        elif m.group("s") is not None:
            out.append(_text_item(m.group("s_t"), strikethrough=True))
        elif m.group("c") is not None:
            out.append(_text_item(m.group("c_t"), code=True))
        elif m.group("lnk") is not None:
            out.append(
                _text_item(m.group("lnk_t"), link=m.group("lnk_u"))
            )
        elif m.group("i1") is not None:
            out.append(_text_item(m.group("i1_t"), italic=True))
        elif m.group("i2") is not None:
            out.append(_text_item(m.group("i2_t"), italic=True))

        pos = m.end()

    if pos < len(md):
        _emit_plain(out, md[pos:])

    return out
