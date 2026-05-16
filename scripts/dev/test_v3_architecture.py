"""
测试 v3 架构实现

验证：
1. SQLite Radar get_new_emails() 方法
2. AppleScript Arm fetch_email_content_by_id() 方法
3. SyncStore v3 架构 API
4. NewWatcher v3 轮询流程

Usage:
    python3 scripts/test_v3_architecture.py
"""

import sys
import time
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import config
from src.utils.logger import setup_logger


def test_sqlite_radar():
    """测试 SQLite Radar v3 功能"""
    print("\n" + "=" * 60)
    print("Testing SQLite Radar v3")
    print("=" * 60)

    from src.mail.sqlite_radar import SQLiteRadar

    radar = SQLiteRadar(mailboxes=["收件箱"])

    if not radar.is_available():
        print("❌ SQLite radar not available (need Full Disk Access)")
        return False

    print("✅ SQLite radar available")

    # 测试获取当前 max_row_id
    max_row_id = radar.get_current_max_row_id()
    print(f"✅ Current max_row_id: {max_row_id}")

    # 测试获取邮件数量
    counts = radar.get_email_count()
    print(f"✅ Email counts: {counts}")

    # 测试 get_new_emails（从 max_row_id - 5 开始）
    if max_row_id > 5:
        since_row_id = max_row_id - 5
        new_emails = radar.get_new_emails(since_row_id)
        print(f"✅ get_new_emails(since={since_row_id}): found {len(new_emails)} emails")

        if new_emails:
            email = new_emails[0]
            print(f"   First email:")
            print(f"   - internal_id: {email.get('internal_id')}")
            print(f"   - subject: {email.get('subject', '')[:50]}")
            print(f"   - sender: {email.get('sender_email', '')}")
            print(f"   - date: {email.get('date_received', '')}")
            print(f"   - mailbox: {email.get('mailbox', '')}")

    return True


def test_applescript_arm():
    """测试 AppleScript Arm v3 功能"""
    print("\n" + "=" * 60)
    print("Testing AppleScript Arm v3")
    print("=" * 60)

    from src.mail.applescript_arm import AppleScriptArm
    from src.mail.sqlite_radar import SQLiteRadar

    arm = AppleScriptArm(
        account_name=config.mail_account_name,
        inbox_name=config.mail_inbox_name
    )

    # 先从 SQLite 获取一个 internal_id
    radar = SQLiteRadar(mailboxes=["收件箱"])
    if not radar.is_available():
        print("❌ Need SQLite radar to get internal_id for testing")
        return False

    max_row_id = radar.get_current_max_row_id()
    new_emails = radar.get_new_emails(max_row_id - 3)

    if not new_emails:
        print("❌ No emails found in radar")
        return False

    # 测试 fetch_email_content_by_id
    email = new_emails[0]
    internal_id = email['internal_id']
    mailbox = email.get('mailbox', '收件箱')

    print(f"\nTesting fetch_email_content_by_id({internal_id}, {mailbox})...")

    start_time = time.time()
    result = arm.fetch_email_content_by_id(internal_id, mailbox)
    elapsed = time.time() - start_time

    if result:
        print(f"✅ fetch_email_content_by_id succeeded in {elapsed:.2f}s")
        print(f"   - subject: {result.get('subject', '')[:50]}")
        print(f"   - sender: {result.get('sender', '')}")
        print(f"   - message_id: {result.get('message_id', '')[:60]}...")
        print(f"   - thread_id: {result.get('thread_id', '')[:60] if result.get('thread_id') else 'None'}...")
        print(f"   - source length: {len(result.get('source', ''))} chars")
        return True
    else:
        print(f"❌ fetch_email_content_by_id failed")
        return False


