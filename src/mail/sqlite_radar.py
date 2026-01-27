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

    def __init__(self, mailboxes: List[str] = None):
        """Initialize the SQLite radar.

        Args:
            mailboxes: List of mailbox names to monitor. Default: ["收件箱"]
        """
        self.db_path = self._find_db_path()
        self.mailboxes = mailboxes or ["收件箱"]
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
                # Validate pattern only contains expected characters
                # (alphanumeric, %, _, -, and URL encoding characters)
                if pattern and all(c.isalnum() or c in '%_-' for c in pattern):
                    conditions.append(f"mb.url LIKE '%{pattern}%'")
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
