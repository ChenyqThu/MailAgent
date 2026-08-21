import asyncio
from notion_client import AsyncClient
from typing import Dict, Any, List, Optional, Set
from loguru import logger

from src.config import config, configured_data_source_id

# Notion File Upload API 支持的扩展名（官方文档）
# https://developers.notion.com/docs/uploading-small-files
NOTION_SUPPORTED_EXTENSIONS: Set[str] = {
    # Audio
    '.aac', '.adts', '.mid', '.midi', '.mp3', '.mpga', '.m4a', '.m4b', '.mp4', '.oga', '.ogg', '.opus', '.wav',
    '.wma', '.weba', '.flac',
    # Document
    '.pdf', '.txt', '.csv', '.json', '.doc', '.dot', '.docx', '.dotx', '.xls', '.xlt', '.xla', '.xlsx', '.xltx',
    '.ppt', '.pot', '.pps', '.ppa', '.pptx', '.potx', '.rtf', '.md', '.markdown', '.html', '.htm', '.epub',
    '.xml', '.css', '.odt', '.ods', '.odp', '.ics', '.yaml', '.yml', '.tsv', '.zip', '.gz', '.gzip', '.tar',
    '.7z', '.bz2', '.rar',
    # Image
    '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp', '.ico', '.bmp', '.avif', '.apng',
    # Video
    '.amv', '.asf', '.wmv', '.avi', '.f4v', '.flv', '.gifv', '.m4v', '.mp4', '.mkv', '.webm', '.mov', '.qt',
    '.mpeg', '.ogv', '.3gp', '.3g2',
}


def _is_cf_waf_block(err: BaseException) -> bool:
    """判定异常是否为 Notion API 前置 Cloudflare WAF 的内容拦截 (HTML 错误页 403)。

    ``_request_with_retry`` 对非 200/201/204 抛 ``Exception("HTTP {method} failed:
    {status} - {body}")``。CF WAF 拦截 multipart body 内容时返回 HTML 错误页
    (含 "have been blocked" / "cf-error"),而 Notion 自身的 403 是 JSON
    (``{"object":"error",...}``) 不含这些标记 —— 用这个区分,只对前者走 zip fallback。
    """
    text = str(err).lower()
    if "403" not in text:
        return False
    return "have been blocked" in text or "cf-error" in text


async def resolve_data_source_id(client: AsyncClient, database_id: str) -> str:
    """database_id → data_source_id 解析单源（无缓存；缓存由调用方按需加）。

    顺序：显式配置（``EMAIL_DATA_SOURCE_ID`` / ``CALENDAR_DATA_SOURCE_ID``，OAuth
    授权时按用户选中的 data source 写入）优先；没配才 ``databases.retrieve`` 取
    ``data_sources[0]``（存量单 data source 库的老行为）。

    一个 database 含多个 data source 时盲取第一个会写错数据源 —— ``src/`` 下所有
    解析点都走这里，别再各自手写 ``data_sources[0]``（task 08-20 Lane 5；
    ``scripts/dev`` 与 ``scripts/archive`` 的一次性脚本有意未收编）。
    """
    explicit = configured_data_source_id(database_id)
    if explicit:
        return explicit
    db = await client.databases.retrieve(database_id=database_id)
    data_sources = db.get("data_sources", [])
    if not data_sources:
        raise ValueError(f"No data sources found for database {database_id}")
    return data_sources[0]["id"]


