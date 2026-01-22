import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.converter.html_converter import HTMLToNotionConverter

def main():
    """调试邮件转换"""
    setup_logger(config.log_level)

    print("=" * 60)
    print("调试邮件内容转换")
    print("=" * 60)

    # 读取第一封未读邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)

    if not emails:
        print("❌ 没有未读邮件")
        return

    email = emails[0]
    print(f"\n邮件: {email.subject}")
    print(f"内容类型: {email.content_type}")
    print(f"内容长度: {len(email.content)} 字符")

    # 转换
    converter = HTMLToNotionConverter()
    blocks = converter.convert(email.content)

    print(f"\n生成了 {len(blocks)} 个 blocks")
    print("\n检查每个block的长度:")
    print("-" * 60)

    for i, block in enumerate(blocks):
        block_type = block.get("type", "unknown")

        # 获取文本内容
        text_content = ""
        if block_type == "paragraph":
            text_content = block["paragraph"]["rich_text"][0]["text"]["content"]
        elif block_type.startswith("heading_"):
            text_content = block[block_type]["rich_text"][0]["text"]["content"]
        elif block_type == "bulleted_list_item":
            text_content = block["bulleted_list_item"]["rich_text"][0]["text"]["content"]
        elif block_type == "numbered_list_item":
            text_content = block["numbered_list_item"]["rich_text"][0]["text"]["content"]
        elif block_type == "quote":
            text_content = block["quote"]["rich_text"][0]["text"]["content"]
        elif block_type == "code":
            text_content = block["code"]["rich_text"][0]["text"]["content"]

        text_len = len(text_content)
        status = "✅" if text_len <= 2000 else "❌"

        if text_len > 1900 or text_len > 2000:
            print(f"{status} Block {i}: {block_type} - {text_len} chars")
            if text_len > 2000:
                print(f"   超出: {text_len - 2000} 字符")
                print(f"   前100字符: {text_content[:100]!r}")

if __name__ == "__main__":
    main()
