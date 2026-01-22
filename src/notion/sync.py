from typing import Dict, Any, List, Set
from pathlib import Path
from loguru import logger
import re

from src.models import Email
from src.notion.client import NotionClient
from src.converter.html_converter import HTMLToNotionConverter
from src.converter.eml_generator import EMLGenerator

class NotionSync:
    """Notion 同步器"""

    def __init__(self):
        self.client = NotionClient()
        self.html_converter = HTMLToNotionConverter()
        self.eml_generator = EMLGenerator()

    async def sync_email(self, email: Email) -> bool:
        """
        同步邮件到 Notion

        Args:
            email: Email 对象

        Returns:
            是否成功
        """
        try:
            logger.info(f"Syncing email to Notion: {email.subject}")

            # 1. 检查是否已同步
            if await self.client.check_page_exists(email.message_id):
                logger.info(f"Email already synced: {email.message_id}")
                return True

            # 2. 附件处理 - 上传所有附件
            uploaded_attachments = []  # {filename, file_upload_id, content_type}
            if email.attachments:
                logger.info(f"邮件包含 {len(email.attachments)} 个附件，开始上传...")
                for attachment in email.attachments:
                    try:
                        # 处理 .eml 附件：Notion 不支持 .eml，需要重命名为 .txt
                        upload_path = attachment.path
                        original_filename = attachment.filename

                        if attachment.filename.lower().endswith('.eml'):
                            import shutil
                            # 创建 .txt 副本
                            txt_path = Path(attachment.path).with_suffix('.txt')
                            shutil.copy2(attachment.path, txt_path)
                            upload_path = str(txt_path)
                            # 更新文件名用于显示
                            original_filename = attachment.filename[:-4] + '.txt'
                            logger.debug(f"Renamed .eml to .txt for upload: {attachment.filename} -> {original_filename}")

                        # 上传附件到Notion
                        file_upload_id = await self.client.upload_file(upload_path)
                        uploaded_attachments.append({
                            'filename': original_filename,
                            'file_upload_id': file_upload_id,
                            'content_type': attachment.content_type,
                            'size': attachment.size
                        })
                        logger.info(f"  ✅ Uploaded: {original_filename}")

                        # 清理临时 .txt 文件
                        if upload_path != attachment.path:
                            Path(upload_path).unlink(missing_ok=True)
                    except Exception as e:
                        logger.error(f"  ❌ Failed to upload {attachment.filename}: {e}")

            # 3. 生成并上传 .eml 文件
            eml_file_upload_id = None
            try:
                from pathlib import Path
                import shutil

                # 生成 .eml 文件
                eml_path = self.eml_generator.generate(email)
                logger.debug(f"Generated .eml file: {eml_path.name}")

                # 将 .eml 重命名为 .txt（Notion不支持.eml扩展名）
                txt_path = eml_path.with_suffix('.txt')
                shutil.copy2(eml_path, txt_path)

                # 上传到 Notion
                eml_file_upload_id = await self.client.upload_file(str(txt_path))
                logger.info(f"✅ Uploaded email file: {txt_path.name}")

                # 清理临时 .txt 文件
                txt_path.unlink(missing_ok=True)
            except Exception as e:
                logger.error(f"Failed to generate/upload email file: {e}")

            # 4. 构建 Properties
            properties = self._build_properties(email, eml_file_upload_id)

            # 5. 构建图片映射（仅用于HTML中真正引用的内联图片）
            image_map = self._build_image_map(email, uploaded_attachments)

            # 6. 转换邮件内容为 Notion Blocks（包括附件和内联图片）
            children = self._build_children(email, uploaded_attachments, image_map)

            # 7. 创建 Page（处理超过 100 blocks 的情况）
            if len(children) <= 100:
                # 直接创建（常规情况）
                await self.client.create_page(properties=properties, children=children)
            else:
                # 分批创建：先创建页面+前100个blocks，然后追加剩余blocks
                logger.info(f"邮件包含 {len(children)} 个 blocks，将分批创建...")

                # 创建页面（包含前100个blocks）
                page = await self.client.create_page(
                    properties=properties,
                    children=children[:100]
                )
                page_id = page['id']
                logger.info(f"✅ Created page with first 100 blocks")

                # 追加剩余 blocks（每次最多100个）
                remaining_blocks = children[100:]
                batch_size = 100
                for i in range(0, len(remaining_blocks), batch_size):
                    batch = remaining_blocks[i:i + batch_size]
                    await self.client.append_block_children(page_id, batch)
                    logger.info(f"✅ Appended {len(batch)} blocks (batch {i//batch_size + 1})")

            logger.info(f"✅ Email synced successfully: {email.subject}")
            return True

        except Exception as e:
            logger.error(f"Failed to sync email: {e}")
            return False

    def _build_image_map(self, email: Email, uploaded_attachments: List[Dict]) -> Dict[str, str]:
        """
        构建图片映射，仅包含HTML中真正引用的内联图片

        Args:
            email: Email 对象
            uploaded_attachments: 已上传的附件列表

        Returns:
            图片映射 {filename: file_upload_id}
        """
        image_map = {}

        # 只处理HTML邮件
        if email.content_type != "text/html":
            return image_map

        # 从HTML中提取所有cid引用
        cid_pattern = r'cid:([^"\'\s>]+)'
        cid_matches = re.findall(cid_pattern, email.content, re.IGNORECASE)

        if not cid_matches:
            # 没有cid引用，所有图片都是普通附件
            logger.debug("No cid references found in HTML")
            return image_map

        logger.debug(f"Found {len(cid_matches)} cid references in HTML: {set(cid_matches)}")

        # 将cid引用与附件匹配
        for att in uploaded_attachments:
            if not att['content_type'].startswith('image/'):
                continue

            filename = att['filename']
            matched = False

            # 尝试匹配cid
            for cid in cid_matches:
                # 多种匹配方式：
                # 1. 直接匹配
                # 2. cid 包含文件名
                # 3. 文件名包含 cid（去掉扩展名）
                filename_without_ext = filename.rsplit('.', 1)[0] if '.' in filename else filename
                cid_clean = cid.split('@')[0] if '@' in cid else cid

                if (cid in filename or
                    filename in cid or
                    cid_clean in filename or
                    filename_without_ext in cid):
                    image_map[filename] = att['file_upload_id']
                    logger.debug(f"Mapped inline image: {filename} -> cid:{cid}")
                    matched = True
                    break

            if not matched:
                logger.debug(f"Image {filename} not matched to any cid (will be regular attachment)")

        total_images = len([a for a in uploaded_attachments if a['content_type'].startswith('image/')])
        logger.info(f"Found {len(image_map)} inline images, {total_images - len(image_map)} regular image attachments")
        logger.debug(f"Image map: {list(image_map.keys())}")
        return image_map

    def _build_properties(self, email: Email, eml_file_upload_id: str = None) -> Dict[str, Any]:
        """构建 Notion Page Properties"""
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

            # Date
            "Date": {
                "date": {"start": email.date.isoformat()}
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

    def _build_children(self, email: Email, uploaded_attachments: List[Dict] = None, image_map: Dict[str, str] = None) -> List[Dict[str, Any]]:
        """构建 Notion Page Children (Content Blocks)"""
        children = []

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

        # 4. 原始邮件备份说明
        children.append({
            "object": "block",
            "type": "divider",
            "divider": {}
        })
        children.append({
            "object": "block",
            "type": "callout",
            "callout": {
                "rich_text": [
                    {"text": {"content": "💾 完整的原始邮件(.eml)已保存在 Original EML 字段中，可下载查看完整格式"}}
                ],
                "icon": {"emoji": "💾"}
            }
        })

        # 注意：不在这里限制 children 数量，由 sync_email 方法处理分批上传

        return children