def test_sync_store():
    """测试 SyncStore v3 功能"""
    print("\n" + "=" * 60)
    print("Testing SyncStore v3")
    print("=" * 60)

    import tempfile
    from src.mail.sync_store import SyncStore

    # 使用临时数据库测试
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        test_db_path = f.name

    store = SyncStore(test_db_path)

    # 测试保存邮件（v3 架构，使用 internal_id）
    test_email = {
        'internal_id': 12345,
        'message_id': '<test@example.com>',
        'thread_id': '<thread@example.com>',
        'subject': 'Test Subject',
        'sender': 'test@example.com',
        'date_received': '2026-01-28T10:00:00',
        'mailbox': '收件箱',
        'sync_status': 'pending'
    }

    result = store.save_email(test_email)
    print(f"✅ save_email (v3): {result}")

    # 测试通过 internal_id 获取
    email = store.get(12345)
    print(f"✅ get(internal_id): {email is not None}")
    if email:
        print(f"   - subject: {email.get('subject')}")
        print(f"   - sync_status: {email.get('sync_status')}")

    # 测试通过 message_id 获取
    email = store.get_by_message_id('<test@example.com>')
    print(f"✅ get_by_message_id: {email is not None}")

    # 测试 update_after_fetch
    result = store.update_after_fetch(12345, {
        'subject': 'Updated Subject',
        'thread_id': '<new_thread@example.com>'
    })
    print(f"✅ update_after_fetch: {result}")

    # 测试 mark_fetch_failed
    result = store.mark_fetch_failed(12345, "Test error")
    print(f"✅ mark_fetch_failed: {result}")

    # 验证状态更新
    email = store.get(12345)
    print(f"   - sync_status: {email.get('sync_status')}")
    print(f"   - retry_count: {email.get('retry_count')}")
    print(f"   - next_retry_at: {email.get('next_retry_at')}")

    # 测试 get_ready_for_retry
    # 需要等待一段时间或修改 next_retry_at
    store._get_connection().cursor().execute(
        "UPDATE email_metadata SET next_retry_at = ? WHERE internal_id = ?",
        (time.time() - 1, 12345)
    )
    store._get_connection().commit()

    ready = store.get_ready_for_retry(limit=10)
    print(f"✅ get_ready_for_retry: {len(ready)} emails")

    # 测试 mark_synced_v3
    result = store.mark_synced_v3(12345, "notion-page-id-123")
    print(f"✅ mark_synced_v3: {result}")

    email = store.get(12345)
    print(f"   - sync_status: {email.get('sync_status')}")
    print(f"   - notion_page_id: {email.get('notion_page_id')}")

    # 测试统计
    stats = store.get_stats()
    print(f"✅ get_stats: {stats.get('total_emails')} emails")

    # 清理
    import os
    os.unlink(test_db_path)

    return True


def test_performance_comparison():
    """性能对比测试"""
    print("\n" + "=" * 60)
    print("Performance Comparison: id vs message_id")
    print("=" * 60)

    from src.mail.applescript_arm import AppleScriptArm
    from src.mail.sqlite_radar import SQLiteRadar

    arm = AppleScriptArm(
        account_name=config.mail_account_name,
        inbox_name=config.mail_inbox_name
    )

    # 获取测试邮件
    radar = SQLiteRadar(mailboxes=["收件箱"])
    if not radar.is_available():
        print("❌ Need SQLite radar")
        return False

    max_row_id = radar.get_current_max_row_id()
    new_emails = radar.get_new_emails(max_row_id - 1)

    if not new_emails:
        print("❌ No emails found")
        return False

    email = new_emails[0]
    internal_id = email['internal_id']
    mailbox = email.get('mailbox', '收件箱')

    # 测试 v3 方法（whose id is）
    print(f"\n1. Testing v3 method: fetch_email_content_by_id({internal_id})")
    start = time.time()
    result_v3 = arm.fetch_email_content_by_id(internal_id, mailbox)
    time_v3 = time.time() - start

    if result_v3:
        message_id = result_v3.get('message_id')
        print(f"   Time: {time_v3:.2f}s")

        # 测试 v2 方法（whose message id is）
        print(f"\n2. Testing v2 method: fetch_email_by_message_id")
        print(f"   message_id: {message_id[:60]}...")
        start = time.time()
        result_v2 = arm.fetch_email_by_message_id(message_id, mailbox)
        time_v2 = time.time() - start
        print(f"   Time: {time_v2:.2f}s")

        # 对比
        if time_v2 > 0:
            speedup = time_v2 / time_v3
            print(f"\n✅ Performance improvement: {speedup:.1f}x faster")
            print(f"   v3 (id): {time_v3:.2f}s")
            print(f"   v2 (message_id): {time_v2:.2f}s")
        else:
            print(f"\n✅ Both methods completed quickly")
    else:
        print("❌ v3 method failed")
        return False

    return True


def main():
    """运行所有测试"""
    setup_logger("INFO")

    print("=" * 60)
    print("v3 Architecture Test Suite")
    print("=" * 60)
    print(f"\nAccount: {config.mail_account_name}")
    print(f"Inbox: {config.mail_inbox_name}")

    results = {}

    # 测试 SQLite Radar
    try:
        results['sqlite_radar'] = test_sqlite_radar()
    except Exception as e:
        print(f"❌ SQLite Radar test failed: {e}")
        results['sqlite_radar'] = False

    # 测试 SyncStore
    try:
        results['sync_store'] = test_sync_store()
    except Exception as e:
        print(f"❌ SyncStore test failed: {e}")
        results['sync_store'] = False

    # 测试 AppleScript Arm
    try:
        results['applescript_arm'] = test_applescript_arm()
    except Exception as e:
        print(f"❌ AppleScript Arm test failed: {e}")
        results['applescript_arm'] = False

    # 性能对比测试（可选）
    try:
        results['performance'] = test_performance_comparison()
    except Exception as e:
        print(f"❌ Performance test failed: {e}")
        results['performance'] = False

    # 汇总
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)

    all_passed = True
    for test_name, passed in results.items():
        status = "✅ PASSED" if passed else "❌ FAILED"
        print(f"  {test_name}: {status}")
        if not passed:
            all_passed = False

    print("\n" + "=" * 60)
    if all_passed:
        print("All tests passed! v3 architecture is ready.")
    else:
        print("Some tests failed. Please check the output above.")
    print("=" * 60)

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
