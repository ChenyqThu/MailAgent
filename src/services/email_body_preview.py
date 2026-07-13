"""Bounded email-body previews shared by serve-api read paths."""

from __future__ import annotations

from bs4 import BeautifulSoup, NavigableString, Tag


EMAIL_BODY_PREVIEW_THRESHOLD_BYTES = 256 * 1024
EMAIL_BODY_PREVIEW_CHARS = 64 * 1024
EMAIL_BODY_HTML_SOURCE_CHARS = 128 * 1024


def _append_within_budget(
    output: BeautifulSoup,
    target: Tag,
    source: Tag | BeautifulSoup,
    remaining: list[int],
) -> None:
    for child in source.contents:
        if remaining[0] <= 0:
            break
        if isinstance(child, NavigableString):
            text = str(child)
            target.append(NavigableString(text[: remaining[0]]))
            remaining[0] -= min(len(text), remaining[0])
            continue
        if not isinstance(child, Tag):
            continue
        clone = output.new_tag(child.name, attrs=dict(child.attrs))
        target.append(clone)
        _append_within_budget(output, clone, child, remaining)


def preview_html(html: str) -> str:
    """Repair a bounded prefix, then serialize balanced nodes within 64K text."""
    source = BeautifulSoup(html, "lxml")
    source_root = source.body or source
    output = BeautifulSoup("", "lxml")
    target = output.new_tag("body")
    output.append(target)
    _append_within_budget(output, target, source_root, [EMAIL_BODY_PREVIEW_CHARS])
    return "".join(str(node) for node in target.contents)
