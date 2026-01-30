"""
批量修复 Notion 页面的 ID 字段

处理两种情况：
1. ID 为空的页面
2. ID 异常（> threshold）的页面

修复策略：
1. Query Notion 中 ID 为空或异常的页面
2. 用 message_id 通过 AppleScript 获取真实 internal_id
3. 更新 SyncStore 和 Notion

如果 AppleScript 获取失败（邮件已删除），则：
- 清空 Notion 中的 ID 字段
- 记录到 deleted_records 供查看

Usage:
    python3 scripts/backfill_notion_id.py [--dry-run] [--threshold N]

Options:
    --dry-run        只检查不实际更新
    --threshold N    判断异常 ID 的阈值（默认 100000）
"""

import sys
import asyncio
import argparse
import json
import subprocess
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

import sqlite3
from notion_client import AsyncClient
from src.config import config

RESULT_FILE = Path("data/backfill_notion_id_result.json")


class FetchResult:
    """AppleScript 查询结果"""
    def __init__(self, internal_id: int = None, not_found: bool = False, error: str = None):
        self.internal_id = internal_id
        self.not_found = not_found  # 明确找不到（邮件已删除）
        self.error = error  # 其他错误（超时等）


def get_internal_id_by_message_id(message_id: str, account_name: str) -> FetchResult:
    """通过 AppleScript 从 Mail.app 获取邮件的 internal_id

    Args:
        message_id: 邮件的 Message-ID
        account_name: Mail.app 账户名

    Returns:
        FetchResult:
            - internal_id: 成功时返回
            - not_found: True 表示邮件确实不存在（已删除）
            - error: 其他错误信息
    """
    escaped_id = message_id.replace('\\', '\\\\').replace('"', '\\"')

    script = f'''
    tell application "Mail"
        tell account "{account_name}"
            repeat with mbox in mailboxes
                try
                    set theMessage to first message of mbox whose message id is "{escaped_id}"
                    return id of theMessage
                end try
            end repeat
            return "NOT_FOUND"
        end tell
    end tell
    '''

    try:
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True,
            text=True,
            timeout=300  # 300 秒超时
        )
        output = result.stdout.strip()

        if output == "NOT_FOUND":
            return FetchResult(not_found=True)

        if not output:
            return FetchResult(error="Empty response")

        return FetchResult(internal_id=int(output))

    except subprocess.TimeoutExpired:
        return FetchResult(error="Timeout (300s)")
    except ValueError as e:
        return FetchResult(error=f"Invalid ID format: {e}")
    except Exception as e:
        return FetchResult(error=str(e))


async def query_notion_abnormal_pages(notion, database_id: str, threshold: int):
    """查询 Notion 中 ID 为空或异常的页面

    Returns:
        list of pages
    """
    pages = []

    # 查询 1: ID 为空
    print("  [1/2] 查询 ID 为空的页面...")
    has_more = True
    start_cursor = None
    while has_more:
        params = {
            "database_id": database_id,
            "filter": {"property": "ID", "number": {"is_empty": True}},
            "page_size": 100
        }
        if start_cursor:
            params["start_cursor"] = start_cursor
        result = await notion.databases.query(**params)
        for page in result["results"]:
            page["_issue_type"] = "empty"
        pages.extend(result["results"])
        has_more = result.get("has_more", False)
        start_cursor = result.get("next_cursor")
    print(f"    找到 {len(pages)} 个 ID 为空的页面")

    # 查询 2: ID > threshold
    print(f"  [2/2] 查询 ID > {threshold} 的页面...")
    abnormal_count = 0
    has_more = True
    start_cursor = None
    while has_more:
        params = {
            "database_id": database_id,
            "filter": {"property": "ID", "number": {"greater_than": threshold}},
            "page_size": 100
        }
        if start_cursor:
            params["start_cursor"] = start_cursor
        result = await notion.databases.query(**params)
        for page in result["results"]:
            page["_issue_type"] = "abnormal"
            abnormal_count += 1
        pages.extend(result["results"])
        has_more = result.get("has_more", False)
        start_cursor = result.get("next_cursor")
    print(f"    找到 {abnormal_count} 个 ID 异常的页面")

    return pages


