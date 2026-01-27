#!/usr/bin/env python3
"""
清理 SyncStore 中的邮件

Usage:
    # 按邮箱保留指定数量
    python scripts/cleanup_syncstore.py --keep 1000 --mailbox 收件箱
    python scripts/cleanup_syncstore.py --keep 100 --mailbox 发件箱

    # 删除最早的 N 封（可指定邮箱）
    python scripts/cleanup_syncstore.py --delete 500
    python scripts/cleanup_syncstore.py --delete 500 --mailbox 收件箱

    # 重置所有同步状态（synced -> pending）
    python scripts/cleanup_syncstore.py --reset-status

    # 重置指定邮箱的同步状态
    python scripts/cleanup_syncstore.py --reset-status --mailbox 发件箱

    # 清空所有数据
    python scripts/cleanup_syncstore.py --clear-all
"""

import argparse
import sys
from pathlib import Path

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from src.mail.sync_store import SyncStore


def show_stats(store: SyncStore):
    """显示当前统计"""
    stats = store.get_stats()
    total = stats.get('total_emails', 0)
    print(f"\n📊 当前 SyncStore 统计:")
    print(f"   总邮件数: {total}")
    print(f"   - 待同步 (pending): {stats.get('pending', 0)}")
    print(f"   - 已同步 (synced): {stats.get('synced', 0)}")
    print(f"   - 失败 (failed): {stats.get('failed', 0)}")
    print(f"   按邮箱:")
    for mailbox, count in stats.get('by_mailbox', {}).items():
        print(f"     - {mailbox}: {count}")
    return stats


def get_mailbox_count(store: SyncStore, mailbox: str) -> int:
    """获取指定邮箱的邮件数量"""
    conn = store._get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT COUNT(*) FROM email_metadata WHERE mailbox = ?",
            (mailbox,)
        )
        return cursor.fetchone()[0]
    finally:
        conn.close()


def delete_oldest_emails(store: SyncStore, count: int, mailbox: str = None, auto_confirm: bool = False):
    """删除最早的邮件"""
    conn = store._get_connection()
    cursor = conn.cursor()

    try:
        # 构建查询条件
        where_clause = "WHERE mailbox = ?" if mailbox else ""
        params = [mailbox] if mailbox else []

        # 获取总数
        cursor.execute(f"SELECT COUNT(*) FROM email_metadata {where_clause}", params)
        total = cursor.fetchone()[0]

        if total == 0:
            mailbox_str = f" ({mailbox})" if mailbox else ""
            print(f"\n✅ 没有邮件{mailbox_str}，无需清理")
            return

        delete_count = min(count, total)
        mailbox_str = f" ({mailbox})" if mailbox else ""
        print(f"\n📝 将删除最早的 {delete_count} 封邮件{mailbox_str}")

        # 确认
        if not auto_confirm:
            confirm = input(f"\n确认删除 {delete_count} 封邮件? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消")
                return

        # 获取要删除的邮件
        cursor.execute(f"""
            SELECT message_id, subject, date_received, mailbox
            FROM email_metadata
            {where_clause}
            ORDER BY date_received ASC
            LIMIT ?
        """, params + [delete_count])

        to_delete = cursor.fetchall()

        print(f"\n🗑️ 正在删除 {len(to_delete)} 封邮件...")

        # 显示前5封
        print("\n   最早的 5 封:")
        for row in to_delete[:5]:
            date_str = (row['date_received'] or '')[:10]
            print(f"     - [{date_str}] [{row['mailbox']}] {(row['subject'] or '')[:35]}...")

        if len(to_delete) > 10:
            print(f"     ... (省略 {len(to_delete) - 10} 封)")

        if len(to_delete) > 5:
            print("\n   最后删除的 5 封:")
            for row in to_delete[-5:]:
                date_str = (row['date_received'] or '')[:10]
                print(f"     - [{date_str}] [{row['mailbox']}] {(row['subject'] or '')[:35]}...")

        # 执行删除
        message_ids = [row['message_id'] for row in to_delete]
        placeholders = ','.join('?' * len(message_ids))

        cursor.execute(f"""
            DELETE FROM email_metadata
            WHERE message_id IN ({placeholders})
        """, message_ids)

        cursor.execute(f"""
            DELETE FROM sync_failures
            WHERE message_id IN ({placeholders})
        """, message_ids)

        conn.commit()
        print(f"\n✅ 已删除 {len(message_ids)} 封邮件")

    except Exception as e:
        conn.rollback()
        print(f"\n❌ 删除失败: {e}")
        raise
    finally:
        conn.close()


def keep_newest_emails(store: SyncStore, keep_count: int, mailbox: str = None, auto_confirm: bool = False):
    """保留最新的 N 封邮件，删除其余的"""
    conn = store._get_connection()
    cursor = conn.cursor()

    try:
        # 构建查询条件
        where_clause = "WHERE mailbox = ?" if mailbox else ""
        params = [mailbox] if mailbox else []

        # 获取总数
        cursor.execute(f"SELECT COUNT(*) FROM email_metadata {where_clause}", params)
        total = cursor.fetchone()[0]

        if total == 0:
            mailbox_str = f" ({mailbox})" if mailbox else ""
            print(f"\n✅ 没有邮件{mailbox_str}，无需清理")
            return

        delete_count = max(0, total - keep_count)
        if delete_count == 0:
            mailbox_str = f" ({mailbox})" if mailbox else ""
            print(f"\n✅ 当前只有 {total} 封{mailbox_str}，小于等于要保留的 {keep_count} 封，无需删除")
            return

        mailbox_str = f" ({mailbox})" if mailbox else ""
        print(f"\n📝 将删除最早的 {delete_count} 封邮件{mailbox_str}，保留最新的 {keep_count} 封")

        # 调用删除函数
        delete_oldest_emails(store, delete_count, mailbox, auto_confirm)

    finally:
        conn.close()


