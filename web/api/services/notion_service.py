"""Notion 正文读取服务。按需从 Notion API 获取邮件页面 blocks。"""

from __future__ import annotations

from typing import Optional

from notion_client import AsyncClient
from loguru import logger

from web.api.config import web_config

_client: Optional[AsyncClient] = None


def _get_client() -> AsyncClient:
    global _client
    if _client is None:
        _client = AsyncClient(auth=web_config.notion_token)
    return _client


class NotionBodyError(Exception):
    """Notion 正文获取失败。让调用方区分『正文真为空』和『API/权限错误』。"""


async def get_page_body(page_id: str) -> str:
    """获取 Notion 页面正文，转为 HTML 返回。

    - 正文真为空 → 返回 ""
    - API 错误/权限问题/页面不存在 → raise NotionBodyError
    """
    client = _get_client()
    html_parts: list[str] = []

    try:
        cursor = None
        while True:
            resp = await client.blocks.children.list(
                block_id=page_id,
                start_cursor=cursor,
                page_size=100,
            )
            for block in resp["results"]:
                html = _block_to_html(block)
                if html:
                    html_parts.append(html)
            if not resp.get("has_more"):
                break
            cursor = resp.get("next_cursor")
    except Exception as e:
        logger.warning(f"[notion-body] Failed to fetch page {page_id}: {e}")
        raise NotionBodyError(str(e)) from e

    return "\n".join(html_parts)


def _rich_text_to_html(rich_text: list[dict]) -> str:
    """将 Notion rich_text 数组转为 HTML，保留 bold/italic/code/link 等格式。"""
    parts: list[str] = []
    for rt in rich_text:
        text = _escape_html(rt.get("plain_text", ""))
        if not text:
            continue
        annotations = rt.get("annotations", {})
        href = rt.get("href") or (rt.get("text", {}) or {}).get("link", {}) or {}
        if isinstance(href, dict):
            href = href.get("url")

        if annotations.get("code"):
            text = f"<code>{text}</code>"
        if annotations.get("bold"):
            text = f"<strong>{text}</strong>"
        if annotations.get("italic"):
            text = f"<em>{text}</em>"
        if annotations.get("strikethrough"):
            text = f"<s>{text}</s>"
        if href:
            text = f'<a href="{_escape_attr(href)}" target="_blank" rel="noopener">{text}</a>'
        parts.append(text)
    return "".join(parts)


def _escape_html(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _get_image_url(type_data: dict) -> str | None:
    """从 image block 提取 URL（file 或 external）。"""
    if type_data.get("type") == "file":
        return type_data.get("file", {}).get("url")
    if type_data.get("type") == "external":
        return type_data.get("external", {}).get("url")
    return None


def _block_to_html(block: dict) -> str:
    """将 Notion block 转为 HTML 片段。"""
    block_type = block.get("type", "")
    type_data = block.get(block_type, {})

    rich_text = type_data.get("rich_text", [])
    if rich_text:
        html = _rich_text_to_html(rich_text)
        if block_type == "heading_1":
            return f"<h1>{html}</h1>"
        if block_type == "heading_2":
            return f"<h2>{html}</h2>"
        if block_type == "heading_3":
            return f"<h3>{html}</h3>"
        if block_type == "bulleted_list_item":
            return f"<li>{html}</li>"
        if block_type == "numbered_list_item":
            return f"<li>{html}</li>"
        if block_type == "quote":
            return f"<blockquote>{html}</blockquote>"
        if block_type == "code":
            lang = type_data.get("language", "")
            cls = f' class="language-{_escape_attr(lang)}"' if lang else ""
            return f"<pre><code{cls}>{html}</code></pre>"
        return f"<p>{html}</p>"

    if block_type == "divider":
        return "<hr/>"

    if block_type == "image":
        url = _get_image_url(type_data)
        caption = type_data.get("caption", [])
        cap_html = _rich_text_to_html(caption) if caption else ""
        if url:
            img = f'<img src="{_escape_attr(url)}" alt="{_escape_html(cap_html)}" style="max-width:100%"/>'
            if cap_html:
                return f"<figure>{img}<figcaption>{cap_html}</figcaption></figure>"
            return img
        return f"<p>[图片]</p>"

    if block_type == "file":
        file_data = type_data.get("file", {}) or type_data.get("external", {})
        url = file_data.get("url", "")
        caption = type_data.get("caption", [])
        cap_text = _rich_text_to_html(caption) if caption else "附件"
        if url:
            return f'<p><a href="{_escape_attr(url)}" target="_blank" rel="noopener">[附件] {cap_text}</a></p>'
        return f"<p>[附件] {cap_text}</p>"

    if block_type == "table":
        return "<p>[表格]</p>"

    return ""
