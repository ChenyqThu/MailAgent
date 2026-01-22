import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """测试同步第二封邮件"""
    # 初始化日志
    setup_logger(config.log_level)

    print("=" * 60)
    print("测试同步第二封邮件到 Notion")
    print("=" * 60)

    # 读取前2封未读邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=2)

    if len(emails) < 2:
        print(f"❌ 只有 {len(emails)} 封未读邮件，需要至少2封")
        if len(emails) == 1:
            email = emails[0]
        else:
            return
    else:
        email = emails[1]  # 第二封

    print(f"\n测试邮件: {email.subject}")
    print(f"发件人: {email.sender_name} <{email.sender}>")
    print(f"附件数: {len(email.attachments)}")
    print(f"内容长度: {len(email.content)} 字符")

    # 同步到 Notion
    print("\n开始同步...")
    syncer = NotionSync()

    try:
        success = await syncer.sync_email(email)

        if success:
            print("\n✅ 同步成功！")
        else:
            print("\n❌ 同步失败")
    except Exception as e:
        print(f"\n❌ 同步出错: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
