"""
NewWatcher - 新架构邮件同步监听器

基于 message_id 的新架构：
- SQLite 雷达只检测 max_row_id 变化（触发器）
- AppleScript 获取最新 N 封邮件
- 使用 message_id 去重
- 使用 thread_id 关联 Parent Item

核心流程：
1. 雷达检测到新邮件 → 估算新邮件数量 N
2. AppleScript 获取最新 N+10 封邮件
3. 用 message_id 与 SyncStore 去重
4. 新邮件加入 SyncStore (pending)
5. 同步到 Notion（包括 Parent Item 关联）
6. 更新 SyncStore (synced)
7. 定期重试失败的邮件

Usage:
    watcher = NewWatcher()
    await watcher.start()
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Any, Callable, Awaitable
from loguru import logger

from src.config import config as settings
from src.models import Email, Attachment
from src.mail.sqlite_radar import SQLiteRadar
from src.mail.applescript_arm import AppleScriptArm
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.mail.reader import EmailReader
from src.mail.meeting_sync import MeetingInviteSync


def _parse_sync_start_date() -> Optional[datetime]:
    """解析同步起始日期配置

    用于缓存预热后的场景：历史邮件在 SyncStore 中（用于 Parent Item 查找），
    但只同步 SYNC_START_DATE 之后的邮件到 Notion。

    如果未配置或配置为空，则不过滤日期（正常启动后只同步新邮件）。

    Returns:
        同步起始日期（带时区），早于此日期的邮件不同步到 Notion
    """
    if not settings.sync_start_date:
        return None

    tz = timezone(timedelta(hours=8))  # 北京时区

    try:
        dt = datetime.strptime(settings.sync_start_date, "%Y-%m-%d")
        return dt.replace(tzinfo=tz)
    except ValueError:
        logger.warning(f"Invalid SYNC_START_DATE format: {settings.sync_start_date}, expected YYYY-MM-DD")
        return None


class NewWatcher:
    """新架构邮件同步监听器"""

    def __init__(
        self,
        mailboxes: List[str] = None,
        poll_interval: int = 5,
        sync_store_path: str = "data/sync_store.db"
    ):
        """初始化监听器

        Args:
            mailboxes: 要监听的邮箱列表，默认 ["收件箱", "发件箱"]
            poll_interval: 轮询间隔（秒），默认 5
            sync_store_path: SyncStore 数据库路径

        Raises:
            RuntimeError: 如果关键组件初始化失败
        """
        self.mailboxes = mailboxes or ["收件箱", "发件箱"]
        self.poll_interval = poll_interval

        # 解析同步起始日期
        self.sync_start_date = _parse_sync_start_date()
        if self.sync_start_date:
            logger.info(f"Sync start date: {self.sync_start_date.strftime('%Y-%m-%d')} (emails before this date will be cached but not synced to Notion)")

        # 初始化组件（带错误检查）
        try:
            self.radar = SQLiteRadar(mailboxes=self.mailboxes)
            if not self.radar.is_available():
                logger.warning("SQLite radar not available, will rely on AppleScript only")
        except Exception as e:
            logger.error(f"Failed to initialize SQLite radar: {e}")
            self.radar = None

        self.arm = AppleScriptArm(
            account_name=settings.mail_account_name,
            inbox_name=settings.mail_inbox_name
        )

        try:
            self.sync_store = SyncStore(sync_store_path)
        except Exception as e:
            logger.error(f"Failed to initialize SyncStore: {e}")
            raise RuntimeError(f"SyncStore initialization failed: {e}")

        self.notion_sync = NotionSync()
        self.email_reader = EmailReader()
        self.meeting_sync = MeetingInviteSync()  # 会议邀请同步器

        # 运行状态
        self._running = False
        self._healthy = True  # 服务健康状态
        self._stats = {
            "polls": 0,
            "new_emails_detected": 0,
            "emails_synced": 0,
            "emails_skipped": 0,  # 因日期过滤跳过的邮件
            "meeting_invites": 0,  # 检测到的会议邀请
            "retries_attempted": 0,
            "retries_succeeded": 0,
            "errors": 0,
            "consecutive_errors": 0  # 连续错误计数
        }

        logger.info(f"NewWatcher initialized: mailboxes={self.mailboxes}, poll_interval={poll_interval}s")

    def _check_health(self) -> bool:
        """检查服务健康状态

        Returns:
            True 如果所有关键组件正常
        """
        # 检查 SyncStore
        try:
            self.sync_store.get_stats()
        except Exception as e:
            logger.error(f"SyncStore health check failed: {e}")
            return False

        # 检查 radar（可选组件）
        if self.radar and not self.radar.is_available():
            logger.warning("SQLite radar became unavailable")

        return True

    async def start(self):
        """启动监听器"""
        if self._running:
            logger.warning("Watcher is already running")
            return

        # 启动前健康检查
        if not self._check_health():
            raise RuntimeError("Service health check failed, cannot start")

        self._running = True
        self._healthy = True
        logger.info("NewWatcher started")

        # 初始化：从 SyncStore 恢复 last_max_row_id
        last_max_row_id = self.sync_store.get_last_max_row_id()
        if self.radar:
            if last_max_row_id > 0:
                self.radar.set_last_max_row_id(last_max_row_id)
                logger.info(f"Restored last_max_row_id from SyncStore: {last_max_row_id}")
            else:
                # 首次运行，获取当前 max_row_id 作为基线
                current_max = self.radar.get_current_max_row_id()
                self.radar.set_last_max_row_id(current_max)
                self.sync_store.set_last_max_row_id(current_max)
                logger.info(f"First run, set baseline max_row_id: {current_max}")

        # 主循环
        while self._running:
            try:
                await self._poll_cycle()
                # 成功后重置连续错误计数
                self._stats["consecutive_errors"] = 0
            except Exception as e:
                logger.error(f"Poll cycle error: {e}")
                self._stats["errors"] += 1
                self._stats["consecutive_errors"] += 1

                # 连续错误过多时进行健康检查
                if self._stats["consecutive_errors"] >= 5:
                    logger.warning("Too many consecutive errors, performing health check...")
                    self._healthy = self._check_health()
                    if not self._healthy:
                        logger.error("Service unhealthy, stopping watcher")
                        self._running = False
                        break

            await asyncio.sleep(self.poll_interval)

    async def stop(self):
        """停止监听器"""
        self._running = False
        logger.info("NewWatcher stopped")

    async def _poll_cycle(self):
        """单次轮询周期"""
        self._stats["polls"] += 1

        # 1. 雷达检测新邮件（如果雷达不可用，跳过检测直接重试失败邮件）
        if self.radar and self.radar.is_available():
            has_new, estimated_count = self.radar.has_new_emails()

            if not has_new:
                logger.debug("No new emails detected")
            else:
                logger.info(f"Detected ~{estimated_count} new emails")
                self._stats["new_emails_detected"] += estimated_count

                # 2. 获取并同步新邮件
                for mailbox in self.mailboxes:
                    await self._sync_mailbox(mailbox, estimated_count)

                # 3. 更新 SyncStore 的 last_max_row_id（立即持久化）
                current_max = self.radar.get_last_max_row_id()
                self.sync_store.set_last_max_row_id(current_max)
                self.sync_store.set_last_sync_time(datetime.now().isoformat())
        else:
            logger.debug("Radar unavailable, skipping new email detection")

        # 4. 尝试重试失败的邮件（每次轮询都检查）
        await self._retry_failed_emails()

    async def _sync_mailbox(self, mailbox: str, estimated_count: int):
        """同步单个邮箱的新邮件

        Args:
            mailbox: 邮箱名称
            estimated_count: 预估的新邮件数量
        """
        # 获取比预估数量多一些的邮件，确保覆盖
        fetch_count = estimated_count + 2

        logger.info(f"Fetching {fetch_count} emails from {mailbox}...")

        # 通过 AppleScript 获取最新邮件
        emails = self.arm.fetch_emails_by_position(fetch_count, mailbox)

        if not emails:
            logger.warning(f"No emails fetched from {mailbox}")
            return

        # 获取已知的 message_id 集合
        known_message_ids = self.sync_store.get_all_message_ids()

        # 筛选新邮件
        new_emails = []
        for email_meta in emails:
            message_id = email_meta.get('message_id')
            if message_id and message_id not in known_message_ids:
                new_emails.append(email_meta)

        if not new_emails:
            logger.info(f"No new emails in {mailbox} (all already known)")
            return

        logger.info(f"Found {len(new_emails)} new emails in {mailbox}")

        # 同步每封新邮件
        for email_meta in new_emails:
            await self._sync_single_email(email_meta, mailbox)

    async def _sync_single_email(self, email_meta: Dict[str, Any], mailbox: str):
        """同步单封邮件

        Args:
            email_meta: 邮件元数据（来自 AppleScript）
            mailbox: 邮箱名称
        """
        message_id = email_meta.get('message_id')
        calendar_page_id = None  # 会议日程页面 ID

        try:
            logger.info(f"Syncing email: {email_meta.get('subject', '')[:50]}...")

            # 1. 获取完整邮件内容（包含 thread_id）
            full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)
            if not full_email:
                logger.error(f"Failed to fetch email content: {message_id}")
                return

            # 2. 检测并处理会议邀请（在正常同步之前）
            source = full_email.get('source', '')
            meeting_invite = None  # 会议邀请对象
            if self.meeting_sync.has_meeting_invite(source):
                calendar_page_id, meeting_invite = await self.meeting_sync.process_email(source, message_id)
                if calendar_page_id:
                    self._stats["meeting_invites"] += 1
                    logger.info(f"Meeting invite synced to calendar: {calendar_page_id}")

            # 3. 解析邮件源码，构建 Email 对象（这会从 MIME 提取正确的日期）
            email_obj = await self._build_email_object(full_email, mailbox)
            if not email_obj:
                logger.error(f"Failed to build Email object: {message_id}")
                self.sync_store.mark_failed(message_id, "Failed to build Email object")
                return

            # 4. 优先使用 MIME 源码中的日期（带时区），回退到 email_meta 的日期
            date_received = ''
            if email_obj.date:
                date_received = email_obj.date.isoformat()
            elif email_meta.get('date_received'):
                date_received = email_meta.get('date_received')

            # 5. 保存到 SyncStore (pending)
            self.sync_store.save_email({
                'message_id': message_id,
                'thread_id': full_email.get('thread_id'),
                'subject': full_email.get('subject', ''),
                'sender': full_email.get('sender', ''),
                'date_received': date_received,
                'mailbox': mailbox,
                'is_read': email_meta.get('is_read', False),
                'is_flagged': email_meta.get('is_flagged', False),
                'sync_status': 'pending'
            })

            # 6. 日期过滤：早于 sync_start_date 的邮件不同步到 Notion
            if self.sync_start_date and email_obj.date:
                # 确保日期带时区以便比较
                email_date = email_obj.date
                if email_date.tzinfo is None:
                    email_date = email_date.replace(tzinfo=timezone(timedelta(hours=8)))

                if email_date < self.sync_start_date:
                    logger.info(f"Skipping old email: {email_date.strftime('%Y-%m-%d')} < {self.sync_start_date.strftime('%Y-%m-%d')}")
                    # 标记为 skipped 状态，保留在 SyncStore 用于 Parent Item 查找
                    self.sync_store.save_email({
                        'message_id': message_id,
                        'sync_status': 'skipped'
                    })
                    self._stats["emails_skipped"] += 1
                    return

            # 7. 同步到 Notion（使用 v2 方法，线程关系自动处理）
            # 如果有会议邀请，传入日程 page_id 和 meeting_invite 用于关联和显示
            page_id = await self.notion_sync.create_email_page_v2(
                email_obj,
                calendar_page_id=calendar_page_id,  # 传入日程页面 ID
                meeting_invite=meeting_invite  # 传入会议邀请对象
            )

            if page_id:
                # 8. 更新 SyncStore (synced) - 用 AppleScript 获取的最新数据完整覆盖
                # 避免批量缓存时的旧数据与实际同步数据不一致
                self.sync_store.save_email({
                    'message_id': message_id,
                    'subject': email_obj.subject or '',
                    'sender': f"{email_obj.sender_name} <{email_obj.sender}>" if email_obj.sender_name else (email_obj.sender or ''),
                    'date_received': email_obj.date.isoformat() if email_obj.date else '',
                    'thread_id': email_obj.thread_id or '',
                    'mailbox': mailbox,
                    'sync_status': 'synced',
                    'notion_page_id': page_id
                })
                self._stats["emails_synced"] += 1
                logger.info(f"Email synced successfully: {message_id[:50]}... -> {page_id}")
            else:
                self.sync_store.mark_failed(message_id, "Notion sync returned None")

        except Exception as e:
            logger.error(f"Failed to sync email {message_id[:50]}...: {e}")
            self.sync_store.mark_failed(message_id, str(e))
            self._stats["errors"] += 1

    async def _build_email_object(self, full_email: Dict[str, Any], mailbox: str) -> Optional[Email]:
        """从 AppleScript 返回的数据构建 Email 对象

        Args:
            full_email: fetch_email_by_message_id 返回的数据
            mailbox: 邮箱名称

        Returns:
            Email 对象，失败返回 None
        """
        try:
            source = full_email.get('source', '')
            if not source:
                logger.warning("Email source is empty")
                return None

            # 使用 EmailReader 解析邮件源码
            email_obj = self.email_reader.parse_email_source(
                source=source,
                message_id=full_email.get('message_id'),
                is_read=full_email.get('is_read', False),
                is_flagged=full_email.get('is_flagged', False)
            )

            if email_obj:
                # 设置额外属性
                email_obj.mailbox = mailbox
                email_obj.thread_id = full_email.get('thread_id')

                # 优先使用 AppleScript 返回的 subject（比 MIME 解析更准确）
                if full_email.get('subject'):
                    email_obj.subject = full_email.get('subject')

            return email_obj

        except Exception as e:
            logger.error(f"Failed to build Email object: {e}")
            return None

    async def _retry_failed_emails(self):
        """重试失败的邮件

        使用指数退避策略：1min, 5min, 15min, 1h, 2h
        每次轮询最多重试 3 封，避免阻塞正常同步

        注意：最大重试次数由 SyncStore.mark_failed() 处理，
        超过次数的邮件会自动标记为 dead_letter 状态。
        """
        # 获取可以重试的邮件（next_retry_at <= now）
        ready_emails = self.sync_store.get_ready_for_retry(limit=3)

        if not ready_emails:
            return

        logger.info(f"Retrying {len(ready_emails)} failed emails...")

        for email_meta in ready_emails:
            message_id = email_meta.get('message_id')
            retry_count = email_meta.get('retry_count', 0)

            self._stats["retries_attempted"] += 1
            logger.info(f"Retry #{retry_count + 1} for: {email_meta.get('subject', '')[:40]}...")

            try:
                mailbox = email_meta.get('mailbox', '收件箱')
                full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)

                if not full_email:
                    logger.warning(f"Email not found in Mail.app, removing from queue: {message_id[:50]}...")
                    self.sync_store.delete_email(message_id)
                    continue

                email_obj = await self._build_email_object(full_email, mailbox)
                if not email_obj:
                    self.sync_store.mark_failed(message_id, "Failed to build Email object on retry")
                    continue

                # 同步到 Notion
                page_id = await self.notion_sync.create_email_page_v2(email_obj)

                if page_id:
                    # 用 AppleScript 获取的最新数据完整覆盖 SyncStore
                    # 避免重试时数据与原缓存不一致
                    self.sync_store.save_email({
                        'message_id': message_id,
                        'subject': email_obj.subject or '',
                        'sender': f"{email_obj.sender_name} <{email_obj.sender}>" if email_obj.sender_name else (email_obj.sender or ''),
                        'date_received': email_obj.date.isoformat() if email_obj.date else '',
                        'thread_id': email_obj.thread_id or '',
                        'mailbox': mailbox,
                        'sync_status': 'synced',
                        'notion_page_id': page_id
                    })
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded: {message_id[:50]}... -> {page_id}")
                else:
                    self.sync_store.mark_failed(message_id, "Notion sync returned None on retry")

            except Exception as e:
                logger.error(f"Retry failed for {message_id[:50]}...: {e}")
                self.sync_store.mark_failed(message_id, str(e))

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        radar_stats = {
            "last_max_row_id": 0,
            "available": False
        }
        if self.radar:
            radar_stats = {
                "last_max_row_id": self.radar.get_last_max_row_id(),
                "available": self.radar.is_available()
            }

        return {
            **self._stats,
            "healthy": self._healthy,
            "running": self._running,
            "sync_store": self.sync_store.get_stats(),
            "radar": radar_stats
        }

    def is_healthy(self) -> bool:
        """返回服务健康状态"""
        return self._healthy and self._running


async def main():
    """测试入口"""
    import sys

    # 配置日志
    logger.remove()
    logger.add(sys.stderr, level="INFO")

    watcher = NewWatcher()

    # 打印状态
    print("NewWatcher Stats:")
    print(watcher.get_stats())

    # 运行一次轮询
    print("\nRunning single poll cycle...")
    await watcher._poll_cycle()

    print("\nDone. Stats:")
    print(watcher.get_stats())


if __name__ == "__main__":
    asyncio.run(main())
