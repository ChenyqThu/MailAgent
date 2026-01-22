import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.reader import EmailReader
from src.utils.logger import setup_logger

def main():
    """测试邮件读取"""
    setup_logger("DEBUG")

    reader = EmailReader()

    print("=" * 60)
    print("Testing Mail Reader")
    print("=" * 60)

    # 获取未读邮件
    emails = reader.get_unread_emails(limit=5)

    print(f"\n找到 {len(emails)} 封未读邮件:\n")

    for i, email in enumerate(emails, 1):
        print(f"{i}. {email.subject}")
        print(f"   发件人: {email.sender_name} <{email.sender}>")
        print(f"   日期: {email.date}")
        print(f"   Message ID: {email.message_id}")
        print(f"   内容长度: {len(email.content)} 字符")
        print(f"   附件数: {len(email.attachments)}")
        print(f"   已读: {email.is_read}")
        print(f"   已标记: {email.is_flagged}")
        print()

if __name__ == "__main__":
    main()
