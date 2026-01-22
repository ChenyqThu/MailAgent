import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """强制同步一封有附件的邮件（跳过去重）"""
    setup_logger("DEBUG")

    print("=" * 60)
    print("强制同步带附件的邮件到 Notion（测试功能）")
    print("=" * 60)

    # 读取邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=10)

    # 找一封有附件的邮件
    email_with_attachments = None
    for email in emails:
        if email.has_attachments and len(email.attachments) > 0:
            email_with_attachments = email
            break

    if not email_with_attachments:
        print("❌ 没有找到带附件的未读邮件")
        return

    email = email_with_attachments
    print(f"\n测试邮件:")
    print(f"  主题: {email.subject}")
    print(f"  发件人: {email.sender_name}")
    print(f"  附件数: {len(email.attachments)}")
    print(f"\n附件列表:")
    for i, att in enumerate(email.attachments, 1):
        size_kb = att.size / 1024
        print(f"  {i}. {att.filename}")
        print(f"     类型: {att.content_type}")
        print(f"     大小: {size_kb:.1f} KB")
        print(f"     路径: {att.path}")

    # 创建同步器（跳过部分步骤，直接测试附件上传和page创建）
    syncer = NotionSync()

    print(f"\n开始同步（包括附件上传）...")

    try:
        # 执行完整的同步流程
        success = await syncer.sync_email(email)

        if success:
            print("\n✅ 同步成功！")
            print("   请在Notion中检查：")
            print("   1. 页面是否创建")
            print("   2. 附件是否在页面底部显示")
            print("   3. 图片附件是否以图片形式显示")
            print("   4. 其他附件是否以文件形式显示")
        else:
            print("\n⚠️ 同步失败或邮件已存在")

    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