class NotionClient:
    """Notion API 客户端封装。

    PR-3 CLI integration: 接受可选 ``token`` / ``email_db_id`` 让
    CLI ``--api-key`` / ``--config`` 真正生效 (不再被全局 ``config`` 旁路).
    向后兼容: 缺省时回退到全局 ``config.notion_token`` / ``config.email_database_id``,
    与 PR-1/PR-2 callers (NotionSync, scripts/*, webhook handlers) 一致。
    """

    # Rate limiting settings
    MAX_RETRIES = 5
    BASE_RETRY_DELAY = 1.0  # seconds

    def __init__(
        self,
        *,
        token: Optional[str] = None,
        email_db_id: Optional[str] = None,
    ):
        self.client = AsyncClient(auth=token or config.notion_token)
        self.email_db_id = email_db_id or config.email_database_id
        self._http_session: Optional["aiohttp.ClientSession"] = None
        self._ds_id_cache: Dict[str, str] = {}

    async def get_data_source_id(self, database_id: str) -> str:
        """从 database_id 解析 data_source_id（带缓存）

        Notion API 2025-09-03 版本要求使用 data_source_id 替代 database_id
        进行查询和页面创建操作。解析规则单源 ``resolve_data_source_id``
        （显式配置优先，其次 data_sources[0]）。

        Args:
            database_id: Notion 数据库 ID

        Returns:
            对应的 data_source_id
        """
        if database_id not in self._ds_id_cache:
            self._ds_id_cache[database_id] = await resolve_data_source_id(self.client, database_id)
            logger.debug(f"Resolved data_source_id: {database_id} -> {self._ds_id_cache[database_id]}")
        return self._ds_id_cache[database_id]

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
            ds_id = await self.get_data_source_id(self.email_db_id)
            page_data = {
                "parent": {"data_source_id": ds_id},
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
            ds_id = await self.get_data_source_id(self.email_db_id)
            query_params = {"data_source_id": ds_id}

            if filter_conditions:
                query_params["filter"] = filter_conditions

            if sorts:
                query_params["sorts"] = sorts

            results = await self.client.data_sources.query(**query_params)
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

        对于不支持的扩展名，使用 "伪装 PDF" 技巧绕过 API 限制：
        - Step 1: 声明文件名为 xxx.pdf（绕过扩展名检查）
        - Step 2: 实际上传时使用原始文件名（保持真实扩展名）
        - 最终在 Notion 中显示原始文件名，下载后无需改后缀

        CF-WAF fallback: Notion API 前置 Cloudflare WAF 会按 multipart body 内容拦截
        (真实报表 HTML 稳定 403，改名/改 content-type 躲不过)。命中 WAF 拦截时把原文件
        zip 打包后 (``.zip`` 受支持) 重传一次，zip 内保留原文件名。

        Args:
            file_path: 文件路径

        Returns:
            file_upload_id: 可用于附加到page properties的文件ID
        """
        try:
            from pathlib import Path

            file = Path(file_path)

            if not file.exists():
                raise FileNotFoundError(f"File not found: {file_path}")

            # 检查文件大小（最大20MB）
            file_size = file.stat().st_size
            if file_size > 20 * 1024 * 1024:
                raise ValueError(f"File too large: {file_size} bytes (max 20MB)")

            file_content = file.read_bytes()

            try:
                return await self._upload_bytes(file_content, file.name)
            except Exception as e:
                if not _is_cf_waf_block(e):
                    raise
                # CF WAF 拦截了原始内容 → zip 打包重传一次 (zip 内保留原文件名)。
                import io
                import zipfile

                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                    zf.writestr(file.name, file_content)
                zip_content = buf.getvalue()

                logger.info(
                    f"Notion upload blocked by Cloudflare WAF for {file.name!r} "
                    f"({file_size}B); retrying as zip ({len(zip_content)}B)"
                )
                return await self._upload_bytes(zip_content, f"{file.name}.zip")

        except Exception as e:
            logger.error(f"Failed to upload file to Notion: {e}")
            raise

    async def _upload_bytes(self, content: bytes, filename: str) -> str:
        """三步上传给定字节内容到 Notion (不读磁盘)。

        ``filename`` 决定 Step 1 声明名与扩展名门控：不支持的扩展名走「伪装 PDF」
        (Step 1 声明 .pdf 绕过检查，Step 2 用真实名保留扩展名)。``upload_file``
        与其 CF-WAF zip fallback 共用本方法 —— zip 路径复核 20MB 上限也走这里。

        Returns:
            file_upload_id: 可用于附加到 page properties 的文件 ID
        """
        from pathlib import Path
        import mimetypes
        import aiohttp

        # 复核大小（20MB）—— zip fallback 后的 zip 字节也在这里再校验一次
        if len(content) > 20 * 1024 * 1024:
            raise ValueError(f"File too large: {len(content)} bytes (max 20MB)")

        # 检查扩展名是否被 Notion 支持
        file_ext = Path(filename).suffix.lower()
        is_supported = file_ext in NOTION_SUPPORTED_EXTENSIONS

        # Step 1 使用的文件名 + content type（不支持的扩展名伪装为 .pdf）
        if is_supported:
            step1_filename = filename
            content_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
        else:
            step1_filename = Path(filename).stem + '.pdf'
            content_type = 'application/pdf'
            logger.debug(f"Unsupported extension '{file_ext}', using fake filename for Step 1: {step1_filename}")

        # Step 1: Create file upload object
        logger.debug(f"Creating file upload for: {filename}")

        notion_headers = {
            "Authorization": f"Bearer {config.notion_token}",
            "Notion-Version": "2025-09-03",
            "Content-Type": "application/json"
        }

        session = await self._get_http_session()

        upload_obj = await self._request_with_retry(
            session, "POST",
            "https://api.notion.com/v1/file_uploads",
            headers=notion_headers,
            json={"filename": step1_filename}  # 可能是伪装的 .pdf 文件名
        )
        upload_url = upload_obj["upload_url"]
        file_upload_id = upload_obj["id"]

        logger.debug(f"Created file upload: {file_upload_id}")

        # Step 2: Send file content（始终用真实文件名保留扩展名）
        logger.debug("Uploading file content to upload_url...")

        send_headers = {
            "Authorization": f"Bearer {config.notion_token}",
            "Notion-Version": "2022-06-28"
        }

        form_data = aiohttp.FormData()
        form_data.add_field('file',
                            content,
                            filename=filename,
                            content_type=content_type)

        await self._request_with_retry(
            session, "POST",
            upload_url,
            headers=send_headers,
            data=form_data,
            expect_json=False
        )

        logger.debug(f"File uploaded successfully: {filename}" +
                    (" (used PDF disguise)" if not is_supported else ""))

        # Step 3: 返回file_upload_id，将在create_page时使用
        return file_upload_id

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
        Execute HTTP request with exponential backoff retry.

        Handles:
        - 429 Rate Limit errors
        - Network errors (connection timeout, DNS failure, etc.)
        - 5xx Server errors

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
        import aiohttp

        last_exception = None

        for attempt in range(self.MAX_RETRIES):
            try:
                async with session.request(
                    method, url,
                    headers=headers,
                    json=json,
                    data=data,
                    timeout=aiohttp.ClientTimeout(total=120)  # 2分钟超时
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

                    if resp.status >= 500:
                        # Server error - retry with backoff
                        delay = self.BASE_RETRY_DELAY * (2 ** attempt)
                        logger.warning(
                            f"Notion API server error {resp.status} (attempt {attempt + 1}/{self.MAX_RETRIES}), "
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
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                # Network errors - retry with backoff
                last_exception = e
                delay = self.BASE_RETRY_DELAY * (2 ** attempt)
                logger.warning(
                    f"Network error: {type(e).__name__}: {e} (attempt {attempt + 1}/{self.MAX_RETRIES}), "
                    f"retrying in {delay:.1f}s"
                )
                await asyncio.sleep(delay)
                continue
            except Exception as e:
                last_exception = e
                if "429" in str(e) or "rate" in str(e).lower():
                    # Rate limit error in exception - retry
                    delay = self.BASE_RETRY_DELAY * (2 ** attempt)
                    await asyncio.sleep(delay)
                    continue
                # Non-retryable error
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
