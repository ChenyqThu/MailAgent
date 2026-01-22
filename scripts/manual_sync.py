import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.reader import EmailReader
from src.notion.sync import NotionSync
from src.utils.logger import setup_logger

async def main():
    """手动同步邮件"""
    setup_logger("DEBUG")

    reader = EmailReader()
    sync = NotionSync()

    print("=" * 60)
    print("Manual Email Sync")
    print("=" * 60)

    # 获取未读邮件
    emails = reader.get_unread_emails(limit=5)

    if not emails:
        print("没有未读邮件")
        return

    print(f"\n找到 {len(emails)} 封未读邮件:\n")

    for i, email in enumerate(emails, 1):
        print(f"{i}. {email.subject}")
        print(f"   发件人: {email.sender_name}")

    # 选择邮件
    choice = input("\n请选择要同步的邮件编号（输入 0 同步全部）: ")

    try:
        choice = int(choice)

        if choice == 0:
            # 同步全部
            for email in emails:
                print(f"\n正在同步: {email.subject}")
                await sync.sync_email(email)

        elif 1 <= choice <= len(emails):
            # 同步选中的
            email = emails[choice - 1]
            print(f"\n正在同步: {email.subject}")
            await sync.sync_email(email)

        else:
            print("无效的选择")

    except ValueError:
        print("请输入数字")

if __name__ == "__main__":
    asyncio.run(main())
