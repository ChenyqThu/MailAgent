import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader

async def main():
    """导出邮件正文到文件"""
    # 初始化日志
    setup_logger(config.log_level)

    print("=" * 60)
    print("导出邮件正文内容")
    print("=" * 60)

    # 读取第一封未读邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)

    if not emails:
        print("❌ 没有未读邮件")
        return

    email = emails[0]
    print(f"\n邮件: {email.subject}")
    print(f"发件人: {email.sender_name} <{email.sender}>")
    print(f"内容类型: {email.content_type}")
    print(f"内容长度: {len(email.content)} 字符")

    # 导出到文件
    output_file = Path(__file__).parent.parent / "email_content_sample.txt"

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(f"Subject: {email.subject}\n")
        f.write(f"From: {email.sender_name} <{email.sender}>\n")
        f.write(f"Content-Type: {email.content_type}\n")
        f.write(f"Content-Length: {len(email.content)} chars\n")
        f.write("=" * 80 + "\n\n")
        f.write(email.content)

    print(f"\n✅ 内容已导出到: {output_file}")
    print(f"文件大小: {output_file.stat().st_size} 字节")

if __name__ == "__main__":
    asyncio.run(main())
