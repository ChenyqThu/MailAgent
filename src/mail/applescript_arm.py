"""
AppleScript 机械臂模块

用于获取邮件详情和执行写操作。配合 SQLite 雷达使用，
实现高效的邮件同步：雷达快速检测新邮件，机械臂精准获取详情。

核心功能：
- fetch_emails_by_position(): 按位置获取最新 N 封邮件
- fetch_email_by_message_id(): 通过 message_id 获取完整邮件（包含 thread_id）
- mark_as_read() / set_flag(): 邮件状态写操作

Usage:
    arm = AppleScriptArm(account_name="Exchange", inbox_name="收件箱")

    # 获取最新邮件
    emails = arm.fetch_emails_by_position(count=10, mailbox="收件箱")

    # 按 message_id 获取完整内容
    content = arm.fetch_email_by_message_id("<message-id@example.com>")

    # 标记已读
    arm.mark_as_read("<message-id@example.com>", read=True)

    # 设置旗标
    arm.set_flag("<message-id@example.com>", flagged=True)
"""

import subprocess
import time
import email
from datetime import datetime
from typing import List, Dict, Optional, Any, Tuple
from loguru import logger

from src.config import config
from src.mail.constants import get_applescript_name


class AppleScriptArm:
    """AppleScript 机械臂 - 获取邮件详情和执行写操作

    支持多邮箱操作（收件箱、发件箱等）
    """

    # 分隔符用于解析 AppleScript 返回结果
    SEPARATOR = "{{SEP}}"
    RECORD_SEPARATOR = "{{REC}}"

    def __init__(
        self,
        account_name: str = "Exchange",
        inbox_name: str = "收件箱"
    ):
        """
        初始化 AppleScript 机械臂

        Args:
            account_name: Mail.app 账户名称
            inbox_name: 默认邮箱名称
        """
        self.account_name = account_name
        self.inbox_name = inbox_name

        # 从配置读取超时时间
        from src.config import config
        self.timeout = config.applescript_timeout

        # 统计信息
        self._stats = {
            "applescript_calls": 0
        }

        logger.debug(f"AppleScriptArm initialized: account={account_name}, inbox={inbox_name}, timeout={self.timeout}s")

    def _get_mailbox_name(self, mailbox: str = None) -> str:
        """Get AppleScript mailbox name from user-friendly name.

        Args:
            mailbox: User-friendly mailbox name (收件箱/发件箱)

        Returns:
            AppleScript mailbox name
        """
        if mailbox is None:
            return self.inbox_name
        return get_applescript_name(mailbox)

    def fetch_emails_by_position(self, count: int, mailbox: str = None) -> List[Dict[str, Any]]:
        """
        按位置获取最新 N 封邮件（与 SQLite 顺序一致）

        Args:
            count: 要获取的邮件数量
            mailbox: 邮箱名称（收件箱/发件箱），默认使用 inbox_name

        Returns:
            List[Dict] 每个包含:
                - message_id: str
                - subject: str
                - sender: str
                - date_received: str (ISO format)
                - is_read: bool
                - is_flagged: bool
                - thread_id: Optional[str]
        """
        if count <= 0:
            return []

        mailbox_name = self._get_mailbox_name(mailbox)
        logger.info(f"Fetching {count} emails from {mailbox_name} via AppleScript...")

        emails = self._fetch_emails_from_applescript(count, mailbox_name)
        self._stats["applescript_calls"] += 1

        return emails[:count] if emails else []

    def _fetch_emails_from_applescript(self, count: int, mailbox_name: str, offset: int = 0) -> List[Dict[str, Any]]:
        """
        实际执行 AppleScript 获取邮件（内部方法）

        Args:
            count: 要获取的邮件数量
            mailbox_name: AppleScript 邮箱名称
            offset: 起始位置偏移（0 表示从最新开始）

        Returns:
            邮件列表，包含 thread_id
        """
        start_index = offset + 1  # AppleScript 从 1 开始
        end_index = offset + count

        script = f'''
        tell application "Mail"
            set resultList to {{}}
            tell account "{self._escape_for_applescript(self.account_name)}"
                tell mailbox "{self._escape_for_applescript(mailbox_name)}"
                    set msgCount to count of messages
                    set startIdx to {start_index}
                    set endIdx to {end_index}

                    if startIdx > msgCount then
                        return ""
                    end if
                    if endIdx > msgCount then
                        set endIdx to msgCount
                    end if

                    repeat with i from startIdx to endIdx
                        try
                            set m to message i
                            set msgId to message id of m
                            set msgSubject to subject of m
                            set msgSender to sender of m
                            set msgDate to date received of m
                            set msgRead to read status of m
                            set msgFlagged to flagged status of m

                            -- 直接按名称获取 References 和 In-Reply-To（比遍历快 4-5 倍）
                            set msgReferences to ""
                            set msgInReplyTo to ""
                            try
                                set msgReferences to content of header "References" of m
                            end try
                            try
                                set msgInReplyTo to content of header "In-Reply-To" of m
                            end try

                            -- 格式化日期为 ISO 格式
                            set dateStr to (year of msgDate as string) & "-"
                            set monthNum to (month of msgDate as integer)
                            if monthNum < 10 then
                                set dateStr to dateStr & "0"
                            end if
                            set dateStr to dateStr & (monthNum as string) & "-"
                            set dayNum to (day of msgDate as integer)
                            if dayNum < 10 then
                                set dateStr to dateStr & "0"
                            end if
                            set dateStr to dateStr & (dayNum as string) & "T"
                            set hourNum to (hours of msgDate as integer)
                            if hourNum < 10 then
                                set dateStr to dateStr & "0"
                            end if
                            set dateStr to dateStr & (hourNum as string) & ":"
                            set minuteNum to (minutes of msgDate as integer)
                            if minuteNum < 10 then
                                set dateStr to dateStr & "0"
                            end if
                            set dateStr to dateStr & (minuteNum as string) & ":"
                            set secondNum to (seconds of msgDate as integer)
                            if secondNum < 10 then
                                set dateStr to dateStr & "0"
                            end if
                            set dateStr to dateStr & (secondNum as string)

                            set info to msgId & "{{{{SEP}}}}" & msgSubject & "{{{{SEP}}}}" & msgSender & "{{{{SEP}}}}" & dateStr & "{{{{SEP}}}}" & (msgRead as string) & "{{{{SEP}}}}" & (msgFlagged as string) & "{{{{SEP}}}}" & msgReferences & "{{{{SEP}}}}" & msgInReplyTo
                            set end of resultList to info
                        on error errMsg
                            -- 跳过无法读取的邮件
                        end try
                    end repeat
                end tell
            end tell

            -- 使用记录分隔符连接结果
            set AppleScript's text item delimiters to "{{{{REC}}}}"
            set resultStr to resultList as string
            set AppleScript's text item delimiters to ""
            return resultStr
        end tell
        '''

        result = self._execute_script(script, timeout=config.applescript_timeout)
        if not result:
            logger.warning("fetch_emails_by_position returned empty result")
            return []

        emails = []
        records = result.split(self.RECORD_SEPARATOR)

        for record in records:
            if not record.strip():
                continue

            parts = record.split(self.SEPARATOR)
            if len(parts) >= 6:
                try:
                    # 提取 thread_id（从 References 或 In-Reply-To）
                    thread_id = None
                    references = parts[6] if len(parts) > 6 else ""
                    in_reply_to = parts[7] if len(parts) > 7 else ""

                    if references:
                        # References 第一个是原始邮件的 message_id
                        refs = references.strip().split()
                        if refs:
                            thread_id = refs[0].strip().strip('<>')
                    elif in_reply_to:
                        thread_id = in_reply_to.strip().strip('<>')

                    # 如果没有回复关系，thread_id 为 None（调用方可用 message_id）
                    emails.append({
                        "message_id": parts[0],
                        "subject": parts[1],
                        "sender": parts[2],
                        "date_received": parts[3],
                        "is_read": parts[4].lower() == "true",
                        "is_flagged": parts[5].lower() == "true",
                        "thread_id": thread_id,
                    })
                except Exception as e:
                    logger.warning(f"Failed to parse email record: {e}, record={record[:100]}")

        logger.debug(f"fetch_emails_by_position: fetched {len(emails)} emails")
        return emails

    def fetch_email_content(self, message_id: str, mailbox: str = None) -> Optional[Dict[str, Any]]:
        """
        通过 message_id 获取邮件完整内容

        Args:
            message_id: 邮件的 Message-ID
            mailbox: 邮箱名称（收件箱/发件箱），默认使用 inbox_name

        Returns:
            Dict 包含:
                - message_id: str
                - subject: str
                - sender: str
                - date: str
                - content: str (邮件正文)
                - source: str (原始源码)
                - is_read: bool
                - is_flagged: bool
            如果获取失败返回 None
        """
        escaped_id = self._escape_for_applescript(message_id)
        mailbox_name = self._get_mailbox_name(mailbox)

        script = f'''
        tell application "Mail"
            tell account "{self._escape_for_applescript(self.account_name)}"
                tell mailbox "{self._escape_for_applescript(mailbox_name)}"
                    try
                        set theMessage to first message whose message id is "{escaped_id}"
                        set msgId to message id of theMessage
                        set msgSubject to subject of theMessage
                        set msgSender to sender of theMessage
                        set msgDate to date received of theMessage
                        set msgContent to content of theMessage
                        set msgSource to source of theMessage
                        set msgRead to read status of theMessage
                        set msgFlagged to flagged status of theMessage

                        -- 格式化日期为 ISO 格式（避免本地化中文日期）
                        set dateStr to (year of msgDate as string) & "-"
                        set monthNum to (month of msgDate as integer)
                        if monthNum < 10 then
                            set dateStr to dateStr & "0"
                        end if
                        set dateStr to dateStr & (monthNum as string) & "-"
                        set dayNum to (day of msgDate as integer)
                        if dayNum < 10 then
                            set dateStr to dateStr & "0"
                        end if
                        set dateStr to dateStr & (dayNum as string) & "T"
                        set hourNum to (hours of msgDate as integer)
                        if hourNum < 10 then
                            set dateStr to dateStr & "0"
                        end if
                        set dateStr to dateStr & (hourNum as string) & ":"
                        set minuteNum to (minutes of msgDate as integer)
                        if minuteNum < 10 then
                            set dateStr to dateStr & "0"
                        end if
                        set dateStr to dateStr & (minuteNum as string) & ":"
                        set secondNum to (seconds of msgDate as integer)
                        if secondNum < 10 then
                            set dateStr to dateStr & "0"
                        end if
                        set dateStr to dateStr & (secondNum as string)

                        -- 返回带状态前缀的结果
                        return "OK{{{{SEP}}}}" & msgId & "{{{{SEP}}}}" & msgSubject & "{{{{SEP}}}}" & msgSender & "{{{{SEP}}}}" & dateStr & "{{{{SEP}}}}" & msgContent & "{{{{SEP}}}}" & msgSource & "{{{{SEP}}}}" & (msgRead as string) & "{{{{SEP}}}}" & (msgFlagged as string)
                    on error errMsg
                        return "ERROR{{{{SEP}}}}" & errMsg
                    end try
                end tell
            end tell
        end tell
        '''

        result = self._execute_script(script, timeout=self.timeout)
        if not result:
            logger.error(f"fetch_email_content returned empty result for message_id={message_id[:50]}")
            return None

        if result.startswith("ERROR" + self.SEPARATOR):
            error_msg = result.replace("ERROR" + self.SEPARATOR, "")
            logger.error(f"fetch_email_content failed: {error_msg}")
            return None

        if not result.startswith("OK" + self.SEPARATOR):
            logger.error(f"fetch_email_content unexpected result format: {result[:100]}")
            return None

        # 移除 OK 前缀
        result = result[len("OK" + self.SEPARATOR):]
        parts = result.split(self.SEPARATOR)

        if len(parts) < 8:
            logger.error(f"fetch_email_content invalid parts count: {len(parts)}")
            return None

        try:
            return {
                "message_id": parts[0],
                "subject": parts[1],
                "sender": parts[2],
                "date": parts[3],
                "content": parts[4],
                "source": parts[5],
                "is_read": parts[6].lower() == "true",
                "is_flagged": parts[7].lower() == "true",
            }
        except Exception as e:
            logger.error(f"fetch_email_content parse error: {e}")
            return None

    def mark_as_read(self, message_id: str, read: bool = True, mailbox: str = None) -> bool:
        """
        标记邮件已读/未读

        Args:
            message_id: 邮件的 Message-ID
            read: True 标记已读，False 标记未读
            mailbox: 邮箱名称（收件箱/发件箱），默认使用 inbox_name

        Returns:
            操作是否成功
        """
        escaped_id = self._escape_for_applescript(message_id)
        read_str = "true" if read else "false"
        mailbox_name = self._get_mailbox_name(mailbox)

        script = f'''
        tell application "Mail"
            tell account "{self._escape_for_applescript(self.account_name)}"
                tell mailbox "{self._escape_for_applescript(mailbox_name)}"
                    try
                        set theMessage to first message whose message id is "{escaped_id}"
                        set read status of theMessage to {read_str}
                        return "OK"
                    on error errMsg
                        return "ERROR: " & errMsg
                    end try
                end tell
            end tell
        end tell
        '''

        result = self._execute_script(script, timeout=30)
        success = result is not None and "OK" in result

        if success:
            logger.debug(f"mark_as_read: message_id={message_id[:50]}, read={read}")
        else:
            logger.error(f"mark_as_read failed: message_id={message_id[:50]}, result={result}")

        return success

    def set_flag(self, message_id: str, flagged: bool = True, mailbox: str = None) -> bool:
        """
        设置/取消旗标

        Args:
            message_id: 邮件的 Message-ID
            flagged: True 设置旗标，False 取消旗标
            mailbox: 邮箱名称（收件箱/发件箱），默认使用 inbox_name

        Returns:
            操作是否成功
        """
        escaped_id = self._escape_for_applescript(message_id)
        flag_str = "true" if flagged else "false"
        mailbox_name = self._get_mailbox_name(mailbox)

        script = f'''
        tell application "Mail"
            tell account "{self._escape_for_applescript(self.account_name)}"
                tell mailbox "{self._escape_for_applescript(mailbox_name)}"
                    try
                        set theMessage to first message whose message id is "{escaped_id}"
                        set flagged status of theMessage to {flag_str}
                        return "OK"
                    on error errMsg
                        return "ERROR: " & errMsg
                    end try
                end tell
            end tell
        end tell
        '''

        result = self._execute_script(script, timeout=30)
        success = result is not None and "OK" in result

        if success:
            logger.debug(f"set_flag: message_id={message_id[:50]}, flagged={flagged}")
        else:
            logger.error(f"set_flag failed: message_id={message_id[:50]}, result={result}")

        return success

    def _execute_script(self, script: str, timeout: int = 120) -> Optional[str]:
        """
        执行 AppleScript 并返回结果

        Args:
            script: AppleScript 脚本内容
            timeout: 超时时间（秒）

        Returns:
            脚本执行结果，失败返回 None
        """
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=timeout
            )

            if result.returncode != 0:
                logger.error(f"AppleScript error (returncode={result.returncode}): {result.stderr[:200]}")
                return None

            return result.stdout.strip()

        except subprocess.TimeoutExpired:
            logger.error(f"AppleScript execution timed out after {timeout}s")
            return None
        except Exception as e:
            logger.error(f"AppleScript execution failed: {e}")
            return None

    def _escape_for_applescript(self, text: str) -> str:
        """
        转义 AppleScript 字符串中的特殊字符

        处理的特殊字符：
        - 反斜杠 \\ → \\\\
        - 双引号 " → \\"
        - 换行符 \\n → \\n（移除）
        - 回车符 \\r → \\r（移除）
        - 制表符 \\t → 空格

        Args:
            text: 原始文本

        Returns:
            转义后的文本
        """
        if not text:
            return ""

        # 转义反斜杠（必须先处理）
        text = text.replace("\\", "\\\\")
        # 转义双引号
        text = text.replace('"', '\\"')
        # 移除换行符和回车符（可能破坏 AppleScript 语法）
        text = text.replace("\n", " ")
        text = text.replace("\r", " ")
        # 替换制表符
        text = text.replace("\t", " ")

        return text

    def extract_thread_id(self, source: str) -> Optional[str]:
        """从邮件源码提取线程标识 (Thread ID)

        Thread ID 用于关联同一线程的邮件。
        对于回复邮件，thread_id 是原始邮件的 message_id。
        对于新邮件，thread_id 就是自身的 message_id。

        优先级:
        1. References 头的第一个 Message-ID（原始邮件）
        2. In-Reply-To 头
        3. 如果都没有，返回 None（调用方应使用自身 message_id）

        Args:
            source: 邮件原始源码 (RFC 822 格式)

        Returns:
            线程标识（原始邮件的 message_id），如果是新线程则返回 None
        """
        if not source:
            return None

        try:
            msg = email.message_from_string(source)

            # 优先使用 References（最可靠，包含完整的回复链）
            references = msg.get("References")
            if references:
                # References 格式: <id1@example.com> <id2@example.com> ...
                # 第一个是原始邮件的 message_id
                refs = references.strip().split()
                if refs:
                    thread_id = refs[0].strip().strip('<>')
                    logger.debug(f"Extracted thread_id from References: {thread_id[:50]}...")
                    return thread_id

            # 次选 In-Reply-To（只包含直接回复的邮件）
            in_reply_to = msg.get("In-Reply-To")
            if in_reply_to:
                thread_id = in_reply_to.strip().strip('<>')
                logger.debug(f"Extracted thread_id from In-Reply-To: {thread_id[:50]}...")
                return thread_id

            # 没有回复关系，这是新线程的起点
            return None

        except Exception as e:
            logger.warning(f"Failed to extract thread_id from source: {e}")
            return None

    def fetch_email_by_message_id(self, message_id: str, mailbox: str = None) -> Optional[Dict[str, Any]]:
        """通过 message_id 获取邮件完整信息（包含 thread_id）

        这是 fetch_email_content 的增强版本，额外提取 thread_id。

        Args:
            message_id: 邮件的 Message-ID
            mailbox: 邮箱名称（收件箱/发件箱），默认使用 inbox_name

        Returns:
            Dict 包含:
                - message_id: str
                - subject: str
                - sender: str
                - date: str
                - content: str (邮件正文)
                - source: str (原始源码)
                - is_read: bool
                - is_flagged: bool
                - thread_id: Optional[str] (线程标识)
            如果获取失败返回 None
        """
        # 获取邮件内容
        email_data = self.fetch_email_content(message_id, mailbox)
        if not email_data:
            return None

        # 提取 thread_id
        thread_id = self.extract_thread_id(email_data.get('source', ''))

        # 如果没有回复关系，使用自身 message_id 作为 thread_id
        if thread_id is None:
            thread_id = message_id.strip('<>')

        email_data['thread_id'] = thread_id
        return email_data

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息

        Returns:
            包含 AppleScript 调用次数等信息
        """
        return self._stats.copy()

