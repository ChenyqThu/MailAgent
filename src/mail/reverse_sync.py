"""
反向同步模块: Notion -> Mail.app

当 AI 审核完邮件后，根据 Action Type 同步操作到 Mail.app，并对重要邮件发送飞书通知。

Action Type → Mail.app 操作映射:
- 需要回复/需要决策/需要Review/需要会议/需要跟进/等待响应 → 设置旗标
- 仅供参考/已完结 → 标记已读
"""

from datetime import datetime
from typing import Dict, Optional
from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.sync_store import SyncStore
from src.mail.sqlite_radar import SQLiteRadar
from src.notion.sync import NotionSync
from src.config import config


class NotionToMailSync:
    """反向同步: Notion -> Mail.app"""

    # Action Type → Mail.app 操作映射
    FLAG_ACTIONS = {"需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应"}
    READ_ACTIONS = {"仅供参考", "已完结"}

    # 飞书通知触发条件
    NOTIFY_ACTIONS = {"需要回复", "需要决策"}
    NOTIFY_PRIORITIES = {"🔴 紧急", "🟡 重要"}

    def __init__(
        self,
        notion_sync: NotionSync,
        arm: AppleScriptArm = None,
        sync_store: SyncStore = None,
        skip_notify: bool = False,
    ):
        if notion_sync is None:
            raise TypeError(
                "NotionToMailSync requires notion_sync to be injected (R-01 strict DI)"
            )
        self.notion_sync = notion_sync
        self.arm = arm or AppleScriptArm()
        self.sync_store = sync_store
        self._skip_notify = skip_notify
        self.last_check: Optional[datetime] = None
        self.sync_count = 0
        self.error_count = 0
        self.notify_count = 0

        self._feishu = None
        if config.feishu_notify_enabled:
            from src.notify.feishu import FeishuNotifier
            self._feishu = FeishuNotifier(
                app_id=config.feishu_app_id,
                app_secret=config.feishu_app_secret,
                chat_id=config.feishu_chat_id,
                webhook_url=config.feishu_webhook_url,
                secret=config.feishu_webhook_secret,
                database_id=config.email_database_id,
            )
            mode = "app_api" if config.feishu_app_id else "webhook"
            logger.info(f"Feishu notification enabled (mode={mode})")

        logger.info("NotionToMailSync initialized")

    async def close(self):
        if self._feishu:
            await self._feishu.close()

    async def check_and_sync(self) -> Dict[str, int]:
        """检查 Notion 状态变更并同步到 Mail.app"""
        stats = {"synced": 0, "failed": 0, "skipped": 0, "notified": 0}

        try:
            pages = await self.notion_sync.query_pages_for_reverse_sync()

            if not pages:
                logger.debug("No pages need reverse sync")
                self.last_check = datetime.now()
                return stats

            logger.info(f"Found {len(pages)} pages for reverse sync")

            for page in pages:
                try:
                    success = await self.sync_single_page(page)
                    if success:
                        stats["synced"] += 1
                        if await self._try_notify(page):
                            stats["notified"] += 1
                    else:
                        stats["skipped"] += 1
                except Exception as e:
                    logger.error(f"Failed to sync page {page.get('page_id', '?')}: {e}")
                    stats["failed"] += 1

            self.sync_count += stats["synced"]
            self.error_count += stats["failed"]
            self.notify_count += stats["notified"]

            logger.info(
                f"Reverse sync: synced={stats['synced']}, "
                f"failed={stats['failed']}, notified={stats['notified']}"
            )

        except Exception as e:
            logger.error(f"Reverse sync check failed: {e}")

        self.last_check = datetime.now()
        return stats

    async def sync_single_page(self, page: Dict) -> bool:
        """同步单个 Notion 页面到 Mail.app"""
        page_id = page.get("page_id")
        message_id = page.get("message_id")
        ai_action = page.get("ai_action", "")
        mailbox = page.get("mailbox") or None

        if not message_id:
            logger.warning(f"Page {page_id} has no Message ID, skipping")
            return False

        msg_short = message_id[:40] + "..." if len(message_id) > 40 else message_id
        logger.info(f"Syncing to Mail: {msg_short} action={ai_action}")

        internal_id = self._lookup_internal_id(message_id)
        page["internal_id"] = internal_id  # 注入供通知回调使用

        # 邮件已不在 Mail.app 中（被删除/移动），直接标记已同步
        if not internal_id:
            logger.info(f"Email not found in Mail.app, marking as synced: {msg_short}")
            try:
                await self.notion_sync.update_page_mail_sync_status(
                    page_id, synced=True, processing_status="已同步"
                )
            except Exception as e:
                logger.error(f"Failed to update Notion sync status: {e}")
                return False
            return True

        # 根据 Action Type 决定操作
        if ai_action in self.FLAG_ACTIONS:
            success = self._do_mark_read_and_flag(internal_id, message_id, mailbox)
        elif ai_action in self.READ_ACTIONS:
            success = self._do_mark_read(internal_id, message_id, mailbox)
        else:
            if ai_action:
                logger.warning(f"Unknown action '{ai_action}', defaulting to mark as read")
            success = self._do_mark_read(internal_id, message_id, mailbox)

        # 操作失败（邮件可能已被删除），仍标记已同步防止无限重试
        if not success:
            logger.warning(f"Mail.app action failed (email may be deleted), marking synced: {msg_short}")

        self._update_store_flags(internal_id, ai_action)
        try:
            await self.notion_sync.update_page_mail_sync_status(
                page_id, synced=True, processing_status="已同步"
            )
            logger.info(f"Reverse sync completed for {msg_short}")
        except Exception as e:
            logger.error(f"Failed to update Notion sync status: {e}")
            return False

        return True

    def _lookup_internal_id(self, message_id: str) -> Optional[int]:
        # 1. SyncStore 查找
        if self.sync_store:
            try:
                record = self.sync_store.get_by_message_id(message_id)
                if record:
                    iid = record.internal_id if hasattr(record, 'internal_id') else record.get('internal_id')
                    if iid:
                        return iid
            except Exception:
                pass

        # 2. Fallback: 直接查 Mail.app SQLite Envelope Index（毫秒级）
        try:
            radar = SQLiteRadar(account_url_prefix=config.mail_account_url_prefix)
            if radar.db_path:
                return radar.lookup_internal_id_by_message_id(message_id)
        except Exception as e:
            logger.debug(f"Envelope Index fallback failed: {e}")

        return None

    def _do_mark_read(self, internal_id: Optional[int], message_id: str, mailbox: str = None) -> bool:
        try:
            if internal_id:
                return self.arm.mark_as_read_by_id(internal_id, True, mailbox)
            return self.arm.mark_as_read(message_id, True, mailbox)
        except Exception as e:
            logger.error(f"mark_as_read failed: {e}")
            return False

    def _do_flag(self, internal_id: Optional[int], message_id: str, mailbox: str = None) -> bool:
        try:
            if internal_id:
                return self.arm.set_flag_by_id(internal_id, True, mailbox)
            return self.arm.set_flag(message_id, True, mailbox)
        except Exception as e:
            logger.error(f"set_flag failed: {e}")
            return False

    def _do_mark_read_and_flag(self, internal_id: Optional[int], message_id: str, mailbox: str = None) -> bool:
        try:
            if not self._do_mark_read(internal_id, message_id, mailbox):
                return False
            return self._do_flag(internal_id, message_id, mailbox)
        except Exception as e:
            logger.error(f"mark_read_and_flag failed: {e}")
            return False

    async def _try_notify(self, page: Dict) -> bool:
        if self._skip_notify or not self._feishu:
            return False

        ai_action = page.get("ai_action", "")
        ai_priority = page.get("ai_priority", "")

        # 发件箱不通知
        mailbox = page.get("mailbox", "")
        if mailbox == "发件箱":
            return False

        # 重要/紧急 且 需要行动
        should_notify = (
            ai_priority in self.NOTIFY_PRIORITIES
            and ai_action in self.FLAG_ACTIONS
        )

        if not should_notify:
            return False

        return await self._feishu.notify_important_email(page)

    def _update_store_flags(self, internal_id: Optional[int], ai_action: str):
        """Echo prevention: 反向同步后更新 SyncStore flags"""
        if not self.sync_store or not internal_id:
            return

        try:
            record = self.sync_store.get(internal_id)
            if not record:
                return

            is_read = record.get('is_read', False) if isinstance(record, dict) else getattr(record, 'is_read', False)
            is_flagged = record.get('is_flagged', False) if isinstance(record, dict) else getattr(record, 'is_flagged', False)

            if ai_action in self.FLAG_ACTIONS or ai_action in self.READ_ACTIONS:
                is_read = True
            if ai_action in self.FLAG_ACTIONS:
                is_flagged = True

            self.sync_store.update_local_flags(internal_id, bool(is_read), bool(is_flagged))
        except Exception as e:
            logger.warning(f"Failed to update store flags for echo prevention: {e}")

    def get_stats(self) -> Dict:
        return {
            "last_check": self.last_check.isoformat() if self.last_check else None,
            "total_synced": self.sync_count,
            "total_errors": self.error_count,
            "total_notified": self.notify_count,
        }
