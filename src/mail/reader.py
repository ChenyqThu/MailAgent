from typing import List, Optional
from datetime import datetime
from pathlib import Path
import tempfile
import os
import hashlib
import email
from email import policy

from loguru import logger
from src.models import Email, Attachment
from src.mail.applescript import MailAppScripts
from src.config import config

class EmailReader:
    """邮件读取器"""

    def __init__(self):
        self.scripts = MailAppScripts()
        self.account = config.mail_account_name
        self.inbox = config.mail_inbox_name
        self.temp_dir = Path(tempfile.gettempdir()) / "email-notion-sync"
        self.temp_dir.mkdir(exist_ok=True)

    def get_unread_emails(self, limit: Optional[int] = None) -> List[Email]:
        """获取未读邮件列表"""
        if limit is None:
            limit = config.max_batch_size

        logger.info(f"Fetching unread emails (limit: {limit})...")

        try:
            # 获取未读邮件的 Message ID 列表
            message_ids = self.scripts.get_unread_message_ids(
                account=self.account,
                inbox=self.inbox,
                limit=limit
            )

            logger.info(f"Found {len(message_ids)} unread emails")

            # 获取每封邮件的详细信息
            emails = []
            for message_id in message_ids:
                try:
                    email = self.get_email_details(message_id)
                    emails.append(email)
                except Exception as e:
                    logger.error(f"Failed to read email {message_id}: {e}")
                    continue

            return emails

        except Exception as e:
            logger.error(f"Failed to get unread emails: {e}")
            return []

    def get_email_details(self, message_id: str) -> Email:
        """获取邮件详细信息"""
        logger.debug(f"Reading email details: {message_id}")

        # 1. 获取基本信息
        details = self.scripts.get_email_details(message_id, self.account, self.inbox)

        # 2. 解析日期
        try:
            # AppleScript 返回的日期格式可能是 "Tuesday, January 5, 2026 at 9:36:00 AM"
            date = datetime.strptime(details["date"], "%A, %B %d, %Y at %I:%M:%S %p")
        except:
            date = datetime.now()

        # 3. 提取发件人名称
        sender_name = self._extract_sender_name(details["sender"])

        # 4. 处理附件
        attachments = []
        if details["attachment_count"] > 0:
            attachments = self._save_and_load_attachments(message_id)

        # 5. 尝试从邮件源码中提取HTML内容和Thread ID
        content = details["content"]
        content_type = "text/plain"
        thread_id = None
        try:
            html_content, thread_id = self._extract_from_source(message_id)
            if html_content:
                content = html_content
                content_type = "text/html"
                logger.debug("Extracted HTML content from email source")
            if thread_id:
                logger.debug(f"Extracted thread ID: {thread_id}")
        except Exception as e:
            logger.warning(f"Failed to extract from source: {e}, using plain text")

        # 6. 构建 Email 对象
        email = Email(
            message_id=message_id,
            subject=details["subject"],
            sender=self._extract_email_address(details["sender"]),
            sender_name=sender_name,
            to=details["to"],
            cc=details["cc"],
            date=date,
            content=content,
            content_type=content_type,
            is_read=details["is_read"],
            is_flagged=details["is_flagged"],
            attachments=attachments,
            thread_id=thread_id
        )

        logger.debug(f"Email read successfully: {email.subject}")
        return email

    def _save_and_load_attachments(self, message_id: str) -> List[Attachment]:
        """保存并加载附件"""
        attachments = []

        try:
            # 创建临时目录 - 使用 hash 避免文件名太长
            # 对于超长的 message_id (如Teams邮件)，使用 MD5 hash
            message_hash = hashlib.md5(message_id.encode()).hexdigest()[:16]
            email_temp_dir = self.temp_dir / message_hash
            email_temp_dir.mkdir(exist_ok=True)

            # 保存附件
            saved_paths = self.scripts.save_attachments(
                message_id,
                str(email_temp_dir),
                self.account,
                self.inbox
            )

            # 加载附件信息
            for path in saved_paths:
                file_path = Path(path)
                if not file_path.exists():
                    continue

                stat = file_path.stat()

                # 检查文件大小
                if stat.st_size > config.max_attachment_size:
                    logger.warning(f"Attachment too large: {file_path.name} ({stat.st_size} bytes)")
                    continue

                # 检查文件类型
                # 如果有扩展名，检查是否在允许列表中；没有扩展名的文件（如内联图片）允许通过
                if file_path.suffix and file_path.suffix.lower() not in config.allowed_attachment_types:
                    logger.warning(f"Attachment type not allowed: {file_path.name}")
                    continue

                attachment = Attachment(
                    filename=file_path.name,
                    content_type=self._get_content_type(file_path),
                    size=stat.st_size,
                    path=str(file_path)
                )
                attachments.append(attachment)

            logger.debug(f"Loaded {len(attachments)} attachments")

        except Exception as e:
            logger.error(f"Failed to load attachments: {e}")

        return attachments

    def get_email_source(self, message_id: str) -> str:
        """获取邮件原始源码"""
        return self.scripts.get_email_source(message_id, self.account, self.inbox)

    def _extract_from_source(self, message_id: str) -> tuple[Optional[str], Optional[str]]:
        """
        从邮件源码中提取HTML内容和Thread ID

        Returns:
            (html_content, thread_id)
        """
        try:
            # 获取邮件源码
            source = self.get_email_source(message_id)
            if not source:
                return None, None

            # 解析邮件
            msg = email.message_from_string(source, policy=policy.default)

            # 1. 提取HTML部分
            html_content = None
            if msg.is_multipart():
                # 遍历所有部分，查找text/html
                for part in msg.walk():
                    content_type = part.get_content_type()
                    if content_type == "text/html":
                        # 获取HTML内容
                        html_content = part.get_content()
                        break
            else:
                # 单部分邮件
                if msg.get_content_type() == "text/html":
                    html_content = msg.get_content()

            # 2. 提取Thread ID
            # 优先使用 References 头部（包含完整的线程链）
            # 如果没有，则使用 In-Reply-To 头部
            thread_id = None

            references = msg.get("References")
            if references:
                # References 可能包含多个 Message-ID，用第一个作为 Thread ID
                # 格式: <id1@server> <id2@server> ...
                refs = references.strip().split()
                if refs:
                    # 使用第一个 Message-ID（线程的根邮件）
                    thread_id = refs[0].strip('<>')
                    logger.debug(f"Found References: {references}")

            if not thread_id:
                in_reply_to = msg.get("In-Reply-To")
                if in_reply_to:
                    thread_id = in_reply_to.strip().strip('<>')
                    logger.debug(f"Found In-Reply-To: {in_reply_to}")

            return html_content, thread_id

        except Exception as e:
            logger.error(f"Failed to extract from email source: {e}")
            return None, None

    @staticmethod
    def _extract_email_address(sender: str) -> str:
        """从发件人字符串中提取邮箱地址"""
        # 格式可能是: "John Doe <john@example.com>" 或 "john@example.com"
        if "<" in sender and ">" in sender:
            return sender.split("<")[1].split(">")[0].strip()
        return sender.strip()

    @staticmethod
    def _extract_sender_name(sender: str) -> str:
        """从发件人字符串中提取姓名"""
        # 格式可能是: "John Doe <john@example.com>" 或 "john@example.com"
        if "<" in sender:
            return sender.split("<")[0].strip()
        return sender.split("@")[0].strip()

    @staticmethod
    def _get_content_type(file_path: Path) -> str:
        """根据文件扩展名获取 Content-Type"""
        extension_map = {
            # 图片
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".svg": "image/svg+xml",
            # 文档
            ".pdf": "application/pdf",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".csv": "text/csv",
            ".txt": "text/plain",
            # 压缩文件
            ".zip": "application/zip",
            ".rar": "application/x-rar-compressed",
            ".7z": "application/x-7z-compressed",
            # 视频
            ".mp4": "video/mp4",
            ".mov": "video/quicktime",
            ".avi": "video/x-msvideo",
        }

        # 如果没有扩展名，尝试从文件内容判断（简单判断是否为图片）
        if not file_path.suffix:
            try:
                with open(file_path, 'rb') as f:
                    header = f.read(16)
                    # PNG magic number
                    if header.startswith(b'\x89PNG'):
                        return "image/png"
                    # JPEG magic number
                    elif header.startswith(b'\xff\xd8\xff'):
                        return "image/jpeg"
                    # GIF magic number
                    elif header.startswith(b'GIF87a') or header.startswith(b'GIF89a'):
                        return "image/gif"
            except:
                pass

        return extension_map.get(file_path.suffix.lower(), "application/octet-stream")
