#!/usr/bin/env python3
"""
Notion 邮件数据库清理脚本

功能：
1. 去重：根据 Message ID 查重，保留创建时间最老的，删除重复的
2. 设置 Parent Item：根据 Thread ID 关联到对应的父邮件

用法:
    # 预览模式
    python3 scripts/cleanup_notion_db.py --dry-run

    # 只执行去重
    python3 scripts/cleanup_notion_db.py --dedup-only

    # 只执行 Parent Item 设置
    python3 scripts/cleanup_notion_db.py --parent-only

    # 全部执行
    python3 scripts/cleanup_notion_db.py
"""

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.config import config


class Colors:
    GREEN = '\033[92m'
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'


def print_header(text: str):
    print(f"\n{'='*70}")
    print(f"{Colors.BOLD}{text}{Colors.ENDC}")
    print('='*70 + "\n", flush=True)


def print_success(text: str):
    print(f"{Colors.GREEN}✓ {text}{Colors.ENDC}", flush=True)


def print_error(text: str):
    print(f"{Colors.RED}✗ {text}{Colors.ENDC}", flush=True)


def print_warning(text: str):
    print(f"{Colors.YELLOW}⚠ {text}{Colors.ENDC}", flush=True)


def print_info(text: str):
    print(f"{Colors.CYAN}ℹ {text}{Colors.ENDC}", flush=True)


