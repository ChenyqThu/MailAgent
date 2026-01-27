#!/usr/bin/env python3
"""清理 Notion 数据库中重复的 Message ID，保留最早创建的页面

用法:
    python3 scripts/cleanup_duplicate_message_ids.py          # 交互模式，需确认
    python3 scripts/cleanup_duplicate_message_ids.py --yes    # 跳过确认，直接执行
"""

import sys
import asyncio
from pathlib import Path
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

from notion_client import AsyncClient
from src.config import config


async def get_all_pages(client: AsyncClient, database_id: str):
    """获取数据库中所有页面（处理分页）"""
    all_pages = []
    has_more = True
    start_cursor = None

    while has_more:
        query_params = {"database_id": database_id, "page_size": 100}
        if start_cursor:
            query_params["start_cursor"] = start_cursor

        response = await client.databases.query(**query_params)
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


async def main():
    print("=" * 70)
    print("Notion 数据库重复 Message ID 清理")
    print("=" * 70)
    print(f"Database ID: {config.email_database_id}")
    print()

    client = AsyncClient(auth=config.notion_token)

    # 获取所有页面
    print("正在获取所有页面...")
    pages = await get_all_pages(client, config.email_database_id)

    # 收集 Message ID 信息
    message_id_map = defaultdict(list)  # message_id -> [page_info, ...]

    for page in pages:
        info = extract_page_info(page)
        if info["message_id"]:
            message_id_map[info["message_id"]].append(info)

    # 找出重复的
    duplicates = {mid: entries for mid, entries in message_id_map.items() if len(entries) > 1}

    if not duplicates:
        print("\n✅ 没有发现重复的 Message ID，无需清理!")
        return

    # 统计
    total_duplicates = len(duplicates)
    total_to_delete = sum(len(entries) - 1 for entries in duplicates.values())

    print()
    print("=" * 70)
    print("清理计划")
    print("=" * 70)
    print(f"重复的 Message ID 数: {total_duplicates}")
    print(f"需要删除的页面数: {total_to_delete}")
    print()

    # 确认
    auto_confirm = "--yes" in sys.argv or "-y" in sys.argv
    if auto_confirm:
        print("已通过 --yes 参数自动确认")
    else:
        confirm = input("确认要删除这些重复页面吗？(输入 'yes' 确认): ")
        if confirm.lower() != 'yes':
            print("已取消操作")
            return

    print()
    print("=" * 70)
    print("开始清理...")
    print("=" * 70)

    deleted_count = 0
    failed_count = 0

    for i, (message_id, entries) in enumerate(duplicates.items(), 1):
        # 按创建时间排序，保留最早的
        sorted_entries = sorted(entries, key=lambda x: x["created_time"])
        keep = sorted_entries[0]
        to_delete = sorted_entries[1:]

        print(f"\n[{i}/{total_duplicates}] Message ID: {message_id[:50]}...")
        print(f"  保留: {keep['title'][:40]}... (创建于 {keep['created_time'][:19]})")

        for entry in to_delete:
            print(f"  删除: {entry['title'][:40]}... (创建于 {entry['created_time'][:19]})")
            success = await archive_page(client, entry["page_id"])
            if success:
                deleted_count += 1
            else:
                failed_count += 1

            # 避免请求过快
            await asyncio.sleep(0.3)

    print()
    print("=" * 70)
    print("清理完成")
    print("=" * 70)
    print(f"成功删除: {deleted_count} 个页面")
    print(f"删除失败: {failed_count} 个页面")
    print(f"保留页面: {total_duplicates} 个")


if __name__ == "__main__":
    asyncio.run(main())
