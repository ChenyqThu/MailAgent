#!/usr/bin/env python3
"""检查 Notion 数据库中重复的 Message ID"""

import sys
import asyncio
from pathlib import Path
from collections import defaultdict

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


def extract_message_id(page: dict) -> tuple[str | None, str, str]:
    """从页面中提取 Message ID 和标题"""
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

    # 提取日期
    date_prop = properties.get("Date", {})
    date = ""
    if date_prop.get("type") == "date" and date_prop.get("date"):
        date = date_prop.get("date", {}).get("start", "")

    return message_id, title, date


async def main():
    print("=" * 70)
    print("Notion 数据库 Message ID 重复检查")
    print("=" * 70)
    print(f"Database ID: {config.email_database_id}")
    print()

    client = AsyncClient(auth=config.notion_token)

    # 获取所有页面
    print("正在获取所有页面...")
    pages = await get_all_pages(client, config.email_database_id)

    # 收集 Message ID
    message_id_map = defaultdict(list)  # message_id -> [(page_id, title, date), ...]
    empty_message_id_count = 0

    for page in pages:
        page_id = page["id"]
        message_id, title, date = extract_message_id(page)

        if not message_id:
            empty_message_id_count += 1
            continue

        message_id_map[message_id].append({
            "page_id": page_id,
            "title": title,
            "date": date
        })

    # 找出重复的
    duplicates = {mid: entries for mid, entries in message_id_map.items() if len(entries) > 1}

    # 输出结果
    print()
    print("=" * 70)
    print("统计结果")
    print("=" * 70)
    print(f"总页面数: {len(pages)}")
    print(f"有效 Message ID 数: {len(message_id_map)}")
    print(f"空 Message ID 数: {empty_message_id_count}")
    print(f"重复的 Message ID 数: {len(duplicates)}")

    # 计算重复页面总数
    duplicate_page_count = sum(len(entries) for entries in duplicates.values())
    extra_pages = duplicate_page_count - len(duplicates)  # 减去每个重复组的一个"正确"页面
    print(f"因重复产生的额外页面数: {extra_pages}")

    if duplicates:
        print()
        print("=" * 70)
        print("重复详情")
        print("=" * 70)

        # 按重复次数排序
        sorted_duplicates = sorted(duplicates.items(), key=lambda x: len(x[1]), reverse=True)

        for i, (message_id, entries) in enumerate(sorted_duplicates[:50], 1):  # 只显示前50个
            print(f"\n{i}. Message ID: {message_id[:60]}{'...' if len(message_id) > 60 else ''}")
            print(f"   重复次数: {len(entries)}")
            for entry in entries:
                print(f"   - 标题: {entry['title'][:50]}{'...' if len(entry['title']) > 50 else ''}")
                print(f"     日期: {entry['date']}")
                print(f"     Page ID: {entry['page_id']}")

        if len(sorted_duplicates) > 50:
            print(f"\n... 还有 {len(sorted_duplicates) - 50} 个重复的 Message ID 未显示")
    else:
        print("\n✅ 没有发现重复的 Message ID!")

    return duplicates


if __name__ == "__main__":
    duplicates = asyncio.run(main())
