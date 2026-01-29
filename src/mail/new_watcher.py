"""
NewWatcher - v3 架构邮件同步监听器

基于 internal_id（SQLite ROWID = AppleScript id）的新架构：
- SQLite 雷达检测 max_row_id 变化并直接获取新邮件元数据
- 立即写入 SyncStore（internal_id 为主键，message_id 后续填充）
- AppleScript 通过 `whose id is <int>` 获取邮件内容（127x 性能提升）
- 使用 thread_id 关联 Parent Item

核心流程（v3）：
1. 雷达检测到新邮件 → SQLite 直接获取新邮件元数据（internal_id, subject, sender, date）
2. 立即写入 SyncStore（status=pending, message_id=NULL）
3. 处理 pending 邮件：AppleScript 通过 internal_id 获取完整内容
4. AppleScript 成功后更新 SyncStore（填充 message_id、thread_id）
5. 同步到 Notion
6. 更新状态（synced/failed）
7. 定期重试 fetch_failed 和 failed 状态的邮件

性能改进：
- `whose id is <int>` ~0.8s vs `whose message id is "<str>"` ~101s（127x 提升）
- 即使 AppleScript 失败也能追踪（有 internal_id）

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
        """单次轮询周期（v3 架构）

        v3 流程：
        1. SQLite 雷达检测变化并直接获取新邮件元数据
        2. 立即写入 SyncStore（internal_id 为主键）
        3. 处理 pending 邮件（AppleScript 获取完整内容）
        4. 处理重试队列
        """
        self._stats["polls"] += 1

        # 1. 雷达检测新邮件并直接获取元数据
        if self.radar and self.radar.is_available():
            last_max_row_id = self.sync_store.get_last_max_row_id()
            has_new, current_max, estimated_count = self.radar.check_for_changes(last_max_row_id)

            if not has_new:
                logger.debug("No new emails detected")
            else:
                logger.info(f"Detected ~{estimated_count} new emails (row_id {last_max_row_id} -> {current_max})")
                self._stats["new_emails_detected"] += estimated_count

                # 2. SQLite 直接获取新邮件元数据（不通过 AppleScript）
                new_emails = self.radar.get_new_emails(last_max_row_id)

                if new_emails:
                    logger.info(f"SQLite found {len(new_emails)} new emails")

                    # 3. 立即写入 SyncStore（internal_id 为主键，message_id=NULL）
                    for email_meta in new_emails:
                        internal_id = email_meta['internal_id']

                        # 检查是否已存在
                        existing = self.sync_store.get(internal_id)
                        if existing:
                            logger.debug(f"Email {internal_id} already in SyncStore, skipping")
                            continue

                        # 写入 SyncStore（pending 状态，等待 AppleScript 获取完整内容）
                        self.sync_store.save_email({
                            'internal_id': internal_id,
                            'message_id': None,  # 后续由 AppleScript 填充
                            'subject': email_meta.get('subject', ''),
                            'sender': email_meta.get('sender_email', ''),
                            'date_received': email_meta.get('date_received', ''),
                            'mailbox': email_meta.get('mailbox', '收件箱'),
                            'is_read': email_meta.get('is_read', False),
                            'is_flagged': email_meta.get('is_flagged', False),
                            'sync_status': 'pending'
                        })
                        logger.debug(f"Added email {internal_id} to SyncStore (pending)")

                # 4. 更新 last_max_row_id（立即持久化）
                self.sync_store.set_last_max_row_id(current_max)
                self.sync_store.set_last_sync_time(datetime.now().isoformat())
        else:
            logger.debug("Radar unavailable, skipping new email detection")

        # 5. 处理 pending 邮件（AppleScript 获取完整内容并同步到 Notion）
        await self._process_pending_emails()

        # 6. 处理重试队列（fetch_failed 和 failed 状态）
        await self._process_retry_queue()

    async def _process_pending_emails(self):
        """处理 pending 状态的邮件（v3 架构）

        从 SyncStore 获取 pending 邮件，通过 AppleScript 获取完整内容并同步到 Notion。
        每次最多处理 10 封，避免阻塞。
        """
        pending_emails = self.sync_store.get_pending_emails(limit=10)

        if not pending_emails:
            return

        logger.info(f"Processing {len(pending_emails)} pending emails...")

        for email_meta in pending_emails:
            await self._sync_single_email_v3(email_meta)

    async def _sync_single_email_v3(self, email_meta: Dict[str, Any]):
        """同步单封邮件（v3 架构）

        通过 internal_id 获取邮件完整内容，然后同步到 Notion。

        Args:
            email_meta: SyncStore 中的邮件元数据（包含 internal_id）
        """
        internal_id = email_meta.get('internal_id')
        mailbox = email_meta.get('mailbox', '收件箱')
        calendar_page_id = None

        try:
            logger.info(f"Syncing email {internal_id}: {email_meta.get('subject', '')[:50]}...")

            # 1. 通过 internal_id 获取完整邮件内容（127x 性能提升）
            full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
            if not full_email:
                logger.warning(f"Failed to fetch email content by id {internal_id}")
                self.sync_store.mark_fetch_failed(internal_id, "AppleScript fetch failed")
                return

            # 2. AppleScript 成功，更新 SyncStore 元数据（填充 message_id、thread_id）
            message_id = full_email.get('message_id')
            thread_id = full_email.get('thread_id')

            self.sync_store.update_after_fetch(internal_id, {
                'message_id': message_id,
                'thread_id': thread_id,
                'subject': full_email.get('subject'),
                'sender': full_email.get('sender')
            })

            # 3. 检测并处理会议邀请
            source = full_email.get('source', '')
            meeting_invite = None
            if self.meeting_sync.has_meeting_invite(source):
                calendar_page_id, meeting_invite = await self.meeting_sync.process_email(source, message_id)
                if calendar_page_id:
                    self._stats["meeting_invites"] += 1
                    logger.info(f"Meeting invite synced to calendar: {calendar_page_id}")

            # 4. 解析邮件源码，构建 Email 对象
            email_obj = await self._build_email_object(full_email, mailbox)
            if not email_obj:
                logger.error(f"Failed to build Email object: {internal_id}")
                self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object")
                return

            # 设置 internal_id（v3 架构）
            email_obj.internal_id = internal_id

            # 5. 日期过滤：早于 sync_start_date 的邮件不同步到 Notion
            if self.sync_start_date and email_obj.date:
                email_date = email_obj.date
                if email_date.tzinfo is None:
                    email_date = email_date.replace(tzinfo=timezone(timedelta(hours=8)))

                if email_date < self.sync_start_date:
                    logger.info(f"Skipping old email: {email_date.strftime('%Y-%m-%d')} < {self.sync_start_date.strftime('%Y-%m-%d')}")
                    self.sync_store.mark_skipped(internal_id)
                    self._stats["emails_skipped"] += 1
                    return

            # 6. 同步到 Notion
            page_id = await self.notion_sync.create_email_page_v2(
                email_obj,
                calendar_page_id=calendar_page_id,
                meeting_invite=meeting_invite
            )

            if page_id:
                # 7. 更新 SyncStore (synced)
                self.sync_store.mark_synced_v3(internal_id, page_id)
                self._stats["emails_synced"] += 1
                logger.info(f"Email synced successfully: {internal_id} -> {page_id}")
            else:
                self.sync_store.mark_failed_v3(internal_id, "Notion sync returned None")

        except Exception as e:
            logger.error(f"Failed to sync email {internal_id}: {e}")
            self.sync_store.mark_failed_v3(internal_id, str(e))
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

    async def _process_retry_queue(self):
        """处理重试队列（v3 架构）

        处理两种失败状态：
        1. fetch_failed: AppleScript 获取失败，需要重新获取内容
        2. failed: Notion 同步失败，内容已获取，只需重试同步

        使用指数退避策略：1min, 5min, 15min, 1h, 2h
        每次轮询最多重试 3 封，避免阻塞正常同步。
        超过最大重试次数的邮件会被标记为 dead_letter。
        """
        # 获取可以重试的邮件（next_retry_at <= now）
        ready_emails = self.sync_store.get_ready_for_retry(limit=3)

        if not ready_emails:
            return

        logger.info(f"Retrying {len(ready_emails)} failed emails...")

        for email_meta in ready_emails:
            internal_id = email_meta.get('internal_id')
            sync_status = email_meta.get('sync_status')
            retry_count = email_meta.get('retry_count', 0)
            mailbox = email_meta.get('mailbox', '收件箱')

            self._stats["retries_attempted"] += 1
            logger.info(f"Retry #{retry_count + 1} for {internal_id} (status={sync_status}): {email_meta.get('subject', '')[:40]}...")

            try:
                if sync_status == 'fetch_failed':
                    # AppleScript 获取失败，需要重新获取
                    full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)

                    if not full_email:
                        logger.warning(f"Retry fetch failed for {internal_id}")
                        self.sync_store.mark_fetch_failed(internal_id, "AppleScript fetch failed on retry")
                        continue

                    # 获取成功，更新元数据
                    message_id = full_email.get('message_id')
                    thread_id = full_email.get('thread_id')
                    self.sync_store.update_after_fetch(internal_id, {
                        'message_id': message_id,
                        'thread_id': thread_id,
                        'subject': full_email.get('subject'),
                        'sender': full_email.get('sender')
                    })

                    # 构建 Email 对象
                    email_obj = await self._build_email_object(full_email, mailbox)
                    if not email_obj:
                        self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object on retry")
                        continue

                    # 设置 internal_id（v3 架构）
                    email_obj.internal_id = internal_id

                else:
                    # failed 状态：已有完整内容，重新获取以确保数据最新
                    message_id = email_meta.get('message_id')
                    if not message_id:
                        # 没有 message_id，尝试重新获取
                        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                        if not full_email:
                            self.sync_store.mark_fetch_failed(internal_id, "Cannot refetch for retry")
                            continue
                        message_id = full_email.get('message_id')
                        self.sync_store.update_after_fetch(internal_id, {
                            'message_id': message_id,
                            'thread_id': full_email.get('thread_id'),
                            'subject': full_email.get('subject'),
                            'sender': full_email.get('sender')
                        })
                    else:
                        # 有 message_id，通过 internal_id 重新获取
                        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                        if not full_email:
                            self.sync_store.mark_fetch_failed(internal_id, "Cannot refetch for retry")
                            continue

                    email_obj = await self._build_email_object(full_email, mailbox)
                    if not email_obj:
                        self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object on retry")
                        continue

                # 设置 internal_id（v3 架构）
                email_obj.internal_id = internal_id

                # 同步到 Notion
                page_id = await self.notion_sync.create_email_page_v2(email_obj)

                if page_id:
                    self.sync_store.mark_synced_v3(internal_id, page_id)
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded: {internal_id} -> {page_id}")
                else:
                    self.sync_store.mark_failed_v3(internal_id, "Notion sync returned None on retry")

            except Exception as e:
                logger.error(f"Retry failed for {internal_id}: {e}")
                self.sync_store.mark_failed_v3(internal_id, str(e))

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