async def main():
    parser = argparse.ArgumentParser(description="修复 Notion 页面 ID 字段")
    parser.add_argument("--dry-run", action="store_true", help="只检查不实际更新")
    parser.add_argument("--threshold", type=int, default=100000, help="异常 ID 阈值（默认 100000）")
    args = parser.parse_args()

    print("=" * 60)
    print("修复 Notion 页面 ID 字段")
    print("=" * 60)

    # 1. 查询 Notion 中异常页面
    print("\n[Step 1] 查询 Notion 中异常页面...")
    notion = AsyncClient(auth=config.notion_token)

    abnormal_pages = await query_notion_abnormal_pages(
        notion, config.email_database_id, args.threshold
    )

    print(f"\n  共找到 {len(abnormal_pages)} 个需要修复的页面")

    if not abnormal_pages:
        print("\n所有页面 ID 正常，无需修复")
        await notion.aclose()
        return

    # 2. 连接 SyncStore
    print("\n[Step 2] 连接 SyncStore...")
    conn = sqlite3.connect('data/sync_store.db')
    conn.row_factory = sqlite3.Row

    # 3. 逐个修复
    print(f"\n[Step 3] 修复页面...")
    if args.dry_run:
        print("  [DRY RUN] 只检查不实际更新\n")

    stats = {
        "total": len(abnormal_pages),
        "fixed": 0,
        "deleted": 0,
        "failed": 0,
        "skipped": 0
    }
    fixed_records = []
    deleted_records = []
    failed_records = []

    for i, page in enumerate(abnormal_pages, 1):
        props = page["properties"]
        page_id = page["id"]
        issue_type = page.get("_issue_type", "unknown")

        # 提取页面信息
        msg_id_items = props.get("Message ID", {}).get("rich_text", [])
        msg_id = msg_id_items[0].get("plain_text", "") if msg_id_items else ""
        subject_items = props.get("Subject", {}).get("title", [])
        subject = subject_items[0].get("plain_text", "N/A")[:50] if subject_items else "N/A"
        date_prop = props.get("Date", {}).get("date", {})
        date_str = (date_prop.get("start", "")[:10] if date_prop else "N/A")
        old_id = props.get("ID", {}).get("number")

        print(f"\n  [{i}/{len(abnormal_pages)}] {date_str} | {subject[:40]}")
        print(f"    Issue: {issue_type}, Old ID: {old_id}")

        if not msg_id:
            print(f"    ⚠ 无 Message ID，跳过")
            stats["skipped"] += 1
            continue

        # 通过 AppleScript 获取真实 internal_id
        print(f"    → 查询 Mail.app...")
        fetch_result = get_internal_id_by_message_id(msg_id, config.mail_account_name)

        if fetch_result.error:
            # 其他错误（超时等），不能确定邮件是否存在
            print(f"    ✗ 查询失败: {fetch_result.error}")
            stats["failed"] += 1
            failed_records.append({
                "page_id": page_id,
                "message_id": msg_id[:60],
                "subject": subject,
                "date": date_str,
                "old_id": old_id,
                "error": fetch_result.error
            })
            continue

        if fetch_result.not_found:
            # 明确找不到，邮件已删除
            print(f"    ✗ 邮件不存在（已删除）")
            stats["deleted"] += 1
            deleted_records.append({
                "page_id": page_id,
                "message_id": msg_id[:60],
                "subject": subject,
                "date": date_str,
                "old_id": old_id
            })

            if not args.dry_run:
                # 清空 Notion ID
                try:
                    await notion.pages.update(
                        page_id=page_id,
                        properties={"ID": {"number": None}}
                    )
                    print(f"    → Notion ID 已清空")
                except Exception as e:
                    print(f"    ✗ Notion 更新失败: {e}")

                # 标记 SyncStore 为 deleted
                try:
                    cursor = conn.cursor()
                    cursor.execute('''
                        UPDATE email_metadata
                        SET sync_status = 'deleted', updated_at = ?
                        WHERE message_id = ?
                    ''', (datetime.now().timestamp(), msg_id))
                    conn.commit()
                    print(f"    → SyncStore 已标记 deleted")
                except Exception as e:
                    print(f"    ⚠ SyncStore 更新失败: {e}")
            continue

        internal_id = fetch_result.internal_id

        # 验证获取到的 ID 是否合理
        if internal_id > args.threshold:
            print(f"    ⚠ 获取到的 ID 仍异常: {internal_id}，跳过")
            stats["failed"] += 1
            failed_records.append({
                "page_id": page_id,
                "message_id": msg_id[:60],
                "subject": subject,
                "date": date_str,
                "old_id": old_id,
                "new_id": internal_id,
                "error": "ID still abnormal"
            })
            continue

        print(f"    ✓ 获取到 internal_id: {internal_id}")

        if not args.dry_run:
            # 更新 SyncStore
            try:
                cursor = conn.cursor()
                cursor.execute('''
                    UPDATE email_metadata
                    SET internal_id = ?, updated_at = ?
                    WHERE message_id = ?
                ''', (internal_id, datetime.now().timestamp(), msg_id))
                conn.commit()
                print(f"    → SyncStore 已更新")
            except Exception as e:
                print(f"    ⚠ SyncStore 更新失败: {e}")

            # 更新 Notion
            try:
                await notion.pages.update(
                    page_id=page_id,
                    properties={"ID": {"number": internal_id}}
                )
                print(f"    → Notion 已更新")
            except Exception as e:
                print(f"    ✗ Notion 更新失败: {e}")
                stats["failed"] += 1
                failed_records.append({
                    "page_id": page_id,
                    "message_id": msg_id[:60],
                    "subject": subject,
                    "date": date_str,
                    "old_id": old_id,
                    "new_id": internal_id,
                    "error": str(e)
                })
                continue

        stats["fixed"] += 1
        fixed_records.append({
            "page_id": page_id,
            "message_id": msg_id[:60],
            "subject": subject,
            "date": date_str,
            "old_id": old_id,
            "new_id": internal_id
        })

    conn.close()
    await notion.aclose()

    # 保存结果
    result = {
        "timestamp": datetime.now().isoformat(),
        "threshold": args.threshold,
        "dry_run": args.dry_run,
        "stats": stats,
        "fixed_records": fixed_records,
        "deleted_records": deleted_records,
        "failed_records": failed_records,
    }
    RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(RESULT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 输出结果
    print(f"\n{'=' * 60}")
    print("完成!")
    print(f"{'=' * 60}")
    print(f"  总异常页面:     {stats['total']}")
    print(f"  已修复:         {stats['fixed']}")
    print(f"  邮件已删除:     {stats['deleted']}")
    print(f"  修复失败:       {stats['failed']}")
    print(f"  跳过:           {stats['skipped']}")

    if deleted_records:
        print(f"\n已删除邮件 ({len(deleted_records)} 条):")
        for r in deleted_records:
            print(f"  - {r['date']} | {r['subject']}")
            print(f"    Page: {r['page_id']}")

    print(f"\n详细结果已保存到: {RESULT_FILE}")


if __name__ == "__main__":
    asyncio.run(main())
