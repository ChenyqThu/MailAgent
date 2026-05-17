#!/usr/bin/env python3
"""
清理 SyncStore: import-only module。

DEPRECATED entry-point. Use 'mailagent admin cleanup-syncstore' instead.

CLI 调用的导出: show_stats / reset_sync_status
"""

from src.mail.sync_store import SyncStore


def show_stats(store: SyncStore):
    """显示当前统计"""
    stats = store.get_stats()
    total = stats.get('total_emails', 0)
    print("\n📊 当前 SyncStore 统计:")
    print(f"   总邮件数: {total}")
    print(f"   - 待同步 (pending): {stats.get('pending', 0)}")
    print(f"   - 已同步 (synced): {stats.get('synced', 0)}")
    print(f"   - 失败 (failed): {stats.get('failed', 0)}")
    print("   按邮箱:")
    for mailbox, count in stats.get('by_mailbox', {}).items():
        print(f"     - {mailbox}: {count}")
    return stats


def reset_sync_status(store: SyncStore, mailbox: str = None, auto_confirm: bool = False):
    """重置同步状态（synced/failed -> pending）"""
    conn = store._get_connection()
    cursor = conn.cursor()

    try:
        # 构建查询条件
        where_clause = "WHERE mailbox = ? AND sync_status != 'pending'" if mailbox else "WHERE sync_status != 'pending'"

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
            confirm = input("\n确认重置同步状态? (y/n): ")
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



