"""
SQLite Radar - Fast new email detection module.

Uses Mail.app's SQLite database for efficient polling to detect new emails.
New architecture: Only detects max_row_id changes, does not track individual row_ids.

The radar triggers AppleScript to fetch latest emails when changes are detected.
No row_id to message_id mapping is needed - we use message_id directly.

Requirements:
- Full Disk Access permission for accessing Mail.app database
- Mail.app must be configured with at least one account
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from loguru import logger

from src.mail.constants import get_sqlite_patterns


class SQLiteRadar:
    """SQLite Radar - Fast new email detection.

    New simplified architecture:
    - Only tracks max_row_id changes (not individual row_ids)
    - Returns estimated new email count
    - Triggers AppleScript fetch when changes detected
    """

    def __init__(self, mailboxes: List[str] = None, account_url_prefix: str = ""):
        """Initialize the SQLite radar.

        Args:
            mailboxes: List of mailbox names to monitor. Default: ["收件箱"]
            account_url_prefix: 账户 URL 前缀过滤（如 "ews://" 只匹配 Exchange 账户）
        """
        self.db_path = self._find_db_path()
        self.mailboxes = mailboxes or ["收件箱"]
        self.account_url_prefix = account_url_prefix
        self._last_max_row_id: int = 0

        if self.db_path:
            logger.info(f"SQLite radar initialized with database: {self.db_path}")
            logger.info(f"Monitoring mailboxes: {self.mailboxes}")
        else:
            logger.warning("SQLite radar: database not found")

    def _find_db_path(self) -> Optional[Path]:
        """Find the Mail.app SQLite database path."""
        mail_base = Path.home() / "Library" / "Mail"

        if not mail_base.exists():
            logger.error(f"Mail directory does not exist: {mail_base}")
            return None

        versions = sorted(
            mail_base.glob("V*"),
            key=lambda p: int(p.name[1:]) if p.name[1:].isdigit() else 0,
            reverse=True
        )

        if not versions:
            logger.error("No Mail version directories found (V*)")
            return None

        db_path = versions[0] / "MailData" / "Envelope Index"

        if not db_path.exists():
            logger.error(f"Envelope Index database not found: {db_path}")
            return None

        logger.debug(f"Found Mail database: {db_path}")
        return db_path

    def _get_connection(self) -> sqlite3.Connection:
        """Get a read-only database connection."""
        if not self.db_path:
            raise RuntimeError("Database path not available")

        uri = f"file:{self.db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def _connection(self):
        """Context manager for database connections.

        Ensures proper cleanup even if an exception occurs.
        """
        conn = self._get_connection()
        try:
            yield conn
        finally:
            conn.close()

    def is_available(self) -> bool:
        """Check if the SQLite radar is available and working."""
        if not self.db_path:
            return False

        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT 1")
            return True
        except Exception as e:
            logger.error(f"SQLite radar availability check failed: {e}")
            return False

    def _build_mailbox_filter(self) -> str:
        """Build SQL WHERE clause for mailbox filtering.

        Security Note:
            The patterns used here come from the centralized constants module,
            which defines internal constant patterns. These patterns are
            NOT user input and cannot be modified at runtime.

            The patterns contain URL-encoded strings and SQL LIKE wildcards,
            which are intentional and safe in this context.

        Returns:
            SQL WHERE clause string for filtering mailboxes.
        """
        conditions = []
        for mailbox in self.mailboxes:
            patterns = get_sqlite_patterns(mailbox)
            for pattern in patterns:
                if pattern and all(c.isalnum() or c in '%_-' for c in pattern):
                    cond = f"mb.url LIKE '%{pattern}%'"
                    # 账户级过滤：只匹配指定 URL 前缀的账户
                    if self.account_url_prefix:
                        prefix = self.account_url_prefix.replace("'", "''")
                        cond = f"(mb.url LIKE '{prefix}%' AND mb.url LIKE '%{pattern}%')"
                    conditions.append(cond)
                else:
                    logger.warning(f"Skipping invalid mailbox pattern: {pattern}")

        if conditions:
            return f"({' OR '.join(conditions)})"
        return "1=1"

    def get_current_max_row_id(self) -> int:
        """Get the current maximum row_id from the database.

        Returns:
            Maximum row_id, or 0 if not available.
        """
        if not self.db_path:
            return 0

        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                mailbox_filter = self._build_mailbox_filter()

                query = f"""
                    SELECT MAX(m.ROWID) as max_row_id
                    FROM messages m
                    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                    WHERE m.deleted = 0
                    AND {mailbox_filter}
                """

                cursor.execute(query)
                row = cursor.fetchone()
                return row['max_row_id'] or 0

        except Exception as e:
            logger.error(f"Failed to get max row_id: {e}")
            return 0

    def get_email_count(self) -> Dict[str, int]:
        """Get current email count per mailbox.

        Returns:
            Dict mapping mailbox name to email count.
        """
        if not self.db_path:
            return {}

        result = {}

        try:
            with self._connection() as conn:
                cursor = conn.cursor()

                for mailbox in self.mailboxes:
                    patterns = get_sqlite_patterns(mailbox)
                    conditions = [f"mb.url LIKE '%{pattern}%'" for pattern in patterns]
                    mailbox_filter = f"({' OR '.join(conditions)})"

                    query = f"""
                        SELECT COUNT(*) as count
                        FROM messages m
                        LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                        WHERE m.deleted = 0
                        AND {mailbox_filter}
                    """

                    cursor.execute(query)
                    row = cursor.fetchone()
                    result[mailbox] = row['count'] or 0

        except Exception as e:
            logger.error(f"Failed to get email count: {e}")

        return result

    def check_for_changes(self, last_max_row_id: int) -> Tuple[bool, int, int]:
        """Check if there are new emails since last check.

        Args:
            last_max_row_id: The max_row_id from last check.

        Returns:
            Tuple of (has_changes, current_max_row_id, estimated_new_count)
        """
        current_max = self.get_current_max_row_id()

        if current_max > last_max_row_id:
            estimated_new = current_max - last_max_row_id
            logger.info(f"Detected changes: max_row_id {last_max_row_id} -> {current_max} (estimated {estimated_new} new)")
            return True, current_max, estimated_new

        return False, current_max, 0

    def has_new_emails(self) -> Tuple[bool, int]:
        """Check if there are new emails (stateful version).

        Uses internal state to track last_max_row_id.

        Returns:
            Tuple of (has_new, estimated_new_count)
        """
        has_changes, current_max, estimated_new = self.check_for_changes(self._last_max_row_id)

        if has_changes:
            self._last_max_row_id = current_max
            return True, estimated_new

        return False, 0

    def set_last_max_row_id(self, row_id: int):
        """Set the last max_row_id (for initialization from persistent storage).

        Args:
            row_id: The row_id to set as last known maximum.
        """
        self._last_max_row_id = row_id
        logger.info(f"Set last_max_row_id to {row_id}")

    def get_last_max_row_id(self) -> int:
        """Get the last known max_row_id.

        Returns:
            Last known max_row_id.
        """
        return self._last_max_row_id

    def get_new_emails(self, since_row_id: int) -> List[Dict]:
        """获取指定 ROWID 之后的所有新邮件元数据

        用于 v3 架构：SQLite 直接查询新邮件，无需通过 AppleScript 批量获取。

        Args:
            since_row_id: 起始 ROWID（不包含）

        Returns:
            List[Dict] 包含:
                - internal_id: int (ROWID = AppleScript id)
                - subject: str
                - sender_email: str
                - sender_name: str
                - date_received: str (ISO format)
                - is_read: bool
                - is_flagged: bool
                - mailbox: str (收件箱/发件箱/...)
        """
        if not self.db_path:
            return []

        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                mailbox_filter = self._build_mailbox_filter()

                query = f"""
                    SELECT
                        m.ROWID as internal_id,
                        COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '') as subject,
                        a.address as sender_email,
                        a.comment as sender_name,
                        datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
                        m.read as is_read,
                        m.flagged as is_flagged,
                        mb.url as mailbox_url
                    FROM messages m
                    LEFT JOIN subjects s ON m.subject = s.ROWID
                    LEFT JOIN addresses a ON m.sender = a.ROWID
                    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                    WHERE m.deleted = 0
                      AND m.ROWID > ?
                      AND {mailbox_filter}
                    ORDER BY m.ROWID ASC
                """

                cursor.execute(query, (since_row_id,))
                rows = cursor.fetchall()

                emails = []
                for row in rows:
                    mailbox = self._parse_mailbox_url(row['mailbox_url'])
                    emails.append({
                        'internal_id': row['internal_id'],
                        'subject': row['subject'] or '',
                        'sender_email': row['sender_email'] or '',
                        'sender_name': row['sender_name'] or '',
                        'date_received': row['date_received'] or '',
                        'is_read': bool(row['is_read']),
                        'is_flagged': bool(row['is_flagged']),
                        'mailbox': mailbox,
                    })

                logger.debug(f"get_new_emails: found {len(emails)} emails since ROWID {since_row_id}")
                return emails

        except Exception as e:
            # 必须抛给调用方 (与 davmail backend 同理): 静默返回 [] 会让 _poll_cycle
            # 把失败当"没新邮件"并推进游标, 失败窗口内的邮件永久丢失。
            logger.error(f"Failed to get new emails: {e}")
            raise

    def get_flags_by_ids(self, internal_ids: List[int]) -> Dict[int, Dict]:
        """查询指定 internal_id 列表的当前 read/flagged 状态"""
        if not internal_ids or not self.db_path:
            return {}
        result = {}
        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                batch_size = 500
                for i in range(0, len(internal_ids), batch_size):
                    batch = internal_ids[i:i + batch_size]
                    placeholders = ','.join('?' * len(batch))
                    cursor.execute(f"""
                        SELECT m.ROWID as internal_id,
                               m.read as is_read,
                               m.flagged as is_flagged
                        FROM messages m
                        WHERE m.ROWID IN ({placeholders})
                          AND m.deleted = 0
                    """, batch)
                    for row in cursor.fetchall():
                        result[row['internal_id']] = {
                            'is_read': bool(row['is_read']),
                            'is_flagged': bool(row['is_flagged']),
                        }
        except Exception as e:
            logger.error(f"Failed to get flags by ids: {e}")
        return result

    def get_recent_flags(self, limit: int = 1000) -> Dict[int, Dict]:
        """获取最近 N 封邮件的 read/flagged 状态

        用于 flag 变化检测：与 SyncStore 中存储的值对比。

        Args:
            limit: 查询邮件数量（按 ROWID 倒序取最近 N 封）

        Returns:
            {internal_id: {'is_read': bool, 'is_flagged': bool}}
        """
        if not self.db_path:
            return {}

        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                mailbox_filter = self._build_mailbox_filter()

                query = f"""
                    SELECT m.ROWID as internal_id,
                           m.read as is_read,
                           m.flagged as is_flagged
                    FROM messages m
                    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                    WHERE m.deleted = 0
                      AND {mailbox_filter}
                    ORDER BY m.ROWID DESC
                    LIMIT ?
                """

                cursor.execute(query, (limit,))
                result = {}
                for row in cursor.fetchall():
                    result[row['internal_id']] = {
                        'is_read': bool(row['is_read']),
                        'is_flagged': bool(row['is_flagged']),
                    }

                logger.debug(f"get_recent_flags: queried {len(result)} emails")
                return result

        except Exception as e:
            logger.error(f"Failed to get recent flags: {e}")
            return {}

    def lookup_internal_id_by_message_id(self, message_id: str) -> Optional[int]:
        """通过 message_id 在 Envelope Index 中查找 internal_id（ROWID）

        用于反向同步时 SyncStore 中找不到记录的 fallback。
        """
        if not self.db_path or not message_id:
            return None

        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                mailbox_filter = self._build_mailbox_filter()
                # message_global_data.message_id_header 带尖括号
                header = f"<{message_id}>" if not message_id.startswith("<") else message_id
                cursor.execute(f"""
                    SELECT m.ROWID as internal_id
                    FROM messages m
                    JOIN message_global_data mgd ON m.message_id = mgd.message_id
                    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                    WHERE mgd.message_id_header = ?
                      AND m.deleted = 0
                      AND {mailbox_filter}
                    LIMIT 1
                """, (header,))
                row = cursor.fetchone()
                if row:
                    return row['internal_id']
        except Exception as e:
            logger.debug(f"lookup_internal_id_by_message_id failed: {e}")

        return None

    def search_all_emails(self, filters: Dict, limit: int = 10, offset: int = 0) -> Dict:
        """搜索 Mail.app 所有邮件元数据（直接查 Envelope Index）

        覆盖收发件箱全部邮件（~24k+），不依赖 SyncStore。

        Args:
            filters: 筛选条件字典，支持的 key：
                - query: 全文模糊搜索（匹配 subject + sender address/name）
                - from: 发件人筛选（LIKE 匹配）
                - subject: 主题筛选（LIKE 匹配）
                - date_from: 起始日期 YYYY-MM-DD
                - date_to: 截止日期 YYYY-MM-DD
                - mailbox: 邮箱名（收件箱/发件箱）
                - is_flagged: 旗标状态
                - is_read: 已读状态
            limit: 最大返回数量（上限 50）
            offset: 分页偏移

        Returns:
            {"total": int, "limit": int, "offset": int, "emails": [...]}
        """
        if not self.db_path:
            return {"total": 0, "limit": limit, "offset": offset, "emails": []}

        limit = min(limit, 50)
        mailbox_filter = self._build_mailbox_filter()
        conditions = [f"m.deleted = 0", mailbox_filter]
        params: list = []

        # 全文模糊搜索
        query = filters.get("query")
        if query:
            conditions.append(
                "(COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '') LIKE ?"
                " OR a.address LIKE ? OR a.comment LIKE ?)"
            )
            like_val = f"%{query}%"
            params.extend([like_val, like_val, like_val])

        # 发件人
        from_filter = filters.get("from")
        if from_filter:
            conditions.append("(a.address LIKE ? OR a.comment LIKE ?)")
            like_val = f"%{from_filter}%"
            params.extend([like_val, like_val])

        # 主题
        subject_filter = filters.get("subject")
        if subject_filter:
            conditions.append(
                "COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '') LIKE ?"
            )
            params.append(f"%{subject_filter}%")

        # 日期范围
        date_from = filters.get("date_from")
        if date_from:
            try:
                from datetime import datetime
                dt = datetime.strptime(date_from, "%Y-%m-%d")
                conditions.append("m.date_received >= ?")
                params.append(dt.timestamp())
            except ValueError:
                pass

        date_to = filters.get("date_to")
        if date_to:
            try:
                from datetime import datetime
                dt = datetime.strptime(date_to, "%Y-%m-%d")
                # 截止日期包含当天
                conditions.append("m.date_received <= ?")
                params.append(dt.timestamp() + 86399)
            except ValueError:
                pass

        # 邮箱名筛选（进一步过滤）
        mailbox = filters.get("mailbox")
        if mailbox:
            mb_patterns = get_sqlite_patterns(mailbox)
            if mb_patterns:
                mb_conds = [f"mb.url LIKE '%{p}%'" for p in mb_patterns
                            if p and all(c.isalnum() or c in '%_-' for c in p)]
                if mb_conds:
                    conditions.append(f"({' OR '.join(mb_conds)})")

        # 旗标/已读
        is_flagged = filters.get("is_flagged")
        if is_flagged is not None:
            conditions.append("m.flagged = ?")
            params.append(1 if is_flagged else 0)

        is_read = filters.get("is_read")
        if is_read is not None:
            conditions.append("m.read = ?")
            params.append(1 if is_read else 0)

        where_clause = " AND ".join(conditions)

        try:
            with self._connection() as conn:
                cursor = conn.cursor()

                # 总数
                cursor.execute(f"""
                    SELECT COUNT(*) as cnt
                    FROM messages m
                    LEFT JOIN subjects s ON m.subject = s.ROWID
                    LEFT JOIN addresses a ON m.sender = a.ROWID
                    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                    WHERE {where_clause}
                """, params)
                total = cursor.fetchone()["cnt"]

                # 数据
                cursor.execute(f"""
                    SELECT
                        m.ROWID as internal_id,
                        COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '') as subject,
                        a.address as sender_email,
                        a.comment as sender_name,
                        datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
                        m.read as is_read,
                        m.flagged as is_flagged,
                        mb.url as mailbox_url
                    FROM messages m
                    LEFT JOIN subjects s ON m.subject = s.ROWID
                    LEFT JOIN addresses a ON m.sender = a.ROWID
                    LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
                    WHERE {where_clause}
                    ORDER BY m.date_received DESC
                    LIMIT ? OFFSET ?
                """, params + [limit, offset])

                emails = []
                for row in cursor.fetchall():
                    emails.append({
                        "internal_id": row["internal_id"],
                        "subject": row["subject"] or "",
                        "sender": row["sender_email"] or "",
                        "sender_name": row["sender_name"] or "",
                        "date_received": row["date_received"] or "",
                        "mailbox": self._parse_mailbox_url(row["mailbox_url"]),
                        "is_read": bool(row["is_read"]),
                        "is_flagged": bool(row["is_flagged"]),
                    })

                return {"total": total, "limit": limit, "offset": offset, "emails": emails}

        except Exception as e:
            logger.error(f"search_all_emails failed: {e}")
            return {"total": 0, "limit": limit, "offset": offset, "emails": []}

    def _parse_mailbox_url(self, url: str) -> str:
        """解析 mailbox URL 提取中文邮箱名称

        Args:
            url: mailbox URL (e.g., "imap://.../%E6%94%B6%E4%BB%B6%E7%AE%B1")

        Returns:
            邮箱名称 (收件箱/发件箱/...)
        """
        if not url:
            return "收件箱"  # 默认

        try:
            from urllib.parse import unquote

            # URL 解码
            decoded = unquote(url)

            # 常见邮箱名称映射
            mailbox_patterns = {
                "收件箱": "收件箱",
                "INBOX": "收件箱",
                "发件箱": "发件箱",
                "已发送邮件": "发件箱",
                "Sent": "发件箱",
                "Sent Messages": "发件箱",
                "已发送": "发件箱",
            }

            for pattern, mailbox_name in mailbox_patterns.items():
                if pattern in decoded:
                    return mailbox_name

            # 未知邮箱，返回最后一段路径
            parts = decoded.rstrip('/').split('/')
            if parts:
                return parts[-1]

            return "收件箱"

        except Exception as e:
            logger.warning(f"Failed to parse mailbox URL: {e}")
            return "收件箱"
