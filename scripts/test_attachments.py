import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """测试附件同步功能"""
    setup_logger("DEBUG")

    print("=" * 60)
    print("测试邮件附件同步到 Notion")
    print("=" * 60)

    # 读取邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=5)

    # 找一封有附件的邮件
    email_with_attachments = None
    for email in emails:
        if email.has_attachments:
            email_with_attachments = email
            break

    if not email_with_attachments:
        print("❌ 没有找到带附件的未读邮件")
        print(f"   共检查了 {len(emails)} 封邮件")
        return

    email = email_with_attachments
    print(f"\n找到带附件的邮件:")
    print(f"  主题: {email.subject}")
    print(f"  发件人: {email.sender_name} <{email.sender}>")
    print(f"  附件数: {len(email.attachments)}")
    print(f"\n附件列表:")
    for i, att in enumerate(email.attachments, 1):
        print(f"  {i}. {att.filename} ({att.content_type}, {att.size} bytes)")

    # 创建同步器
    syncer = NotionSync()

    # 检查是否已同步
    if await syncer.client.check_page_exists(email.message_id):
        print(f"\n⚠️  该邮件已同步过，跳过...")
        print("   如需重新测试，请先在Notion中删除该页面")
        return

    print(f"\n开始同步...")
    try:
        success = await syncer.sync_email(email)

        if success:
            print("\n✅ 同步成功！")
            print("   请在Notion中查看附件是否正确显示")
        else:
            print("\n❌ 同步失败")
    except Exception as e:
        print(f"\n❌ 同步出错: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
