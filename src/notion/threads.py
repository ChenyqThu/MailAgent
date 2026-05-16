from datetime import datetime
from typing import Any, Dict, List, Optional

from loguru import logger

from src.models import Email
from src.notion._common import BEIJING_TZ


class ThreadOps:
    def __init__(self, *, client, email_repo):
        self.client = client
        self._email_repo = email_repo

    async def _find_thread_parent_by_thread_id(self, thread_id: Optional[str]) -> Optional[str]:
        """通过 Thread ID (线程头邮件的 message_id) 查找 Parent Item

        新架构：thread_id 就是线程头邮件的 message_id。
        直接通过 Message ID 属性查找对应的 Notion 页面。

        Args:
            thread_id: 线程头邮件的 message_id

        Returns:
            线程头邮件的 page_id，如果没有则返回 None
        """
        if not thread_id:
            return None

        try:
            # 直接通过 Message ID 查找线程头邮件
            filter_conditions = {
                "property": "Message ID",
                "rich_text": {"equals": thread_id}
            }

            results = await self.client.query_database(
                filter_conditions=filter_conditions
            )

            if results:
                parent_page = results[0]
                parent_page_id = parent_page.get("id")
                logger.debug(f"Found thread parent by thread_id: {thread_id[:50]}... -> page_id={parent_page_id}")
                return parent_page_id

            logger.debug(f"Thread parent not found in Notion: {thread_id[:50]}...")
            return None

        except Exception as e:
            logger.warning(f"Failed to find thread parent for thread_id={thread_id[:50]}...: {e}")
            return None

    async def _find_all_thread_members_with_date(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> List[Dict[str, Any]]:
        """查找同一线程中的所有邮件（带日期信息）

        用于新架构的 Parent Item 关联：找到线程中所有邮件，
        比较日期以确定最新邮件。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）

        Returns:
            邮件列表，每项包含 {page_id, message_id, date}
        """
        if not thread_id:
            return []

        try:
            ds_id = await self.client.get_data_source_id(self.client.email_db_id)
            results = await self.client.client.data_sources.query(
                data_source_id=ds_id,
                filter={
                    "property": "Thread ID",
                    "rich_text": {"equals": thread_id}
                },
                page_size=100
            )

            pages = results.get("results", [])
            thread_members = []

            for page in pages:
                page_id = page.get("id")
                props = page.get("properties", {})

                # 获取 message_id
                msg_id_texts = props.get("Message ID", {}).get("rich_text", [])
                msg_id = msg_id_texts[0].get("text", {}).get("content", "") if msg_id_texts else ""

                # 排除当前邮件
                if exclude_message_id and msg_id == exclude_message_id:
                    continue

                # 获取日期
                date_prop = props.get("Date", {}).get("date", {})
                date_str = date_prop.get("start", "") if date_prop else ""

                thread_members.append({
                    "page_id": page_id,
                    "message_id": msg_id,
                    "date": date_str
                })

            logger.debug(f"Found {len(thread_members)} thread members for: {thread_id[:30]}...")
            return thread_members

        except Exception as e:
            logger.warning(f"Failed to find thread members for thread_id={thread_id[:30]}...: {e}")
            return []

    async def update_sub_items(self, page_id: str, child_page_ids: List[str]) -> bool:
        """更新页面的 Sub-item 关系

        通过设置母节点的 Sub-item，Notion 双向关联会自动更新子节点的 Parent Item。

        Args:
            page_id: 母节点的 page_id
            child_page_ids: 子节点的 page_id 列表

        Returns:
            是否成功
        """
        if not child_page_ids:
            return True

        try:
            # 过滤和验证子页面 ID
            valid_child_ids = []
            seen = set()
            for pid in child_page_ids:
                if not pid or pid == page_id or pid in seen:
                    continue
                seen.add(pid)
                valid_child_ids.append(pid)

            if not valid_child_ids:
                return True

            # 1. 清空 parent 的 Parent Item（避免循环引用）
            await self.client.client.pages.update(
                page_id=page_id,
                properties={"Parent Item": {"relation": []}}
            )

            # 2. 设置 parent 的 Sub-item（Notion 双向关联会自动更新子节点的 Parent Item）
            relations = [{"id": pid} for pid in valid_child_ids]
            await self.client.client.pages.update(
                page_id=page_id,
                properties={"Sub-item": {"relation": relations}}
            )

            logger.debug(f"Updated Sub-item for {page_id}: {len(valid_child_ids)} children")
            return True

        except Exception as e:
            logger.error(f"Failed to update Sub-item for {page_id}: {e}")
            return False

    def _parse_date_to_beijing(self, date_str: str) -> Optional[datetime]:
        """将日期字符串转换为北京时间 datetime 对象

        支持的格式：
        - ISO 格式: 2026-01-27T09:14:00+08:00
        - Notion 格式: 2026-01-27T09:14:00.000+08:00

        Args:
            date_str: 日期字符串

        Returns:
            北京时间的 datetime 对象，解析失败返回 None
        """
        if not date_str:
            return None

        try:
            # 处理 Notion 返回的毫秒格式: 2026-01-27T09:14:00.000+08:00
            # Python 3.11+ 的 fromisoformat 可以处理这种格式
            # 但为了兼容，移除毫秒部分
            import re
            # 移除毫秒（.000 或 .123456 等）
            normalized = re.sub(r'\.\d+', '', date_str)
            dt = datetime.fromisoformat(normalized)
            # 转换为北京时间
            return dt.astimezone(BEIJING_TZ)
        except Exception as e:
            logger.warning(f"Failed to parse date string '{date_str}': {e}")
            return None

    async def handle_thread_relations(self, page_id: str, email: Email):
        """处理线程关系（新架构：最新邮件为母节点）.

        Phase 4 R-02 改造：SQLite SSoT 优先 + Notion fallback。
        数据源（改造点）：
        - 优先用 self._email_repo.get_thread_members(...) 从 SQLite 查
        - SQLite 没找到 + config.thread_relations_fallback_to_notion=True → 兜底 Notion API
        - thread_relations_fallback_to_notion=False 且 SQLite miss → 直接 return（信任 SSoT）
        """
        thread_id = email.thread_id
        if not thread_id:
            return

        try:
            # 1. SQLite 优先 (R-02)
            sqlite_members = self._email_repo.get_thread_members(
                thread_id=thread_id,
                exclude_internal_id=email.internal_id if email.internal_id else None,
                synced_only=True,
            )

            # 转 dict 列表（兼容后续逻辑 'page_id' / 'date' key）
            thread_members: List[Dict[str, Any]] = []
            for m in sqlite_members:
                if not m.page_id:
                    continue
                thread_members.append({
                    'page_id': m.page_id,
                    'date': m.date_received or '',
                })

            # 2. SQLite 空 + 灰度开关允许 → Notion API fallback
            if not thread_members:
                from src.config import config as app_config
                if app_config.thread_relations_fallback_to_notion:
                    logger.debug(
                        f"[R-02] SQLite missed thread {thread_id[:30]}, falling back to Notion API"
                    )
                    thread_members = await self._find_all_thread_members_with_date(
                        thread_id,
                        exclude_message_id=email.message_id,
                    )

            if not thread_members:
                logger.debug("No other thread members found, this is the only email in thread")
                return

            # 3. 当前邮件北京时间
            current_dt = None
            if email.date:
                if email.date.tzinfo is None:
                    current_dt = email.date.replace(tzinfo=BEIJING_TZ)
                else:
                    current_dt = email.date.astimezone(BEIJING_TZ)

            # 4. 找最新成员
            for member in thread_members:
                member['date_dt'] = self._parse_date_to_beijing(member.get('date', ''))

            valid_members = [m for m in thread_members if m.get('date_dt')]
            if not valid_members:
                logger.warning("No valid dates found in thread members, skipping relation handling")
                return

            latest_member = max(valid_members, key=lambda x: x['date_dt'])
            latest_dt = latest_member['date_dt']

            is_current_latest = current_dt is not None and current_dt >= latest_dt
            if is_current_latest:
                all_other_page_ids = [m['page_id'] for m in thread_members]
                logger.info(
                    f"Current email is the latest ({current_dt} >= {latest_dt}), "
                    f"setting Sub-item with {len(all_other_page_ids)} members"
                )
                await self.update_sub_items(page_id, all_other_page_ids)
            else:
                latest_page_id = latest_member['page_id']
                logger.info(
                    f"Current email is not the latest ({current_dt} < {latest_dt}), "
                    f"updating latest email's Sub-item"
                )
                all_non_latest = [m['page_id'] for m in thread_members if m['page_id'] != latest_page_id]
                all_non_latest.append(page_id)
                await self.update_sub_items(latest_page_id, all_non_latest)

        except Exception as e:
            logger.warning(f"Failed to handle thread relations for {email.message_id[:30]}...: {e}")
