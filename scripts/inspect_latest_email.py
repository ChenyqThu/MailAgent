"""检查最新未读邮件的详细内容"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.reader import EmailReader
from src.utils.logger import setup_logger

def main():
    setup_logger("INFO")

    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)

    if not emails:
        print("没有未读邮件")
        return

    email = emails[0]

    print("=" * 80)
    print(f"主题: {email.subject}")
    print(f"发件人: {email.sender_name} <{email.sender}>")
    print(f"日期: {email.date}")
    print(f"内容类型: {email.content_type}")
    print(f"附件数量: {len(email.attachments)}")
    print("=" * 80)

    if email.attachments:
        print("\n附件列表:")
        for i, att in enumerate(email.attachments, 1):
            print(f"{i}. {att.filename} ({att.content_type}, {att.size} bytes)")

    print("\n" + "=" * 80)
    print("HTML 内容（前3000字符）:")
    print("=" * 80)
    print(email.content[:3000])

    # 保存完整HTML到文件
    output_file = Path(__file__).parent / "latest_email_content.html"
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(email.content)

    print("\n" + "=" * 80)
    print(f"完整HTML内容已保存到: {output_file}")
    print("=" * 80)

if __name__ == "__main__":
    main()
