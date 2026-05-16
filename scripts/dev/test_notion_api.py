import sys
import asyncio
from pathlib import Path
from datetime import datetime, timezone, timedelta
import uuid

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.notion.client import NotionClient
from src.config import config
from src.utils.logger import setup_logger

# 北京时区
BEIJING_TZ = timezone(timedelta(hours=8))


async def main():
    """测试 Notion API 连接

    测试流程:
    1. 创建测试邮件页面
    2. 验证页面是否存在
    3. 查询数据库确认
    4. 删除测试页面（清理）
    """
    setup_logger("DEBUG")

    client = NotionClient()
    test_page_id = None
    test_message_id = f"test-{uuid.uuid4().hex[:12]}@mailagent.test"

    try:
        print("=" * 60)
        print("Testing Notion API")
        print("=" * 60)
        print(f"Token: {config.notion_token[:20]}...")
        print(f"Database ID: {config.email_database_id}")
        print(f"Test Message ID: {test_message_id}")
        print()

        # 1. 创建测试邮件页面
        print("1. 创建测试邮件页面...")
        test_properties = {
            "Subject": {
                "title": [{"text": {"content": "[TEST] MailAgent API 测试邮件"}}]
            },
            "Message ID": {
                "rich_text": [{"text": {"content": test_message_id}}]
            },
            "From": {
                "email": "test@mailagent.test"
            },
            "From Name": {
                "rich_text": [{"text": {"content": "MailAgent Test"}}]
            },
            "Date": {
                "date": {"start": datetime.now(BEIJING_TZ).isoformat()}
            },
            "Is Read": {"checkbox": True},
            "Is Flagged": {"checkbox": False},
            "Has Attachments": {"checkbox": False},
            "Mailbox": {"select": {"name": "收件箱"}},
            "Processing Status": {"select": {"name": "未处理"}}
        }

        test_children = [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"text": {"content": "这是 MailAgent 的 API 测试邮件，将在测试完成后自动删除。"}}]
                }
            }
        ]

        page = await client.create_page(
            properties=test_properties,
            children=test_children,
            icon={"type": "emoji", "emoji": "🧪"}
        )
        test_page_id = page["id"]
        print(f"   ✅ 创建成功！Page ID: {test_page_id}")

        # 2. 验证页面是否存在
        print("\n2. 验证页面是否存在...")
        exists = await client.check_page_exists(test_message_id)
        if exists:
            print(f"   ✅ 验证成功！邮件存在: {exists}")
        else:
            print(f"   ❌ 验证失败！邮件不存在")
            return

        # 3. 查询数据库确认
        print("\n3. 查询数据库确认...")
        results = await client.query_database(
            filter_conditions={
                "property": "Message ID",
                "rich_text": {"equals": test_message_id}
            }
        )
        if results and len(results) == 1:
            found_page = results[0]
            found_subject = found_page.get("properties", {}).get("Subject", {}).get("title", [])
            subject_text = found_subject[0].get("text", {}).get("content", "") if found_subject else ""
            print(f"   ✅ 查询成功！找到页面: {subject_text}")
        else:
            print(f"   ❌ 查询失败！预期 1 个结果，实际 {len(results)} 个")
            return

        print("\n" + "=" * 60)
        print("所有测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n❌ 测试失败: {e}")
        raise

    finally:
        # 4. 清理：删除测试页面
        if test_page_id:
            print("\n清理: 删除测试页面...")
            try:
                await client.client.pages.update(
                    page_id=test_page_id,
                    archived=True
                )
                print(f"   ✅ 已删除测试页面: {test_page_id}")
            except Exception as e:
                print(f"   ⚠️ 删除失败（请手动删除）: {e}")

        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
