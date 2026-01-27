import asyncio
from notion_client import AsyncClient
from typing import Dict, Any, List, Optional
from loguru import logger

from src.config import config


class NotionClient:
    """Notion API 客户端封装"""

    # Rate limiting settings
    MAX_RETRIES = 5
    BASE_RETRY_DELAY = 1.0  # seconds

    def __init__(self):
        self.client = AsyncClient(auth=config.notion_token)
        self.email_db_id = config.email_database_id
        self._http_session: Optional["aiohttp.ClientSession"] = None

    async def _get_http_session(self) -> "aiohttp.ClientSession":
        """Get or create a reusable HTTP session for file uploads."""
        import aiohttp
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession()
        return self._http_session

    async def close(self):
        """Close the HTTP session. Should be called when done using the client."""
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
            self._http_session = None

    async def create_page(
        self,
        properties: Dict[str, Any],
        children: Optional[List[Dict[str, Any]]] = None,
        icon: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        在 Email Inbox Database 中创建 Page

        Args:
            properties: Page 属性
            children: Page 内容（Blocks）
            icon: 页面图标（emoji 或 external）

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

            if icon:
                page_data["icon"] = icon

            page = await self.client.pages.create(**page_data)
            logger.debug(f"Created Notion page: {page['id']}")
            return page

        except Exception as e:
            logger.error(f"Failed to create Notion page: {e}")
            raise

    async def query_database(
        self,
        filter_conditions: Optional[Dict[str, Any]] = None,
        sorts: Optional[List[Dict[str, Any]]] = None,
        raise_on_error: bool = True
    ) -> List[Dict[str, Any]]:
        """
        查询 Email Inbox Database

        Args:
            filter_conditions: 过滤条件
            sorts: 排序条件
            raise_on_error: 是否在错误时抛出异常（默认 True）

        Returns:
            Page 列表

        Raises:
            Exception: 当 raise_on_error=True 且查询失败时
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
            if raise_on_error:
                raise
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

            session = await self._get_http_session()

            # Step 1: Create file upload with retry
            upload_obj = await self._request_with_retry(
                session, "POST",
                "https://api.notion.com/v1/file_uploads",
                headers=notion_headers,
                json=create_payload
            )
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

            import aiohttp
            form_data = aiohttp.FormData()
            form_data.add_field('file',
                               file_content,
                               filename=file.name,
                               content_type=content_type)

            # Step 2: Upload file content with retry
            await self._request_with_retry(
                session, "POST",
                upload_url,
                headers=send_headers,
                data=form_data,
                expect_json=False
            )

            logger.debug(f"File uploaded successfully: {file.name}")

            # Step 3: 返回file_upload_id，将在create_page时使用
            return file_upload_id

        except Exception as e:
            logger.error(f"Failed to upload file to Notion: {e}")
            raise

    async def _request_with_retry(
        self,
        session: "aiohttp.ClientSession",
        method: str,
        url: str,
        headers: Dict[str, str],
        json: Optional[Dict[str, Any]] = None,
        data: Optional[Any] = None,
        expect_json: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        Execute HTTP request with exponential backoff retry on rate limit.

        Args:
            session: aiohttp session
            method: HTTP method (GET, POST, etc.)
            url: Request URL
            headers: Request headers
            json: JSON payload (for POST)
            data: Form data (for POST)
            expect_json: Whether to parse response as JSON

        Returns:
            Response JSON if expect_json=True, otherwise None

        Raises:
            Exception: After all retries exhausted or on non-retryable errors
        """
        last_exception = None

        for attempt in range(self.MAX_RETRIES):
            try:
                async with session.request(
                    method, url,
                    headers=headers,
                    json=json,
                    data=data
                ) as resp:
                    if resp.status == 429:
                        # Rate limited - extract retry-after or use exponential backoff
                        retry_after = resp.headers.get("Retry-After")
                        if retry_after:
                            delay = float(retry_after)
                        else:
                            delay = self.BASE_RETRY_DELAY * (2 ** attempt)

                        logger.warning(
                            f"Rate limited by Notion API (attempt {attempt + 1}/{self.MAX_RETRIES}), "
                            f"retrying in {delay:.1f}s"
                        )
                        await asyncio.sleep(delay)
                        continue

                    if resp.status not in [200, 201, 204]:
                        error_text = await resp.text()
                        raise Exception(f"HTTP {method} failed: {resp.status} - {error_text}")

                    if expect_json:
                        return await resp.json()
                    return None

            except asyncio.CancelledError:
                raise
            except Exception as e:
                last_exception = e
                if "429" not in str(e) and "rate" not in str(e).lower():
                    # Non-rate-limit error, don't retry
                    raise

        # All retries exhausted
        raise Exception(f"Max retries ({self.MAX_RETRIES}) exceeded. Last error: {last_exception}")

    async def check_page_exists(self, message_id: str) -> bool:
        """
        检查邮件是否已存在于 Notion

        Args:
            message_id: 邮件 Message ID

        Returns:
            是否存在

        Raises:
            Exception: 查询失败时抛出异常，避免在错误情况下返回 False 导致重复创建
        """
        # 注意：这里不捕获异常，让调用方决定如何处理
        # 这样可以区分"页面不存在"和"查询失败"
        results = await self.query_database(
            filter_conditions={
                "property": "Message ID",
                "rich_text": {"equals": message_id}
            }
        )
        return len(results) > 0

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
