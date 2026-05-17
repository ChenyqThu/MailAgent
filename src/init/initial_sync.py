#!/usr/bin/env python3
# ruff: noqa: E402
"""
初始化同步: import-only module。

DEPRECATED entry-point. Use 'mailagent init <action>' instead.

保留的 import 表面 (供 src/cli/commands/init.py 调用):
    - InitialSync 类
    - AnalysisReport 类
"""

import json
import time
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional

# 北京时区
BEIJING_TZ = timezone(timedelta(hours=8))

from loguru import logger
from src.config import config as settings
from src.models import Email
from src.mail.applescript_arm import AppleScriptArm
from src.mail.sync_store import SyncStore
from src.mail.reader import EmailReader
from src.notion.sync import NotionSync
from src.repository import AttachmentStore, EmailRepository


def get_system_timezone() -> timezone:
    """获取系统当前时区（考虑夏令时）"""
    local_time = time.localtime()
    if local_time.tm_isdst > 0:
        offset_seconds = -time.altzone
    else:
        offset_seconds = -time.timezone
    return timezone(timedelta(seconds=offset_seconds))


def parse_chinese_datetime(date_str: str) -> Optional[datetime]:
    """解析中文日期格式

    支持格式：
    - "2025年9月9日 星期二 下午8:48:14"
    - "2025年1月13日 星期一 上午10:30:00"

    Returns:
        datetime 对象（无时区），解析失败返回 None
    """
    import re

    # 匹配中文日期格式
    pattern = r'(\d{4})年(\d{1,2})月(\d{1,2})日\s+星期[一二三四五六日]\s+(上午|下午)(\d{1,2}):(\d{2}):(\d{2})'
    match = re.match(pattern, date_str)
    if not match:
        return None

    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    am_pm = match.group(4)
    hour = int(match.group(5))
    minute = int(match.group(6))
    second = int(match.group(7))

    # 转换 12 小时制为 24 小时制
    if am_pm == "下午" and hour < 12:
        hour += 12
    elif am_pm == "上午" and hour == 12:
        hour = 0

    return datetime(year, month, day, hour, minute, second)


def parse_datetime_with_tz(date_str: str, default_tz: timezone = None) -> Optional[datetime]:
    """解析日期字符串，支持带时区和不带时区的格式

    Args:
        date_str: 日期字符串，如 "2026-01-24T14:02:32" 或 "2026-01-24T14:02:32+08:00"
                  也支持中文格式如 "2025年9月9日 星期二 下午8:48:14"
        default_tz: 无时区时使用的默认时区（None 时使用系统时区）

    Returns:
        带时区的 datetime 对象，解析失败返回 None
    """
    if not date_str:
        return None

    # 先尝试解析中文日期格式
    if "年" in date_str and "月" in date_str:
        dt = parse_chinese_datetime(date_str)
        if dt:
            if default_tz is None:
                default_tz = get_system_timezone()
            return dt.replace(tzinfo=default_tz)
        return None

    try:
        # 尝试解析 ISO 格式（可能带时区）
        if "+" in date_str or date_str.endswith("Z") or (date_str.count("-") > 2 and "T" in date_str):
            # 处理 Notion 返回的毫秒格式: 2026-01-24T22:02:00.000+08:00
            date_str_clean = date_str.replace("Z", "+00:00")
            return datetime.fromisoformat(date_str_clean)
        else:
            # 无时区，添加默认时区
            dt = datetime.fromisoformat(date_str)
            if default_tz is None:
                default_tz = get_system_timezone()
            return dt.replace(tzinfo=default_tz)
    except Exception as e:
        logger.debug(f"Failed to parse datetime '{date_str}': {e}")
        return None


def dates_match(store_date_str: str, notion_date_str: str, tolerance_seconds: int = 120) -> bool:
    """比较两个日期是否匹配（转换为 UTC 比较，允许一定容差）

    Args:
        store_date_str: SyncStore 中的日期字符串
        notion_date_str: Notion 中的日期字符串
        tolerance_seconds: 允许的误差秒数（默认 120 秒）

    Returns:
        是否匹配
    """
    store_dt = parse_datetime_with_tz(store_date_str)
    notion_dt = parse_datetime_with_tz(notion_date_str)

    if store_dt is None or notion_dt is None:
        # 无法解析，回退到日期字符串比较
        store_date = (store_date_str or '')[:10]
        notion_date = (notion_date_str or '')[:10]
        return store_date == notion_date

    # 转换为 UTC 比较
    store_utc = store_dt.astimezone(timezone.utc)
    notion_utc = notion_dt.astimezone(timezone.utc)

    diff_seconds = abs((store_utc - notion_utc).total_seconds())
    return diff_seconds <= tolerance_seconds


def is_notion_date_beijing_tz(notion_date_str: str) -> bool:
    """检查 Notion 日期是否是北京时区"""
    if not notion_date_str:
        return False
    return "+08:00" in notion_date_str


class AnalysisReport:
    """分析报告类，支持 JSON 序列化"""

    def __init__(self):
        self.created_at: str = datetime.now().isoformat()
        self.comparison: Dict = {
            'matched': [],
            'property_mismatch': [],      # date 或 thread_id 不同（合并）
            'critical_mismatch': [],      # subject 或 sender 不同
            'store_only': [],             # 待同步（已过滤日期）
            'store_only_before_date': [], # 早于 sync_start_date（仅缓存，按需同步）
            'notion_only': [],            # 仅在 Notion（不处理，可能是召回邮件）
        }
        self.parent_analysis: Dict = {
            'total': 0,
            'thread_heads': {
                'correct': [],      # 线程头，Parent 已正确（空）
                'need_clear': [],   # 线程头，但有 Parent（需清空）
            },
            'replies': {
                'correct': [],              # 回复，Parent 已正确
                'need_update_notion': [],   # 回复，线程头在 Notion，需更新
                'need_sync_store': [],      # 回复，线程头在 SyncStore 未同步
                'need_fallback': [],        # 回复，需使用降级方案
                'no_parent_available': [],  # 回复，找不到合适 Parent（孤儿回复）
            }
        }
        self.stats: Dict = {
            "fetched_from_applescript": 0,
            "saved_to_store": 0,
            "already_in_notion": 0,
            "pending_sync": 0,
            "synced": 0,
            "failed": 0
        }

    def to_dict(self) -> Dict:
        """转换为字典"""
        return {
            "created_at": self.created_at,
            "comparison": self.comparison,
            "parent_analysis": self.parent_analysis,
            "stats": self.stats
        }

    @classmethod
    def from_dict(cls, data: Dict) -> 'AnalysisReport':
        """从字典创建"""
        report = cls()
        report.created_at = data.get("created_at", "")
        report.comparison = data.get("comparison", report.comparison)
        report.parent_analysis = data.get("parent_analysis", report.parent_analysis)
        report.stats = data.get("stats", report.stats)
        return report

    def save(self, path: str):
        """保存到 JSON 文件"""
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
        print(f"  ✅ 报告已保存到: {path}")

    @classmethod
    def load(cls, path: str) -> 'AnalysisReport':
        """从 JSON 文件加载"""
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        report = cls.from_dict(data)
        print(f"  ✅ 已加载报告: {path} (创建于 {report.created_at})")
        return report