def reset_sync_status(store: SyncStore, mailbox: str = None, auto_confirm: bool = False):
    """重置同步状态（synced/failed -> pending）"""
    conn = store._get_connection()
    cursor = conn.cursor()

    try:
        # 构建查询条件
        where_clause = "WHERE mailbox = ? AND sync_status != 'pending'" if mailbox else "WHERE sync_status != 'pending'"
        params = [mailbox] if mailbox else []

        # 获取将被重置的数量
        cursor.execute(f"""
            SELECT sync_status, COUNT(*) as count
            FROM email_metadata
            {where_clause.replace("AND sync_status != 'pending'", "") if mailbox else ""}
            GROUP BY sync_status
        """, [mailbox] if mailbox else [])

        status_counts = {row['sync_status']: row['count'] for row in cursor.fetchall()}
        synced_count = status_counts.get('synced', 0)
        failed_count = status_counts.get('failed', 0)
        total_reset = synced_count + failed_count

        if total_reset == 0:
            mailbox_str = f" ({mailbox})" if mailbox else ""
            print(f"\n✅ 没有需要重置的邮件{mailbox_str}")
            return

        mailbox_str = f" ({mailbox})" if mailbox else ""
        print(f"\n📝 将重置 {total_reset} 封邮件的同步状态{mailbox_str}")
        print(f"   - synced -> pending: {synced_count} 封")
        print(f"   - failed -> pending: {failed_count} 封")

        # 确认
        if not auto_confirm:
            confirm = input(f"\n确认重置同步状态? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消")
                return

        # 执行重置
        if mailbox:
            cursor.execute("""
                UPDATE email_metadata
                SET sync_status = 'pending',
                    notion_page_id = NULL,
                    notion_thread_id = NULL,
                    sync_error = NULL,
                    retry_count = 0
                WHERE mailbox = ? AND sync_status != 'pending'
            """, (mailbox,))
        else:
            cursor.execute("""
                UPDATE email_metadata
                SET sync_status = 'pending',
                    notion_page_id = NULL,
                    notion_thread_id = NULL,
                    sync_error = NULL,
                    retry_count = 0
                WHERE sync_status != 'pending'
            """)

        # 清空失败队列
        if mailbox:
            cursor.execute("""
                DELETE FROM sync_failures
                WHERE message_id IN (
                    SELECT message_id FROM email_metadata WHERE mailbox = ?
                )
            """, (mailbox,))
        else:
            cursor.execute("DELETE FROM sync_failures")

        conn.commit()
        print(f"\n✅ 已重置 {total_reset} 封邮件的同步状态为 pending")

    except Exception as e:
        conn.rollback()
        print(f"\n❌ 重置失败: {e}")
        raise
    finally:
        conn.close()


def clear_all(store: SyncStore, auto_confirm: bool = False):
    """清空所有数据"""
    stats = store.get_stats()
    total = stats.get('total_emails', 0)

    if total == 0:
        print("\n✅ SyncStore 已经是空的")
        return

    print(f"\n⚠️ 警告：将清空所有 {total} 封邮件和同步状态！")

    if not auto_confirm:
        confirm = input("\n确认清空所有数据? 请输入 'DELETE ALL' 确认: ")
        if confirm != 'DELETE ALL':
            print("已取消")
            return

    store.clear_all()
    print("\n✅ 已清空所有数据")


def main():
    parser = argparse.ArgumentParser(description="清理 SyncStore 中的邮件")

    # 操作类型
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--keep", type=int, help="保留最新的 N 封邮件")
    group.add_argument("--delete", type=int, help="删除最早的 N 封邮件")
    group.add_argument("--reset-status", action="store_true", help="重置同步状态 (synced/failed -> pending)")
    group.add_argument("--clear-all", action="store_true", help="清空所有数据")
    group.add_argument("--stats", action="store_true", help="仅显示统计信息")

    # 可选参数
    parser.add_argument("--mailbox", type=str, choices=["收件箱", "发件箱"], help="指定邮箱")
    parser.add_argument("--yes", "-y", action="store_true", help="跳过确认")

    args = parser.parse_args()

    store = SyncStore("data/sync_store.db")

    # 显示当前统计
    show_stats(store)

    if args.stats:
        return

    # 执行操作
    if args.keep:
        keep_newest_emails(store, args.keep, args.mailbox, args.yes)
    elif args.delete:
        delete_oldest_emails(store, args.delete, args.mailbox, args.yes)
    elif args.reset_status:
        reset_sync_status(store, args.mailbox, args.yes)
    elif args.clear_all:
        clear_all(store, args.yes)

    # 显示更新后的统计
    print("\n" + "=" * 50)
    show_stats(store)

    # 压缩数据库
    if not args.stats:
        print("\n🔧 压缩数据库...")
        store.vacuum()
        print("✅ 完成")


if __name__ == "__main__":
    main()