class NotionDBCleaner:
    """Notion 邮件数据库清理工具"""

    def __init__(self):
        self.notion_client = None
        self.all_pages: List[Dict] = []

        # message_id -> page 映射（用于 Parent Item 查找）
        self.message_id_to_page: Dict[str, Dict] = {}

        # 统计
        self.stats = {
            "total_pages": 0,
            "duplicates_found": 0,
            "duplicates_deleted": 0,
            "parent_set": 0,
            "parent_removed": 0,
            "parent_missing": 0,
            "no_thread_id": 0,
            "errors": 0
        }

    async def init_notion(self) -> bool:
        try:
            from notion_client import AsyncClient
            self.notion_client = AsyncClient(auth=config.notion_token)
            await self.notion_client.databases.retrieve(database_id=config.email_database_id)
            print_success("Notion 连接成功")
            return True
        except Exception as e:
            print_error(f"Notion 连接失败: {e}")
            return False

    async def fetch_all_pages(self):
        """获取所有 Notion 页面"""
        print_info("获取所有 Notion 页面...")

        self.all_pages = []
        self.message_id_to_page = {}
        has_more = True
        start_cursor = None

        while has_more:
            query_params = {
                "database_id": config.email_database_id,
                "page_size": 100,
                "sorts": [{"timestamp": "created_time", "direction": "ascending"}]  # 从旧到新
            }
            if start_cursor:
                query_params["start_cursor"] = start_cursor

            results = await self.notion_client.databases.query(**query_params)

            for page in results.get("results", []):
                props = page.get("properties", {})

                # 提取 Message ID
                msg_id_texts = props.get("Message ID", {}).get("rich_text", [])
                message_id = msg_id_texts[0].get("text", {}).get("content", "") if msg_id_texts else ""

                # 提取 Thread ID
                thread_id_texts = props.get("Thread ID", {}).get("rich_text", [])
                thread_id = thread_id_texts[0].get("text", {}).get("content", "") if thread_id_texts else ""

                # 提取 Subject
                subj_texts = props.get("Subject", {}).get("title", [])
                subject = subj_texts[0].get("text", {}).get("content", "") if subj_texts else ""

                # 提取 Parent Item
                parent_rel = props.get("Parent Item", {}).get("relation", [])
                parent_id = parent_rel[0].get("id") if parent_rel else None

                page_data = {
                    "page_id": page["id"],
                    "created_time": page.get("created_time", ""),
                    "message_id": message_id,
                    "thread_id": thread_id,
                    "subject": subject,
                    "parent_id": parent_id
                }

                self.all_pages.append(page_data)

                # 建立 message_id -> page 映射（用于 Parent Item 查找）
                if message_id:
                    self.message_id_to_page[message_id] = page_data

            has_more = results.get("has_more", False)
            start_cursor = results.get("next_cursor")
            print(f"\r  已获取 {len(self.all_pages)} 个页面...", end="", flush=True)

        print(f"\r  已获取 {len(self.all_pages)} 个页面    ")
        self.stats["total_pages"] = len(self.all_pages)

    async def step1_dedup(self, dry_run: bool = False):
        """Step 1: 根据 Message ID 去重"""
        print_header("Step 1: 去重（按 Message ID）")

        # 按 Message ID 分组
        msg_id_to_pages: Dict[str, List[Dict]] = defaultdict(list)

        for page in self.all_pages:
            msg_id = page.get("message_id", "")
            if msg_id:
                msg_id_to_pages[msg_id].append(page)

        # 找出重复的
        duplicates = {k: v for k, v in msg_id_to_pages.items() if len(v) > 1}

        if not duplicates:
            print_success("没有发现重复的 Message ID")
            return

        total_dup_pages = sum(len(v) - 1 for v in duplicates.values())  # 每组保留 1 个
        self.stats["duplicates_found"] = total_dup_pages
        print_warning(f"发现 {len(duplicates)} 个重复的 Message ID，涉及 {total_dup_pages} 个待删除页面")

        # 显示示例
        print("\n重复详情（前 5 个）:")
        for i, (msg_id, pages) in enumerate(list(duplicates.items())[:5]):
            print(f"\n  Message ID: {msg_id[:50]}... ({len(pages)} 个页面)")
            # 按创建时间排序（旧的在前）
            sorted_pages = sorted(pages, key=lambda x: x.get("created_time", ""))
            for j, p in enumerate(sorted_pages):
                status = "保留" if j == 0 else "删除"
                print(f"    [{status}] {p['subject'][:35]}... (created: {p['created_time'][:19]})")

        if dry_run:
            print_info(f"预览模式：将删除 {total_dup_pages} 个重复页面")
            return

        # 执行删除
        print_info(f"开始删除 {total_dup_pages} 个重复页面...")

        deleted = 0
        for msg_id, pages in duplicates.items():
            # 按创建时间排序，保留最老的
            sorted_pages = sorted(pages, key=lambda x: x.get("created_time", ""))

            # 删除除第一个之外的所有页面
            for page in sorted_pages[1:]:
                try:
                    await self.notion_client.pages.update(
                        page_id=page["page_id"],
                        archived=True  # 归档（软删除）
                    )
                    deleted += 1
                    print(f"  [{deleted}/{total_dup_pages}] 删除: {page['subject'][:40]}...")
                    await asyncio.sleep(0.1)
                except Exception as e:
                    print_error(f"删除失败: {e}")
                    self.stats["errors"] += 1

        self.stats["duplicates_deleted"] = deleted
        print_success(f"已删除 {deleted} 个重复页面")

        # 更新 all_pages，移除已删除的
        deleted_ids = set()
        for pages in duplicates.values():
            sorted_pages = sorted(pages, key=lambda x: x.get("created_time", ""))
            for page in sorted_pages[1:]:
                deleted_ids.add(page["page_id"])

        self.all_pages = [p for p in self.all_pages if p["page_id"] not in deleted_ids]

        # 重建 message_id_to_page 映射
        self.message_id_to_page = {p["message_id"]: p for p in self.all_pages if p.get("message_id")}

    async def step2_set_parent(self, dry_run: bool = False):
        """Step 2: 设置 Parent Item（根据 Thread ID 关联）

        逻辑：
        - 如果页面有 Thread ID，查找 Message ID 等于该 Thread ID 的页面
        - 如果找到，设置 Parent Item 为该页面
        - 如果没找到，报错说明缺失该线程的邮件头
        - 如果没有 Thread ID，说明是第一封邮件，不需要 Parent
        - 如果没有 Thread ID 但有 Parent Item，说明之前关联错了，需要移除
        """
        print_header("Step 2: 设置 Parent Item（按 Thread ID）")

        to_set = []  # 需要设置 Parent 的页面
        to_remove = []  # 需要移除 Parent 的页面（没有 Thread ID 但有 Parent）
        missing_parents = []  # 缺失父邮件的页面

        for page in self.all_pages:
            thread_id = page.get("thread_id", "")
            current_parent = page.get("parent_id")

            # 没有 Thread ID，说明是第一封邮件
            if not thread_id:
                self.stats["no_thread_id"] += 1
                # 如果有 Parent Item，说明之前关联错了，需要移除
                if current_parent:
                    to_remove.append({
                        "page": page,
                        "current_parent": current_parent
                    })
                continue

            # 查找 Message ID 等于 Thread ID 的页面
            parent_page = self.message_id_to_page.get(thread_id)

            if parent_page:
                # 找到了父邮件
                parent_page_id = parent_page["page_id"]

                # 检查是否已经正确设置
                if current_parent != parent_page_id:
                    to_set.append({
                        "page": page,
                        "parent_page_id": parent_page_id,
                        "parent_subject": parent_page.get("subject", "")[:30]
                    })
            else:
                # 没找到父邮件
                missing_parents.append({
                    "page": page,
                    "thread_id": thread_id
                })

        # 报告统计
        print_info(f"无 Thread ID（第一封邮件）: {self.stats['no_thread_id']} 个")
        print_info(f"需要设置 Parent: {len(to_set)} 个")
        print_warning(f"需要移除错误 Parent: {len(to_remove)} 个")
        print_warning(f"缺失父邮件: {len(missing_parents)} 个")

        # 显示需要移除的 Parent
        if to_remove:
            print("\n需要移除错误 Parent 详情（前 10 个）:")
            for item in to_remove[:10]:
                p = item["page"]
                print(f"  - {p['subject'][:50]}...")

        # 显示缺失的父邮件
        if missing_parents:
            self.stats["parent_missing"] = len(missing_parents)
            print("\n缺失父邮件详情（前 10 个）:")
            for item in missing_parents[:10]:
                p = item["page"]
                print(f"  - {p['subject'][:45]}...")
                print(f"    Thread ID: {item['thread_id'][:60]}...")

        if dry_run:
            if to_remove:
                print_info(f"\n预览模式：将移除 {len(to_remove)} 个页面的错误 Parent Item")
            if to_set:
                print_info(f"预览模式：将设置 {len(to_set)} 个页面的 Parent Item")
                for item in to_set[:5]:
                    p = item["page"]
                    print(f"  {p['subject'][:35]}...")
                    print(f"    → Parent: {item['parent_subject']}...")
            if not to_remove and not to_set:
                print_success("所有 Parent Item 都已正确设置")
            return

        # 执行移除错误 Parent
        if to_remove:
            print_info(f"\n开始移除 {len(to_remove)} 个页面的错误 Parent Item...")
            remove_count = 0
            for item in to_remove:
                page = item["page"]
                try:
                    await self.notion_client.pages.update(
                        page_id=page["page_id"],
                        properties={
                            "Parent Item": {"relation": []}  # 清空关联
                        }
                    )
                    remove_count += 1
                    if remove_count % 20 == 0:
                        print(f"  已移除 {remove_count}/{len(to_remove)}...")
                    await asyncio.sleep(0.1)
                except Exception as e:
                    print_error(f"移除 Parent 失败: {e}")
                    self.stats["errors"] += 1

            self.stats["parent_removed"] = remove_count
            print_success(f"已移除 {remove_count} 个页面的错误 Parent Item")

        # 执行设置 Parent
        if to_set:
            print_info(f"\n开始设置 {len(to_set)} 个页面的 Parent Item...")
            set_count = 0
            for item in to_set:
                page = item["page"]
                try:
                    await self.notion_client.pages.update(
                        page_id=page["page_id"],
                        properties={
                            "Parent Item": {"relation": [{"id": item["parent_page_id"]}]}
                        }
                    )
                    set_count += 1
                    if set_count % 20 == 0:
                        print(f"  已设置 {set_count}/{len(to_set)}...")
                    await asyncio.sleep(0.1)
                except Exception as e:
                    print_error(f"设置 Parent 失败: {e}")
                    self.stats["errors"] += 1

            self.stats["parent_set"] = set_count
            print_success(f"已设置 {set_count} 个页面的 Parent Item")

        if not to_remove and not to_set:
            print_success("所有 Parent Item 都已正确设置")

    async def run(
        self,
        dry_run: bool = False,
        dedup_only: bool = False,
        parent_only: bool = False
    ):
        """执行清理"""
        print_header("Notion 邮件数据库清理")

        # 初始化
        if not await self.init_notion():
            return False

        # 获取所有页面
        await self.fetch_all_pages()

        # 根据选项决定执行哪些步骤
        run_all = not (dedup_only or parent_only)

        # Step 1: 去重
        if run_all or dedup_only:
            await self.step1_dedup(dry_run)

        # Step 2: 设置 Parent Item
        if run_all or parent_only:
            # 如果执行了去重，需要重新获取页面
            if dedup_only and not dry_run:
                print_info("重新获取页面数据...")
                await self.fetch_all_pages()

            await self.step2_set_parent(dry_run)

        # 统计
        print_header("清理完成")
        print(f"""
  📊 统计结果:
  ─────────────────────────
  总页面数:          {self.stats['total_pages']}
  发现重复:          {self.stats['duplicates_found']}
  已删除重复:        {self.stats['duplicates_deleted']}
  无 Thread ID:      {self.stats['no_thread_id']}
  Parent 已设置:     {self.stats['parent_set']}
  Parent 已移除:     {self.stats['parent_removed']}
  缺失父邮件:        {self.stats['parent_missing']}
  错误:              {self.stats['errors']}
  ─────────────────────────
        """)

        if dry_run:
            print_info("以上为预览模式，未实际执行修改")

        return True


async def main():
    parser = argparse.ArgumentParser(description="Notion 邮件数据库清理")
    parser.add_argument("--dry-run", action="store_true", help="预览模式，不实际执行")
    parser.add_argument("--dedup-only", action="store_true", help="只执行去重")
    parser.add_argument("--parent-only", action="store_true", help="只执行 Parent Item 设置")

    args = parser.parse_args()

    cleaner = NotionDBCleaner()
    await cleaner.run(
        dry_run=args.dry_run,
        dedup_only=args.dedup_only,
        parent_only=args.parent_only
    )


if __name__ == "__main__":
    asyncio.run(main())
