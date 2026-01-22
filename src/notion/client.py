from notion_client import AsyncClient
from typing import Dict, Any, List, Optional
from loguru import logger

from src.config import config

class NotionClient:
    """Notion API 客户端封装"""

    def __init__(self):
        self.client = AsyncClient(auth=config.notion_token)
        self.email_db_id = config.email_database_id

    async def create_page(
        self,
        properties: Dict[str, Any],
        children: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        在 Email Inbox Database 中创建 Page

        Args:
            properties: Page 属性
            children: Page 内容（Blocks）

        Returns:
            创建的 Page 对象
        """
        try:
            page_data = {
                "parent": {"database_id": self.email_db_id},
                "properties": properties
            }

            if children:
                page_data["children"] = children

            page = await self.client.pages.create(**page_data)
            logger.debug(f"Created Notion page: {page['id']}")
            return page

        except Exception as e:
            logger.error(f"Failed to create Notion page: {e}")
            raise

    async def query_database(
        self,
        filter_conditions: Optional[Dict[str, Any]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None
    ) -> List[Dict[str, Any]]:
        """
        查询 Email Inbox Database

        Args:
            filter_conditions: 过滤条件
            sorts: 排序条件

        Returns:
            Page 列表
        """
        try:
            query_params = {"database_id": self.email_db_id}

            if filter_conditions:
                query_params["filter"] = filter_conditions

            if sorts:
                query_params["sorts"] = sorts

            results = await self.client.databases.query(**query_params)
            return results.get("results", [])

        except Exception as e:
            logger.error(f"Failed to query Notion database: {e}")
            return []

    async def upload_file(self, file_path: str) -> str:
        """
        上传文件到 Notion (三步流程)
        https://developers.notion.com/docs/uploading-small-files

        Args:
            file_path: 文件路径

        Returns:
            file_upload_id: 可用于附加到page properties的文件ID
        """
        try:
            from pathlib import Path
            import aiohttp
            import mimetypes

            file = Path(file_path)

            if not file.exists():
                raise FileNotFoundError(f"File not found: {file_path}")

            # 检查文件大小（最大20MB）
            file_size = file.stat().st_size
            if file_size > 20 * 1024 * 1024:
                raise ValueError(f"File too large: {file_size} bytes (max 20MB)")

            # Step 1: Create file upload object
            logger.debug(f"Creating file upload for: {file.name}")

            # Step 1使用Notion API headers
            notion_headers = {
                "Authorization": f"Bearer {config.notion_token}",
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            }

            create_payload = {
                "filename": file.name
            }

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    "https://api.notion.com/v1/file_uploads",
                    headers=notion_headers,
                    json=create_payload
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        raise Exception(f"Failed to create file upload: {resp.status} - {error_text}")

                    upload_obj = await resp.json()
                    upload_url = upload_obj["upload_url"]
                    file_upload_id = upload_obj["id"]

            logger.debug(f"Created file upload: {file_upload_id}")
            logger.debug(f"Upload URL: {upload_url[:100]}...")  # 只打印前100个字符

            # Step 2: Send file content (需要Authorization因为upload_url是Notion API endpoint)
            logger.debug(f"Uploading file content to upload_url...")

            # 读取文件内容
            with open(file, 'rb') as f:
                file_content = f.read()

            # 确定content type
            content_type = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'

            # 使用multipart/form-data上传（需要Authorization header）
            send_headers = {
                "Authorization": f"Bearer {config.notion_token}",
                "Notion-Version": "2022-06-28"
                # 注意：不设置Content-Type，让aiohttp自动设置为multipart/form-data
            }

            async with aiohttp.ClientSession() as session:
                form_data = aiohttp.FormData()
                form_data.add_field('file',
                                   file_content,
                                   filename=file.name,
                                   content_type=content_type)

                async with session.post(upload_url, headers=send_headers, data=form_data) as resp:
                    if resp.status not in [200, 201, 204]:
                        error_text = await resp.text()
                        raise Exception(f"Failed to send file: {resp.status} - {error_text}")

            logger.debug(f"✅ File uploaded successfully: {file.name}")

            # Step 3: 返回file_upload_id，将在create_page时使用
            return file_upload_id

        except Exception as e:
            logger.error(f"Failed to upload file to Notion: {e}")
            raise

    async def check_page_exists(self, message_id: str) -> bool:
        """
        检查邮件是否已存在于 Notion

        Args:
            message_id: 邮件 Message ID

        Returns:
            是否存在
        """
        try:
            results = await self.query_database(
                filter_conditions={
                    "property": "Message ID",
                    "rich_text": {"equals": message_id}
                }
            )
            return len(results) > 0

        except Exception as e:
            logger.error(f"Failed to check page existence: {e}")
            return False

    async def append_block_children(
        self,
        block_id: str,
        children: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        向 Block 追加子 Blocks

        Args:
            block_id: Block ID (通常是 Page ID)
            children: 要追加的 Blocks

        Returns:
            API 响应
        """
        try:
            result = await self.client.blocks.children.append(
                block_id=block_id,
                children=children
            )
            logger.debug(f"Appended {len(children)} blocks to {block_id}")
            return result

        except Exception as e:
            logger.error(f"Failed to append blocks: {e}")
            raise
