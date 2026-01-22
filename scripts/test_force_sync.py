import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """强制重新同步一封邮件（跳过去重检查）"""
    # 初始化日志
    setup_logger("DEBUG")

    print("=" * 60)
    print("强制重新同步邮件到 Notion（测试文件上传）")
    print("=" * 60)

    # 读取第一封未读邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)

    if not emails:
        print("❌ 没有未读邮件")
        return

    email = emails[0]
    print(f"\n测试邮件: {email.subject}")
    print(f"发件人: {email.sender_name} <{email.sender}>")
    print(f"附件数: {len(email.attachments)}")

    # 创建同步器
    syncer = NotionSync()

    try:
        # 生成并上传 .eml 文件（复制自sync_email方法，跳过去重检查）
        from pathlib import Path
        import shutil

        print("\n生成 .eml 文件...")
        eml_path = syncer.eml_generator.generate(email)
        print(f"✅ Generated: {eml_path.name}")

        # 转换为 .txt
        txt_path = eml_path.with_suffix('.txt')
        shutil.copy2(eml_path, txt_path)
        print(f"✅ Converted to: {txt_path.name}")

        # 上传
        print(f"\n开始上传文件到 Notion...")
        file_upload_id = await syncer.client.upload_file(str(txt_path))
        print(f"✅ 文件上传成功！")
        print(f"   File Upload ID: {file_upload_id}")

        # 清理
        txt_path.unlink(missing_ok=True)

        print("\n✅ 测试成功！文件上传功能正常工作。")
        print(f"\n注意: 这个file_upload_id可以用于附加到Notion page properties中。")

    except Exception as e:
        print(f"\n❌ 测试失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
