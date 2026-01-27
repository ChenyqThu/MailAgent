"""
日历同步模块 - 将日历事件同步到 Notion
"""

from datetime import datetime
from typing import Dict, Any, Optional, List, Tuple
from loguru import logger
from notion_client import AsyncClient

from src.config import config
from src.models import CalendarEvent, EventStatus
from src.calendar_notion.description_parser import DescriptionParser


class CalendarNotionSync:
    """日历事件同步到 Notion"""

    def __init__(self):
        self.client = AsyncClient(auth=config.notion_token)
        self.database_id = config.calendar_database_id
        self.description_parser = DescriptionParser()

    async def sync_event(self, event: CalendarEvent) -> Tuple[str, str]:
        """
        同步单个事件到 Notion

        Args:
            event: 日历事件

        Returns:
            (action, page_id): action 为 'created'/'updated'/'skipped', page_id 为 Notion 页面 ID
        """
        try:
            # 检查事件是否已存在
            existing = await self._find_existing_event(event.event_id)

            if existing:
                # 检查是否需要更新
                if await self._needs_update(existing, event):
                    page_id = existing["id"]
                    await self._update_page(page_id, event)
                    logger.info(f"更新事件: {event.title}")
                    return ("updated", page_id)
                else:
                    logger.debug(f"跳过未变更事件: {event.title}")
                    return ("skipped", existing["id"])
            else:
                # 创建新页面
                page = await self._create_page(event)
                logger.info(f"创建事件: {event.title}")
                return ("created", page["id"])

        except Exception as e:
            logger.error(f"同步事件失败 [{event.title}]: {e}")
            raise

    async def sync_events(self, events: List[CalendarEvent]) -> Dict[str, int]:
        """
        批量同步事件

        Args:
            events: 事件列表

        Returns:
            统计信息 {'created': n, 'updated': n, 'skipped': n, 'failed': n}
        """
        stats = {"created": 0, "updated": 0, "skipped": 0, "failed": 0}

        for event in events:
            try:
                action, _ = await self.sync_event(event)
                stats[action] += 1
            except Exception:
                stats["failed"] += 1

        return stats

    async def _find_existing_event(self, event_id: str) -> Optional[Dict[str, Any]]:
        """根据 Event ID 查找已存在的事件"""
        try:
            response = await self.client.databases.query(
                database_id=self.database_id,
                filter={
                    "property": "Event ID",
                    "rich_text": {"equals": event_id}
                }
            )
            results = response.get("results", [])
            return results[0] if results else None
        except Exception as e:
            logger.error(f"查询事件失败: {e}")
            return None

    async def _needs_update(self, existing: Dict[str, Any], event: CalendarEvent) -> bool:
        """
        检查事件是否需要更新

        策略：
        1. 如果事件有 last_modified，比较它与 Notion 中记录的 Last Modified
        2. 如果事件没有 last_modified（从未修改过），检查是否已同步过

        注意：Notion 存储的日期精度只到分钟，所以比较时需要截断到分钟级别
        """
        try:
            props = existing.get("properties", {})

            # 策略1：比较 Last Modified（事件本身的修改时间）
            if event.last_modified:
                notion_modified = props.get("Last Modified", {}).get("date")
                if notion_modified and notion_modified.get("start"):
                    notion_mod_str = notion_modified["start"]
                    notion_mod_dt = datetime.fromisoformat(notion_mod_str.replace("Z", "+00:00"))

                    # 统一转换为 UTC 无时区，并截断到分钟级别比较
                    event_mod = event.last_modified.replace(tzinfo=None, second=0, microsecond=0)
                    notion_mod = notion_mod_dt.replace(tzinfo=None, second=0, microsecond=0)

                    if event_mod > notion_mod:
                        logger.debug(f"事件已修改: {event_mod} > {notion_mod}")
                        return True
                    else:
                        logger.debug(f"事件未修改: {event_mod} <= {notion_mod}")
                        return False
                else:
                    # Notion 中没有记录 Last Modified，说明是旧数据，需要更新一次
                    logger.debug("Notion 中无 Last Modified 记录，需要更新")
                    return True

            # 策略2：事件没有 last_modified（从未修改过）
            # 检查是否已经同步过（通过 Last Synced 判断）
            notion_synced = props.get("Last Synced", {}).get("date")
            if notion_synced and notion_synced.get("start"):
                # 已经同步过，且事件没有修改，跳过
                logger.debug("事件无修改时间且已同步过，跳过")
                return False

            # 从未同步过，需要更新
            logger.debug("事件从未同步过，需要更新")
            return True

        except Exception as e:
            logger.debug(f"比较修改时间失败: {e}")
            return True

    async def _create_page(self, event: CalendarEvent) -> Dict[str, Any]:
        """创建 Notion 页面"""
        properties = self._build_properties(event)

        # 解析描述内容为 blocks
        children = self._build_content_blocks(event)

        # 根据状态设置 icon
        icon = self._get_status_icon(event)

        page = await self.client.pages.create(
            parent={"database_id": self.database_id},
            properties=properties,
            icon=icon,
            children=children if children else None
        )
        return page

    async def _update_page(self, page_id: str, event: CalendarEvent) -> Dict[str, Any]:
        """更新 Notion 页面"""
        properties = self._build_properties(event)

        # 根据状态设置 icon
        icon = self._get_status_icon(event)

        # 更新页面属性和 icon
        page = await self.client.pages.update(
            page_id=page_id,
            properties=properties,
            icon=icon
        )

        # 更新页面内容（先删除旧内容，再添加新内容）
        await self._update_page_content(page_id, event)

        return page

    async def _update_page_content(self, page_id: str, event: CalendarEvent):
        """更新页面正文内容"""
        try:
            # 获取现有的 children blocks
            existing_blocks = await self.client.blocks.children.list(block_id=page_id)

            # 删除所有现有 blocks
            for block in existing_blocks.get("results", []):
                try:
                    await self.client.blocks.delete(block_id=block["id"])
                except Exception as e:
                    logger.debug(f"删除 block 失败: {e}")

            # 添加新的 blocks
            children = self._build_content_blocks(event)
            if children:
                await self.client.blocks.children.append(
                    block_id=page_id,
                    children=children
                )

        except Exception as e:
            logger.warning(f"更新页面内容失败: {e}")

    def _get_status_icon(self, event: CalendarEvent) -> Dict[str, Any]:
        """根据事件状态返回对应的 icon

        Args:
            event: 日历事件

        Returns:
            Notion icon 对象
        """
        # 取消的会议使用 ❌
        if event.status == EventStatus.CANCELLED:
            return {"type": "emoji", "emoji": "❌"}

        # 默认使用日期日历 icon（基于起始日期）
        date_str = event.start_time.strftime("%Y-%m-%d")
        icon_url = f"https://notion-icons.chenge.ink/?type=day&color=red&date={date_str}"
        return {
            "type": "external",
            "external": {"url": icon_url}
        }

    def _build_content_blocks(self, event: CalendarEvent) -> List[Dict[str, Any]]:
        """构建页面正文 blocks"""
        blocks = []

        # 解析描述内容
        if event.description:
            # 获取原始描述（未清理的版本）
            raw_description = getattr(event, '_raw_description', event.description)
            parsed_blocks = self.description_parser.parse(raw_description)
            blocks.extend(parsed_blocks)

        return blocks

    def _build_properties(self, event: CalendarEvent) -> Dict[str, Any]:
        """构建 Notion 页面属性"""
        from datetime import timezone
        now = datetime.now(timezone.utc).isoformat()

        properties = {
            # 标题
            "Title": {
                "title": [{"text": {"content": event.title[:2000]}}]
            },
            # Event ID
            "Event ID": {
                "rich_text": [{"text": {"content": event.event_id}}]
            },
            # Calendar
            "Calendar": {
                "select": {"name": "Exchange"}
            },
            # Time (包含起止时间)
            # 全天事件：只使用日期部分，Notion 会正确显示为全天
            # 跨天事件：需要包含 end 日期
            "Time": {
                "date": {
                    "start": event.start_time.date().isoformat() if event.is_all_day else event.start_time.isoformat(),
                    "end": event.end_time.date().isoformat() if event.is_all_day else event.end_time.isoformat()
                }
            },
            # Is All Day
            "Is All Day": {
                "checkbox": event.is_all_day
            },
            # Status
            "Status": {
                "select": {"name": event.status.value}
            },
            # Is Recurring
            "Is Recurring": {
                "checkbox": event.is_recurring
            },
            # Attendee Count
            "Attendee Count": {
                "number": event.attendee_count
            },
            # Sync Status
            "Sync Status": {
                "select": {"name": "synced"}
            },
            # Last Synced
            "Last Synced": {
                "date": {"start": now}
            }
        }

        # 可选字段
        if event.location:
            properties["Location"] = {
                "rich_text": [{"text": {"content": event.location[:2000]}}]
            }

        # Description 内容写入页面正文，不再写入属性字段

        # URL: 优先使用 Teams 会议链接，否则使用事件自带的 URL
        url_to_use = None
        if hasattr(event, '_raw_description') and event._raw_description:
            teams_info = self.description_parser._extract_teams_info(event._raw_description)
            if teams_info.join_url:
                url_to_use = teams_info.join_url
        if not url_to_use and event.url:
            url_to_use = event.url
        if url_to_use:
            properties["URL"] = {"url": url_to_use}

        if event.organizer:
            properties["Organizer"] = {
                "rich_text": [{"text": {"content": event.organizer[:2000]}}]
            }

        if event.organizer_email:
            properties["Organizer Email"] = {"email": event.organizer_email}

        if event.attendees:
            properties["Attendees"] = {
                "rich_text": [{"text": {"content": event.attendees_str[:2000]}}]
            }

        if event.recurrence_rule:
            properties["Recurrence Rule"] = {
                "rich_text": [{"text": {"content": event.recurrence_rule[:2000]}}]
            }

        if event.last_modified:
            properties["Last Modified"] = {
                "date": {"start": event.last_modified.isoformat()}
            }

        return properties
