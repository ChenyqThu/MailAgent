import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync
from src.models import Email

def main():
    """调试完整的children blocks"""
    setup_logger(config.log_level)

    print("=" * 60)
    print("调试完整的 children blocks")
    print("=" * 60)

    # 读取第一封未读邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)

    if not emails:
        print("❌ 没有未读邮件")
        return

    email = emails[0]
    print(f"\n邮件: {email.subject}")

    # 创建同步器并生成children
    syncer = NotionSync()
    children = syncer._build_children(email, uploaded_files=None)

    print(f"\n生成了 {len(children)} 个 children blocks")
    print("\n检查每个block的长度:")
    print("-" * 60)

    for i, block in enumerate(children):
        block_type = block.get("type", "unknown")

        # 获取文本内容
        text_content = ""
        try:
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
            elif block_type == "callout":
                text_content = block["callout"]["rich_text"][0]["text"]["content"]
            elif block_type == "divider":
                text_content = "(divider)"
        except Exception as e:
            text_content = f"(error: {e})"

        text_len = len(text_content)
        status = "✅" if text_len <= 2000 else "❌"

        print(f"{status} Block {i}: {block_type:20s} - {text_len:5d} chars", end="")
        if text_len > 2000:
            print(f"  ⚠️ 超出 {text_len - 2000} 字符!")
        else:
            print()

        if text_len > 2000:
            print(f"   前200字符: {text_content[:200]!r}")
            print()

if __name__ == "__main__":
    main()