class InitialSync:
    """初始化同步器"""

    def __init__(self, sync_store_path: str = "data/sync_store.db", mailbox_limits: Dict[str, int] = None):
        """初始化

        Args:
            sync_store_path: SyncStore 数据库路径
            mailbox_limits: 每个邮箱的获取数量限制，如 {"收件箱": 3000, "发件箱": 500}
                           None 或 0 表示不限制
        """
        # 从配置读取邮箱列表，支持自定义
        self.mailboxes = getattr(settings, 'init_mailboxes', ["收件箱", "发件箱"])
        self.mailbox_limits = mailbox_limits or {}

        # 初始化组件
        self.arm = AppleScriptArm(
            account_name=settings.mail_account_name,
            inbox_name=settings.mail_inbox_name
        )
        self.sync_store = SyncStore(sync_store_path)
        self.email_repo = EmailRepository(
            db_path=sync_store_path,
            attachment_store=AttachmentStore(settings.attachment_storage_dir),
        )
        self.notion_sync = NotionSync(
            email_repo=self.email_repo,
            sync_store=self.sync_store,
        )
        self.email_reader = EmailReader()

        # 分析报告
        self.report = AnalysisReport()

    @property
    def comparison(self) -> Dict:
        """兼容旧代码的属性"""
        return self.report.comparison

    @property
    def stats(self) -> Dict:
        """兼容旧代码的属性"""
        return self.report.stats

    # ==================== 主流程 ====================

    async def run(self, auto_confirm: bool = False, limit: int = None):
        """运行初始化同步（完整流程）

        Args:
            auto_confirm: 是否跳过确认步骤
            limit: 限制同步数量
        """
        print("\n" + "=" * 60)
        print("MailAgent 初始化同步")
        print("=" * 60)

        # Step 1: 检查环境
        print("\n Step 1: 检查环境...")
        if not self._check_environment():
            return

        # Step 2: 从 AppleScript 获取邮件（增量模式）
        print("\n Step 2: 从 Mail.app 获取邮件...")
        if not await self._fetch_emails_from_applescript():
            return

        # Step 3: 分析 SyncStore vs Notion
        print("\n Step 3: 分析数据...")
        try:
            await self._analyze_all()
        except Exception as e:
            logger.error(f"Analysis failed: {e}")
            print(f"\n❌ 分析失败: {e}")
            return

        # Step 4: 显示统计并确认
        print("\n Step 4: 同步统计")
        self._print_analysis_stats()

        pending_count = len(self.comparison.get('store_only', []))
        if pending_count == 0:
            print("\n 所有邮件已同步，无需操作！")
            return

        if limit:
            pending_count = min(pending_count, limit)
            print(f"\n 将只同步前 {limit} 封邮件")

        if not auto_confirm:
            confirm = input(f"\n是否开始同步 {pending_count} 封邮件到 Notion? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消同步")
                return

        # Step 5: 执行同步
        print(f"\n Step 5: 开始同步 {pending_count} 封邮件...")
        await self._sync_pending_emails(limit)

        # 最终统计
        print("\n" + "=" * 60)
        print(" 同步完成!")
        self._print_final_stats()
        print("=" * 60)

    async def analyze_only(self, skip_fetch: bool = False) -> AnalysisReport:
        """仅执行分析，不同步

        Args:
            skip_fetch: 是否跳过从 Mail.app 获取邮件（仅对比现有数据）

        Returns:
            AnalysisReport 分析报告
        """
        print("\n" + "=" * 60)
        print("MailAgent 数据分析")
        print("=" * 60)

        # Step 1: 检查环境
        print("\n Step 1: 检查环境...")
        if not self._check_environment():
            return self.report

        if not skip_fetch:
            # Step 2: 从 AppleScript 获取邮件
            print("\n Step 2: 从 Mail.app 获取邮件...")
            await self._fetch_emails_from_applescript()
        else:
            print("\n Step 2: 跳过获取邮件（使用现有 SyncStore 数据）")

        # Step 3: 一次查询完成所有分析（SyncStore vs Notion + Parent Item）
        print("\n Step 3: 分析数据...")
        try:
            await self._analyze_all()
        except Exception as e:
            logger.error(f"Analysis failed: {e}")
            print(f"\n❌ 分析失败: {e}")
            return self.report

        # Step 4: 显示统计
        print("\n Step 4: 分析结果")
        self._print_analysis_stats()

        return self.report

    # ==================== 环境检查 ====================

    def _check_environment(self) -> bool:
        """检查环境"""
        # 显示 SyncStore 统计
        stats = self.sync_store.get_stats()
        total = stats.get('total_emails', 0)
        by_mailbox = stats.get('by_mailbox', {})

        print(f"  SyncStore 邮件总数: {total}")
        for mb, count in by_mailbox.items():
            print(f"    - {mb}: {count} 封")

        return True

    # ==================== 数据获取 ====================

    def _get_existing_count_by_mailbox(self) -> Dict[str, int]:
        """获取 SyncStore 中各邮箱已有的邮件数量"""
        conn = self.sync_store._get_connection()
        cursor = conn.cursor()
        try:
            cursor.execute("""
                SELECT mailbox, COUNT(*) as count
                FROM email_metadata
                GROUP BY mailbox
            """)
            return {row['mailbox']: row['count'] for row in cursor.fetchall()}
        except Exception as e:
            logger.warning(f"Failed to get existing counts: {e}")
            return {}
        finally:
            conn.close()

    async def _fetch_emails_from_applescript(self) -> bool:
        """从 AppleScript 获取邮件并保存到 SyncStore（增量模式）

        采用时间驱动方式：获取邮件到缓存，后续通过 SYNC_START_DATE 过滤需同步的邮件。
        支持通过 mailbox_limits 参数限制每个邮箱的获取数量。
        """
        total_fetched = 0

        # 获取 SyncStore 中已有的邮件数量（按邮箱）
        existing_counts = self._get_existing_count_by_mailbox()
        print("\n   SyncStore 中已有邮件:")
        for mailbox in self.mailboxes:
            count = existing_counts.get(mailbox, 0)
            limit = self.mailbox_limits.get(mailbox, 0)
            limit_str = f" (目标: {limit})" if limit > 0 else ""
            print(f"     - {mailbox}: {count} 封{limit_str}")

        for mailbox in self.mailboxes:
            existing = existing_counts.get(mailbox, 0)
            max_count = self.mailbox_limits.get(mailbox, 0)

            # 计算需要获取的数量
            if max_count > 0:
                need_count = max(0, max_count - existing)
                if need_count == 0:
                    print(f"\n  ✅ {mailbox}: 已有 {existing} 封，已达目标 {max_count}，跳过")
                    continue
                print(f"\n  获取 {mailbox}（已有 {existing}，需获取 {need_count} 封）...")
            else:
                need_count = 0  # 0 = 不限制，获取全部
                print(f"\n  获取 {mailbox}（已有 {existing} 封，无数量限制）...")

            # 分批获取邮件（从配置读取批量大小）
            batch_size = settings.init_batch_size
            # 从已有数量位置开始，避免重复获取
            offset = existing
            mailbox_total = 0

            print(f"    批量大小: {batch_size}, 起始位置: {offset}")

            while True:
                # 检查是否已达到限制
                if need_count > 0 and mailbox_total >= need_count:
                    break

                # 计算本批次获取数量
                if need_count > 0:
                    remaining = need_count - mailbox_total
                    fetch_count = min(batch_size, remaining)
                else:
                    fetch_count = batch_size

                # 显示当前获取进度
                print(f"    📥 获取第 {offset + 1} - {offset + fetch_count} 封...", end=' ', flush=True)

                # 使用 offset 分页获取
                import time
                start_time = time.time()
                emails = self.arm._fetch_emails_from_applescript(fetch_count, self.arm._get_mailbox_name(mailbox), offset=offset)
                elapsed = time.time() - start_time

                if not emails:
                    print(f"无更多邮件 ({elapsed:.1f}s)")
                    break

                print(f"获取 {len(emails)} 封 ({elapsed:.1f}s)", end=' ', flush=True)

                # 保存到 SyncStore（批量获取已包含 thread_id）
                email_dicts = []
                for email in emails:
                    # thread_id 已在批量获取时提取，如果为 None 则使用 message_id
                    thread_id = email.get('thread_id') or email['message_id'].strip('<>')

                    # AppleScript 返回的时间是本地时间（无时区），添加系统时区
                    date_received = email.get('date_received', '')
                    if date_received and '+' not in date_received and not date_received.endswith('Z'):
                        # 添加系统时区
                        sys_tz = get_system_timezone()
                        tz_offset = sys_tz.utcoffset(None)
                        total_seconds = int(tz_offset.total_seconds())
                        hours, remainder = divmod(abs(total_seconds), 3600)
                        minutes = remainder // 60
                        sign = '+' if total_seconds >= 0 else '-'
                        tz_suffix = f"{sign}{hours:02d}:{minutes:02d}"
                        date_received = date_received + tz_suffix

                    email_dict = {
                        'internal_id': email.get('id'),  # v3: AppleScript id
                        'message_id': email['message_id'],
                        'thread_id': thread_id,
                        'subject': email.get('subject', ''),
                        'sender': email.get('sender', ''),
                        'date_received': date_received,
                        'mailbox': mailbox,
                        'is_read': email.get('is_read', False),
                        'is_flagged': email.get('is_flagged', False),
                        'sync_status': 'pending'
                    }
                    email_dicts.append(email_dict)

                saved = self.sync_store.save_emails_batch(email_dicts)
                mailbox_total += saved
                total_fetched += saved

                # 显示保存结果
                if saved < len(emails):
                    print(f"→ 新增 {saved} 封 (跳过 {len(emails) - saved} 封重复)")
                else:
                    print(f"→ 新增 {saved} 封")

                # 如果获取的数量少于请求数量，说明已到末尾
                if len(emails) < fetch_count:
                    print("    已到达邮件末尾")
                    break

                offset += fetch_count

            print(f"  ✅ {mailbox}: 本次新增 {mailbox_total} 封，总计 {existing + mailbox_total} 封")

        self.stats["fetched_from_applescript"] = total_fetched
        self.stats["saved_to_store"] = total_fetched

        # 如果没有新获取的，检查是否已有数据
        if total_fetched == 0:
            total_existing = sum(existing_counts.values())
            if total_existing > 0:
                print(f"\n  已有 {total_existing} 封邮件在 SyncStore 中，无需重新获取")
                return True

        return total_fetched > 0 or sum(existing_counts.values()) > 0

    def _get_all_store_emails(self) -> Dict[str, Dict]:
        """获取 SyncStore 中所有邮件

        Returns:
            {message_id: {subject, sender, date_received, thread_id, mailbox, sync_status}}
        """
        store_emails = {}
        conn = self.sync_store._get_connection()
        cursor = conn.cursor()

        try:
            cursor.execute("""
                SELECT internal_id, message_id, subject, sender, date_received, thread_id,
                       mailbox, sync_status, notion_page_id
                FROM email_metadata
            """)

            for row in cursor.fetchall():
                store_emails[row['message_id']] = {
                    "internal_id": row['internal_id'],
                    "subject": row['subject'],
                    "sender": row['sender'],
                    "date_received": row['date_received'],
                    "thread_id": row['thread_id'],
                    "mailbox": row['mailbox'],
                    "sync_status": row['sync_status'],
                    "notion_page_id": row['notion_page_id']
                }

        except Exception as e:
            logger.error(f"Failed to get store emails: {e}")
        finally:
            conn.close()

        return store_emails

    # ==================== 辅助方法 ====================

    def _extract_rich_text(self, props: dict, name: str) -> str:
        """从 Notion properties 提取 rich_text 值"""
        items = props.get(name, {}).get("rich_text", [])
        return items[0].get("text", {}).get("content", "") if items else ""

    def _extract_title(self, props: dict, name: str) -> str:
        """从 Notion properties 提取 title 值"""
        items = props.get(name, {}).get("title", [])
        return items[0].get("text", {}).get("content", "") if items else ""

    def _extract_date(self, props: dict, name: str) -> str:
        """从 Notion properties 提取 date 值"""
        date_obj = props.get(name, {}).get("date", {})
        return date_obj.get("start", "") if date_obj else ""

    def _extract_relation_id(self, props: dict, name: str) -> Optional[str]:
        """从 Notion properties 提取 relation 的第一个 ID"""
        relations = props.get(name, {}).get("relation", [])
        return relations[0].get("id") if relations else None

    async def _try_fetch_thread_head_from_mailapp(self, thread_id: str) -> bool:
        """尝试从 Mail.app 获取线程头并保存到 SyncStore

        Args:
            thread_id: 线程头的 message_id

        Returns:
            bool: 是否成功获取并保存
        """
        # 1. 检查是否已标记为 not_found（避免重复请求）
        if self.sync_store.is_thread_head_not_found(thread_id):
            return False

        # 2. 尝试从两个邮箱获取
        full_email = None
        found_mailbox = None
        for mailbox in ['收件箱', '发件箱']:
            full_email = self.arm.fetch_email_by_message_id(thread_id, mailbox)
            if full_email:
                found_mailbox = mailbox
                break

        if not full_email:
            # 3. 获取失败，标记为 not_found
            self.sync_store.mark_thread_head_not_found(
                thread_id,
                note="Not found in Mail.app during analysis"
            )
            return False

        # 4. 获取成功，保存到 SyncStore
        # 处理时区
        date_received = full_email.get('date_received', '') or full_email.get('date', '')
        if date_received and '+' not in date_received and not date_received.endswith('Z'):
            sys_tz = get_system_timezone()
            tz_offset = sys_tz.utcoffset(None)
            total_seconds = int(tz_offset.total_seconds())
            hours, remainder = divmod(abs(total_seconds), 3600)
            minutes = remainder // 60
            sign = '+' if total_seconds >= 0 else '-'
            tz_suffix = f"{sign}{hours:02d}:{minutes:02d}"
            date_received = date_received + tz_suffix

        email_dict = {
            'message_id': thread_id,
            'thread_id': full_email.get('thread_id') or thread_id.strip('<>'),
            'subject': full_email.get('subject', ''),
            'sender': full_email.get('sender', ''),
            'date_received': date_received,
            'mailbox': found_mailbox,
            'is_read': full_email.get('is_read', False),
            'is_flagged': full_email.get('is_flagged', False),
            'sync_status': 'pending'
        }
        self.sync_store.save_email(email_dict)
        logger.info(f"Fetched thread head from Mail.app: {thread_id[:40]}...")
        return True

    # ==================== 对比分析（核心方法） ====================

    async def _analyze_all(self):
        """一次查询完成所有分析

        同时生成：
        - self.report.comparison: SyncStore vs Notion 对比
        - self.report.parent_analysis: Parent Item 状态分析
        """
        print("  查询 Notion 数据库...")

        # 1. 查询 Notion（一次）
        notion_pages = []
        has_more = True
        start_cursor = None
        query_count = 0

        # Resolve data_source_id
        _db_info = await self.notion_sync.client.client.databases.retrieve(self.notion_sync.client.email_db_id)
        _data_source_id = _db_info["data_sources"][0]["id"]

        while has_more:
            query_params = {
                "data_source_id": _data_source_id,
                "filter": {"property": "Message ID", "rich_text": {"is_not_empty": True}},
                "page_size": 100
            }
            if start_cursor:
                query_params["start_cursor"] = start_cursor

            results = await self.notion_sync.client.client.data_sources.query(**query_params)
            query_count += 1

            for page in results.get("results", []):
                props = page.get("properties", {})

                # 提取所有需要的字段
                message_id = self._extract_rich_text(props, "Message ID")
                if not message_id:
                    continue

                notion_pages.append({
                    "page_id": page["id"],
                    "message_id": message_id,
                    "subject": self._extract_title(props, "Subject"),
                    "sender": props.get("From", {}).get("email", ""),
                    "date": self._extract_date(props, "Date"),
                    "thread_id": self._extract_rich_text(props, "Thread ID"),
                    "parent_item_id": self._extract_relation_id(props, "Parent Item"),
                    "has_parent": len(props.get("Parent Item", {}).get("relation", [])) > 0
                })

            has_more = results.get("has_more", False)
            start_cursor = results.get("next_cursor")

            if query_count % 10 == 0:
                print(f"    已查询 {len(notion_pages)} 封...", end='\r')

        print(f"  Notion 中有 {len(notion_pages)} 封邮件")

        # 2. 查询 SyncStore
        store_emails = self._get_all_store_emails()
        print(f"  SyncStore 中有 {len(store_emails)} 封邮件")

        # 3. 构建索引
        notion_by_msg_id = {}
        for page in notion_pages:
            msg_id = page['message_id']
            notion_by_msg_id[msg_id] = page
            notion_by_msg_id[msg_id.strip('<>')] = page

        store_ids = set(store_emails.keys())
        notion_ids = set(notion_by_msg_id.keys())

        # 4. SyncStore vs Notion 对比 → comparison
        self._build_comparison(store_emails, notion_by_msg_id, store_ids, notion_ids)

        # 5. Parent Item 分析 → parent_analysis
        await self._build_parent_analysis(notion_pages, notion_by_msg_id, store_emails)

    def _build_comparison(self, store_emails: Dict, notion_by_msg_id: Dict,
                          store_ids: set, notion_ids: set):
        """构建 SyncStore vs Notion 对比结果"""
        comparison = self.report.comparison

        # 重置
        comparison['matched'] = []
        comparison['property_mismatch'] = []
        comparison['critical_mismatch'] = []
        comparison['store_only'] = []
        comparison['store_only_before_date'] = []
        comparison['notion_only'] = []

        sync_start_date = settings.sync_start_date

        # 仅在 SyncStore
        for msg_id in (store_ids - notion_ids):
            store_data = store_emails.get(msg_id)
            if not store_data:
                continue
            date_received = (store_data.get('date_received') or '')[:10]

            if sync_start_date and date_received and date_received < sync_start_date:
                comparison['store_only_before_date'].append(msg_id)
            else:
                comparison['store_only'].append(msg_id)

        # 仅在 Notion（去重处理）
        seen_notion_only = set()
        for msg_id in (notion_ids - store_ids):
            notion_data = notion_by_msg_id.get(msg_id)
            if notion_data and notion_data['message_id'] not in seen_notion_only:
                seen_notion_only.add(notion_data['message_id'])
                comparison['notion_only'].append((msg_id, notion_data))

        # 两边都有
        for msg_id in (store_ids & notion_ids):
            store_data = store_emails.get(msg_id)
            notion_data = notion_by_msg_id.get(msg_id)
            if not store_data or not notion_data:
                continue

            critical_reasons = []
            date_mismatch = False
            thread_mismatch = False

            # 对比 subject (strip 去掉前后所有空白字符，包括 tab、换行等)
            store_subject = (store_data.get('subject') or '').strip()[:50]
            notion_subject = (notion_data.get('subject') or '').strip()[:50]
            if store_subject.lower() != notion_subject.lower():
                critical_reasons.append("subject 不同")

            # 对比 sender
            store_sender = self._extract_email_address(store_data.get('sender', ''))
            notion_sender = self._extract_email_address(notion_data.get('sender', ''))
            if store_sender and notion_sender and store_sender.lower() != notion_sender.lower():
                critical_reasons.append("sender 不同")

            # 对比 date
            store_date_str = store_data.get('date_received') or ''
            notion_date_str = notion_data.get('date') or ''
            if store_date_str and notion_date_str:
                if not dates_match(store_date_str, notion_date_str, tolerance_seconds=120):
                    date_mismatch = True

            # 检查时区
            tz_mismatch = notion_date_str and not is_notion_date_beijing_tz(notion_date_str)

            # 对比 thread_id
            store_thread = store_data.get('thread_id', '')
            notion_thread = notion_data.get('thread_id', '')
            if store_thread and store_thread != notion_thread:
                thread_mismatch = True

            # 分类
            if critical_reasons:
                comparison['critical_mismatch'].append((msg_id, store_data, notion_data, critical_reasons))
            elif date_mismatch or thread_mismatch or tz_mismatch:
                comparison['property_mismatch'].append((msg_id, store_data, notion_data))
            else:
                comparison['matched'].append((msg_id, store_data, notion_data))

    async def _build_parent_analysis(self, notion_pages: List[Dict],
                                      notion_by_msg_id: Dict, store_emails: Dict):
        """构建 Parent Item 分析结果（新架构：最新邮件为母节点）

        新逻辑：
        1. 按 thread_id 分组所有邮件
        2. 每个线程中最新的邮件为母节点（不应有 Parent Item）
        3. 其他邮件的 Parent Item 应指向最新邮件
        """
        analysis = self.report.parent_analysis

        # 重置
        analysis['total'] = len(notion_pages)
        analysis['threads'] = {}  # 新增：按线程分组的分析结果
        analysis['summary'] = {
            'total_threads': 0,
            'single_email_threads': 0,  # 只有一封邮件的线程
            'multi_email_threads': 0,   # 多封邮件的线程
            'correct': 0,               # 关系正确的邮件
            'need_update': 0,           # 需要更新的邮件
        }

        print("  分析 Parent Item 状态（新架构：最新邮件为母节点）...")

        # 1. 按 thread_id 分组
        threads_map = {}  # thread_id -> List[page_data]
        no_thread_emails = []  # 没有 thread_id 的邮件

        for page_data in notion_pages:
            thread_id = page_data.get('thread_id', '').strip('<>')
            message_id = page_data.get('message_id', '').strip('<>')

            # 没有 thread_id 或 thread_id == message_id 的邮件，视为独立邮件
            if not thread_id or thread_id == message_id:
                no_thread_emails.append(page_data)
            else:
                if thread_id not in threads_map:
                    threads_map[thread_id] = []
                threads_map[thread_id].append(page_data)

        # 也要把线程头加入到对应的线程组
        # 线程头是 message_id == thread_id 的邮件，但我们需要把它加入到以它为 thread_id 的线程中
        for page_data in no_thread_emails:
            message_id = page_data.get('message_id', '').strip('<>')
            # 检查是否有以此为 thread_id 的线程存在
            if message_id in threads_map:
                threads_map[message_id].append(page_data)

        print(f"    线程分组完成: {len(threads_map)} 个线程, {len(no_thread_emails)} 封独立邮件")

        # 2. 分析每个线程
        for thread_id, emails in threads_map.items():
            if len(emails) == 0:
                continue

            # 按日期排序（降序，最新在前）
            emails_sorted = sorted(
                emails,
                key=lambda x: x.get('date', '') or '',
                reverse=True
            )

            latest_email = emails_sorted[0]
            latest_page_id = latest_email['page_id']
            other_emails = emails_sorted[1:]

            thread_analysis = {
                'thread_id': thread_id,
                'latest_page_id': latest_page_id,
                'latest_message_id': latest_email.get('message_id', ''),
                'latest_subject': latest_email.get('subject', '')[:50],
                'latest_date': latest_email.get('date', ''),
                'latest_current_parent': latest_email.get('parent_item_id'),
                'other_emails': [],
                'need_update_latest': False,  # 最新邮件是否需要清空 Parent
                'sub_items_to_set': []  # 需要设置为 Sub-item 的 page_id 列表
            }

            # 检查最新邮件是否有错误的 Parent Item（应该没有）
            if latest_email.get('parent_item_id'):
                thread_analysis['need_update_latest'] = True
                analysis['summary']['need_update'] += 1
            else:
                analysis['summary']['correct'] += 1

            # 分析其他邮件
            for email in other_emails:
                email_info = {
                    'page_id': email['page_id'],
                    'message_id': email.get('message_id', ''),
                    'subject': email.get('subject', '')[:50],
                    'date': email.get('date', ''),
                    'current_parent': email.get('parent_item_id'),
                    'need_update': False
                }

                # 检查 Parent Item 是否正确指向最新邮件
                if email.get('parent_item_id') != latest_page_id:
                    email_info['need_update'] = True
                    thread_analysis['sub_items_to_set'].append(email['page_id'])
                    analysis['summary']['need_update'] += 1
                else:
                    analysis['summary']['correct'] += 1

                thread_analysis['other_emails'].append(email_info)

            analysis['threads'][thread_id] = thread_analysis

        # 3. 统计独立邮件（没有线程关系的）
        for email in no_thread_emails:
            message_id = email.get('message_id', '').strip('<>')
            # 如果这个邮件不是某个线程的线程头，它就是真正的独立邮件
            if message_id not in threads_map:
                # 独立邮件不应该有 Parent Item
                if email.get('parent_item_id'):
                    # 需要清空
                    analysis['summary']['need_update'] += 1
                else:
                    analysis['summary']['correct'] += 1

        # 更新统计
        analysis['summary']['total_threads'] = len(threads_map)
        analysis['summary']['single_email_threads'] = sum(
            1 for t in analysis['threads'].values() if len(t.get('other_emails', [])) == 0
        )
        analysis['summary']['multi_email_threads'] = sum(
            1 for t in analysis['threads'].values() if len(t.get('other_emails', [])) > 0
        )

        print(f"    分析完成: {analysis['summary']['total_threads']} 个线程")
        print(f"      - 单邮件线程: {analysis['summary']['single_email_threads']} 个")
        print(f"      - 多邮件线程: {analysis['summary']['multi_email_threads']} 个")
        print(f"      - 关系正确: {analysis['summary']['correct']} 封")
        print(f"      - 需要更新: {analysis['summary']['need_update']} 封")

    def _extract_email_address(self, sender: str) -> str:
        """从 sender 字符串中提取邮箱地址

        支持格式:
        - "Name" <email@example.com>
        - Name <email@example.com>
        - email@example.com
        """
        import re
        if not sender:
            return ""

        # 尝试从 <email> 格式中提取
        match = re.search(r'<([^>]+)>', sender)
        if match:
            return match.group(1).strip().lower()

        # 如果没有尖括号，检查是否本身就是邮箱
        if '@' in sender:
            return sender.strip().lower()

        return ""

    # ==================== 统计输出 ====================

    def _print_stats(self):
        """打印统计信息"""
        print(f"""
  ┌─────────────────────────────────────┐
  │ 从 Mail.app 获取:  {self.stats['fetched_from_applescript']:>6} 封       │
  │ 已在 Notion:       {self.stats['already_in_notion']:>6} 封       │
  │ 待同步:            {self.stats['pending_sync']:>6} 封       │
  └─────────────────────────────────────┘
        """)

    def _print_final_stats(self):
        """打印最终统计"""
        print(f"""
  ┌─────────────────────────────────────┐
  │ 成功同步:  {self.stats['synced']:>6} 封              │
  │ 同步失败:  {self.stats['failed']:>6} 封              │
  └─────────────────────────────────────┘
        """)

    def _print_analysis_stats(self):
        """打印合并后的分析统计"""
        comp = self.report.comparison
        pa = self.report.parent_analysis
        summary = pa.get('summary', {})
        threads = pa.get('threads', {})

        # 计算需要更新的线程数
        threads_need_update = sum(
            1 for t in threads.values()
            if t.get('need_update_latest') or t.get('sub_items_to_set')
        )

        print(f"""
  ┌─────────────────────────────────────────────────────────────────┐
  │                        分析结果                                 │
  ├─────────────────────────────────────────────────────────────────┤
  │ 【SyncStore vs Notion 对比】                                    │
  │   ✅ 完全匹配（已同步）:              {len(comp.get('matched', [])):>6} 封                │
  │   ⚠️  属性不同（date/thread_id）:     {len(comp.get('property_mismatch', [])):>6} 封                │
  │   ❌ 关键信息不同（需重新同步）:      {len(comp.get('critical_mismatch', [])):>6} 封                │
  │   📤 待同步（仅在 SyncStore）:        {len(comp.get('store_only', [])):>6} 封                │
  │   📅 早于同步日期（仅缓存）:          {len(comp.get('store_only_before_date', [])):>6} 封                │
  │   ❓ 仅在 Notion:                     {len(comp.get('notion_only', [])):>6} 封                │
  ├─────────────────────────────────────────────────────────────────┤
  │ 【Parent Item 状态】新架构：最新邮件为母节点                    │
  │   总邮件数: {pa.get('total', 0):>6} 封                                        │
  │   总线程数: {summary.get('total_threads', 0):>6} 个                                        │
  │     - 单邮件线程: {summary.get('single_email_threads', 0):>6} 个                                │
  │     - 多邮件线程: {summary.get('multi_email_threads', 0):>6} 个                                │
  │   关系状态:                                                     │
  │     ✅ 已正确: {summary.get('correct', 0):>6} 封                                        │
  │     ⚠️  需更新: {summary.get('need_update', 0):>6} 封                                        │
  └─────────────────────────────────────────────────────────────────┘
        """)

        # 需要操作的统计
        need_fix_props = len(comp.get('property_mismatch', []))
        need_fix_critical = len(comp.get('critical_mismatch', []))
        need_sync_new = len(comp.get('store_only', []))

        print("  📌 需要操作:")
        print(f"     - 修复属性 (fix-properties): {need_fix_props} 封")
        print(f"     - 重新同步 (fix-critical): {need_fix_critical} 封")
        print(f"     - 同步新邮件 (sync-new): {need_sync_new} 封")
        print(f"     - 更新 Parent Item (update-all-parents): {threads_need_update} 个线程")

        # 标记已匹配的为 synced
        for message_id, store_data, notion_data in comp.get('matched', []):
            self.sync_store.mark_synced(message_id, notion_data['page_id'], None)

        if comp.get('matched'):
            print(f"\n  ✅ 已标记 {len(comp['matched'])} 封为已同步")

    # ==================== 同步操作 ====================

    async def _sync_pending_emails(self, limit: int = None):
        """同步所有待同步的邮件"""
        pending_emails = self.sync_store.get_pending_emails(limit=limit or 10000)

        total = len(pending_emails)
        for i, email_meta in enumerate(pending_emails, 1):
            message_id = email_meta['message_id']
            internal_id = email_meta.get('internal_id')
            subject = email_meta.get('subject', '')[:40]

            print(f"\n  [{i}/{total}] {subject}...")

            try:
                # 获取完整邮件内容（v3: 优先使用 internal_id，127x 更快）
                mailbox = email_meta.get('mailbox', '收件箱')
                if internal_id and internal_id < 100000000:  # 真实 AppleScript id
                    full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                else:
                    full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)

                if not full_email:
                    print("    ❌ 无法获取邮件内容")
                    self.sync_store.mark_failed(message_id, "Failed to fetch content")
                    self.stats["failed"] += 1
                    continue

                # 构建 Email 对象（传入 internal_id）
                email_obj = await self._build_email_object(full_email, mailbox, internal_id)
                if not email_obj:
                    print("    ❌ 无法解析邮件")
                    self.sync_store.mark_failed(message_id, "Failed to parse email")
                    self.stats["failed"] += 1
                    continue

                # 同步到 Notion
                page_id = await self.notion_sync.create_email_page_v2(
                    email_obj
                )

                if page_id:
                    self.sync_store.mark_synced(message_id, page_id)
                    self.stats["synced"] += 1
                    print("    ✅ 同步成功")
                else:
                    self.sync_store.mark_failed(message_id, "Notion returned None")
                    self.stats["failed"] += 1
                    print("    ❌ 同步失败")

            except Exception as e:
                logger.error(f"Sync error for {message_id}: {e}")
                self.sync_store.mark_failed(message_id, str(e))
                self.stats["failed"] += 1
                print(f"    ❌ 错误: {e}")

    async def _sync_specific_emails(self, message_ids: List[str]):
        """同步指定的邮件列表（用于修复操作）"""
        total = len(message_ids)
        success = 0
        failed = 0
        not_found = 0

        for i, message_id in enumerate(message_ids, 1):
            # 获取邮件元数据
            email_meta = self.sync_store.get_email(message_id)
            if not email_meta:
                print(f"  [{i}/{total}] ❌ 未找到邮件元数据: {message_id[:30]}...")
                failed += 1
                continue

            subject = email_meta.get('subject', '')[:40]
            internal_id = email_meta.get('internal_id')
            print(f"  [{i}/{total}] {subject}...", end='\r')

            try:
                # v3: 优先使用 internal_id 获取（127x 更快）
                mailbox = email_meta.get('mailbox', '收件箱')
                if internal_id and internal_id < 100000000:  # 真实 AppleScript id
                    full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                else:
                    full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)

                if not full_email:
                    # 邮件在 Mail.app 中找不到，删除记录
                    self.sync_store.delete_email(message_id)
                    not_found += 1
                    continue

                email_obj = await self._build_email_object(full_email, mailbox, internal_id)
                if not email_obj:
                    self.sync_store.mark_failed(message_id, "Failed to parse email")
                    failed += 1
                    continue

                page_id = await self.notion_sync.create_email_page_v2(
                    email_obj
                )

                if page_id:
                    self.sync_store.mark_synced(message_id, page_id)
                    success += 1
                else:
                    self.sync_store.mark_failed(message_id, "Notion returned None")
                    failed += 1

            except Exception as e:
                logger.error(f"Sync error for {message_id}: {e}")
                self.sync_store.mark_failed(message_id, str(e))
                failed += 1

        return success, failed, not_found

    async def _fetch_and_sync_thread_head(self, thread_id: str) -> Optional[str]:
        """[已废弃] 获取并同步线程头邮件

        新架构使用最新邮件作为母节点，不再需要查找和同步线程头。
        线程关系由 NotionSync._handle_thread_relations() 自动处理。

        保留此方法仅用于向后兼容，实际不再被调用。

        Args:
            thread_id: 线程标识（通常是原始邮件的 message_id）

        Returns:
            None（不再执行任何操作）
        """
        logger.debug(f"[DEPRECATED] _fetch_and_sync_thread_head called for: {thread_id[:50]}...")
        return None

    async def _fetch_and_sync_thread_head_legacy(self, thread_id: str) -> Optional[str]:
        """[已废弃 - 旧实现备份] 获取并同步线程头邮件

        从 SyncStore 缓存中查找同 thread_id 最早的邮件并同步。

        优先级：
        1. 检查线程头是否已同步到 Notion（通过 message_id 查找）
        2. 在 SyncStore 缓存中查找同 thread_id 最早的邮件并同步

        注意：不再从 Mail.app 实时获取线程头，依赖预先写入的缓存。
        如果缓存中没有，会由 create_email_page_v2 的降级方案处理（使用 Notion 中最早的同线程邮件）。

        Args:
            thread_id: 线程标识（通常是原始邮件的 message_id）

        Returns:
            线程头邮件的 page_id，找不到返回 None
        """
        # 1. 检查线程头是否已在 SyncStore 且已同步
        existing = self.sync_store.get_email(thread_id)
        if existing and existing.get('sync_status') == 'synced':
            return existing.get('notion_page_id')

        # 2. 在 SyncStore 缓存中查找同 thread_id 最早的邮件
        earliest = self.sync_store.get_earliest_email_by_thread_id(thread_id)
        if earliest:
            earliest_msg_id = earliest.get('message_id')

            # 如果最早的邮件已同步，直接返回
            if earliest.get('sync_status') == 'synced':
                logger.info(f"Found synced earliest thread member in cache: {earliest_msg_id[:40]}...")
                return earliest.get('notion_page_id')

            # 最早的邮件未同步，尝试同步它（跳过 Parent Item 查找避免递归）
            logger.info(f"Found unsynced earliest thread member in cache, syncing: {earliest_msg_id[:40]}...")
            mailbox = earliest.get('mailbox', '收件箱')

            try:
                full_email = self.arm.fetch_email_by_message_id(earliest_msg_id, mailbox)
                if full_email:
                    email_obj = await self._build_email_object(full_email, mailbox)
                    if email_obj:
                        # 使用 skip_parent_lookup=True 避免递归
                        page_id = await self.notion_sync.create_email_page_v2(
                            email_obj,
                            skip_parent_lookup=True  # 关键：跳过 Parent Item 查找
                        )

                        if page_id:
                            self.sync_store.mark_synced(earliest_msg_id, page_id)
                            logger.info(f"Synced earliest thread member: {earliest_msg_id[:40]}... -> {page_id}")
                            return page_id
            except Exception as e:
                logger.warning(f"Failed to sync earliest thread member {earliest_msg_id[:40]}...: {e}")

        # 缓存中没有找到，返回 None（由 create_email_page_v2 的降级方案处理）
        logger.info(f"Thread head not found in cache: {thread_id[:50]}...")
        return None

    async def _sync_email_by_message_id(self, message_id: str, mailbox: str) -> Optional[str]:
        """同步指定 message_id 的邮件到 Notion

        用于降级方案：同步 SyncStore 中的邮件作为 Parent Item。
        如果邮件不在 SyncStore 中，会先保存元数据再同步。

        Args:
            message_id: 邮件的 message_id
            mailbox: 邮箱名称

        Returns:
            同步成功返回 page_id，失败返回 None
        """
        try:
            # 检查是否已同步
            existing = self.sync_store.get_email(message_id)
            if existing and existing.get('sync_status') == 'synced':
                return existing.get('notion_page_id')

            # 从 Mail.app 获取完整邮件
            full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)
            if not full_email:
                logger.warning(f"Email not found in Mail.app: {message_id[:40]}...")
                return None

            # 如果 SyncStore 中没有这封邮件，先保存元数据
            if not existing:
                # 添加系统时区到 AppleScript 返回的本地时间
                date_received = full_email.get('date_received', '') or full_email.get('date', '')
                if date_received and '+' not in date_received and not date_received.endswith('Z'):
                    sys_tz = get_system_timezone()
                    tz_offset = sys_tz.utcoffset(None)
                    total_seconds = int(tz_offset.total_seconds())
                    hours, remainder = divmod(abs(total_seconds), 3600)
                    minutes = remainder // 60
                    sign = '+' if total_seconds >= 0 else '-'
                    tz_suffix = f"{sign}{hours:02d}:{minutes:02d}"
                    date_received = date_received + tz_suffix

                email_dict = {
                    'message_id': message_id,
                    'thread_id': full_email.get('thread_id') or message_id.strip('<>'),
                    'subject': full_email.get('subject', ''),
                    'sender': full_email.get('sender', ''),
                    'date_received': date_received,
                    'mailbox': mailbox,
                    'is_read': full_email.get('is_read', False),
                    'is_flagged': full_email.get('is_flagged', False),
                    'sync_status': 'pending'
                }
                self.sync_store.save_email(email_dict)
                logger.info(f"Saved email to SyncStore before sync: {message_id[:40]}...")

            # 构建 Email 对象
            email_obj = await self._build_email_object(full_email, mailbox)
            if not email_obj:
                logger.warning(f"Failed to build email object: {message_id[:40]}...")
                return None

            # 同步到 Notion（跳过 Parent Item 查找避免递归）
            page_id = await self.notion_sync.create_email_page_v2(
                email_obj,
                skip_parent_lookup=True
            )

            if page_id:
                self.sync_store.mark_synced(message_id, page_id)
                logger.info(f"Synced email for fallback: {message_id[:40]}... -> {page_id}")
                return page_id

        except Exception as e:
            logger.error(f"Failed to sync email {message_id[:40]}...: {e}")

        return None

    async def _build_email_object(self, full_email: Dict, mailbox: str, internal_id: int = None) -> Optional[Email]:
        """使用 EmailReader 构建完整的 Email 对象（包含附件和图片处理）

        优化：直接使用已获取的 source 解析，避免重复调用 AppleScript
        """
        try:
            source = full_email.get('source', '')
            if not source:
                logger.warning("Email source is empty")
                return None

            # 直接解析已获取的 source，不再调用 AppleScript
            email_obj = self.email_reader.parse_email_source(
                source=source,
                message_id=full_email.get('message_id'),
                is_read=full_email.get('is_read', False),
                is_flagged=full_email.get('is_flagged', False)
            )

            if email_obj:
                # 设置邮箱类型
                email_obj.mailbox = mailbox
                # 如果 AppleScript 已经提取了 thread_id，使用它
                if full_email.get('thread_id'):
                    email_obj.thread_id = full_email.get('thread_id')
                # 设置 internal_id（v3 架构）
                if internal_id:
                    email_obj.internal_id = internal_id

            return email_obj

        except Exception as e:
            logger.error(f"Failed to build Email object: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None

    # ==================== 修复操作 ====================

    async def fix_properties(self, auto_confirm: bool = False):
        """修复属性不同的邮件（更新 Notion 的 Date 和 Thread ID）"""
        items = self.comparison.get('property_mismatch', [])
        if not items:
            print("✅ 没有需要修复属性的邮件")
            return

        print(f"\n 修复属性不同的邮件: {len(items)} 封")

        if not auto_confirm:
            confirm = input(f"确认更新 {len(items)} 封邮件的 Date/Thread ID? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消")
                return

        success = 0
        failed = 0

        for i, (message_id, store_data, notion_data) in enumerate(items, 1):
            page_id = notion_data['page_id']

            print(f"  [{i}/{len(items)}] 更新属性...", end='\r')

            try:
                # 构建需要更新的属性
                properties_to_update = {}

                # 检查并更新 Date（统一转换为北京时间）
                store_date_str = store_data.get('date_received', '')
                notion_date_str = notion_data.get('date', '')

                # 需要更新的情况：
                # 1. 日期时间不匹配（超过容差）
                # 2. Notion 时区不是北京时间
                need_date_update = False
                if store_date_str:
                    if not dates_match(store_date_str, notion_date_str, tolerance_seconds=120):
                        need_date_update = True
                    elif not is_notion_date_beijing_tz(notion_date_str):
                        need_date_update = True

                if need_date_update:
                    # 解析 SyncStore 时间并转换为北京时间
                    store_dt = parse_datetime_with_tz(store_date_str)
                    if store_dt:
                        beijing_dt = store_dt.astimezone(BEIJING_TZ)
                        properties_to_update["Date"] = {"date": {"start": beijing_dt.isoformat()}}
                    else:
                        # 无法解析日期，记录警告
                        logger.warning(f"Cannot parse date '{store_date_str}' for {message_id[:40]}...")

                # 检查并更新 Thread ID
                store_thread = store_data.get('thread_id', '')
                notion_thread = notion_data.get('thread_id', '')
                if store_thread and store_thread != notion_thread:
                    properties_to_update["Thread ID"] = {
                        "rich_text": [{"text": {"content": store_thread[:1999]}}]
                    }

                # 执行更新
                if properties_to_update:
                    await self.notion_sync.client.client.pages.update(
                        page_id=page_id,
                        properties=properties_to_update
                    )
                    self.sync_store.mark_synced(message_id, page_id, None)
                    success += 1
                else:
                    # 没有可更新的属性（可能是日期解析失败）
                    logger.warning(f"No properties to update for {message_id[:40]}... (date parse failed?)")
                    failed += 1
            except Exception as e:
                logger.error(f"Failed to update properties for {message_id}: {e}")
                failed += 1

        print(f"\n✅ 属性更新完成: 成功 {success} 封, 失败 {failed} 封")

    async def fix_critical_mismatch(self, auto_confirm: bool = False):
        """修复关键信息不同的邮件（删除旧页面，重新同步）"""
        items = self.comparison.get('critical_mismatch', [])
        if not items:
            print("✅ 没有关键信息不同的邮件")
            return

        print(f"\n 修复关键信息不同的邮件: {len(items)} 封")
        print("  这将删除 Notion 中的旧页面并重新同步")

        if not auto_confirm:
            # 显示详情
            print("\n  将处理以下邮件:")
            for _, store_data, _, reasons in items[:10]:
                print(f"    - {store_data.get('subject', '')[:40]}...")
                print(f"      原因: {', '.join(reasons)}")

            if len(items) > 10:
                print(f"    ... 还有 {len(items) - 10} 封")

            confirm = input(f"\n确认重新同步 {len(items)} 封邮件? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消")
                return

        success = 0
        failed = 0
        not_found = 0  # 邮件在 Mail.app 中找不到

        for i, (message_id, store_data, notion_data, _) in enumerate(items, 1):
            page_id = notion_data['page_id']
            subject = store_data.get('subject', '')[:40]
            internal_id = store_data.get('internal_id')

            print(f"  [{i}/{len(items)}] 重新同步: {subject}...", end='\r')

            try:
                # 1. 归档（删除）旧页面（如果尚未归档）
                try:
                    await self.notion_sync.client.client.pages.update(
                        page_id=page_id,
                        archived=True
                    )
                except Exception as archive_err:
                    # 如果页面已经被归档，忽略错误继续执行
                    if "archived" in str(archive_err).lower():
                        logger.debug(f"Page already archived: {page_id}")
                    else:
                        raise archive_err

                # 2. 重新同步（v3: 优先使用 internal_id）
                mailbox = store_data.get('mailbox', '收件箱')
                if internal_id and internal_id < 100000000:  # 真实 AppleScript id
                    full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                else:
                    full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)

                if not full_email:
                    # 邮件在 Mail.app 中找不到（可能已删除或移动）
                    # 直接删除 SyncStore 记录，避免后续重复处理
                    self.sync_store.delete_email(message_id)
                    not_found += 1
                    continue

                email_obj = await self._build_email_object(full_email, mailbox, internal_id)
                if not email_obj:
                    failed += 1
                    self.sync_store.mark_failed(message_id, "Failed to build email object")
                    continue

                new_page_id = await self.notion_sync.create_email_page_v2(
                    email_obj
                )

                if new_page_id:
                    # 3. 用 Mail.app 中的正确数据更新 SyncStore（修复元数据污染问题）
                    # mark_synced 只更新 sync_status 和 notion_page_id，不更新 subject/sender
                    # 所以需要用 save_email 完整覆盖
                    self.sync_store.save_email({
                        'internal_id': internal_id,  # v3: 保留 internal_id
                        'message_id': message_id,
                        'subject': email_obj.subject or '',
                        'sender': f"{email_obj.sender_name} <{email_obj.sender}>" if email_obj.sender_name else (email_obj.sender or ''),
                        'date_received': email_obj.date.isoformat() if email_obj.date else '',
                        'thread_id': email_obj.thread_id or '',
                        'mailbox': mailbox,
                        'sync_status': 'synced',
                        'notion_page_id': new_page_id
                    })
                    success += 1
                else:
                    failed += 1
                    self.sync_store.mark_failed(message_id, "Notion create page failed")

            except Exception as e:
                logger.error(f"Failed to fix critical mismatch for {message_id}: {e}")
                failed += 1

        # 输出统计
        print(f"\n✅ 关键信息修复完成: 成功 {success} 封, 失败 {failed} 封", end="")
        if not_found > 0:
            print(f", 邮件找不到 {not_found} 封")
        else:
            print()

    async def update_all_parent_items(self, auto_confirm: bool = False):
        """遍历所有线程，重建 Parent Item 关联（新架构：最新邮件为母节点）

        新逻辑：
        1. 对于每个线程，找到最新邮件
        2. 设置最新邮件的 Sub-item 包含同线程所有其他邮件
        3. 这会自动重建所有邮件的 Parent Item 关系

        Args:
            auto_confirm: 跳过确认步骤
        """
        # 检查是否已有分析结果
        analysis = self.report.parent_analysis
        has_existing_analysis = analysis.get('total', 0) > 0 and 'threads' in analysis

        if not has_existing_analysis:
            # 执行新的分析
            print("\n📊 执行 Parent Item 分析（新架构）...")
            await self._analyze_all()
            analysis = self.report.parent_analysis

            if analysis.get('total', 0) == 0:
                print("❌ 分析失败或没有数据")
                return

        # 显示分析结果
        summary = analysis.get('summary', {})
        threads = analysis.get('threads', {})

        print("\n📊 Parent Item 分析结果（新架构：最新邮件为母节点）")
        print(f"  总邮件数: {analysis.get('total', 0)}")
        print(f"  总线程数: {summary.get('total_threads', 0)}")
        print(f"    - 单邮件线程: {summary.get('single_email_threads', 0)} 个")
        print(f"    - 多邮件线程: {summary.get('multi_email_threads', 0)} 个")
        print("  关系状态:")
        print(f"    - 已正确: {summary.get('correct', 0)} 封")
        print(f"    - 需要更新: {summary.get('need_update', 0)} 封")

        # 计算需要操作的线程数
        threads_need_update = [
            t for t in threads.values()
            if t.get('need_update_latest') or t.get('sub_items_to_set')
        ]

        if not threads_need_update:
            print("\n✅ 所有 Parent Item 关系已正确，无需更新")
            return

        print(f"\n  需要更新的线程: {len(threads_need_update)} 个")

        if not auto_confirm:
            confirm = input(f"\n确认更新 {len(threads_need_update)} 个线程的 Parent Item 关系? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消")
                return

        # 统计
        stats = {
            'threads_processed': 0,
            'threads_updated': 0,
            'emails_updated': 0,
            'failed': 0
        }

        print("\n  开始更新 Parent Item 关系...")

        for i, (thread_id, thread_data) in enumerate(threads.items(), 1):
            if not thread_data.get('need_update_latest') and not thread_data.get('sub_items_to_set'):
                continue

            stats['threads_processed'] += 1
            latest_page_id = thread_data['latest_page_id']
            latest_subject = thread_data.get('latest_subject', '')[:40]
            # 同时包含需要清空 Parent 的最新邮件（如果有错误的 Parent）
            # 通过设置 Sub-item 可以一次性处理
            all_other_page_ids = [e['page_id'] for e in thread_data.get('other_emails', [])]

            print(f"  [{stats['threads_processed']}/{len(threads_need_update)}] "
                  f"{latest_subject}... ({len(all_other_page_ids)} 封)", end='\r')

            try:
                success = True
                if all_other_page_ids:
                    # 设置最新邮件的 Sub-item（这会自动重建 Parent Item 关系）
                    success = await self.notion_sync.update_sub_items(latest_page_id, all_other_page_ids)
                    if success:
                        stats['emails_updated'] += len(all_other_page_ids)
                elif thread_data.get('need_update_latest'):
                    # 只需要清空最新邮件的 Parent Item
                    await self.notion_sync.client.client.pages.update(
                        page_id=latest_page_id,
                        properties={"Parent Item": {"relation": []}}
                    )
                    stats['emails_updated'] += 1

                if success:
                    stats['threads_updated'] += 1
                else:
                    stats['failed'] += 1

            except Exception as e:
                logger.error(f"Failed to update thread {thread_id[:30]}...: {e}")
                stats['failed'] += 1

        # 输出统计
        print("\n\n✅ Parent Item 关系重建完成:")
        print(f"   处理线程: {stats['threads_processed']} 个")
        print(f"   成功更新: {stats['threads_updated']} 个线程, {stats['emails_updated']} 封邮件")
        print(f"   失败: {stats['failed']} 个")

    async def sync_new_emails(self, limit: int = None, auto_confirm: bool = False):
        """同步新邮件（仅在 SyncStore 中的）"""
        items = self.comparison.get('store_only', [])
        if not items:
            print("✅ 没有需要同步的新邮件")
            return

        if limit:
            items = items[:limit]

        print(f"\n 同步新邮件: {len(items)} 封")

        if not auto_confirm:
            confirm = input(f"确认同步 {len(items)} 封新邮件? (y/n): ")
            if confirm.lower() != 'y':
                print("已取消")
                return

        # 直接同步指定的 message_ids，而不是从 get_pending_emails 获取
        success, failed, not_found = await self._sync_specific_emails(items)
        print(f"\n✅ 新邮件同步完成: 成功 {success} 封, 失败 {failed} 封", end="")
        if not_found > 0:
            print(f", 邮件找不到 {not_found} 封（已删除记录）")
        else:
            print()
