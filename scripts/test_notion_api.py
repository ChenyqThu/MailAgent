import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.notion.client import NotionClient
from src.config import config
from src.utils.logger import setup_logger

async def main():
    """测试 Notion API 连接"""
    setup_logger("DEBUG")

    client = NotionClient()

    print("=" * 60)
    print("Testing Notion API")
    print("=" * 60)
    print(f"Token: {config.notion_token[:20]}...")
    print(f"Database ID: {config.email_database_id}")
    print()

    # 测试查询数据库
    print("查询数据库...")
    results = await client.query_database()
    print(f"✅ 成功！找到 {len(results)} 个 Pages")

    # 测试检查邮件是否存在
    print("\n测试检查邮件是否存在...")
    exists = await client.check_page_exists("test-message-id-12345")
    print(f"✅ 成功！邮件存在: {exists}")

    print("\n" + "=" * 60)
    print("所有测试通过！")

if __name__ == "__main__":
    asyncio.run(main())
