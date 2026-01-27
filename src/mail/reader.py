from typing import List, Optional
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import os
import hashlib
import email
from email import policy
from email.utils import parsedate_to_datetime

from loguru import logger
from src.models import Email, Attachment
from src.mail.applescript import MailAppScripts
from src.config import config

# 北京时区 (UTC+8)
BEIJING_TZ = timezone(timedelta(hours=8))

class EmailReader:
    """邮件读取器"""

    def __init__(self):
        self.scripts = MailAppScripts()
        self.account = config.mail_account_name
        self.inbox = config.mail_inbox_name
        self.temp_dir = Path(tempfile.gettempdir()) / "email-notion-sync"
        self.temp_dir.mkdir(exist_ok=True)
        self._temp_subdirs = set()  # 跟踪创建的临时子目录

    def cleanup_temp_dir(self, message_id: str = None):
        """清理临时目录

        Args:
            message_id: 指定清理的邮件临时目录，为 None 时清理所有已跟踪的目录
        """
        import shutil

        if message_id:
            # 清理特定邮件的临时目录
            message_hash = hashlib.md5(message_id.encode()).hexdigest()[:16]
            email_temp_dir = self.temp_dir / message_hash
            if email_temp_dir.exists():
                try:
                    shutil.rmtree(email_temp_dir)
                    logger.debug(f"Cleaned up temp dir: {email_temp_dir}")
                    self._temp_subdirs.discard(str(email_temp_dir))
                except Exception as e:
                    logger.warning(f"Failed to cleanup temp dir {email_temp_dir}: {e}")
        else:
            # 清理所有已跟踪的临时目录
            for dir_path in list(self._temp_subdirs):
                try:
                    if Path(dir_path).exists():
                        shutil.rmtree(dir_path)
                        logger.debug(f"Cleaned up temp dir: {dir_path}")
                except Exception as e:
                    logger.warning(f"Failed to cleanup temp dir {dir_path}: {e}")
            self._temp_subdirs.clear()

    def __del__(self):
        """析构函数，清理临时目录"""
        try:
            self.cleanup_temp_dir()
        except Exception:
            pass  # 忽略析构时的错误

    def get_unread_emails(self, limit: int = 100) -> List[Email]:
        """获取未读邮件列表

        Args:
            limit: 最大获取数量，默认 100

        Returns:
            Email 对象列表
        """
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

        # 2. 尝试从邮件源码中提取HTML内容、Thread ID、Content-ID 映射、内联图片和日期
        content = details["content"]
        content_type = "text/plain"
        thread_id = None
        cid_map = {}
        inline_images = []
        mime_date = None
        try:
            html_content, thread_id, cid_map, inline_images, mime_date = self._extract_from_source(message_id)
            if html_content:
                content = html_content
                content_type = "text/html"
                logger.debug("Extracted HTML content from email source")
            if thread_id:
                logger.debug(f"Extracted thread ID: {thread_id}")
            if cid_map:
                logger.debug(f"Extracted {len(cid_map)} Content-ID mappings")
            if inline_images:
                logger.debug(f"Extracted {len(inline_images)} inline images from MIME")
            if mime_date:
                logger.debug(f"Extracted date from MIME: {mime_date.isoformat()}")
        except Exception as e:
            logger.warning(f"Failed to extract from source: {e}, using plain text")

        # 3. 解析日期（优先使用 MIME 源码中的日期，带时区信息）
        if mime_date:
            date = mime_date
        else:
            # 回退: 解析 AppleScript 返回的日期
            date = self._parse_applescript_date(details["date"])

        # 4. 提取发件人名称
        sender_name = self._extract_sender_name(details["sender"])

        # 5. 处理附件 - 包括 AppleScript 保存的附件和 MIME 提取的内联图片
        attachments = []
        if details["attachment_count"] > 0 or inline_images:
            attachments = self._save_and_load_attachments(message_id, cid_map, inline_images)

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

    def _parse_applescript_date(self, date_str: str) -> datetime:
        """解析 AppleScript 返回的日期字符串

        尝试多种格式：
        - 英文格式: "Tuesday, January 5, 2026 at 9:36:00 AM"
        - 中文格式: "2026年1月24日 星期五 上午9:36:00"
        - ISO 格式: "2026-01-24T09:36:00"

        返回的日期假设为北京时间 (UTC+8)
        """
        formats = [
            # 英文格式
            "%A, %B %d, %Y at %I:%M:%S %p",
            # ISO 格式（可能来自其他处理）
            "%Y-%m-%dT%H:%M:%S",
        ]

        for fmt in formats:
            try:
                dt = datetime.strptime(date_str, fmt)
                # 添加北京时区
                return dt.replace(tzinfo=BEIJING_TZ)
            except ValueError:
                continue

        # 尝试解析中文格式
        try:
            import re
            match = re.match(r'(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2}):(\d{2}):(\d{2})', date_str)
            if match:
                year, month, day, hour, minute, second = map(int, match.groups())
                # 处理上午/下午
                if '下午' in date_str and hour < 12:
                    hour += 12
                elif '上午' in date_str and hour == 12:
                    hour = 0
                dt = datetime(year, month, day, hour, minute, second, tzinfo=BEIJING_TZ)
                return dt
        except Exception:
            pass

        # 最后回退到当前时间
        logger.warning(f"Failed to parse date: {date_str}, using current time")
        return datetime.now(tz=BEIJING_TZ)

    def _save_and_load_attachments(self, message_id: str, cid_map: dict = None, inline_images: list = None, skip_applescript: bool = False) -> List[Attachment]:
        """保存并加载附件，包括 AppleScript 保存的附件和 MIME 提取的内联图片

        Args:
            message_id: 邮件 Message-ID
            cid_map: Content-ID 映射 {cid: {filename, content_type, is_inline}}
            inline_images: MIME 提取的内联图片列表
            skip_applescript: 是否跳过 AppleScript 附件保存（用于已有完整 MIME 源码的情况）
        """
        attachments = []
        cid_map = cid_map or {}
        inline_images = inline_images or []

        try:
            # 创建临时目录 - 使用 hash 避免文件名太长
            # 对于超长的 message_id (如Teams邮件)，使用 MD5 hash
            message_hash = hashlib.md5(message_id.encode()).hexdigest()[:16]
            email_temp_dir = self.temp_dir / message_hash
            email_temp_dir.mkdir(exist_ok=True)
            self._temp_subdirs.add(str(email_temp_dir))  # 跟踪临时目录

            # 1. 先处理 MIME 提取的附件（内联图片和常规附件）
            inline_filenames = set()
            for img in inline_images:
                try:
                    filename = img['filename']
                    # 避免文件名冲突
                    file_path = email_temp_dir / filename
                    counter = 1
                    while file_path.exists():
                        name, ext = filename.rsplit('.', 1) if '.' in filename else (filename, '')
                        file_path = email_temp_dir / f"{name}_{counter}.{ext}"
                        counter += 1

                    # 写入附件数据
                    with open(file_path, 'wb') as f:
                        f.write(img['data'])

                    inline_filenames.add(file_path.name)

                    # 检查文件大小
                    stat = file_path.stat()
                    if stat.st_size > config.max_attachment_size:
                        logger.warning(f"Attachment too large: {file_path.name} ({stat.st_size} bytes)")
                        file_path.unlink()
                        continue

                    attachment = Attachment(
                        filename=file_path.name,
                        content_type=img['content_type'],
                        size=stat.st_size,
                        path=str(file_path),
                        content_id=img.get('content_id'),
                        is_inline=img.get('is_inline', False)
                    )
                    attachments.append(attachment)
                    logger.debug(f"Saved MIME attachment: {file_path.name} (cid:{img.get('content_id')}, inline:{img.get('is_inline')})")

                except Exception as e:
                    logger.error(f"Failed to save MIME attachment {img.get('filename', 'unknown')}: {e}")

            # 2. 然后处理 AppleScript 保存的附件（如果需要）
            saved_paths = []
            if not skip_applescript:
                saved_paths = self.scripts.save_attachments(
                    message_id,
                    str(email_temp_dir),
                    self.account,
                    self.inbox
                )

            # 构建文件名到 CID 的反向映射
            filename_to_cid = {}
            for cid, info in cid_map.items():
                filename_to_cid[info['filename']] = {
                    'cid': cid,
                    'is_inline': info.get('is_inline', False)
                }

            # 加载 AppleScript 保存的附件
            for path in saved_paths:
                file_path = Path(path)
                if not file_path.exists():
                    continue

                # 跳过已经从 MIME 提取的内联图片（避免重复）
                if file_path.name in inline_filenames:
                    logger.debug(f"Skipping duplicate: {file_path.name} (already extracted from MIME)")
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

                # 查找对应的 Content-ID
                content_id = None
                is_inline = False
                cid_info = filename_to_cid.get(file_path.name)
                if cid_info:
                    content_id = cid_info['cid']
                    is_inline = cid_info['is_inline']
                    logger.debug(f"Matched attachment {file_path.name} to Content-ID: {content_id}")

                attachment = Attachment(
                    filename=file_path.name,
                    content_type=self._get_content_type(file_path),
                    size=stat.st_size,
                    path=str(file_path),
                    content_id=content_id,
                    is_inline=is_inline
                )
                attachments.append(attachment)

            inline_count = sum(1 for a in attachments if a.is_inline)
            logger.debug(f"Loaded {len(attachments)} attachments ({inline_count} inline, {len(attachments) - inline_count} regular)")

        except Exception as e:
            logger.error(f"Failed to load attachments: {e}")

        return attachments

    def get_email_source(self, message_id: str) -> str:
        """获取邮件原始源码"""
        return self.scripts.get_email_source(message_id, self.account, self.inbox)

    def _extract_from_source(self, message_id: str) -> tuple[Optional[str], Optional[str], dict, list, Optional[datetime]]:
        """
        从邮件源码中提取HTML内容、Thread ID、Content-ID 映射、内联图片数据和日期

        Returns:
            (html_content, thread_id, cid_map, inline_images, email_date)
            cid_map: {content_id: {filename, content_type, is_inline}}
            inline_images: [{filename, content_type, content_id, data}] - 内联图片的二进制数据
            email_date: datetime with timezone from MIME Date header
        """
        try:
            # 获取邮件源码
            source = self.get_email_source(message_id)
            if not source:
                return None, None, {}, [], None

            # 解析邮件
            msg = email.message_from_string(source, policy=policy.default)

            # 0. 提取日期（从 Date 头部，带时区信息）
            email_date = None
            date_header = msg.get("Date")
            if date_header:
                try:
                    email_date = parsedate_to_datetime(date_header)
                    logger.debug(f"Parsed Date header: {date_header} -> {email_date.isoformat()}")
                except Exception as e:
                    logger.warning(f"Failed to parse Date header '{date_header}': {e}")

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

            # 3. 提取所有附件的 Content-ID 映射和内联图片数据
            cid_map = {}
            inline_images = []

            if msg.is_multipart():
                for part in msg.walk():
                    content_id = part.get("Content-ID")
                    if content_id:
                        # 清理 Content-ID（去掉 < > 符号）
                        cid = content_id.strip().strip('<>')

                        # 获取文件名
                        filename = part.get_filename()
                        if not filename:
                            # 尝试从 Content-Type 参数获取
                            filename = part.get_param("name")

                        # 获取 Content-Disposition
                        disposition = part.get("Content-Disposition", "")
                        is_inline = disposition.lower().startswith("inline") or not disposition

                        content_type = part.get_content_type()

                        if filename:
                            cid_map[cid] = {
                                'filename': filename,
                                'content_type': content_type,
                                'is_inline': is_inline
                            }
                            logger.debug(f"Found Content-ID mapping: {cid} -> {filename} (inline={is_inline})")

                        # 提取所有带 Content-ID 的部分（不仅限于图片）
                        # 这样可以处理 Outlook 将图片误标为 application/octet-stream 的情况
                        # 跳过已知的非渲染类型（日历邀请、vCard 等）
                        skip_types = ('text/calendar', 'text/vcard', 'application/ics')
                        if not content_type.startswith(skip_types):
                            try:
                                # 获取数据
                                payload = part.get_payload(decode=True)
                                if payload:
                                    # 使用 magic bytes 检测真实的 Content-Type
                                    detected_type = self._detect_content_type(payload, content_type, filename)
                                    if detected_type != content_type:
                                        logger.debug(f"Content-Type corrected: {content_type} -> {detected_type}")
                                        content_type = detected_type
                                        # 同步更新 cid_map 中的类型
                                        if cid in cid_map:
                                            cid_map[cid]['content_type'] = detected_type

                                    # 生成或修正文件名（确保有正确扩展名）
                                    if not filename:
                                        ext = content_type.split('/')[-1]
                                        filename = f"inline_{cid.split('@')[0]}.{ext}"
                                    elif '.' not in filename:
                                        # 文件名存在但没有扩展名，根据 content_type 添加扩展名
                                        ext = content_type.split('/')[-1]
                                        if ext == 'jpeg':
                                            ext = 'jpg'
                                        filename = f"{filename}.{ext}"
                                        logger.debug(f"Added extension to filename: {filename}")

                                    inline_images.append({
                                        'filename': filename,
                                        'content_type': content_type,
                                        'content_id': cid,
                                        'is_inline': is_inline,
                                        'data': payload
                                    })
                                    logger.debug(f"Extracted inline content: {filename} ({len(payload)} bytes, type={content_type})")
                            except Exception as e:
                                logger.warning(f"Failed to extract inline content {cid}: {e}")

            return html_content, thread_id, cid_map, inline_images, email_date

        except Exception as e:
            logger.error(f"Failed to extract from email source: {e}")
            return None, None, {}, [], None

    def parse_email_source(
        self,
        source: str,
        message_id: str,
        is_read: bool = False,
        is_flagged: bool = False
    ) -> Optional[Email]:
        """从邮件源码直接解析构建 Email 对象（无需再次调用 AppleScript）

        Args:
            source: 邮件 MIME 源码
            message_id: 邮件 Message-ID
            is_read: 是否已读
            is_flagged: 是否已标记

        Returns:
            Email 对象，失败返回 None
        """
        if not source:
            logger.warning("Email source is empty")
            return None

        try:
            # 解析邮件
            msg = email.message_from_string(source, policy=policy.default)

            # 1. 提取基本信息
            subject = msg.get("Subject", "")
            sender_raw = msg.get("From", "")
            to = msg.get("To", "")
            cc = msg.get("Cc", "")

            # 2. 提取日期
            email_date = None
            date_header = msg.get("Date")
            if date_header:
                try:
                    email_date = parsedate_to_datetime(date_header)
                except Exception as e:
                    logger.warning(f"Failed to parse Date header: {e}")

            if not email_date:
                email_date = datetime.now(tz=BEIJING_TZ)

            # 3. 提取 HTML 内容
            html_content = None
            content = ""
            content_type = "text/plain"

            if msg.is_multipart():
                for part in msg.walk():
                    part_type = part.get_content_type()
                    if part_type == "text/html":
                        html_content = part.get_content()
                        break
                    elif part_type == "text/plain" and not content:
                        content = part.get_content()
            else:
                if msg.get_content_type() == "text/html":
                    html_content = msg.get_content()
                else:
                    content = msg.get_content() if hasattr(msg, 'get_content') else str(msg.get_payload(decode=True) or "")

            if html_content:
                content = html_content
                content_type = "text/html"

            # 4. 提取 Thread ID
            thread_id = None
            references = msg.get("References")
            if references:
                refs = references.strip().split()
                if refs:
                    thread_id = refs[0].strip('<>')

            if not thread_id:
                in_reply_to = msg.get("In-Reply-To")
                if in_reply_to:
                    thread_id = in_reply_to.strip().strip('<>')

            # 5. 提取附件和内联图片
            cid_map = {}
            inline_images = []
            regular_attachments = []  # 常规附件（从 MIME 提取）

            if msg.is_multipart():
                for part in msg.walk():
                    content_id = part.get("Content-ID")
                    disposition = part.get("Content-Disposition", "")
                    part_content_type = part.get_content_type()
                    filename = part.get_filename() or part.get_param("name")

                    # 跳过主体内容
                    if part_content_type in ("text/plain", "text/html", "multipart/alternative", "multipart/mixed", "multipart/related"):
                        continue

                    if content_id:
                        # 有 Content-ID 的部分（通常是内联图片）
                        cid = content_id.strip().strip('<>')
                        is_inline = disposition.lower().startswith("inline") or not disposition

                        if filename:
                            cid_map[cid] = {
                                'filename': filename,
                                'content_type': part_content_type,
                                'is_inline': is_inline
                            }

                        # 提取所有带 Content-ID 的内容（不仅限于图片）
                        # 跳过已知的非渲染类型（日历邀请、vCard 等）
                        skip_types = ('text/calendar', 'text/vcard', 'application/ics')
                        if not part_content_type.startswith(skip_types):
                            try:
                                payload = part.get_payload(decode=True)
                                if payload:
                                    # 使用 magic bytes 检测真实的 Content-Type
                                    detected_type = self._detect_content_type(payload, part_content_type, filename)
                                    if detected_type != part_content_type:
                                        logger.debug(f"Content-Type corrected: {part_content_type} -> {detected_type}")
                                        part_content_type = detected_type
                                        # 同步更新 cid_map 中的类型
                                        if cid in cid_map:
                                            cid_map[cid]['content_type'] = detected_type

                                    # 生成或修正文件名（确保有正确扩展名）
                                    if not filename:
                                        ext = part_content_type.split('/')[-1]
                                        filename = f"inline_{cid.split('@')[0]}.{ext}"
                                    elif '.' not in filename:
                                        # 文件名存在但没有扩展名，根据 content_type 添加扩展名
                                        ext = part_content_type.split('/')[-1]
                                        if ext == 'jpeg':
                                            ext = 'jpg'
                                        filename = f"{filename}.{ext}"
                                        logger.debug(f"Added extension to filename: {filename}")

                                    inline_images.append({
                                        'filename': filename,
                                        'content_type': part_content_type,
                                        'content_id': cid,
                                        'is_inline': is_inline,
                                        'data': payload
                                    })
                            except Exception as e:
                                logger.warning(f"Failed to extract inline content {cid}: {e}")

                    elif disposition.lower().startswith("attachment") and filename:
                        # 常规附件（无 Content-ID，有 Content-Disposition: attachment）
                        try:
                            payload = part.get_payload(decode=True)
                            if payload:
                                regular_attachments.append({
                                    'filename': filename,
                                    'content_type': part_content_type,
                                    'content_id': None,
                                    'is_inline': False,
                                    'data': payload
                                })
                                logger.debug(f"Extracted regular attachment: {filename}")
                        except Exception as e:
                            logger.warning(f"Failed to extract attachment {filename}: {e}")

            # 6. 保存附件（MIME 提取的内联图片和常规附件，跳过 AppleScript）
            all_extracted = inline_images + regular_attachments
            attachments = []
            if all_extracted:
                attachments = self._save_and_load_attachments(
                    message_id, cid_map, all_extracted, skip_applescript=True
                )

            # 7. 构建 Email 对象
            email_obj = Email(
                message_id=message_id,
                subject=subject,
                sender=self._extract_email_address(sender_raw),
                sender_name=self._extract_sender_name(sender_raw),
                to=to,
                cc=cc,
                date=email_date,
                content=content,
                content_type=content_type,
                is_read=is_read,
                is_flagged=is_flagged,
                attachments=attachments,
                thread_id=thread_id
            )

            logger.debug(f"Parsed email from source: {subject}")
            return email_obj

        except Exception as e:
            logger.error(f"Failed to parse email source: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None

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
    def _detect_content_type(payload: bytes, declared_type: str, filename: str = None) -> str:
        """检测真实的 Content-Type（通过 magic bytes + 文件扩展名 + 声明类型）

        处理 Outlook 等客户端将图片误标为 application/octet-stream 的情况

        Args:
            payload: 文件二进制内容
            declared_type: MIME 声明的 Content-Type
            filename: 文件名（可选）

        Returns:
            检测到的真实 Content-Type
        """
        # 1. 首先尝试 magic bytes 检测
        if payload and len(payload) >= 16:
            # PNG: \x89PNG\r\n\x1a\n
            if payload.startswith(b'\x89PNG'):
                return "image/png"
            # JPEG: \xff\xd8\xff
            if payload.startswith(b'\xff\xd8\xff'):
                return "image/jpeg"
            # GIF: GIF87a or GIF89a
            if payload.startswith(b'GIF87a') or payload.startswith(b'GIF89a'):
                return "image/gif"
            # BMP: BM
            if payload.startswith(b'BM'):
                return "image/bmp"
            # WebP: RIFF....WEBP
            if payload[:4] == b'RIFF' and payload[8:12] == b'WEBP':
                return "image/webp"

        # 2. 如果 magic bytes 无法识别，尝试从文件名扩展名推断
        if filename:
            ext_map = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.bmp': 'image/bmp',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
            }
            ext = '.' + filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
            if ext in ext_map:
                return ext_map[ext]

        # 3. 回退到声明的 Content-Type
        return declared_type

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
                    # WebP magic number
                    elif header[8:12] == b'WEBP':
                        return "image/webp"
                    # BMP magic number
                    elif header.startswith(b'BM'):
                        return "image/bmp"
                    # PDF magic number
                    elif header.startswith(b'%PDF'):
                        return "application/pdf"
            except (OSError, IOError) as e:
                logger.debug(f"Could not read file header for type detection: {e}")

        return extension_map.get(file_path.suffix.lower(), "application/octet-stream")
