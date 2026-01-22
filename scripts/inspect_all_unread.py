"""检查所有未读邮件，找出包含HTML和表格的邮件"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.reader import EmailReader
from src.utils.logger import setup_logger

def main():
    setup_logger("INFO")

    reader = EmailReader()
    emails = reader.get_unread_emails(limit=10)

    print(f"找到 {len(emails)} 封未读邮件\n")

    for i, email in enumerate(emails, 1):
        print("=" * 80)
        print(f"[{i}] 主题: {email.subject}")
        print(f"    发件人: {email.sender_name}")
        print(f"    内容类型: {email.content_type}")
        print(f"    附件数量: {len(email.attachments)}")

        if email.attachments:
            print("    附件:")
            for att in email.attachments:
                print(f"      - {att.filename} ({att.content_type})")

        # 检查是否包含表格
        has_table = "<table" in email.content.lower()
        has_html = email.content_type == "text/html" or "<html" in email.content.lower()

        if has_html:
            print(f"    ✓ 包含HTML")
        if has_table:
            print(f"    ✓ 包含表格")

        print()

if __name__ == "__main__":
    main()
