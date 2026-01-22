import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """检查特殊字符导致的长度问题"""
    setup_logger("INFO")

    # 读取邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)
    email = emails[0]

    # 生成children
    syncer = NotionSync()
    children = syncer._build_children(email, uploaded_files=None)

    print("检查超长blocks的字符编码问题:")
    print("=" * 60)

    for i, block in enumerate(children):
        block_type = block.get("type", "unknown")

        text = ""
        try:
            if block_type == "paragraph":
                text = block["paragraph"]["rich_text"][0]["text"]["content"]
        except:
            continue

        if len(text) > 1900:
            print(f"\nBlock {i}: {len(text)} chars")

            # 检查不同编码下的长度
            utf8_len = len(text.encode('utf-8'))
            utf16_len = len(text.encode('utf-16')) // 2  # UTF-16使用2字节单元

            print(f"  Python len():      {len(text)}")
            print(f"  UTF-8 bytes:       {utf8_len}")
            print(f"  UTF-16 code units: {utf16_len}")

            # 检查emoji数量
            emoji_count = sum(1 for c in text if ord(c) > 0x1F300)
            print(f"  Emoji/特殊字符:    {emoji_count}")

            # 如果超过2000，显示具体超出情况
            if len(text) > 2000:
                print(f"  ❌ Python长度超出: {len(text) - 2000}")
            if utf8_len > 2000:
                print(f"  ❌ UTF-8超出: {utf8_len - 2000}")
            if utf16_len > 2000:
                print(f"  ❌ UTF-16超出: {utf16_len - 2000}")

if __name__ == "__main__":
    asyncio.run(main())
