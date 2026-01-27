import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.applescript_arm import AppleScriptArm
from src.mail.reader import EmailReader
from src.config import config
from src.utils.logger import setup_logger

def main():
    """测试邮件读取

    使用 AppleScriptArm.fetch_emails_by_position() 直接按位置获取最新邮件，
    避免遍历所有邮件导致 Mail.app 卡死。
    """
    setup_logger("DEBUG")

    print("=" * 60)
    print("Testing Mail Reader")
    print("=" * 60)

    # 使用 AppleScriptArm 获取最新邮件（按位置，不会遍历所有邮件）
    arm = AppleScriptArm(
        account_name=config.mail_account_name,
        inbox_name=config.mail_inbox_name
    )

    print(f"\n账户: {config.mail_account_name}")
    print(f"邮箱: {config.mail_inbox_name}")
    print("\n正在获取最新 5 封邮件...")

    # 获取最新 5 封邮件的基本信息
    emails = arm.fetch_emails_by_position(count=5, mailbox="收件箱")

    print(f"\n找到 {len(emails)} 封邮件:\n")

    for i, email in enumerate(emails, 1):
        print(f"{i}. {email['subject']}")
        print(f"   发件人: {email['sender']}")
        print(f"   日期: {email['date_received']}")
        print(f"   Message ID: {email['message_id'][:60]}...")
        print(f"   Thread ID: {email['thread_id'][:60] if email['thread_id'] else 'N/A'}...")
        print(f"   已读: {email['is_read']}")
        print(f"   已标记: {email['is_flagged']}")
        print()

    # 如果需要测试完整邮件内容解析，可以获取第一封邮件的详情
    if emails:
        print("-" * 60)
        print("测试完整邮件内容解析（第一封邮件）:")
        print("-" * 60)

        reader = EmailReader()
        first_email = emails[0]
        full_email = reader.get_email_details(first_email['message_id'])

        print(f"主题: {full_email.subject}")
        print(f"内容类型: {full_email.content_type}")
        print(f"内容长度: {len(full_email.content)} 字符")
        print(f"附件数: {len(full_email.attachments)}")
        if full_email.attachments:
            for att in full_email.attachments:
                print(f"  - {att.filename} ({att.content_type}, {att.size} bytes)")

if __name__ == "__main__":
    main()
