#!/usr/bin/env python3
"""
检查缺失 Row ID 或 Conversation ID 的邮件
"""

import asyncio
import json
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import config


class Colors:
    GREEN = '\033[92m'
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'


async def main():
    from notion_client import AsyncClient
    client = AsyncClient(auth=config.notion_token)

    # 查询没有 Row ID 或 Conversation ID 的邮件
    print(f"{Colors.BOLD}查询缺失 Row ID 或 Conversation ID 的邮件...{Colors.ENDC}\n")

    missing_pages = []

    # 查询 Row ID 为空的
    has_more = True
    start_cursor = None

    while has_more:
        query_params = {
            "database_id": config.email_database_id,
            "filter": {
                "or": [
                    {"property": "Row ID", "number": {"is_empty": True}},
                    {"property": "Conversation ID", "number": {"is_empty": True}}
                ]
            },
            "page_size": 100
        }
        if start_cursor:
            query_params["start_cursor"] = start_cursor

        results = await client.databases.query(**query_params)

        for page in results.get("results", []):
            props = page.get("properties", {})

            # 提取信息
            row_id = props.get("Row ID", {}).get("number")
            conv_id = props.get("Conversation ID", {}).get("number")

            subj_texts = props.get("Subject", {}).get("title", [])
            subject = subj_texts[0].get("text", {}).get("content", "") if subj_texts else ""

            msg_id_texts = props.get("Message ID", {}).get("rich_text", [])
            message_id = msg_id_texts[0].get("text", {}).get("content", "") if msg_id_texts else ""

            date_val = props.get("Date", {}).get("date", {})
            date_str = date_val.get("start", "") if date_val else ""

            sender = props.get("From", {}).get("email", "")

            created_time = page.get("created_time", "")

            missing_pages.append({
                "page_id": page["id"],
                "subject": subject,
                "message_id": message_id,
                "date": date_str,
                "sender": sender,
                "row_id": row_id,
                "conv_id": conv_id,
                "created_time": created_time
            })

        has_more = results.get("has_more", False)
        start_cursor = results.get("next_cursor")

    print(f"共找到 {len(missing_pages)} 封缺失 ID 的邮件\n")
    print("=" * 80)

    # 加载 AppleScript 缓存
    cache_file = Path(__file__).parent.parent / "data" / "applescript_cache.json"
    as_cache = {}
    if cache_file.exists():
        with open(cache_file, 'r', encoding='utf-8') as f:
            as_cache = json.load(f)
        print(f"AppleScript 缓存: {len(as_cache)} 封邮件")

        # 获取缓存的日期范围
        dates = []
        for email in as_cache.values():
            date_str = email.get('date_received', '')
            if date_str:
                dates.append(date_str[:10])
        if dates:
            print(f"缓存日期范围: {min(dates)} ~ {max(dates)}")

    print("=" * 80 + "\n")

    # 分析每封邮件
    for i, page in enumerate(missing_pages, 1):
        print(f"{Colors.BOLD}[{i}/{len(missing_pages)}]{Colors.ENDC}")
        print(f"  主题: {page['subject'][:60]}{'...' if len(page['subject']) > 60 else ''}")
        print(f"  发件人: {page['sender']}")
        print(f"  日期: {page['date']}")
        print(f"  Message ID: {page['message_id'][:50]}{'...' if len(page['message_id']) > 50 else ''}")
        print(f"  Row ID: {page['row_id']}, Conversation ID: {page['conv_id']}")
        print(f"  创建时间: {page['created_time']}")

        # 分析原因
        reasons = []

        # 1. 检查是否在 AppleScript 缓存中
        if page['message_id'] and page['message_id'] in as_cache:
            reasons.append(f"{Colors.GREEN}✓ 在 AppleScript 缓存中{Colors.ENDC}")
        else:
            reasons.append(f"{Colors.RED}✗ 不在 AppleScript 缓存中{Colors.ENDC}")

            # 检查日期是否在缓存范围内
            if page['date']:
                page_date = page['date'][:10]
                if as_cache:
                    dates = [e.get('date_received', '')[:10] for e in as_cache.values() if e.get('date_received')]
                    if dates:
                        min_date, max_date = min(dates), max(dates)
                        if page_date < min_date:
                            reasons.append(f"{Colors.YELLOW}  → 日期 {page_date} 早于缓存范围 {min_date}{Colors.ENDC}")
                        elif page_date > max_date:
                            reasons.append(f"{Colors.YELLOW}  → 日期 {page_date} 晚于缓存范围 {max_date}{Colors.ENDC}")
                        else:
                            reasons.append(f"{Colors.YELLOW}  → 日期在缓存范围内但未找到匹配{Colors.ENDC}")

        # 2. 检查 Message ID 格式
        if not page['message_id']:
            reasons.append(f"{Colors.RED}✗ 没有 Message ID{Colors.ENDC}")
        elif '@' not in page['message_id']:
            reasons.append(f"{Colors.YELLOW}⚠ Message ID 格式异常 (无 @){Colors.ENDC}")

        # 3. 检查发件人
        if not page['sender']:
            reasons.append(f"{Colors.YELLOW}⚠ 没有发件人邮箱{Colors.ENDC}")

        for reason in reasons:
            print(f"  {reason}")

        print()

    # 统计
    print("=" * 80)
    print(f"{Colors.BOLD}统计分析:{Colors.ENDC}")

    in_cache = sum(1 for p in missing_pages if p['message_id'] in as_cache)
    no_msg_id = sum(1 for p in missing_pages if not p['message_id'])

    print(f"  在缓存中: {in_cache}")
    print(f"  不在缓存中: {len(missing_pages) - in_cache}")
    print(f"  无 Message ID: {no_msg_id}")

    # 按发件人域名分组
    domains = {}
    for p in missing_pages:
        sender = p['sender'] or ''
        if '@' in sender:
            domain = sender.split('@')[1]
        else:
            domain = '(无域名)'
        domains[domain] = domains.get(domain, 0) + 1

    print(f"\n  按发件人域名分组:")
    for domain, count in sorted(domains.items(), key=lambda x: -x[1]):
        print(f"    {domain}: {count}")


if __name__ == "__main__":
    asyncio.run(main())
