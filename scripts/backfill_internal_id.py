"""
修复 SyncStore 中的异常 internal_id

两种模式：
1. 默认模式：查询 SyncStore 中 internal_id > threshold 的记录，
   通过 message_id 从 Mail.app 获取正确的 internal_id 并更新
2. --fix-metadata 模式：修复元数据混淆问题，用 internal_id
   从 Mail.app 重新获取正确的 subject/sender 等信息

Usage:
    python3 scripts/backfill_internal_id.py [--dry-run] [--threshold N]
    python3 scripts/backfill_internal_id.py --fix-metadata --ids 41407,41468

Options:
    --dry-run        只检查不实际更新
    --threshold N    判断异常 ID 的阈值（默认 42000）
    --fix-metadata   修复元数据模式（用 internal_id 重新获取信息）
    --ids            指定要修复的 internal_id 列表（逗号分隔）
"""

import sys
import argparse
import json
import subprocess
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))

import sqlite3
from src.config import config

RESULT_FILE = Path("data/backfill_internal_id_result.json")


class FetchResult:
    """AppleScript 查询结果"""
    def __init__(self, internal_id: int = None, not_found: bool = False, error: str = None, metadata: dict = None):
        self.internal_id = internal_id
        self.not_found = not_found
        self.error = error
        self.metadata = metadata  # 完整元数据


def get_internal_id_by_message_id(message_id: str, account_name: str) -> FetchResult:
    """通过 message_id 从 Mail.app 获取 internal_id"""
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
            timeout=300
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


