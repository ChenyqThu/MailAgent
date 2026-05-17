#!/usr/bin/env python3
"""
清理 Notion 数据库中重复的 Message ID: import-only module。

DEPRECATED entry-point. Use 'mailagent admin cleanup-duplicates' instead.

CLI 调用的导出: get_all_pages / extract_page_info / archive_page
"""

from notion_client import AsyncClient


async def get_all_pages(client: AsyncClient, database_id: str):
    """获取数据库中所有页面（处理分页）"""
    all_pages = []
    has_more = True
    start_cursor = None

    # Resolve data_source_id
    db_info = await client.databases.retrieve(database_id)
    data_source_id = db_info["data_sources"][0]["id"]

    while has_more:
        query_params = {"data_source_id": data_source_id, "page_size": 100}
        if start_cursor:
            query_params["start_cursor"] = start_cursor

        response = await client.data_sources.query(**query_params)
        all_pages.extend(response.get("results", []))

        has_more = response.get("has_more", False)
        start_cursor = response.get("next_cursor")

        print(f"已获取 {len(all_pages)} 条记录...", end="\r")

    print(f"共获取 {len(all_pages)} 条记录         ")
    return all_pages


def extract_page_info(page: dict) -> dict:
    """从页面中提取关键信息"""
    properties = page.get("properties", {})

    # 提取 Message ID
    message_id_prop = properties.get("Message ID", {})
    message_id = None
    if message_id_prop.get("type") == "rich_text":
        rich_text = message_id_prop.get("rich_text", [])
        if rich_text:
            message_id = rich_text[0].get("plain_text", "")

    # 提取标题 (Subject)
    title_prop = properties.get("Subject", {})
    title = ""
    if title_prop.get("type") == "title":
        title_list = title_prop.get("title", [])
        if title_list:
            title = title_list[0].get("plain_text", "")

    # 提取创建时间
    created_time = page.get("created_time", "")

    return {
        "page_id": page["id"],
        "message_id": message_id,
        "title": title,
        "created_time": created_time,
        "url": page.get("url", "")
    }


async def archive_page(client: AsyncClient, page_id: str) -> bool:
    """归档（删除）页面"""
    try:
        await client.pages.update(page_id=page_id, archived=True)
        return True
    except Exception as e:
        print(f"  ❌ 归档失败 {page_id}: {e}")
        return False

