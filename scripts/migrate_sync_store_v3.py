"""
SyncStore v2 -> v3 迁移脚本

v3 架构变更：
- internal_id (SQLite ROWID = AppleScript id) 作为主键
- message_id 作为 UNIQUE 约束
- 合并 sync_failures 到 email_metadata
- 新增 next_retry_at 字段

迁移步骤：
1. 备份现有数据库
2. 检查当前版本
3. 创建新表结构
4. 迁移数据（为现有记录生成 internal_id）
5. 迁移 sync_failures 数据
6. 更新版本号
7. 清理旧表

Usage:
    python3 scripts/migrate_sync_store_v3.py [--db-path data/sync_store.db] [--dry-run]
"""

import argparse
import shutil
import sqlite3
import time
from datetime import datetime
from pathlib import Path

# 添加项目根目录到路径
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))


def get_connection(db_path: str) -> sqlite3.Connection:
    """获取数据库连接"""
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def check_current_version(conn: sqlite3.Connection) -> int:
    """检查当前数据库版本"""
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT value FROM sync_state WHERE key = 'db_version'")
        row = cursor.fetchone()
        return int(row['value']) if row else 1
    except sqlite3.Error:
        return 1


def backup_database(db_path: str) -> str:
    """备份数据库"""
    backup_path = f"{db_path}.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(db_path, backup_path)
    print(f"Database backed up to: {backup_path}")
    return backup_path


def check_table_structure(conn: sqlite3.Connection) -> dict:
    """检查表结构"""
    cursor = conn.cursor()
    result = {
        'has_email_metadata': False,
        'has_internal_id': False,
        'has_sync_failures': False,
        'has_next_retry_at': False,
        'email_count': 0,
        'failure_count': 0,
    }

    # 检查 email_metadata 表
    cursor.execute("""
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='email_metadata'
    """)
    if cursor.fetchone():
        result['has_email_metadata'] = True

        # 检查列
        cursor.execute("PRAGMA table_info(email_metadata)")
        columns = {row[1] for row in cursor.fetchall()}
        result['has_internal_id'] = 'internal_id' in columns
        result['has_next_retry_at'] = 'next_retry_at' in columns

        # 统计记录数
        cursor.execute("SELECT COUNT(*) FROM email_metadata")
        result['email_count'] = cursor.fetchone()[0]

    # 检查 sync_failures 表
    cursor.execute("""
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='sync_failures'
    """)
    if cursor.fetchone():
        result['has_sync_failures'] = True
        cursor.execute("SELECT COUNT(*) FROM sync_failures")
        result['failure_count'] = cursor.fetchone()[0]

    return result


