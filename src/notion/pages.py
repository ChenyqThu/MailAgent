from typing import Dict, Any, List, Mapping, Optional, Tuple, TYPE_CHECKING
from pathlib import Path
from loguru import logger
from datetime import datetime
import re
import shutil
import tempfile

if TYPE_CHECKING:
    from src.mail.icalendar_parser import MeetingInvite
    from src.mail.sync_store import SyncStore
    from src.repository import AttachmentRecord, EmailBodyRecord, EmailRepository

from src.models import Email, Attachment
from src.mail.mailbox_semantics import is_sent_mailbox
from src.notion._common import BEIJING_TZ, CreateEmailFromSqliteResult


class PageOps:
    def __init__(self, *, client, html_converter, eml_generator, email_repo, sync_store, rollout, threads):
        self.client = client
        self.html_converter = html_converter
        self.eml_generator = eml_generator
        self._email_repo = email_repo
        self._sync_store = sync_store
        self._rollout = rollout
        self._threads = threads

    async def sync_email(self, email: Email) -> bool:
        """同步邮件到 Notion（兼容旧 API）

        这是一个简化的接口，内部调用 create_email_page_v2()。
        主要用于脚本和测试。

        Args:
            email: Email 对象

        Returns:
            是否成功
        """
        page_id = await self.create_email_page_v2(email)
        return page_id is not None

    async def _upload_attachments(self, email: Email) -> "tuple[List[Dict[str, Any]], List[str]]":
        """上传邮件附件到 Notion

        使用 "伪装 PDF" 技巧自动处理不支持的扩展名（如 .eml），
        无需手动重命名文件。

        Args:
            email: Email 对象

        Returns:
            元组 (uploaded_attachments, failed_filenames):
                - uploaded_attachments: 上传成功的附件列表
                - failed_filenames: 上传失败的文件名列表
        """
        uploaded_attachments = []
        failed_filenames = []

        if not email.attachments:
            return uploaded_attachments, failed_filenames

        logger.info(f"邮件包含 {len(email.attachments)} 个附件，开始上传...")

        for attachment in email.attachments:
            try:
                # 直接上传，client.upload_file 会自动处理不支持的扩展名
                file_upload_id = await self.client.upload_file(attachment.path)
                uploaded_attachments.append({
                    'filename': attachment.filename,
                    'file_upload_id': file_upload_id,
                    'content_type': attachment.content_type,
                    'size': attachment.size,
                    'content_id': attachment.content_id,
                    'is_inline': attachment.is_inline
                })
                logger.info(f"  Uploaded: {attachment.filename} (cid={attachment.content_id})")

            except Exception as e:
                logger.error(f"  Failed to upload {attachment.filename}: {e}")
                failed_filenames.append(attachment.filename)

        if failed_filenames:
            logger.warning(f"Failed to upload {len(failed_filenames)} attachments: {failed_filenames}")

        return uploaded_attachments, failed_filenames

    async def _upload_eml_file(self, email: Email) -> Optional[str]:
        """生成并上传 .eml 归档文件

        使用 "伪装 PDF" 技巧直接上传 .eml 文件，无需重命名。

        Args:
            email: Email 对象

        Returns:
            file_upload_id，失败返回 None
        """
        try:
            eml_path = self.eml_generator.generate(email)
            logger.debug(f"Generated .eml file: {eml_path.name}")

            # 直接上传 .eml 文件，client.upload_file 会自动处理
            file_upload_id = await self.client.upload_file(str(eml_path))
            logger.info(f"Uploaded email file: {eml_path.name}")

            return file_upload_id

        except Exception as e:
            logger.error(f"Failed to generate/upload email file: {e}")
            return None

    async def _create_page_with_blocks(
        self,
        properties: Dict[str, Any],
        children: List[Dict[str, Any]],
        icon: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """创建 Notion 页面，处理超过 100 blocks 的情况

        Args:
            properties: 页面属性
            children: 内容 blocks
            icon: 页面图标

        Returns:
            创建的页面对象
        """
        if len(children) <= 100:
            return await self.client.create_page(properties=properties, children=children, icon=icon)

        # 分批创建：先创建页面 + 前 100 个 blocks
        logger.info(f"邮件包含 {len(children)} 个 blocks，将分批创建...")

        page = await self.client.create_page(
            properties=properties,
            children=children[:100],
            icon=icon
        )
        page_id = page['id']
        logger.info("Created page with first 100 blocks")

        # 追加剩余 blocks（每次最多 100 个）
        remaining_blocks = children[100:]
        batch_size = 100
        for i in range(0, len(remaining_blocks), batch_size):
            batch = remaining_blocks[i:i + batch_size]
            await self.client.append_block_children(page_id, batch)
            logger.info(f"Appended {len(batch)} blocks (batch {i//batch_size + 1})")

        return page

    def _create_meeting_callout(self, invite: 'MeetingInvite') -> Dict[str, Any]:
        """创建会议邀请 Callout Block

        Args:
            invite: MeetingInvite 对象

        Returns:
            Notion callout block
        """
        # 格式化时间（北京时间）
        start = invite.start_time.astimezone(BEIJING_TZ)
        end = invite.end_time.astimezone(BEIJING_TZ)

        if invite.is_all_day:
            time_str = start.strftime("%Y-%m-%d") + " (全天)"
        else:
            time_str = f"{start.strftime('%Y-%m-%d %H:%M')} - {end.strftime('%H:%M')} (北京时间)"

        # 判断会议状态：取消 / 更新 / 普通邀请
        if invite.method == "CANCEL" or invite.status == "cancelled":
            title_prefix = "【会议已取消】"
            callout_color = "red_background"
        elif invite.sequence > 0:
            title_prefix = "【更新】"
            callout_color = "blue_background"
        else:
            title_prefix = ""
            callout_color = "blue_background"

        title_text = f"{title_prefix}在线会议邀请"

        # 构建内容行
        lines = [
            f"📌 主题：{invite.summary}",
            f"🕐 时间：{time_str}",
        ]

        if invite.location:
            lines.append(f"📍 地点：{invite.location}")

        content_text = "\n".join(lines)

        # 构建 rich_text 数组
        rich_text_parts = [
            {
                "type": "text",
                "text": {"content": title_text + "\n\n"},
                "annotations": {"bold": True}
            },
            {
                "type": "text",
                "text": {"content": content_text}
            }
        ]

        # 会议链接（可点击）
        if invite.teams_url:
            rich_text_parts.append({
                "type": "text",
                "text": {"content": "\n🔗 会议链接："}
            })
            rich_text_parts.append({
                "type": "text",
                "text": {
                    "content": invite.teams_url[:80] + ("..." if len(invite.teams_url) > 80 else ""),
                    "link": {"url": invite.teams_url}
                },
                "annotations": {"color": "blue"}
            })

        # 会议 ID
        if invite.meeting_id:
            rich_text_parts.append({
                "type": "text",
                "text": {"content": f"\n🆔 会议 ID：{invite.meeting_id}"}
            })

        # 密码
        if invite.passcode:
            rich_text_parts.append({
                "type": "text",
                "text": {"content": f"\n🔑 密码：{invite.passcode}"}
            })

        return {
            "object": "block",
            "type": "callout",
            "callout": {
                "rich_text": rich_text_parts,
                "icon": {"type": "emoji", "emoji": "🗓"},
                "color": callout_color
            }
        }

    def _build_image_map(self, email: Email, uploaded_attachments: List[Dict]) -> Dict[str, tuple]:
        """
        构建图片映射，基于 Content-ID 精确匹配内联内容

        Args:
            email: Email 对象（包含带 content_id 的附件信息）
            uploaded_attachments: 已上传的附件列表

        Returns:
            映射 {cid: (file_upload_id, content_type)} 和 {filename: (file_upload_id, content_type)}
        """
        image_map = {}

        # 只处理HTML邮件
        if email.content_type != "text/html":
            return image_map

        # 从HTML中提取所有cid引用
        cid_pattern = r'cid:([^"\'\s>]+)'
        cid_matches = set(re.findall(cid_pattern, email.content, re.IGNORECASE))

        if not cid_matches:
            # 没有cid引用，所有图片都是普通附件
            logger.debug("No cid references found in HTML")
            return image_map

        logger.debug(f"Found {len(cid_matches)} cid references in HTML: {cid_matches}")

        # 方法1：使用附件的 content_id 精确匹配（推荐）
        # 构建 content_id -> (file_upload_id, content_type) 映射
        # 注意：不再限制只有 image/* 类型，因为 magic bytes 检测可能已经修正了类型
        cid_to_upload_info = {}
        for att in uploaded_attachments:
            content_id = att.get('content_id')
            if content_id:
                content_type = att.get('content_type', 'application/octet-stream')
                upload_info = (att['file_upload_id'], content_type)
                cid_to_upload_info[content_id] = upload_info
                # 同时添加文件名映射，便于 html_converter 查找
                image_map[att['filename']] = upload_info
                logger.debug(f"Mapped by Content-ID: {content_id} -> {att['filename']} (type={content_type})")

        # 检查 HTML 中的每个 cid 引用是否有对应的上传文件
        for cid in cid_matches:
            if cid in cid_to_upload_info:
                # 添加 cid 本身作为 key（html_converter 会用 cid 查找）
                image_map[cid] = cid_to_upload_info[cid]
                logger.debug(f"CID {cid} matched to uploaded file")
            else:
                # 方法2：降级到启发式匹配（兼容旧数据）
                for att in uploaded_attachments:
                    content_id = att.get('content_id')
                    if content_id:
                        # 已经在上面处理过
                        continue
                    filename = att['filename']
                    filename_without_ext = filename.rsplit('.', 1)[0] if '.' in filename else filename
                    cid_clean = cid.split('@')[0] if '@' in cid else cid

                    if (cid in filename or filename in cid or
                        cid_clean in filename or filename_without_ext in cid):
                        content_type = att.get('content_type', 'application/octet-stream')
                        upload_info = (att['file_upload_id'], content_type)
                        image_map[cid] = upload_info
                        image_map[filename] = upload_info
                        logger.debug(f"Fallback match: CID {cid} -> {filename} (type={content_type})")
                        break

        inline_count = len([a for a in uploaded_attachments if a.get('is_inline')])
        total_images = len([a for a in uploaded_attachments if a.get('content_type', '').startswith('image/')])
        logger.info(f"Image mapping: {len(image_map)//2} inline items, {total_images} images total, {inline_count} marked inline")

        return image_map

    def _build_properties(self, email: Email, eml_file_upload_id: str = None) -> Dict[str, Any]:
        """构建 Notion Page Properties"""
        # 确保日期带有时区信息，并统一转换为北京时间 (UTC+8)
        email_date = email.date
        if email_date.tzinfo is None:
            # 假设原始时间是北京时间，添加时区信息
            logger.debug(f"Date without timezone, assuming Beijing time: {email_date}")
            email_date = email_date.replace(tzinfo=BEIJING_TZ)
        else:
            # 转换为北京时间 (UTC+8)
            original_tz = email_date.isoformat()
            email_date = email_date.astimezone(BEIJING_TZ)
            logger.debug(f"Date converted to Beijing time: {original_tz} -> {email_date.isoformat()}")

        properties = {
            # Subject (Title)
            "Subject": {
                "title": [{"text": {"content": email.subject[:2000]}}]
            },

            # From (Email)
            "From": {
                "email": email.sender
            },

            # From Name (Text)
            "From Name": {
                "rich_text": [{"text": {"content": (email.sender_name or "")[:1999]}}]
            },

            # To (Text)
            "To": {
                "rich_text": [{"text": {"content": email.to[:1999]}}]
            } if email.to else {"rich_text": []},

            # CC (Text)
            "CC": {
                "rich_text": [{"text": {"content": email.cc[:1999]}}]
            } if email.cc else {"rich_text": []},

            # Date (带时区的 ISO 格式)
            "Date": {
                "date": {"start": email_date.isoformat()}
            },

            # Message ID (Text)
            "Message ID": {
                "rich_text": [{"text": {"content": email.message_id[:1999]}}]
            },

            # Processing Status (Select) - 默认为"未处理"
            "Processing Status": {
                "select": {"name": "未处理"}
            },

            # Is Read (Checkbox)
            "Is Read": {
                "checkbox": email.is_read
            },

            # Is Flagged (Checkbox)
            "Is Flagged": {
                "checkbox": email.is_flagged
            },

            # Has Attachments (Checkbox)
            "Has Attachments": {
                "checkbox": email.has_attachments
            },

            # Mailbox (Select) - 邮箱类型
            "Mailbox": {
                "select": {"name": email.mailbox}
            },
        }

        # Thread ID (可选)
        if email.thread_id:
            properties["Thread ID"] = {
                "rich_text": [{"text": {"content": email.thread_id[:1999]}}]
            }

        # ID (internal_id, 可选) - v3 架构: AppleScript id = SQLite ROWID
        if email.internal_id:
            properties["ID"] = {
                "number": email.internal_id
            }

        # Original EML (Files) - .eml 文件上传
        if eml_file_upload_id:
            properties["Original EML"] = {
                "files": [
                    {
                        "type": "file_upload",
                        "file_upload": {
                            "id": eml_file_upload_id
                        }
                    }
                ]
            }

        return properties

    # Notion 内容安全过滤会对某些 Unix 路径返回 403，用零宽空格拆分绕过
    _SENSITIVE_PATH_PATTERN = re.compile(r'/etc/(?=hosts|passwd|shadow|sudoers|crontab|fstab|resolv)')

    @classmethod
    def _sanitize_text(cls, text: str) -> str:
        """净化文本中可能触发 Notion 403 的敏感路径"""
        return cls._SENSITIVE_PATH_PATTERN.sub('/etc/\u200B', text)

    @classmethod
    def _sanitize_rich_text_list(cls, rich_text_list: list):
        """净化一个 rich_text 数组中的文本内容"""
        for rt in rich_text_list:
            text_obj = rt.get('text', {})
            if 'content' in text_obj:
                text_obj['content'] = cls._sanitize_text(text_obj['content'])

    @classmethod
    def _sanitize_blocks(cls, blocks: list):
        """递归净化 blocks 中的 rich_text 内容（含 table cells）"""
        for block in blocks:
            btype = block.get('type', '')
            container = block.get(btype, {})
            if isinstance(container, dict):
                # 普通 blocks 的 rich_text
                if 'rich_text' in container:
                    cls._sanitize_rich_text_list(container['rich_text'])
                # table_row 的 cells: [[rich_text], [rich_text], ...]
                for cell in container.get('cells', []):
                    cls._sanitize_rich_text_list(cell)
                # 递归处理子 blocks
                if 'children' in container:
                    cls._sanitize_blocks(container['children'])

    def _build_children(self, email: Email, uploaded_attachments: List[Dict] = None, image_map: Dict[str, tuple] = None, meeting_invite: 'MeetingInvite' = None) -> List[Dict[str, Any]]:
        """构建 Notion Page Children (Content Blocks)"""
        children = []

        # 0. 会议邀请 Callout（放在最前面）
        if meeting_invite:
            children.append(self._create_meeting_callout(meeting_invite))
            children.append({
                "object": "block",
                "type": "divider",
                "divider": {}
            })

        # 1. 非图片附件区域（放在顶部，类似邮件的表现）
        non_image_attachments = []
        inline_image_filenames = set(image_map.keys()) if image_map else set()

        if uploaded_attachments:
            for attachment in uploaded_attachments:
                content_type = attachment.get('content_type', '').lower()
                is_image = content_type.startswith('image/')

                # 非图片附件：放在顶部
                # 图片附件：只有非内联图片才放在顶部
                if not is_image:
                    non_image_attachments.append(attachment)
                elif attachment['filename'] not in inline_image_filenames:
                    # 非内联图片也放在附件区域
                    non_image_attachments.append(attachment)

        if non_image_attachments:
            children.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{"text": {"content": "📎 附件"}}]
                }
            })

            for attachment in non_image_attachments:
                content_type = attachment.get('content_type', '').lower()
                is_image = content_type.startswith('image/')

                if is_image:
                    # 非内联图片
                    children.append({
                        "object": "block",
                        "type": "image",
                        "image": {
                            "type": "file_upload",
                            "file_upload": {
                                "id": attachment['file_upload_id']
                            },
                            "caption": [{"text": {"content": attachment['filename']}}]
                        }
                    })
                else:
                    # 其他文件
                    children.append({
                        "object": "block",
                        "type": "file",
                        "file": {
                            "type": "file_upload",
                            "file_upload": {
                                "id": attachment['file_upload_id']
                            },
                            "caption": [{"text": {"content": attachment['filename']}}]
                        }
                    })

            children.append({
                "object": "block",
                "type": "divider",
                "divider": {}
            })

        # 2. 邮件内容区域标题
        children.append({
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"text": {"content": "📧 邮件内容"}}]
            }
        })

        # 3. 转换邮件正文（包括内联图片）
        try:
            content_blocks = self.html_converter.convert(email.content, image_map)
            children.extend(content_blocks)
        except Exception as e:
            logger.error(f"Failed to convert email content: {e}")
            # 降级：添加纯文本
            children.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"text": {"content": email.content[:2000]}}]
                }
            })

        # 注意：不在这里限制 children 数量，由 _create_page_with_blocks 方法处理分批上传

        return children

    # ============================================================
    # v4 SSoT 路径：从 SQLite 读 body+attachments+metadata 创建 Notion 页
    # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §5
    # ============================================================

    # 匹配 storage_payload_builder._rewrite_cid_to_local 写入 body_html 的相对路径
    _V4_ATTACHMENT_SRC_RE = re.compile(
        r"""(?P<attr>src|href)\s*=\s*(?P<quote>["'])attachments/(?P<int_id>\d+)/(?P<filename>[^"']+)(?P=quote)""",
        re.IGNORECASE,
    )

    @classmethod
    def _restore_cid_in_body_html(
        cls, html: Optional[str], attachments: List['AttachmentRecord']
    ) -> str:
        """把 v4 body_html 里 ``attachments/{int_id}/{filename}`` 还原成 ``cid:{content_id}``。

        Why: _build_image_map / _handle_image 已经被 v2 验证过、只认 cid: 引用；与其改写两边
        不如把 v4 的相对路径反推回 cid 让既有 helper 原样工作。filename → content_id 映射来自
        email_attachment 表（保 inline / content_id 不为空）。映射缺失就保留原相对路径，
        _handle_image 进入 "unsupported src" 分支吐占位 callout，不会让整封邮件失败。
        """
        if not html:
            return html or ""
        filename_to_cid = {
            att.filename: att.content_id
            for att in attachments
            if att.content_id
        }
        if not filename_to_cid:
            return html

        def repl(m: "re.Match[str]") -> str:
            filename = m.group("filename")
            cid = filename_to_cid.get(filename)
            if not cid:
                return m.group(0)
            return f'{m.group("attr")}={m.group("quote")}cid:{cid}{m.group("quote")}'

        return cls._V4_ATTACHMENT_SRC_RE.sub(repl, html)

    @staticmethod
    def _materialize_attachments(
        att_records: List['AttachmentRecord'],
        work_dir: Path,
        repo: 'EmailRepository',
    ) -> Tuple[List[Attachment], List[int]]:
        """把 SQLite 附件物化到 work_dir，转成 v2 期望的 Attachment list。

        v2 的 _upload_attachments / EMLGenerator.generate 都按 ``attachment.path`` 读盘，
        这里给它们准备好临时文件即可，让上层逻辑无差异复用。

        Returns:
            (materialized, missing_att_ids):
                - materialized: 成功落盘的 Attachment 列表（顺序 = att_records 中可用项）
                - missing_att_ids: 落盘文件不存在的 attachment.id（告警 / 排错用）
        """
        materialized: List[Attachment] = []
        missing: List[int] = []
        for att in att_records:
            content = repo.get_attachment_bytes(att.id)
            if content is None:
                logger.warning(
                    f"Attachment file missing for att_id={att.id} "
                    f"local_path={att.local_path!r}; skipping"
                )
                missing.append(att.id)
                continue
            target = work_dir / att.filename
            try:
                target.write_bytes(content)
            except OSError as e:
                logger.warning(f"Failed to stage attachment {att.filename!r}: {e}")
                missing.append(att.id)
                continue
            materialized.append(Attachment(
                filename=att.filename,
                content_type=att.content_type or "application/octet-stream",
                size=att.size_bytes or len(content),
                path=str(target),
                content_id=att.content_id,
                is_inline=att.is_inline,
                # derived_from_filename 留空：自动派生已于 2026-08 退役，此处不再有
                # 「让下游二次转换」的语义；derived_format 仍从存量行透传。
                derived_from_filename=None,
                derived_format=att.derived_format,
            ))
        return materialized, missing

    @staticmethod
    def _parse_iso_to_beijing(date_str: Optional[str]) -> datetime:
        """ISO 串 → 带 UTC+8 的 datetime；失败回退 now()。"""
        if not date_str:
            return datetime.now(BEIJING_TZ)
        try:
            normalized = re.sub(r'\.\d+', '', date_str)
            dt = datetime.fromisoformat(normalized)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=BEIJING_TZ)
            return dt
        except Exception:
            logger.warning(f"Failed to parse date {date_str!r}, using now()")
            return datetime.now(BEIJING_TZ)

    @classmethod
    def _build_email_from_sqlite(
        cls,
        internal_id: int,
        body_record: 'EmailBodyRecord',
        metadata: Mapping[str, Any],
        att_records: List['AttachmentRecord'],
        work_dir: Path,
        repo: 'EmailRepository',
    ) -> Email:
        """合成 Email 对象，让 v2 的 properties/children/upload helpers 原样复用。

        - body content 优先取 body_html；text-only / empty 用 markdown 兜底
        - body_format='html' → content_type='text/html'，否则 'text/plain'
        - cid 还原仅在 HTML 路径上做，plaintext 不需要
        """
        materialized, _missing = cls._materialize_attachments(att_records, work_dir, repo)

        is_html = body_record.body_format == "html" and body_record.html
        if is_html:
            content = cls._restore_cid_in_body_html(body_record.html, att_records)
            content_type = "text/html"
        else:
            content = body_record.markdown or body_record.html or ""
            content_type = "text/plain"

        parsed_date = cls._parse_iso_to_beijing(metadata.get("date_received"))

        message_id = metadata.get("message_id") or body_record.message_id
        if not message_id:
            raise ValueError(f"Missing message_id in SQLite for internal_id={internal_id}")

        return Email(
            message_id=message_id,
            subject=metadata.get("subject") or "(No Subject)",
            sender=metadata.get("sender") or "",
            sender_name=metadata.get("sender_name") or None,
            to=metadata.get("to_addr") or "",
            cc=metadata.get("cc_addr") or "",
            date=parsed_date,
            content=content,
            content_type=content_type,
            is_read=bool(metadata.get("is_read")),
            is_flagged=bool(metadata.get("is_flagged")),
            attachments=materialized,
            thread_id=metadata.get("thread_id") or None,
            mailbox=metadata.get("mailbox") or "收件箱",
            internal_id=internal_id,
        )

    @staticmethod
    def _build_file_id_map(
        uploaded_attachments: List[Dict[str, Any]],
        att_records: List['AttachmentRecord'],
    ) -> Dict[int, str]:
        """把上传成功的附件与 SQLite 行关联，返回 {attachment_id: file_upload_id}。

        给 repo.update_notion_links 用，让未来反向同步 / orphan 清理可以走
        email_attachment.notion_file_id。filename 是 sanitize 后的稳定 key，
        commit 阶段和 materialize 阶段一致。
        """
        filename_to_id = {att.filename: att.id for att in att_records}
        file_id_map: Dict[int, str] = {}
        for ua in uploaded_attachments:
            att_id = filename_to_id.get(ua.get("filename"))
            upload_id = ua.get("file_upload_id")
            if att_id is not None and upload_id:
                file_id_map[att_id] = upload_id
        return file_id_map

    async def create_email_page_v2(
        self,
        email: Email,
        skip_parent_lookup: bool = False,
        calendar_page_id: str = None,
        meeting_invite: 'MeetingInvite' = None
    ) -> Optional[str]:
        """创建邮件页面（新架构 v2）

        新架构特性：
        - 线程中最新邮件作为母节点
        - 通过设置 Sub-item 自动重建 Parent Item 关系
        - 支持关联日程页面（会议邀请邮件）
        - 支持在邮件正文前显示会议邀请信息

        Args:
            email: Email 对象（必须包含 thread_id）
            skip_parent_lookup: 是否跳过线程关系处理（用于批量同步时避免重复处理）
            calendar_page_id: 日程页面 ID（如果邮件包含会议邀请）
            meeting_invite: 会议邀请对象（用于在正文前显示会议信息 callout）

        Returns:
            成功返回 page_id，失败返回 None

        Raises:
            Exception: 检查重复时发生错误会抛出异常，避免创建重复页面
        """
        # v4 P4-04：灰度路由 —— NOTION_READ_FROM_SQLITE=true + SQLite 命中 body 时
        # delegate 到 create_email_page_from_sqlite；miss 自动 fallback 走老路径。
        # 默认 false，对生产无副作用；切 true 后正常 sync + resync 都统一走 SSoT。
        # PR-4 R-06: 路径选择计数 → v4_rollout_stats 表 (RFC §8 选项 A).
        # PR-4 codex critic round 1: fallback 仅覆盖 *pre-side-effect* 错 (body lookup miss / DB locked);
        # 一旦进入 create_email_page_from_sqlite (side effect 已开始), 错误必须上抛, 否则可能
        # 触发老路径再建一张重复页 (duplicate page risk).
        import time as _time
        from src.config import config as app_config
        if app_config.notion_read_from_sqlite and email.internal_id:
            _t0 = _time.monotonic()
            should_route_sqlite = False
            try:
                repo = self._email_repo
                sync_store = self._sync_store
                # pre-side-effect 阶段: 只是查 body 是否存在
                if repo.get_body(email.internal_id) is not None:
                    should_route_sqlite = True
                else:
                    logger.debug(
                        f"[v4] SQLite body miss for internal_id={email.internal_id}, "
                        f"falling back to legacy v2 path"
                    )
                    self._rollout.record_miss(int(email.internal_id))
            except ValueError:
                # body / metadata lookup 不一致 (Phase 1 之前老邮件): fallback 老路径
                logger.debug(
                    f"[v4] SQLite resources incomplete for internal_id={email.internal_id}, "
                    f"falling back to legacy v2 path"
                )
                self._rollout.record_miss(int(email.internal_id))
            except Exception as e:
                # DB locked / 路径解析等 pre-side-effect 错: fallback 但 warning
                logger.warning(
                    f"[v4] SQLite pre-route lookup failed for internal_id={email.internal_id} "
                    f"({type(e).__name__}: {e}); falling back to legacy v2 path"
                )
                self._rollout.record_error()

            # side-effect 阶段: 一旦走 create_email_page_from_sqlite, 任何错都必须上抛, 不再 fallback.
            if should_route_sqlite:
                logger.debug(
                    f"[v4] routing to from-sqlite path: internal_id={email.internal_id}"
                )
                sqlite_creator = getattr(
                    self,
                    "_create_email_page_from_sqlite",
                    self.create_email_page_from_sqlite,
                )
                sqlite_result = await sqlite_creator(
                    email.internal_id,
                    repo=repo,
                    sync_store=sync_store,
                    meeting_invite=meeting_invite,
                    calendar_page_id=calendar_page_id,
                    skip_parent_lookup=skip_parent_lookup,
                )
                self._rollout.record_hit((_time.monotonic() - _t0) * 1000)
                return sqlite_result.page_id

        try:
            logger.info(f"Creating email page (v2): {email.subject}")

            # 1. 检查是否已同步（这里的异常会向上传播，避免重复创建）
            try:
                if await self.client.check_page_exists(email.message_id):
                    logger.info(f"Email already synced: {email.message_id}")
                    existing = await self.client.query_database(
                        filter_conditions={
                            "property": "Message ID",
                            "rich_text": {"equals": email.message_id}
                        }
                    )
                    if existing:
                        return existing[0].get("id")
                    return None
            except Exception as e:
                # 检查重复失败时，向上抛出异常，避免创建重复页面
                logger.error(f"Failed to check if page exists, aborting to prevent duplicates: {e}")
                raise

            # 2.（已退役）Office 派生 —— 原先在此把 docx/pptx→PDF、xlsx→CSV 追加进
            #    附件列表，受 OFFICE_CONVERT_ENABLED 门控。2026-08 退役：Notion 侧已有
            #    沙盒电脑可直接处理 office 文件，派生失去意义；它也是自动链路对未打包进
            #    .app 的系统级 LibreOffice 的最后一条依赖。历史派生附件不做清理。
            #    序号有意留空，避免为一次删除重排下方全部步骤注释。

            # 3. 上传附件（使用提取的方法）
            uploaded_attachments, failed_attachments = await self._upload_attachments(email)

            # 4. 生成并上传 .eml 归档文件
            eml_file_upload_id = await self._upload_eml_file(email)

            # 5. 构建 Properties
            properties = self._build_properties(email, eml_file_upload_id)

            # 6. 关联日程页面（会议邀请邮件）
            if calendar_page_id:
                properties["Calendar Events"] = {
                    "relation": [{"id": calendar_page_id}]
                }
                logger.info(f"Linked to calendar event: {calendar_page_id}")

            # 7. 构建图片映射
            image_map = self._build_image_map(email, uploaded_attachments)

            # 8. 转换邮件内容为 Notion Blocks
            children = self._build_children(email, uploaded_attachments, image_map, meeting_invite)

            # 8.5 净化 blocks 中可能触发 Notion 403 的敏感路径
            self._sanitize_blocks(children)

            # 9. 如果有附件上传失败，添加警告提示
            if failed_attachments:
                warning_block = {
                    "type": "callout",
                    "callout": {
                        "rich_text": [{
                            "type": "text",
                            "text": {"content": f"⚠️ {len(failed_attachments)} 个附件上传失败: {', '.join(failed_attachments)}"}
                        }],
                        "icon": {"type": "emoji", "emoji": "⚠️"},
                        "color": "yellow_background"
                    }
                }
                children.insert(0, warning_block)

            # 10. 设置邮件 icon（收件箱 📧，发件箱 📤）
            email_icon = {"type": "emoji", "emoji": "📤"} if is_sent_mailbox(email.mailbox) else {"type": "emoji", "emoji": "📧"}

            # 11. 创建 Page（使用提取的方法处理分批）
            page = await self._create_page_with_blocks(properties, children, email_icon)
            page_id = page['id']
            logger.info(f"Email page created successfully (v2): {email.subject} (page_id={page_id})")

            # 12. 处理线程关系（新架构：最新邮件为母节点）
            thread_id = email.thread_id
            if not skip_parent_lookup and thread_id:
                await self._handle_thread_relations(page_id, email)

            return page_id

        except Exception as e:
            logger.error(f"Failed to create email page (v2): {e}")
            raise  # 向上传播异常，让调用方知道失败原因

    async def create_email_page_from_sqlite(
        self,
        internal_id: int,
        *,
        repo: 'EmailRepository',
        sync_store: 'SyncStore',
        meeting_invite: Optional['MeetingInvite'] = None,
        calendar_page_id: Optional[str] = None,
        skip_parent_lookup: bool = False,
        replace_existing: bool = False,
    ) -> CreateEmailFromSqliteResult:
        """v4 SSoT 路径：从 SQLite 读 body+attachments+metadata 创建 Notion 邮件页面。

        与 create_email_page_v2 的语义差异：
        - 不接受 in-memory Email 对象，整张邮件从 SQLite 重建
        - 附件从 ``email_attachment.local_path`` 读盘，不再依赖 ``/tmp/{md5}/``
        - Office 转换跳过（v4 dual-write 已把 derived 行预转完）
        - 上传完成后通过 ``repo.update_notion_links`` 回写 ``notion_file_id``
          供反向同步 / orphan cleanup 复用

        适用场景：
        - ``mailagent email resync`` 重传历史邮件（不再走 AppleScript）
        - 灰度切换后正常 sync 路径（P4-04 wrapper 路由）

        Raises:
            ValueError: SQLite 没有 body / metadata。调用方自行决定是否降级到 AppleScript。
        """
        body_record = repo.get_body(internal_id)
        if body_record is None:
            raise ValueError(f"No body in SQLite for internal_id={internal_id}")
        metadata = sync_store.get(internal_id)
        if metadata is None:
            raise ValueError(f"No metadata in SQLite for internal_id={internal_id}")
        att_records = repo.get_attachments(internal_id)

        work_dir = Path(tempfile.mkdtemp(prefix=f"mailagent-sqlite-{internal_id}-"))
        try:
            email = self._build_email_from_sqlite(
                internal_id, body_record, metadata, att_records, work_dir, repo
            )

            logger.info(
                f"Creating email page from SQLite: {email.subject} "
                f"(internal_id={internal_id}, attachments={len(email.attachments)}, "
                f"format={body_record.body_format})"
            )

            # 1. dup check（与 v2 同语义）
            # R-19 / PR-2 critic round 2: 追踪 dup 命中 + archive 真实发生情况, 供
            # 结构化 result 区分 'skipped' / 'replaced' / 'created'。
            existing_page_id_pre_replace: Optional[str] = None
            archived_page_id: Optional[str] = None
            try:
                if await self.client.check_page_exists(email.message_id):
                    logger.info(f"Email already synced: {email.message_id}")
                    existing = await self.client.query_database(
                        filter_conditions={
                            "property": "Message ID",
                            "rich_text": {"equals": email.message_id}
                        }
                    )
                    if existing:
                        existing_page_id = existing[0].get("id")
                        if not replace_existing:
                            return CreateEmailFromSqliteResult(
                                page_id=existing_page_id,
                                action="skipped",
                                existing_page_id=existing_page_id,
                            )
                        # replace_existing：归档老页落到 create 流程
                        existing_page_id_pre_replace = existing_page_id
                        try:
                            await self.client.client.pages.update(
                                page_id=existing_page_id, archived=True
                            )
                            archived_page_id = existing_page_id
                            logger.info(
                                f"Archived existing page {existing_page_id} for replace"
                            )
                        except Exception as e:
                            logger.warning(
                                f"Archive existing page {existing_page_id} failed: {e}; "
                                f"continuing with create anyway"
                            )
                    else:
                        # check_page_exists 命中但 query 拉不到 — Notion 侧索引/视图不一致,
                        # 不再创建 (避免重复) 也无法定位老页, 返回 page_id=None 的 'skipped'。
                        return CreateEmailFromSqliteResult(
                            page_id=None,
                            action="skipped",
                        )
            except Exception:
                logger.error(
                    "Failed to check page existence (from-sqlite), aborting to prevent duplicates"
                )
                raise

            # 2. 附件上传（v2 _upload_attachments 直接复用，path 指向 work_dir 临时文件）
            uploaded_attachments, failed_filenames = await self._upload_attachments(email)

            # 3. .eml 归档（v2 EMLGenerator 直接复用）
            eml_file_upload_id = await self._upload_eml_file(email)

            # 4. properties + image_map + children
            properties = self._build_properties(email, eml_file_upload_id)
            if calendar_page_id:
                properties["Calendar Events"] = {"relation": [{"id": calendar_page_id}]}
                logger.info(f"Linked to calendar event: {calendar_page_id}")

            image_map = self._build_image_map(email, uploaded_attachments)
            children = self._build_children(email, uploaded_attachments, image_map, meeting_invite)
            self._sanitize_blocks(children)

            if failed_filenames:
                warning_block = {
                    "type": "callout",
                    "callout": {
                        "rich_text": [{
                            "type": "text",
                            "text": {"content": f"⚠️ {len(failed_filenames)} 个附件上传失败: {', '.join(failed_filenames)}"}
                        }],
                        "icon": {"type": "emoji", "emoji": "⚠️"},
                        "color": "yellow_background"
                    }
                }
                children.insert(0, warning_block)

            # 5. 创建 Page
            email_icon = (
                {"type": "emoji", "emoji": "📤"}
                if is_sent_mailbox(email.mailbox)
                else {"type": "emoji", "emoji": "📧"}
            )
            page = await self._create_page_with_blocks(properties, children, email_icon)
            page_id = page["id"]
            logger.info(
                f"Email page created from SQLite (v4): {email.subject} "
                f"(page_id={page_id})"
            )

            # 6. P4-03: 回写 notion_file_id
            file_id_map = self._build_file_id_map(uploaded_attachments, att_records)
            if file_id_map:
                try:
                    repo.update_notion_links(internal_id, file_id_map=file_id_map)
                    logger.debug(
                        f"Wrote back {len(file_id_map)} notion_file_id entries "
                        f"for internal_id={internal_id}"
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to write back notion_file_id for "
                        f"internal_id={internal_id}: {e}"
                    )

            # 7. 线程关系（v2 同链路）
            if not skip_parent_lookup and email.thread_id:
                await self._handle_thread_relations(page_id, email)

            return CreateEmailFromSqliteResult(
                page_id=page_id,
                action=(
                    "replaced" if existing_page_id_pre_replace else "created"
                ),
                existing_page_id=existing_page_id_pre_replace,
                archived_page_id=archived_page_id,
            )
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    async def _handle_thread_relations(self, page_id: str, email: Email):
        return await self._threads.handle_thread_relations(page_id, email)
