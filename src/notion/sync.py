from typing import Dict, Any, List, Set, Optional, TYPE_CHECKING
from pathlib import Path
from loguru import logger
from datetime import datetime, timezone, timedelta
import re
import shutil

if TYPE_CHECKING:
    from src.mail.icalendar_parser import MeetingInvite

from src.models import Email
from src.notion.client import NotionClient
from src.converter.html_converter import HTMLToNotionConverter
from src.converter.eml_generator import EMLGenerator

# 北京时区 (UTC+8)
BEIJING_TZ = timezone(timedelta(hours=8))

class NotionSync:
    """Notion 同步器"""

    def __init__(self):
        self.client = NotionClient()
        self.html_converter = HTMLToNotionConverter()
        self.eml_generator = EMLGenerator()

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

    async def _upload_attachments(self, email: Email) -> tuple[List[Dict[str, Any]], List[str]]:
        """上传邮件附件到 Notion

        处理 .eml 附件重命名为 .txt（Notion 不支持 .eml 格式）

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
                upload_path = attachment.path
                original_filename = attachment.filename

                # 处理 .eml 附件：Notion 不支持 .eml，需要重命名为 .txt
                if attachment.filename.lower().endswith('.eml'):
                    txt_path = Path(attachment.path).with_suffix('.txt')
                    shutil.copy2(attachment.path, txt_path)
                    upload_path = str(txt_path)
                    original_filename = attachment.filename[:-4] + '.txt'
                    logger.debug(f"Renamed .eml to .txt for upload: {attachment.filename} -> {original_filename}")

                # 上传附件到 Notion
                file_upload_id = await self.client.upload_file(upload_path)
                uploaded_attachments.append({
                    'filename': original_filename,
                    'file_upload_id': file_upload_id,
                    'content_type': attachment.content_type,
                    'size': attachment.size,
                    'content_id': attachment.content_id,
                    'is_inline': attachment.is_inline
                })
                logger.info(f"  Uploaded: {original_filename} (cid={attachment.content_id})")

                # 清理临时 .txt 文件
                if upload_path != attachment.path:
                    Path(upload_path).unlink(missing_ok=True)

            except Exception as e:
                logger.error(f"  Failed to upload {attachment.filename}: {e}")
                failed_filenames.append(attachment.filename)

        if failed_filenames:
            logger.warning(f"Failed to upload {len(failed_filenames)} attachments: {failed_filenames}")

        return uploaded_attachments, failed_filenames

    async def _upload_eml_file(self, email: Email) -> Optional[str]:
        """生成并上传 .eml 归档文件

        Args:
            email: Email 对象

        Returns:
            file_upload_id，失败返回 None
        """
        try:
            eml_path = self.eml_generator.generate(email)
            logger.debug(f"Generated .eml file: {eml_path.name}")

            # 将 .eml 重命名为 .txt（Notion 不支持 .eml 扩展名）
            txt_path = eml_path.with_suffix('.txt')
            shutil.copy2(eml_path, txt_path)

            # 上传到 Notion
            file_upload_id = await self.client.upload_file(str(txt_path))
            logger.info(f"Uploaded email file: {txt_path.name}")

            # 清理临时 .txt 文件
            txt_path.unlink(missing_ok=True)

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
        logger.info(f"Created page with first 100 blocks")

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

    async def _find_thread_parent_by_thread_id(self, thread_id: Optional[str]) -> Optional[str]:
        """通过 Thread ID (线程头邮件的 message_id) 查找 Parent Item

        新架构：thread_id 就是线程头邮件的 message_id。
        直接通过 Message ID 属性查找对应的 Notion 页面。

        Args:
            thread_id: 线程头邮件的 message_id

        Returns:
            线程头邮件的 page_id，如果没有则返回 None
        """
        if not thread_id:
            return None

        try:
            # 直接通过 Message ID 查找线程头邮件
            filter_conditions = {
                "property": "Message ID",
                "rich_text": {"equals": thread_id}
            }

            results = await self.client.query_database(
                filter_conditions=filter_conditions
            )

            if results:
                parent_page = results[0]
                parent_page_id = parent_page.get("id")
                logger.debug(f"Found thread parent by thread_id: {thread_id[:50]}... -> page_id={parent_page_id}")
                return parent_page_id

            logger.debug(f"Thread parent not found in Notion: {thread_id[:50]}...")
            return None

        except Exception as e:
            logger.warning(f"Failed to find thread parent for thread_id={thread_id[:50]}...: {e}")
            return None

    async def _find_all_thread_members_with_date(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> List[Dict[str, Any]]:
        """查找同一线程中的所有邮件（带日期信息）

        用于新架构的 Parent Item 关联：找到线程中所有邮件，
        比较日期以确定最新邮件。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）

        Returns:
            邮件列表，每项包含 {page_id, message_id, date}
        """
        if not thread_id:
            return []

        try:
            results = await self.client.client.databases.query(
                database_id=self.client.email_db_id,
                filter={
                    "property": "Thread ID",
                    "rich_text": {"equals": thread_id}
                },
                page_size=100
            )

            pages = results.get("results", [])
            thread_members = []

            for page in pages:
                page_id = page.get("id")
                props = page.get("properties", {})

                # 获取 message_id
                msg_id_texts = props.get("Message ID", {}).get("rich_text", [])
                msg_id = msg_id_texts[0].get("text", {}).get("content", "") if msg_id_texts else ""

                # 排除当前邮件
                if exclude_message_id and msg_id == exclude_message_id:
                    continue

                # 获取日期
                date_prop = props.get("Date", {}).get("date", {})
                date_str = date_prop.get("start", "") if date_prop else ""

                thread_members.append({
                    "page_id": page_id,
                    "message_id": msg_id,
                    "date": date_str
                })

            logger.debug(f"Found {len(thread_members)} thread members for: {thread_id[:30]}...")
            return thread_members

        except Exception as e:
            logger.warning(f"Failed to find thread members for thread_id={thread_id[:30]}...: {e}")
            return []

    async def update_sub_items(self, page_id: str, child_page_ids: List[str]) -> bool:
        """更新页面的 Sub-item 关系

        通过设置母节点的 Sub-item，Notion 双向关联会自动更新子节点的 Parent Item。

        Args:
            page_id: 母节点的 page_id
            child_page_ids: 子节点的 page_id 列表

        Returns:
            是否成功
        """
        if not child_page_ids:
            return True

        try:
            # 过滤和验证子页面 ID
            valid_child_ids = []
            seen = set()
            for pid in child_page_ids:
                if not pid or pid == page_id or pid in seen:
                    continue
                seen.add(pid)
                valid_child_ids.append(pid)

            if not valid_child_ids:
                return True

            # 1. 清空 parent 的 Parent Item（避免循环引用）
            await self.client.client.pages.update(
                page_id=page_id,
                properties={"Parent Item": {"relation": []}}
            )

            # 2. 设置 parent 的 Sub-item（Notion 双向关联会自动更新子节点的 Parent Item）
            relations = [{"id": pid} for pid in valid_child_ids]
            await self.client.client.pages.update(
                page_id=page_id,
                properties={"Sub-item": {"relation": relations}}
            )

            logger.debug(f"Updated Sub-item for {page_id}: {len(valid_child_ids)} children")
            return True

        except Exception as e:
            logger.error(f"Failed to update Sub-item for {page_id}: {e}")
            return False

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

            # 2. 上传附件（使用提取的方法）
            uploaded_attachments, failed_attachments = await self._upload_attachments(email)

            # 3. 生成并上传 .eml 归档文件
            eml_file_upload_id = await self._upload_eml_file(email)

            # 4. 构建 Properties
            properties = self._build_properties(email, eml_file_upload_id)

            # 5. 关联日程页面（会议邀请邮件）
            if calendar_page_id:
                properties["Calendar Events"] = {
                    "relation": [{"id": calendar_page_id}]
                }
                logger.info(f"Linked to calendar event: {calendar_page_id}")

            # 6. 构建图片映射
            image_map = self._build_image_map(email, uploaded_attachments)

            # 7. 转换邮件内容为 Notion Blocks
            children = self._build_children(email, uploaded_attachments, image_map, meeting_invite)

            # 8. 如果有附件上传失败，添加警告提示
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

            # 9. 设置邮件 icon（收件箱 📧，发件箱 📤）
            email_icon = {"type": "emoji", "emoji": "📤"} if email.mailbox == "发件箱" else {"type": "emoji", "emoji": "📧"}

            # 10. 创建 Page（使用提取的方法处理分批）
            page = await self._create_page_with_blocks(properties, children, email_icon)
            page_id = page['id']
            logger.info(f"Email page created successfully (v2): {email.subject} (page_id={page_id})")

            # 11. 处理线程关系（新架构：最新邮件为母节点）
            thread_id = email.thread_id
            if not skip_parent_lookup and thread_id:
                await self._handle_thread_relations(page_id, email)

            return page_id

        except Exception as e:
            logger.error(f"Failed to create email page (v2): {e}")
            raise  # 向上传播异常，让调用方知道失败原因

    def _parse_date_to_beijing(self, date_str: str) -> Optional[datetime]:
        """将日期字符串转换为北京时间 datetime 对象

        支持的格式：
        - ISO 格式: 2026-01-27T09:14:00+08:00
        - Notion 格式: 2026-01-27T09:14:00.000+08:00

        Args:
            date_str: 日期字符串

        Returns:
            北京时间的 datetime 对象，解析失败返回 None
        """
        if not date_str:
            return None

        try:
            # 处理 Notion 返回的毫秒格式: 2026-01-27T09:14:00.000+08:00
            # Python 3.11+ 的 fromisoformat 可以处理这种格式
            # 但为了兼容，移除毫秒部分
            import re
            # 移除毫秒（.000 或 .123456 等）
            normalized = re.sub(r'\.\d+', '', date_str)
            dt = datetime.fromisoformat(normalized)
            # 转换为北京时间
            return dt.astimezone(BEIJING_TZ)
        except Exception as e:
            logger.warning(f"Failed to parse date string '{date_str}': {e}")
            return None

    async def _handle_thread_relations(self, page_id: str, email: Email):
        """处理线程关系（新架构：最新邮件为母节点）

        核心逻辑：
        1. 查找同线程所有已有邮件（带日期）
        2. 比较当前邮件与已有邮件的日期（统一转为北京时间比较）
        3. 如果当前邮件是最新的 → 设置 Sub-item 包含所有已有邮件
        4. 如果当前邮件不是最新的 → 设置 Parent Item 指向最新邮件

        Args:
            page_id: 当前邮件的 page_id
            email: 当前邮件对象
        """
        thread_id = email.thread_id
        if not thread_id:
            return

        try:
            # 1. 查找同线程所有已有邮件
            thread_members = await self._find_all_thread_members_with_date(
                thread_id,
                exclude_message_id=email.message_id
            )

            if not thread_members:
                # 线程中没有其他邮件，当前邮件是唯一的
                logger.debug(f"No other thread members found, this is the only email in thread")
                return

            # 2. 获取当前邮件的日期（转换为北京时间）
            current_dt = None
            if email.date:
                if email.date.tzinfo is None:
                    # naive datetime，假设是北京时间
                    current_dt = email.date.replace(tzinfo=BEIJING_TZ)
                else:
                    # 有时区信息，转换为北京时间
                    current_dt = email.date.astimezone(BEIJING_TZ)

            # 3. 找到线程中最新的邮件（转换为北京时间比较）
            # 为每个成员解析日期
            for member in thread_members:
                member['date_dt'] = self._parse_date_to_beijing(member.get('date', ''))

            # 过滤掉日期解析失败的成员
            valid_members = [m for m in thread_members if m.get('date_dt')]
            if not valid_members:
                logger.warning(f"No valid dates found in thread members, skipping relation handling")
                return

            latest_member = max(valid_members, key=lambda x: x['date_dt'])
            latest_dt = latest_member['date_dt']

            # 4. 判断当前邮件是否是最新的（使用 datetime 对象比较，避免时区问题）
            is_current_latest = current_dt is not None and current_dt >= latest_dt
            if is_current_latest:
                # 当前邮件是最新的 → 设置 Sub-item 包含所有已有邮件
                all_other_page_ids = [m['page_id'] for m in thread_members]
                logger.info(f"Current email is the latest ({current_dt} >= {latest_dt}), setting Sub-item with {len(all_other_page_ids)} members")
                await self.update_sub_items(page_id, all_other_page_ids)
            else:
                # 当前邮件不是最新的 → 需要更新最新邮件的 Sub-item
                latest_page_id = latest_member['page_id']
                logger.info(f"Current email is not the latest ({current_dt} < {latest_dt}), updating latest email's Sub-item")
                # 获取所有非最新邮件的 page_id（包括当前邮件）
                all_non_latest = [m['page_id'] for m in thread_members if m['page_id'] != latest_page_id]
                all_non_latest.append(page_id)
                await self.update_sub_items(latest_page_id, all_non_latest)

        except Exception as e:
            logger.warning(f"Failed to handle thread relations for {email.message_id[:30]}...: {e}")

    async def update_parent_item(self, page_id: str, parent_page_id: str) -> bool:
        """更新邮件的 Parent Item 关联

        用于在线程头邮件同步后，更新子邮件的关联。

        Args:
            page_id: 子邮件的 page_id
            parent_page_id: 线程头邮件的 page_id

        Returns:
            是否成功
        """
        try:
            await self.client.client.pages.update(
                page_id=page_id,
                properties={
                    "Parent Item": {
                        "relation": [{"id": parent_page_id}]
                    }
                }
            )
            logger.debug(f"Updated Parent Item: {page_id} -> {parent_page_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to update Parent Item for {page_id}: {e}")
            return False

    async def query_all_message_ids(self) -> Set[str]:
        """查询所有已同步邮件的 message_id

        新架构使用 message_id 作为唯一标识。

        Returns:
            message_id 集合
        """
        message_ids: Set[str] = set()

        try:
            logger.info("Querying all message IDs from Notion database...")

            filter_conditions = {
                "property": "Message ID",
                "rich_text": {"is_not_empty": True}
            }

            has_more = True
            start_cursor = None

            while has_more:
                query_params = {
                    "database_id": self.client.email_db_id,
                    "filter": filter_conditions,
                    "page_size": 100
                }

                if start_cursor:
                    query_params["start_cursor"] = start_cursor

                results = await self.client.client.databases.query(**query_params)

                for page in results.get("results", []):
                    msg_id_prop = page.get("properties", {}).get("Message ID", {})
                    rich_text = msg_id_prop.get("rich_text", [])
                    if rich_text:
                        message_id = rich_text[0].get("text", {}).get("content", "")
                        if message_id:
                            message_ids.add(message_id)

                has_more = results.get("has_more", False)
                start_cursor = results.get("next_cursor")

            logger.info(f"Found {len(message_ids)} existing message IDs in Notion")
            return message_ids

        except Exception as e:
            logger.error(f"Failed to query message IDs: {e}")
            return message_ids

    async def query_all_row_ids(self) -> Set[int]:
        """查询所有已同步邮件的 row_id（启动时调用）

        查询 Notion 数据库中所有 Row ID 不为空的页面
        返回 row_id 集合
        """
        row_ids: Set[int] = set()

        try:
            logger.info("Querying all row IDs from Notion database...")

            filter_conditions = {
                "property": "Row ID",
                "number": {"is_not_empty": True}
            }

            has_more = True
            start_cursor = None

            while has_more:
                query_params = {
                    "database_id": self.client.email_db_id,
                    "filter": filter_conditions,
                    "page_size": 100
                }

                if start_cursor:
                    query_params["start_cursor"] = start_cursor

                results = await self.client.client.databases.query(**query_params)

                for page in results.get("results", []):
                    row_id_prop = page.get("properties", {}).get("Row ID", {})
                    row_id_value = row_id_prop.get("number")
                    if row_id_value is not None:
                        row_ids.add(int(row_id_value))

                has_more = results.get("has_more", False)
                start_cursor = results.get("next_cursor")

            logger.info(f"Found {len(row_ids)} existing row IDs in Notion")
            return row_ids

        except Exception as e:
            logger.error(f"Failed to query row IDs: {e}")
            return row_ids

    async def query_pages_for_reverse_sync(self) -> List[Dict]:
        """查询需要反向同步的页面

        条件:
        - AI Review Status = 'Reviewed'
        - Synced to Mail = False (checkbox)

        Returns:
            页面列表，每个包含 page_id, message_id, ai_action
        """
        pages = []

        try:
            logger.info("Querying pages for reverse sync...")

            filter_conditions = {
                "and": [
                    {
                        "property": "AI Review Status",
                        "select": {"equals": "Reviewed"}
                    },
                    {
                        "property": "Synced to Mail",
                        "checkbox": {"equals": False}
                    }
                ]
            }

            has_more = True
            start_cursor = None

            while has_more:
                query_params = {
                    "database_id": self.client.email_db_id,
                    "filter": filter_conditions,
                    "page_size": 100
                }

                if start_cursor:
                    query_params["start_cursor"] = start_cursor

                results = await self.client.client.databases.query(**query_params)

                for page in results.get("results", []):
                    props = page.get("properties", {})

                    # 提取 Message ID
                    message_id_prop = props.get("Message ID", {})
                    message_id_texts = message_id_prop.get("rich_text", [])
                    message_id = message_id_texts[0].get("text", {}).get("content", "") if message_id_texts else ""

                    # 提取 AI Action
                    ai_action_prop = props.get("AI Action", {})
                    ai_action = ai_action_prop.get("select", {})
                    ai_action_name = ai_action.get("name", "") if ai_action else ""

                    pages.append({
                        "page_id": page["id"],
                        "message_id": message_id,
                        "ai_action": ai_action_name
                    })

                has_more = results.get("has_more", False)
                start_cursor = results.get("next_cursor")

            logger.info(f"Found {len(pages)} pages for reverse sync")
            return pages

        except Exception as e:
            logger.error(f"Failed to query pages for reverse sync: {e}")
            return pages

    async def update_page_mail_sync_status(
        self,
        page_id: str,
        synced: bool = True
    ):
        """更新页面的邮件同步状态

        设置 Synced to Mail = True
        设置 Mail Sync Time = now
        """
        try:
            logger.info(f"Updating mail sync status for page: {page_id}")

            properties = {
                "Synced to Mail": {"checkbox": synced},
                "Mail Sync Time": {"date": {"start": datetime.now().isoformat()}}
            }

            await self.client.client.pages.update(
                page_id=page_id,
                properties=properties
            )

            logger.info(f"Mail sync status updated for page: {page_id}")

        except Exception as e:
            logger.error(f"Failed to update mail sync status for {page_id}: {e}")
            raise

    async def query_by_row_id(self, row_id: int) -> Optional[Dict]:
        """通过 row_id 查询页面是否已存在

        Args:
            row_id: 数据库行 ID

        Returns:
            页面信息（如果存在），否则返回 None
        """
        try:
            filter_conditions = {
                "property": "Row ID",
                "number": {"equals": row_id}
            }

            results = await self.client.query_database(filter_conditions=filter_conditions)

            if results:
                page = results[0]
                return {
                    "page_id": page["id"],
                    "row_id": row_id
                }

            return None

        except Exception as e:
            logger.error(f"Failed to query by row_id {row_id}: {e}")
            return None