def get_metadata_by_internal_id(internal_id: int, account_name: str) -> FetchResult:
    """通过 internal_id 从 Mail.app 获取完整元数据"""

    script = f'''
    tell application "Mail"
        tell account "{account_name}"
            repeat with mbox in mailboxes
                try
                    set theMessage to first message of mbox whose id is {internal_id}
                    set msgId to message id of theMessage
                    set msgSubject to subject of theMessage
                    set msgSender to sender of theMessage
                    set msgDate to date received of theMessage

                    -- 格式化日期
                    set dateStr to (year of msgDate as string) & "-"
                    set monthNum to (month of msgDate as integer)
                    if monthNum < 10 then set dateStr to dateStr & "0"
                    set dateStr to dateStr & (monthNum as string) & "-"
                    set dayNum to (day of msgDate as integer)
                    if dayNum < 10 then set dateStr to dateStr & "0"
                    set dateStr to dateStr & (dayNum as string) & "T"
                    set hourNum to (hours of msgDate as integer)
                    if hourNum < 10 then set dateStr to dateStr & "0"
                    set dateStr to dateStr & (hourNum as string) & ":"
                    set minuteNum to (minutes of msgDate as integer)
                    if minuteNum < 10 then set dateStr to dateStr & "0"
                    set dateStr to dateStr & (minuteNum as string) & ":"
                    set secondNum to (seconds of msgDate as integer)
                    if secondNum < 10 then set dateStr to dateStr & "0"
                    set dateStr to dateStr & (secondNum as string)

                    set mboxName to name of mbox

                    return msgId & "{{{{SEP}}}}" & msgSubject & "{{{{SEP}}}}" & msgSender & "{{{{SEP}}}}" & dateStr & "{{{{SEP}}}}" & mboxName
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
            timeout=60
        )
        output = result.stdout.strip()

        if output == "NOT_FOUND":
            return FetchResult(not_found=True)

        if not output:
            return FetchResult(error="Empty response")

        parts = output.split("{{SEP}}")
        if len(parts) < 5:
            return FetchResult(error=f"Invalid response format: {output[:100]}")

        return FetchResult(metadata={
            "message_id": parts[0],
            "subject": parts[1],
            "sender": parts[2],
            "date_received": parts[3],
            "mailbox": parts[4]
        })

    except subprocess.TimeoutExpired:
        return FetchResult(error="Timeout (60s)")
    except Exception as e:
        return FetchResult(error=str(e))


def fix_abnormal_ids(args):
    """修复异常 internal_id（默认模式）"""
    print("=" * 60)
    print("修复 SyncStore 异常 internal_id")
    print("=" * 60)

    # 连接 SyncStore
    conn = sqlite3.connect('data/sync_store.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 查询异常 ID 记录
    cursor.execute('''
        SELECT internal_id, message_id, subject, sender, mailbox, sync_status
        FROM email_metadata
        WHERE internal_id > ?
        ORDER BY internal_id
    ''', (args.threshold,))

    records = cursor.fetchall()
    print(f"\n找到 {len(records)} 条异常 ID 记录 (> {args.threshold})")

    if not records:
        print("\n✅ 无异常记录")
        conn.close()
        return

    if args.dry_run:
        print("\n[DRY RUN] 只检查不实际更新\n")

    stats = {"total": len(records), "fixed": 0, "deleted": 0, "failed": 0}
    fixed_records = []
    deleted_records = []
    failed_records = []

    for i, record in enumerate(records, 1):
        old_id = record["internal_id"]
        msg_id = record["message_id"]
        subject = (record["subject"] or "N/A")[:40]
        status = record["sync_status"]

        print(f"\n[{i}/{len(records)}] {subject}")
        print(f"  Old ID: {old_id}, Status: {status}")

        if not msg_id:
            print(f"  ⚠ 无 message_id，跳过")
            stats["failed"] += 1
            continue

        # 查询 Mail.app
        print(f"  → 查询 Mail.app...")
        fetch_result = get_internal_id_by_message_id(msg_id, config.mail_account_name)

        if fetch_result.error:
            print(f"  ✗ 查询失败: {fetch_result.error}")
            stats["failed"] += 1
            failed_records.append({
                "old_id": old_id,
                "message_id": msg_id[:60],
                "subject": subject,
                "error": fetch_result.error
            })
            continue

        if fetch_result.not_found:
            print(f"  ✗ 邮件不存在（已删除）")
            stats["deleted"] += 1
            deleted_records.append({
                "old_id": old_id,
                "message_id": msg_id[:60],
                "subject": subject
            })

            if not args.dry_run:
                cursor.execute('''
                    UPDATE email_metadata
                    SET sync_status = 'deleted', updated_at = ?
                    WHERE internal_id = ?
                ''', (datetime.now().timestamp(), old_id))
                conn.commit()
                print(f"  → SyncStore 已标记 deleted")
            continue

        new_id = fetch_result.internal_id

        # 检查新 ID 是否合理
        if new_id > args.threshold:
            print(f"  ⚠ 新 ID 仍异常: {new_id}，跳过")
            stats["failed"] += 1
            failed_records.append({
                "old_id": old_id,
                "new_id": new_id,
                "message_id": msg_id[:60],
                "subject": subject,
                "error": "New ID still abnormal"
            })
            continue

        # 检查新 ID 是否已被占用
        cursor.execute('SELECT message_id, subject FROM email_metadata WHERE internal_id = ?', (new_id,))
        existing = cursor.fetchone()
        if existing and existing["message_id"] != msg_id:
            print(f"  ⚠ ID {new_id} 已被占用: {(existing['subject'] or '')[:30]}")
            print(f"    → 当前邮件可能已删除，标记 deleted")
            stats["deleted"] += 1
            deleted_records.append({
                "old_id": old_id,
                "conflict_id": new_id,
                "message_id": msg_id[:60],
                "subject": subject
            })
            if not args.dry_run:
                cursor.execute('''
                    UPDATE email_metadata
                    SET sync_status = 'deleted', updated_at = ?
                    WHERE internal_id = ?
                ''', (datetime.now().timestamp(), old_id))
                conn.commit()
                print(f"  → SyncStore 已标记 deleted")
            continue

        print(f"  ✓ 新 ID: {new_id}")

        if not args.dry_run:
            try:
                cursor.execute('''
                    UPDATE email_metadata
                    SET internal_id = ?, updated_at = ?
                    WHERE internal_id = ?
                ''', (new_id, datetime.now().timestamp(), old_id))
                conn.commit()
                print(f"  → SyncStore 已更新")
            except sqlite3.IntegrityError:
                print(f"  ✗ 主键冲突，跳过")
                stats["failed"] += 1
                failed_records.append({
                    "old_id": old_id,
                    "new_id": new_id,
                    "message_id": msg_id[:60],
                    "subject": subject,
                    "error": "IntegrityError: duplicate internal_id"
                })
                continue

        stats["fixed"] += 1
        fixed_records.append({
            "old_id": old_id,
            "new_id": new_id,
            "message_id": msg_id[:60],
            "subject": subject
        })

    conn.close()

    # 保存结果
    result = {
        "timestamp": datetime.now().isoformat(),
        "mode": "fix_abnormal_ids",
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
    print(f"  总异常记录:   {stats['total']}")
    print(f"  已修复:       {stats['fixed']}")
    print(f"  邮件已删除:   {stats['deleted']}")
    print(f"  失败:         {stats['failed']}")
    print(f"\n详细结果已保存到: {RESULT_FILE}")


def fix_metadata(args):
    """修复元数据混淆（--fix-metadata 模式）"""
    print("=" * 60)
    print("修复 SyncStore 元数据混淆")
    print("=" * 60)

    if not args.ids:
        print("\n❌ 请指定 --ids 参数，如 --ids 41407,41468")
        return

    ids = [int(x.strip()) for x in args.ids.split(",")]
    print(f"\n要修复的 internal_id: {ids}")

    conn = sqlite3.connect('data/sync_store.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if args.dry_run:
        print("\n[DRY RUN] 只检查不实际更新\n")

    stats = {"total": len(ids), "fixed": 0, "failed": 0}
    fixed_records = []
    failed_records = []

    for i, internal_id in enumerate(ids, 1):
        # 获取当前 SyncStore 数据
        cursor.execute('''
            SELECT internal_id, message_id, subject, sender, mailbox, sync_status
            FROM email_metadata
            WHERE internal_id = ?
        ''', (internal_id,))
        record = cursor.fetchone()

        if not record:
            print(f"\n[{i}/{len(ids)}] internal_id={internal_id}")
            print(f"  ⚠ SyncStore 中不存在")
            stats["failed"] += 1
            continue

        old_subject = (record["subject"] or "N/A")[:40]
        old_sender = record["sender"] or "N/A"

        print(f"\n[{i}/{len(ids)}] internal_id={internal_id}")
        print(f"  当前: {old_subject}")
        print(f"  发件人: {old_sender}")

        # 从 Mail.app 获取正确元数据
        print(f"  → 查询 Mail.app...")
        fetch_result = get_metadata_by_internal_id(internal_id, config.mail_account_name)

        if fetch_result.error:
            print(f"  ✗ 查询失败: {fetch_result.error}")
            stats["failed"] += 1
            failed_records.append({
                "internal_id": internal_id,
                "error": fetch_result.error
            })
            continue

        if fetch_result.not_found:
            print(f"  ✗ 邮件不存在")
            stats["failed"] += 1
            failed_records.append({
                "internal_id": internal_id,
                "error": "Not found in Mail.app"
            })
            continue

        meta = fetch_result.metadata
        print(f"  ✓ Mail.app: {meta['subject'][:40]}")
        print(f"    发件人: {meta['sender']}")

        if not args.dry_run:
            cursor.execute('''
                UPDATE email_metadata
                SET message_id = ?, subject = ?, sender = ?,
                    date_received = ?, mailbox = ?, updated_at = ?
                WHERE internal_id = ?
            ''', (
                meta['message_id'],
                meta['subject'],
                meta['sender'],
                meta['date_received'],
                meta['mailbox'],
                datetime.now().timestamp(),
                internal_id
            ))
            conn.commit()
            print(f"  → SyncStore 已更新")

        stats["fixed"] += 1
        fixed_records.append({
            "internal_id": internal_id,
            "old_subject": old_subject,
            "old_sender": old_sender,
            "new_subject": meta['subject'][:50],
            "new_sender": meta['sender'],
            "new_message_id": meta['message_id'][:60]
        })

    conn.close()

    # 保存结果
    result = {
        "timestamp": datetime.now().isoformat(),
        "mode": "fix_metadata",
        "dry_run": args.dry_run,
        "stats": stats,
        "fixed_records": fixed_records,
        "failed_records": failed_records,
    }
    RESULT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(RESULT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 60}")
    print("完成!")
    print(f"{'=' * 60}")
    print(f"  总计:   {stats['total']}")
    print(f"  已修复: {stats['fixed']}")
    print(f"  失败:   {stats['failed']}")
    print(f"\n详细结果已保存到: {RESULT_FILE}")


def main():
    parser = argparse.ArgumentParser(description="修复 SyncStore 中的异常 internal_id")
    parser.add_argument("--dry-run", action="store_true", help="只检查不实际更新")
    parser.add_argument("--threshold", type=int, default=42000, help="异常 ID 阈值（默认 42000）")
    parser.add_argument("--fix-metadata", action="store_true", help="修复元数据混淆模式")
    parser.add_argument("--ids", type=str, help="指定要修复的 internal_id 列表（逗号分隔）")
    args = parser.parse_args()

    if args.fix_metadata:
        fix_metadata(args)
    else:
        fix_abnormal_ids(args)


if __name__ == "__main__":
    main()