def migrate_to_v3(conn: sqlite3.Connection, dry_run: bool = False):
    """执行 v3 迁移"""
    cursor = conn.cursor()

    print("\n=== Starting v3 migration ===")

    # 检查表结构
    structure = check_table_structure(conn)
    print(f"\nCurrent structure:")
    print(f"  - email_metadata table: {structure['has_email_metadata']}")
    print(f"  - internal_id column: {structure['has_internal_id']}")
    print(f"  - next_retry_at column: {structure['has_next_retry_at']}")
    print(f"  - sync_failures table: {structure['has_sync_failures']}")
    print(f"  - Email records: {structure['email_count']}")
    print(f"  - Failure records: {structure['failure_count']}")

    if structure['has_internal_id'] and structure['has_next_retry_at']:
        print("\nDatabase already migrated to v3!")
        return

    if dry_run:
        print("\n[DRY RUN] Would perform the following migrations:")

    # 步骤 1: 添加 internal_id 列（如果不存在）
    if not structure['has_internal_id'] and structure['has_email_metadata']:
        print("\n1. Adding internal_id column...")
        if not dry_run:
            # 创建新表
            cursor.execute("""
                CREATE TABLE email_metadata_new (
                    internal_id INTEGER PRIMARY KEY,
                    message_id TEXT UNIQUE,
                    thread_id TEXT,
                    subject TEXT,
                    sender TEXT,
                    sender_name TEXT,
                    to_addr TEXT,
                    cc_addr TEXT,
                    date_received TEXT,
                    mailbox TEXT,
                    is_read INTEGER DEFAULT 0,
                    is_flagged INTEGER DEFAULT 0,
                    sync_status TEXT DEFAULT 'pending',
                    notion_page_id TEXT,
                    notion_thread_id TEXT,
                    sync_error TEXT,
                    retry_count INTEGER DEFAULT 0,
                    next_retry_at REAL,
                    created_at REAL,
                    updated_at REAL
                )
            """)

            # 迁移数据（为每条记录生成 internal_id）
            cursor.execute("SELECT * FROM email_metadata")
            rows = cursor.fetchall()

            for row in rows:
                message_id = row['message_id']
                # 使用 message_id 的 hash 生成负数 internal_id
                internal_id = -abs(hash(message_id)) % 2147483647

                cursor.execute("""
                    INSERT INTO email_metadata_new
                    (internal_id, message_id, thread_id, subject, sender, sender_name,
                     to_addr, cc_addr, date_received, mailbox,
                     is_read, is_flagged, sync_status, notion_page_id,
                     notion_thread_id, sync_error, retry_count, next_retry_at,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    internal_id,
                    message_id,
                    row['thread_id'] if 'thread_id' in row.keys() else None,
                    row['subject'] if 'subject' in row.keys() else '',
                    row['sender'] if 'sender' in row.keys() else '',
                    row['sender_name'] if 'sender_name' in row.keys() else '',
                    row['to_addr'] if 'to_addr' in row.keys() else '',
                    row['cc_addr'] if 'cc_addr' in row.keys() else '',
                    row['date_received'] if 'date_received' in row.keys() else '',
                    row['mailbox'] if 'mailbox' in row.keys() else '收件箱',
                    row['is_read'] if 'is_read' in row.keys() else 0,
                    row['is_flagged'] if 'is_flagged' in row.keys() else 0,
                    row['sync_status'] if 'sync_status' in row.keys() else 'pending',
                    row['notion_page_id'] if 'notion_page_id' in row.keys() else None,
                    row['notion_thread_id'] if 'notion_thread_id' in row.keys() else None,
                    row['sync_error'] if 'sync_error' in row.keys() else None,
                    0,  # retry_count
                    None,  # next_retry_at
                    row['created_at'] if 'created_at' in row.keys() else time.time(),
                    row['updated_at'] if 'updated_at' in row.keys() else time.time()
                ))

            # 替换旧表
            cursor.execute("DROP TABLE email_metadata")
            cursor.execute("ALTER TABLE email_metadata_new RENAME TO email_metadata")

            print(f"   Migrated {len(rows)} email records")

    # 步骤 2: 迁移 sync_failures 数据
    if structure['has_sync_failures'] and structure['failure_count'] > 0:
        print("\n2. Migrating sync_failures to email_metadata...")
        if not dry_run:
            # 计算指数退避延迟
            delays = [60, 300, 900, 3600, 7200]
            now = time.time()

            cursor.execute("SELECT * FROM sync_failures")
            failures = cursor.fetchall()

            for failure in failures:
                message_id = failure['message_id']
                retry_count = failure['retry_count'] if 'retry_count' in failure.keys() else 0
                error = failure['error_message'] if 'error_message' in failure.keys() else 'Unknown error'

                # 计算下次重试时间
                delay = delays[min(retry_count, len(delays) - 1)]
                next_retry = now + delay

                # 更新 email_metadata
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'failed',
                        sync_error = ?,
                        retry_count = ?,
                        next_retry_at = ?,
                        updated_at = ?
                    WHERE message_id = ?
                """, (error, retry_count, next_retry, now, message_id))

            print(f"   Merged {len(failures)} failure records")

    # 步骤 3: 创建索引
    print("\n3. Creating indexes...")
    if not dry_run:
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_message_id
            ON email_metadata(message_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_thread
            ON email_metadata(thread_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_date
            ON email_metadata(date_received DESC)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_sync_status
            ON email_metadata(sync_status)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_mailbox
            ON email_metadata(mailbox)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_next_retry
            ON email_metadata(next_retry_at)
            WHERE sync_status IN ('fetch_failed', 'failed')
        """)
        print("   Indexes created")

    # 步骤 4: 更新版本号
    print("\n4. Updating database version...")
    if not dry_run:
        cursor.execute("""
            INSERT OR REPLACE INTO sync_state (key, value, updated_at)
            VALUES ('db_version', '3', ?)
        """, (time.time(),))
        print("   Version updated to 3")

    # 步骤 5: 清理旧表（可选）
    if structure['has_sync_failures']:
        print("\n5. Keeping sync_failures table for reference (can be deleted manually)")
        # 不自动删除，保留用于检查
        # cursor.execute("DROP TABLE IF EXISTS sync_failures")

    if not dry_run:
        conn.commit()
        print("\n=== Migration completed successfully ===")
    else:
        print("\n=== Dry run completed (no changes made) ===")


def main():
    parser = argparse.ArgumentParser(description='Migrate SyncStore to v3')
    parser.add_argument(
        '--db-path',
        default='data/sync_store.db',
        help='Path to SyncStore database (default: data/sync_store.db)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be done without making changes'
    )
    parser.add_argument(
        '--no-backup',
        action='store_true',
        help='Skip backup (not recommended)'
    )

    args = parser.parse_args()

    db_path = Path(args.db_path)

    if not db_path.exists():
        print(f"Database not found: {db_path}")
        print("Creating new v3 database...")
        # 新数据库会自动创建 v3 结构
        return

    print(f"Database: {db_path}")
    print(f"Size: {db_path.stat().st_size / 1024 / 1024:.2f} MB")

    # 检查版本
    conn = get_connection(str(db_path))
    current_version = check_current_version(conn)
    print(f"Current version: {current_version}")

    if current_version >= 3:
        print("Database is already at v3 or higher. No migration needed.")
        conn.close()
        return

    # 备份
    if not args.no_backup and not args.dry_run:
        backup_database(str(db_path))

    # 迁移
    try:
        migrate_to_v3(conn, dry_run=args.dry_run)
    except Exception as e:
        print(f"\nMigration failed: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
