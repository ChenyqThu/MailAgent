from typing import Dict, List, Optional, Set

from loguru import logger


class QueryOps:
    def __init__(self, *, client):
        self.client = client

    async def update_parent_item(self, page_id: str, parent_page_id: str) -> bool:
        """更新邮件的 Parent Item 关联

        用于在线程头邮件同步后，更新子邮件的关联。

        Args:
            page_id: 子邮件的 page_id
            parent_page_id: 线程头邮件的 page_id

        Returns:
            是否成功
        """
        try:
            await self.client.client.pages.update(
                page_id=page_id,
                properties={
                    "Parent Item": {
                        "relation": [{"id": parent_page_id}]
                    }
                }
            )
            logger.debug(f"Updated Parent Item: {page_id} -> {parent_page_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to update Parent Item for {page_id}: {e}")
            return False

    async def query_all_message_ids(self) -> Set[str]:
        """查询所有已同步邮件的 message_id

        新架构使用 message_id 作为唯一标识。

        Returns:
            message_id 集合
        """
        message_ids: Set[str] = set()

        try:
            logger.info("Querying all message IDs from Notion database...")
            ds_id = await self.client.get_data_source_id(self.client.email_db_id)

            filter_conditions = {
                "property": "Message ID",
                "rich_text": {"is_not_empty": True}
            }

            has_more = True
            start_cursor = None

            while has_more:
                query_params = {
                    "data_source_id": ds_id,
                    "filter": filter_conditions,
                    "page_size": 100
                }

                if start_cursor:
                    query_params["start_cursor"] = start_cursor

                results = await self.client.client.data_sources.query(**query_params)

                for page in results.get("results", []):
                    msg_id_prop = page.get("properties", {}).get("Message ID", {})
                    rich_text = msg_id_prop.get("rich_text", [])
                    if rich_text:
                        message_id = rich_text[0].get("text", {}).get("content", "")
                        if message_id:
                            message_ids.add(message_id)

                has_more = results.get("has_more", False)
                start_cursor = results.get("next_cursor")

            logger.info(f"Found {len(message_ids)} existing message IDs in Notion")
            return message_ids

        except Exception as e:
            logger.error(f"Failed to query message IDs: {e}")
            return message_ids

    async def query_all_row_ids(self) -> Set[int]:
        """查询所有已同步邮件的 row_id（启动时调用）

        查询 Notion 数据库中所有 Row ID 不为空的页面
        返回 row_id 集合
        """
        row_ids: Set[int] = set()

        try:
            logger.info("Querying all row IDs from Notion database...")
            ds_id = await self.client.get_data_source_id(self.client.email_db_id)

            filter_conditions = {
                "property": "Row ID",
                "number": {"is_not_empty": True}
            }

            has_more = True
            start_cursor = None

            while has_more:
                query_params = {
                    "data_source_id": ds_id,
                    "filter": filter_conditions,
                    "page_size": 100
                }

                if start_cursor:
                    query_params["start_cursor"] = start_cursor

                results = await self.client.client.data_sources.query(**query_params)

                for page in results.get("results", []):
                    row_id_prop = page.get("properties", {}).get("Row ID", {})
                    row_id_value = row_id_prop.get("number")
                    if row_id_value is not None:
                        row_ids.add(int(row_id_value))

                has_more = results.get("has_more", False)
                start_cursor = results.get("next_cursor")

            logger.info(f"Found {len(row_ids)} existing row IDs in Notion")
            return row_ids

        except Exception as e:
            logger.error(f"Failed to query row IDs: {e}")
            return row_ids

    async def query_pages_for_reverse_sync(self) -> List[Dict]:
        """查询需要反向同步的页面

        条件:
        - Processing Status = 'AI Reviewed'
        - Synced to Mail = False (checkbox)

        Returns:
            页面列表，每个包含 page_id, message_id, ai_action
        """
        pages = []

        try:
            logger.debug("Querying pages for reverse sync...")
            ds_id = await self.client.get_data_source_id(self.client.email_db_id)

            filter_conditions = {
                "and": [
                    {
                        "property": "Processing Status",
                        "select": {"equals": "AI Reviewed"}
                    },
                    {
                        "property": "Synced to Mail",
                        "checkbox": {"equals": False}
                    }
                ]
            }

            has_more = True
            start_cursor = None

            while has_more:
                query_params = {
                    "data_source_id": ds_id,
                    "filter": filter_conditions,
                    "page_size": 100
                }

                if start_cursor:
                    query_params["start_cursor"] = start_cursor

                results = await self.client.client.data_sources.query(**query_params)

                for page in results.get("results", []):
                    props = page.get("properties", {})

                    # 提取 Message ID
                    message_id_prop = props.get("Message ID", {})
                    message_id_texts = message_id_prop.get("rich_text", [])
                    message_id = message_id_texts[0].get("text", {}).get("content", "") if message_id_texts else ""

                    # 提取 AI Action
                    ai_action_prop = props.get("Action Type", {})
                    ai_action = ai_action_prop.get("select", {})
                    ai_action_name = ai_action.get("name", "") if ai_action else ""

                    # 提取 Subject (title)
                    subject_prop = props.get("Subject", {})
                    subject_titles = subject_prop.get("title", [])
                    subject = subject_titles[0].get("text", {}).get("content", "") if subject_titles else ""

                    # 提取 From Name / From
                    from_name = ""
                    from_name_prop = props.get("From Name", {})
                    from_name_texts = from_name_prop.get("rich_text", [])
                    if from_name_texts:
                        from_name = from_name_texts[0].get("text", {}).get("content", "")

                    from_email = ""
                    from_prop = props.get("From", {})
                    from_email = from_prop.get("email", "") or ""

                    # 提取 To / CC (rich_text)
                    to_addr = ""
                    to_prop = props.get("To", {})
                    to_texts = to_prop.get("rich_text", [])
                    if to_texts:
                        to_addr = "".join(t.get("text", {}).get("content", "") for t in to_texts)

                    cc_addr = ""
                    cc_prop = props.get("CC", {})
                    cc_texts = cc_prop.get("rich_text", [])
                    if cc_texts:
                        cc_addr = "".join(t.get("text", {}).get("content", "") for t in cc_texts)

                    # 提取 Date
                    date_str = ""
                    date_prop = props.get("Date", {})
                    date_val = date_prop.get("date")
                    if date_val:
                        date_str = date_val.get("start", "")

                    # 提取 AI Priority (select, 可能不存在)
                    ai_priority = ""
                    ai_priority_prop = props.get("Priority", {})
                    ai_priority_sel = ai_priority_prop.get("select")
                    if ai_priority_sel:
                        ai_priority = ai_priority_sel.get("name", "")

                    # 提取 Mailbox (select)
                    mailbox = ""
                    mailbox_prop = props.get("Mailbox", {})
                    mailbox_sel = mailbox_prop.get("select")
                    if mailbox_sel:
                        mailbox = mailbox_sel.get("name", "")

                    # 提取 AI Summary
                    ai_summary = ""
                    summary_prop = props.get("AI Summary", {})
                    summary_texts = summary_prop.get("rich_text", [])
                    if summary_texts:
                        ai_summary = "".join(t.get("text", {}).get("content", "") for t in summary_texts)

                    # 提取 ID (number)
                    row_id = None
                    id_prop = props.get("ID", {})
                    row_id = id_prop.get("number")

                    # 提取 Category
                    category = ""
                    cat_prop = props.get("Category", {})
                    cat_sel = cat_prop.get("select")
                    if cat_sel:
                        category = cat_sel.get("name", "")

                    # 提取 Reply Suggestion
                    reply_suggestion = ""
                    reply_prop = props.get("Reply Suggestion", {})
                    reply_texts = reply_prop.get("rich_text", [])
                    if reply_texts:
                        reply_suggestion = "".join(t.get("text", {}).get("content", "") for t in reply_texts)

                    pages.append({
                        "page_id": page["id"],
                        "message_id": message_id,
                        "ai_action": ai_action_name,
                        "subject": subject,
                        "from_name": from_name,
                        "from_email": from_email,
                        "to_addr": to_addr,
                        "cc_addr": cc_addr,
                        "date": date_str,
                        "ai_priority": ai_priority,
                        "mailbox": mailbox,
                        "ai_summary": ai_summary,
                        "row_id": row_id,
                        "category": category,
                        "reply_suggestion": reply_suggestion,
                    })

                has_more = results.get("has_more", False)
                start_cursor = results.get("next_cursor")

            if pages:
                logger.info(f"Found {len(pages)} pages for reverse sync")
            return pages

        except Exception as e:
            logger.error(f"Failed to query pages for reverse sync: {e}")
            return pages

    async def update_page_mail_sync_status(
        self,
        page_id: str,
        synced: bool = True,
        processing_status: str = ""
    ):
        """更新页面的邮件同步状态"""
        try:
            properties = {
                "Synced to Mail": {"checkbox": synced},
            }
            if processing_status:
                properties["Processing Status"] = {"select": {"name": processing_status}}

            await self.client.client.pages.update(
                page_id=page_id,
                properties=properties
            )
            logger.info(f"Mail sync status updated: {page_id} status={processing_status or 'unchanged'}")

        except Exception as e:
            logger.error(f"Failed to update mail sync status for {page_id}: {e}")
            raise

    async def update_email_flags(
        self,
        page_id: str,
        is_read: bool,
        is_flagged: bool,
        processing_status: str = ""
    ):
        """更新邮件的 Is Read / Is Flagged 状态到 Notion"""
        try:
            properties = {
                "Is Read": {"checkbox": is_read},
                "Is Flagged": {"checkbox": is_flagged},
            }
            if processing_status:
                properties["Processing Status"] = {"select": {"name": processing_status}}

            await self.client.client.pages.update(
                page_id=page_id,
                properties=properties
            )

            logger.debug(f"Flags updated for {page_id}: read={is_read}, flagged={is_flagged}, status={processing_status or 'unchanged'}")

        except Exception as e:
            logger.error(f"Failed to update flags for {page_id}: {e}")
            raise

    async def query_by_row_id(self, row_id: int) -> Optional[Dict]:
        """通过 row_id 查询页面是否已存在

        Args:
            row_id: 数据库行 ID

        Returns:
            页面信息（如果存在），否则返回 None
        """
        try:
            filter_conditions = {
                "property": "Row ID",
                "number": {"equals": row_id}
            }

            results = await self.client.query_database(filter_conditions=filter_conditions)

            if results:
                page = results[0]
                return {
                    "page_id": page["id"],
                    "row_id": row_id
                }

            return None

        except Exception as e:
            logger.error(f"Failed to query by row_id {row_id}: {e}")
            return None
