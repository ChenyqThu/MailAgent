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
        from src.config import config
        _client = AsyncClient(auth=config.notion_token)
    return _client


async def get_page_body(page_id: str) -> str:
    """获取 Notion 页面正文，转为纯文本返回。"""
    client = _get_client()
    blocks_text: list[str] = []

    try:
        cursor = None
        while True:
            resp = await client.blocks.children.list(
                block_id=page_id,
                start_cursor=cursor,
                page_size=100,
            )
            for block in resp["results"]:
                text = _extract_block_text(block)
                if text:
                    blocks_text.append(text)
            if not resp.get("has_more"):
                break
            cursor = resp.get("next_cursor")
    except Exception as e:
        logger.warning(f"[notion-body] Failed to fetch page {page_id}: {e}")
        return ""

    return "\n".join(blocks_text)


def _extract_block_text(block: dict) -> str:
    """从 Notion block 提取纯文本。"""
    block_type = block.get("type", "")
    type_data = block.get(block_type, {})

    # 大多数文本 block 有 rich_text 数组
    rich_text = type_data.get("rich_text", [])
    if rich_text:
        text = "".join(rt.get("plain_text", "") for rt in rich_text)
        # 处理标题
        if block_type.startswith("heading"):
            return f"\n{text}\n"
        return text

    # 特殊类型
    if block_type == "divider":
        return "---"
    if block_type == "image":
        caption = type_data.get("caption", [])
        cap_text = "".join(rt.get("plain_text", "") for rt in caption)
        return f"[图片]{f': {cap_text}' if cap_text else ''}"
    if block_type == "file":
        caption = type_data.get("caption", [])
        cap_text = "".join(rt.get("plain_text", "") for rt in caption)
        return f"[附件]{f': {cap_text}' if cap_text else ''}"
    if block_type == "table":
        return "[表格]"

    return ""
