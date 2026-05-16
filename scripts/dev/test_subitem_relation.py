#!/usr/bin/env python3
"""
测试 Notion Sub-item 关系自动重建

验证：通过修改母节点的 Sub-item，是否能自动更新子节点的 Parent Item
"""

import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from notion_client import AsyncClient
from src.config import config


# 测试页面 ID（去掉 dashes）
TEST_PAGE_ID = "2f315375830d8169a2adf4ef16e8400a"  # test 页面，当前 Parent 指向 ENBU-ABR
NEW_PARENT_PAGE_ID = "2f415375830d819fb6fec086838b7f3d"  # 0126 页面，要成为新的母节点
OLD_PARENT_PAGE_ID = "2f415375830d81ef8664dc56b28f70a1"  # ENBU-ABR 页面，当前母节点


async def get_page_relations(client: AsyncClient, page_id: str) -> dict:
    """获取页面的 Parent Item 和 Sub-item 关系"""
    try:
        page = await client.pages.retrieve(page_id=page_id)
        props = page.get("properties", {})

        # 获取 Parent Item
        parent_item = props.get("Parent Item", {})
        parent_relations = parent_item.get("relation", [])
        parent_ids = [r.get("id") for r in parent_relations]

        # 获取 Sub-item
        sub_item = props.get("Sub-item", {})
        sub_relations = sub_item.get("relation", [])
        sub_ids = [r.get("id") for r in sub_relations]

        # 获取标题
        title_prop = props.get("Subject", {})
        title_arr = title_prop.get("title", [])
        title = title_arr[0].get("text", {}).get("content", "") if title_arr else ""

        return {
            "page_id": page_id,
            "title": title,
            "parent_ids": parent_ids,
            "sub_ids": sub_ids
        }
    except Exception as e:
        print(f"Error getting page {page_id}: {e}")
        return {}


async def update_sub_item(client: AsyncClient, parent_page_id: str, child_page_ids: list) -> bool:
    """更新页面的 Sub-item 关系"""
    try:
        relations = [{"id": pid} for pid in child_page_ids]

        await client.pages.update(
            page_id=parent_page_id,
            properties={
                "Sub-item": {
                    "relation": relations
                }
            }
        )
        print(f"✅ Updated Sub-item of {parent_page_id}")
        print(f"   Added: {child_page_ids}")
        return True
    except Exception as e:
        print(f"❌ Failed to update Sub-item: {e}")
        return False


async def main():
    print("=" * 60)
    print("Notion Sub-item 关系自动重建测试")
    print("=" * 60)

    client = AsyncClient(auth=config.notion_token)

    # Step 1: 获取当前状态
    print("\n📋 Step 1: 获取当前关系状态")
    print("-" * 40)

    test_info = await get_page_relations(client, TEST_PAGE_ID)
    new_parent_info = await get_page_relations(client, NEW_PARENT_PAGE_ID)

    print(f"Test 页面: {test_info.get('title', 'N/A')}")
    print(f"  - Page ID: {TEST_PAGE_ID}")
    print(f"  - 当前 Parent Item: {test_info.get('parent_ids', [])}")
    print(f"  - 当前 Sub-item: {test_info.get('sub_ids', [])}")

    print(f"\n0126 页面 (新母节点): {new_parent_info.get('title', 'N/A')}")
    print(f"  - Page ID: {NEW_PARENT_PAGE_ID}")
    print(f"  - 当前 Parent Item: {new_parent_info.get('parent_ids', [])}")
    print(f"  - 当前 Sub-item: {new_parent_info.get('sub_ids', [])}")

    # Step 2: 将 test 页面添加到 0126 的 Sub-item
    print("\n📝 Step 2: 将 test 页面添加到 0126 的 Sub-item")
    print("-" * 40)

    # 保留 0126 现有的 Sub-item，添加 test 页面
    existing_subs = new_parent_info.get('sub_ids', [])
    if TEST_PAGE_ID not in existing_subs:
        new_subs = existing_subs + [TEST_PAGE_ID]
    else:
        new_subs = existing_subs
        print("Test 页面已在 Sub-item 中，跳过添加")

    success = await update_sub_item(client, NEW_PARENT_PAGE_ID, new_subs)

    if not success:
        print("❌ 测试失败：无法更新 Sub-item")
        return

    # Step 3: 验证 test 页面的 Parent Item 是否已更新
    print("\n🔍 Step 3: 验证 test 页面的 Parent Item 是否已更新")
    print("-" * 40)

    # 等待一下让 Notion 处理关系更新
    await asyncio.sleep(1)

    test_info_after = await get_page_relations(client, TEST_PAGE_ID)
    new_parent_info_after = await get_page_relations(client, NEW_PARENT_PAGE_ID)

    print(f"Test 页面更新后:")
    print(f"  - Parent Item (之前): {test_info.get('parent_ids', [])}")
    print(f"  - Parent Item (之后): {test_info_after.get('parent_ids', [])}")

    # 检查是否成功
    new_parent_ids = test_info_after.get('parent_ids', [])
    if NEW_PARENT_PAGE_ID in new_parent_ids or NEW_PARENT_PAGE_ID.replace("-", "") in [p.replace("-", "") for p in new_parent_ids]:
        print("\n✅ 测试成功！")
        print("   通过修改母节点的 Sub-item，子节点的 Parent Item 自动更新了！")
        print("   这意味着可以用这种方式批量重建线程关系。")
    else:
        print("\n⚠️  测试结果不确定")
        print(f"   期望 Parent Item 包含: {NEW_PARENT_PAGE_ID}")
        print(f"   实际 Parent Item: {new_parent_ids}")
        print("   请手动检查 Notion 中的关系是否正确")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
