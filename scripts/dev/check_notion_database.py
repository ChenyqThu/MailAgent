import sys
import asyncio
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from notion_client import AsyncClient
from src.config import config

async def main():
    """检查 Notion Database 字段结构"""
    client = AsyncClient(auth=config.notion_token)

    print("=" * 60)
    print("Notion Database 字段检查")
    print("=" * 60)
    print(f"Database ID: {config.email_database_id}")
    print()

    try:
        # 获取 Database 信息
        database = await client.databases.retrieve(database_id=config.email_database_id)

        print("✅ Database 访问成功!")
        print(f"名称: {database.get('title', [{}])[0].get('plain_text', 'Untitled')}")
        print()

        print("📋 字段列表:")
        print("-" * 60)

        properties = database.get('properties', {})

        for name, prop in properties.items():
            prop_type = prop.get('type', 'unknown')
            print(f"\n字段名: {name}")
            print(f"  类型: {prop_type}")

            # 如果是 Select 类型，显示选项
            if prop_type == 'select':
                options = prop.get('select', {}).get('options', [])
                if options:
                    print(f"  选项: {', '.join([opt.get('name', '') for opt in options])}")

        print()
        print("=" * 60)
        print("所需字段检查:")
        print("-" * 60)

        required_fields = {
            'Subject': 'title',
            'From': 'email',
            'From Name': 'rich_text',
            'To': 'rich_text',
            'CC': 'rich_text',
            'Date': 'date',
            'Message ID': 'rich_text',
            'Processing Status': 'select',
            'Is Read': 'checkbox',
            'Is Flagged': 'checkbox',
            'Has Attachments': 'checkbox',
            'Thread ID': 'rich_text',
            'Original EML': 'files',
        }

        missing_fields = []
        type_mismatch = []

        for field_name, expected_type in required_fields.items():
            if field_name not in properties:
                missing_fields.append(field_name)
                print(f"❌ 缺失: {field_name} ({expected_type})")
            elif properties[field_name].get('type') != expected_type:
                actual_type = properties[field_name].get('type')
                type_mismatch.append((field_name, expected_type, actual_type))
                print(f"⚠️  类型不匹配: {field_name} (期望: {expected_type}, 实际: {actual_type})")
            else:
                print(f"✅ {field_name} ({expected_type})")

        print()
        print("=" * 60)

        if missing_fields or type_mismatch:
            print("⚠️  发现问题:")
            if missing_fields:
                print(f"\n缺失的字段: {', '.join(missing_fields)}")
            if type_mismatch:
                print("\n类型不匹配的字段:")
                for name, expected, actual in type_mismatch:
                    print(f"  - {name}: 期望 {expected}, 实际 {actual}")
        else:
            print("✅ 所有必需字段都存在且类型正确!")

    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
