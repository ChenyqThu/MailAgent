import sys
import asyncio
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.utils.logger import setup_logger
from src.config import config
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync

async def main():
    """调试发送给Notion的payload"""
    setup_logger("DEBUG")

    print("=" * 60)
    print("调试Notion API Payload")
    print("=" * 60)

    # 读取第一封未读邮件
    reader = EmailReader()
    emails = reader.get_unread_emails(limit=1)

    if not emails:
        print("❌ 没有未读邮件")
        return

    email = emails[0]
    print(f"\n邮件: {email.subject}")

    # 创建同步器
    syncer = NotionSync()

    # 生成 eml
    try:
        eml_path = syncer.eml_generator.generate(email)
        eml_file_path = str(eml_path)
    except:
        eml_file_path = None

    # 生成附件名列表
    attachment_names = [a.filename for a in email.attachments]

    # 生成 properties 和 children
    properties = syncer._build_properties(email, eml_file_path, attachment_names)
    children = syncer._build_children(email, uploaded_files=None)

    print(f"\n生成了 {len(children)} 个children blocks")
    print("\n检查children中的长文本:")
    print("-" * 60)

    # 将children转为JSON看看实际发送的内容
    json_str = json.dumps(children, ensure_ascii=False)

    for i, block in enumerate(children):
        block_type = block.get("type", "unknown")

        # 序列化单个block为JSON
        block_json = json.dumps(block, ensure_ascii=False)
        block_json_len = len(block_json)

        # 提取文本
        text = ""
        try:
            if block_type == "paragraph":
                text = block["paragraph"]["rich_text"][0]["text"]["content"]
            elif block_type.startswith("heading_"):
                text = block[block_type]["rich_text"][0]["text"]["content"]
            elif block_type == "callout":
                text = block["callout"]["rich_text"][0]["text"]["content"]
        except:
            pass

        text_len = len(text)

        if text_len > 1900 or block_json_len > 3000:
            status = "❌" if text_len > 2000 else "⚠️"
            print(f"{status} Block {i}: {block_type}")
            print(f"   文本长度: {text_len} chars")
            print(f"   JSON长度: {block_json_len} chars")
            if text_len > 2000:
                print(f"   超出: {text_len - 2000} 字符")
            # 检查是否有特殊字符
            if '\\' in block_json:
                print(f"   ⚠️ JSON中包含转义字符")

if __name__ == "__main__":
    asyncio.run(main())
