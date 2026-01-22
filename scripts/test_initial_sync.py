import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """测试启动时同步所有未读邮件"""
    setup_logger("INFO")

    print("=" * 60)
    print("测试启动时同步未读邮件功能")
    print("=" * 60)
    print(f"配置: SYNC_EXISTING_UNREAD = {config.sync_existing_unread}")
    print(f"批量大小: MAX_BATCH_SIZE = {config.max_batch_size}")
    print()

    # 读取未读邮件
    reader = EmailReader()
    print("正在读取未读邮件...")
    emails = reader.get_unread_emails(limit=config.max_batch_size)

    if not emails:
        print("✅ 没有未读邮件")
        return

    print(f"📬 找到 {len(emails)} 封未读邮件:")
    print()
    for i, email in enumerate(emails, 1):
        print(f"{i}. {email.subject}")
        print(f"   发件人: {email.sender_name}")
        print(f"   日期: {email.date}")
        print(f"   附件: {len(email.attachments)}")
        print()

    # 询问是否继续
    print("=" * 60)
    choice = input("是否开始同步这些邮件到Notion? (y/n): ")

    if choice.lower() != 'y':
        print("取消同步")
        return

    print()
    print("开始同步...")
    print("=" * 60)

    # 同步邮件
    syncer = NotionSync()
    synced_count = 0
    skipped_count = 0
    failed_count = 0

    for i, email in enumerate(emails, 1):
        print(f"\n[{i}/{len(emails)}] {email.subject}")

        try:
            success = await syncer.sync_email(email)

            if success:
                synced_count += 1
                print("  ✅ 同步成功")
            else:
                skipped_count += 1
                print("  ⏭  已存在，跳过")

        except Exception as e:
            failed_count += 1
            print(f"  ❌ 失败: {e}")

    # 汇总
    print()
    print("=" * 60)
    print("同步完成!")
    print("=" * 60)
    print(f"✅ 成功: {synced_count}")
    print(f"⏭  跳过: {skipped_count}")
    print(f"❌ 失败: {failed_count}")
    print(f"📊 总计: {len(emails)}")

if __name__ == "__main__":
    asyncio.run(main())
