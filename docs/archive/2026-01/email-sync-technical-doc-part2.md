> ⚠️ **已归档存史（2026-01 原始技术文档）**：架构已历经 v3/Sprint15/Sprint16/v4 多轮演进，本文仅存历史。当前总览见 `ARCHITECTURE.md`，深度见 `docs/reference/architecture/`。

# Email to Notion 实时同步脚本 - 技术文档（第二部分）

## 📄 接上文

本文档是《Email to Notion 实时同步脚本 - 技术文档》的第二部分，包含：
- HTML 转 Notion Blocks 转换器
- Notion API 客户端封装
- Notion 同步逻辑
- 主程序入口
- 测试和部署

---

## 6. HTML 转 Notion Blocks 转换器 (src/converter/html_converter.py)

```python
from typing import List, Dict, Any
from bs4 import BeautifulSoup
import html2text
from loguru import logger

class HTMLToNotionConverter:
    """HTML 转 Notion Blocks 转换器"""
    
    def __init__(self):
        self.html2text = html2text.HTML2Text()
        self.html2text.ignore_links = False
        self.html2text.body_width = 0  # 不换行
    
    def convert(self, html_content: str) -> List[Dict[str, Any]]:
        """
        转换 HTML 为 Notion Blocks
        
        Args:
            html_content: HTML 内容
            
        Returns:
            Notion Blocks 列表
        """
        try:
            # 如果是纯文本，直接返回段落
            if not self._is_html(html_content):
                return self._text_to_blocks(html_content)
            
            # 解析 HTML
            soup = BeautifulSoup(html_content, "lxml")
            
            # 移除 script 和 style 标签
            for tag in soup(["script", "style"]):
                tag.decompose()
            
            # 提取 body 内容（如果有）
            body = soup.find("body")
            if body:
                soup = body
            
            # 转换为 Notion Blocks
            blocks = self._convert_element(soup)
            
            # 如果没有生成任何 block，使用 html2text 降级处理
            if not blocks:
                text = self.html2text.handle(html_content)
                blocks = self._text_to_blocks(text)
            
            # 限制 block 数量（Notion API 限制）
            if len(blocks) > 100:
                logger.warning(f"Too many blocks ({len(blocks)}), truncating to 100")
                blocks = blocks[:99]
                blocks.append(self._create_paragraph("... (内容过长，已截断)"))
            
            return blocks
        
        except Exception as e:
            logger.error(f"Failed to convert HTML to Notion blocks: {e}")
            # 降级：返回纯文本
            text = self.html2text.handle(html_content)
            return self._text_to_blocks(text[:2000])  # 限制长度
    
    def _convert_element(self, element) -> List[Dict[str, Any]]:
        """递归转换 HTML 元素"""
        blocks = []
        
        for child in element.children:
            if isinstance(child, str):
                text = child.strip()
                if text:
                    blocks.append(self._create_paragraph(text))
            
            elif child.name == "p":
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_paragraph(text))
            
            elif child.name in ["h1", "h2", "h3"]:
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_heading(text, int(child.name[1])))
            
            elif child.name == "ul":
                for li in child.find_all("li", recursive=False):
                    text = li.get_text(strip=True)
                    if text:
                        blocks.append(self._create_bulleted_list(text))
            
            elif child.name == "ol":
                for li in child.find_all("li", recursive=False):
                    text = li.get_text(strip=True)
                    if text:
                        blocks.append(self._create_numbered_list(text))
            
            elif child.name == "blockquote":
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_quote(text))
            
            elif child.name == "pre" or child.name == "code":
                text = child.get_text(strip=True)
                if text:
                    blocks.append(self._create_code(text))
            
            elif child.name == "a":
                text = child.get_text(strip=True)
                href = child.get("href", "")
                if text and href:
                    blocks.append(self._create_paragraph(f"{text} ({href})"))
            
            elif child.name == "br":
                continue
            
            elif child.name == "div" or child.name == "span":
                # 递归处理 div 和 span
                blocks.extend(self._convert_element(child))
            
            elif child.name == "table":
                # 表格转换为代码块（简化处理）
                table_text = self._table_to_text(child)
                blocks.append(self._create_code(table_text))
        
        return blocks
    
    def _text_to_blocks(self, text: str) -> List[Dict[str, Any]]:
        """纯文本转 Notion Blocks"""
        blocks = []
        
        # 按段落分割
        paragraphs = text.split("\n\n")
        
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            
            # 限制每个段落的长度
            if len(para) > 2000:
                para = para[:1997] + "..."
            
            blocks.append(self._create_paragraph(para))
        
        return blocks
    
    @staticmethod
    def _create_paragraph(text: str) -> Dict[str, Any]:
        """创建段落 Block"""
        return {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
            }
        }
    
    @staticmethod
    def _create_heading(text: str, level: int) -> Dict[str, Any]:
        """创建标题 Block"""
        heading_type = f"heading_{min(level, 3)}"
        return {
            "object": "block",
            "type": heading_type,
            heading_type: {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
            }
        }
    
    @staticmethod
    def _create_bulleted_list(text: str) -> Dict[str, Any]:
        """创建无序列表 Block"""
        return {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
            }
        }
    
    @staticmethod
    def _create_numbered_list(text: str) -> Dict[str, Any]:
        """创建有序列表 Block"""
        return {
            "object": "block",
            "type": "numbered_list_item",
            "numbered_list_item": {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
            }
        }
    
    @staticmethod
    def _create_quote(text: str) -> Dict[str, Any]:
        """创建引用 Block"""
        return {
            "object": "block",
            "type": "quote",
            "quote": {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
            }
        }
    
    @staticmethod
    def _create_code(text: str) -> Dict[str, Any]:
        """创建代码 Block"""
        return {
            "object": "block",
            "type": "code",
            "code": {
                "rich_text": [{"type": "text", "text": {"content": text[:2000]}}],
                "language": "plain text"
            }
        }
    
    @staticmethod
    def _is_html(content: str) -> bool:
        """判断是否是 HTML"""
        return "<html" in content.lower() or "<body" in content.lower() or "<div" in content.lower()
    
    @staticmethod
    def _table_to_text(table_element) -> str:
        """表格转文本（简化显示）"""
        lines = []
        rows = table_element.find_all("tr")
        
        for row in rows:
            cells = row.find_all(["td", "th"])
            line = " | ".join(cell.get_text(strip=True) for cell in cells)
            lines.append(line)
        
        return "\n".join(lines)
```

---

## 7. .eml 生成器 (src/converter/eml_generator.py)

```python
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from datetime import datetime
from typing import Optional

from loguru import logger
from src.models import Email

class EMLGenerator:
    """生成 .eml 文件"""
    
    @staticmethod
    def generate(email: Email, output_path: Optional[Path] = None) -> Path:
        """
        生成 .eml 文件
        
        Args:
            email: Email 对象
            output_path: 输出路径，如果为 None 则自动生成
            
        Returns:
            生成的 .eml 文件路径
        """
        try:
            # 创建 MIME 邮件
            msg = MIMEMultipart()
            msg["Subject"] = email.subject
            msg["From"] = f"{email.sender_name} <{email.sender}>"
            msg["To"] = email.to
            if email.cc:
                msg["Cc"] = email.cc
            msg["Date"] = email.date.strftime("%a, %d %b %Y %H:%M:%S %z")
            msg["Message-ID"] = email.message_id
            
            # 添加邮件正文
            if email.content_type == "text/html":
                msg.attach(MIMEText(email.content, "html", "utf-8"))
            else:
                msg.attach(MIMEText(email.content, "plain", "utf-8"))
            
            # 添加附件
            for attachment in email.attachments:
                try:
                    with open(attachment.path, "rb") as f:
                        part = MIMEBase("application", "octet-stream")
                        part.set_payload(f.read())
                        encoders.encode_base64(part)
                        part.add_header(
                            "Content-Disposition",
                            f"attachment; filename={attachment.filename}"
                        )
                        msg.attach(part)
                except Exception as e:
                    logger.error(f"Failed to attach file {attachment.filename}: {e}")
            
            # 确定输出路径
            if output_path is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                safe_subject = "".join(c for c in email.subject if c.isalnum() or c in (" ", "-", "_"))[:50]
                filename = f"{timestamp}_{safe_subject}.eml"
                output_path = Path("/tmp") / filename
            
            # 写入文件
            with open(output_path, "w") as f:
                f.write(msg.as_string())
            
            logger.debug(f"Generated .eml file: {output_path}")
            return output_path
        
        except Exception as e:
            logger.error(f"Failed to generate .eml file: {e}")
            raise
```

---

## 8. Notion API 客户端 (src/notion/client.py)

```python
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
    
    async def upload_file(self, file_path: str) -> Dict[str, Any]:
        """
        上传文件到 Notion
        使用 Notion 的文件上传 API
        
        Args:
            file_path: 文件路径
            
        Returns:
            文件信息，包含 file 对象
        """
        try:
            from pathlib import Path
            
            file = Path(file_path)
            
            if not file.exists():
                raise FileNotFoundError(f"File not found: {file_path}")
            
            # 读取文件
            with open(file, 'rb') as f:
                file_content = f.read()
            
            # 调用 Notion 文件上传 API
            # https://developers.notion.com/reference/file-upload
            response = await self.client.files.upload(
                file=file_content,
                file_name=file.name
            )
            
            logger.debug(f"Uploaded file to Notion: {file.name}")
            return response
        
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
```

---

## 9. Notion 同步器 (src/notion/sync.py)

```python
from typing import Dict, Any, List
from pathlib import Path
from loguru import logger

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
            
            # 2. 上传附件（如果有）
            uploaded_files = []
            if email.attachments:
                for attachment in email.attachments:
                    try:
                        file_info = await self.client.upload_file(attachment.path)
                        uploaded_files.append({
                            "name": attachment.filename,
                            "file": file_info
                        })
                        logger.debug(f"Uploaded attachment: {attachment.filename}")
                    except Exception as e:
                        logger.error(f"Failed to upload attachment {attachment.filename}: {e}")
            
            # 3. 生成并上传 .eml 文件
            eml_file = None
            try:
                eml_path = self.eml_generator.generate(email)
                eml_file = await self.client.upload_file(str(eml_path))
                logger.debug(f"Uploaded .eml file: {eml_path.name}")
            except Exception as e:
                logger.error(f"Failed to upload .eml file: {e}")
            
            # 4. 构建 Properties
            properties = self._build_properties(email, eml_file)
            
            # 5. 转换邮件内容为 Notion Blocks
            children = self._build_children(email, uploaded_files)
            
            # 6. 创建 Page
            await self.client.create_page(properties=properties, children=children)
            
            logger.info(f"✅ Email synced successfully: {email.subject}")
            return True
        
        except Exception as e:
            logger.error(f"Failed to sync email: {e}")
            return False
    
    def _build_properties(self, email: Email, eml_file: Dict = None) -> Dict[str, Any]:
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
                "rich_text": [{"text": {"content": email.sender_name or ""}}]
            },
            
            # To (Text)
            "To": {
                "rich_text": [{"text": {"content": email.to[:2000]}}]
            } if email.to else {"rich_text": []},
            
            # CC (Text)
            "CC": {
                "rich_text": [{"text": {"content": email.cc[:2000]}}]
            } if email.cc else {"rich_text": []},
            
            # Date
            "Date": {
                "date": {"start": email.date.isoformat()}
            },
            
            # Message ID (Text)
            "Message ID": {
                "rich_text": [{"text": {"content": email.message_id}}]
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
                "rich_text": [{"text": {"content": email.thread_id}}]
            }
        
        # Original EML (Files & media) - 上传的 .eml 文件
        if eml_file:
            properties["Original EML"] = {
                "files": [eml_file]
            }
        
        return properties
    
    def _build_children(self, email: Email, uploaded_files: List[Dict] = None) -> List[Dict[str, Any]]:
        """构建 Notion Page Children (Content Blocks)"""
        children = []
        
        # 1. 邮件内容区域标题
        children.append({
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"text": {"content": "📧 邮件内容"}}]
            }
        })
        
        # 2. 转换邮件正文
        try:
            content_blocks = self.html_converter.convert(email.content)
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
        
        # 3. 附件区域
        if uploaded_files:
            children.append({
                "object": "block",
                "type": "divider",
                "divider": {}
            })
            children.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{"text": {"content": "📎 附件"}}]
                }
            })
            
            for file_info in uploaded_files:
                # 添加文件块
                children.append({
                    "object": "block",
                    "type": "file",
                    "file": file_info["file"]
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
        
        # 限制 children 数量（Notion API 限制单次请求最多 100 个 blocks）
        if len(children) > 100:
            logger.warning(f"Too many children blocks ({len(children)}), truncating to 100")
            children = children[:100]
        
        return children
```

---

## 10. 主程序入口 (main.py)

```python
import asyncio
import sys
from pathlib import Path

from loguru import logger
from src.config import config
from src.mail.watcher import MailWatcher
from src.notion.sync import NotionSync
from src.utils.logger import setup_logger

# 设置日志
setup_logger(config.log_level, config.log_file)

class EmailNotionSyncApp:
    """邮件同步应用主类"""
    
    def __init__(self):
        self.notion_sync = NotionSync()
        self.watcher = MailWatcher(on_new_email_callback=self.handle_new_email)
    
    async def handle_new_email(self, email):
        """
        处理新邮件的回调函数
        
        Args:
            email: Email 对象
        """
        logger.info(f"📬 New email received: {email.subject}")
        
        try:
            # 同步到 Notion
            success = await self.notion_sync.sync_email(email)
            
            if success:
                logger.info(f"✅ Successfully synced: {email.subject}")
            else:
                logger.error(f"❌ Failed to sync: {email.subject}")
        
        except Exception as e:
            logger.error(f"Error handling email: {e}")
    
    async def start(self):
        """启动应用"""
        logger.info("=" * 60)
        logger.info("Email to Notion Sync Service")
        logger.info("=" * 60)
        logger.info(f"User: {config.user_email}")
        logger.info(f"Check interval: {config.check_interval} seconds")
        logger.info(f"Log level: {config.log_level}")
        logger.info("=" * 60)
        
        try:
            # 启动邮件监听器
            await self.watcher.start()
        
        except KeyboardInterrupt:
            logger.info("Shutting down gracefully...")
        except Exception as e:
            logger.error(f"Fatal error: {e}")
            sys.exit(1)

async def main():
    """主函数"""
    app = EmailNotionSyncApp()
    await app.start()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## 11. 日志配置 (src/utils/logger.py)

```python
import sys
from pathlib import Path
from loguru import logger

def setup_logger(log_level: str = "INFO", log_file: str = "logs/sync.log"):
    """
    配置日志
    
    Args:
        log_level: 日志级别
        log_file: 日志文件路径
    """
    # 移除默认处理器
    logger.remove()
    
    # 添加控制台输出（带颜色）
    logger.add(
        sys.stdout,
        level=log_level,
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
        colorize=True
    )
    
    # 添加文件输出
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    
    logger.add(
        log_file,
        level=log_level,
        format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message}",
        rotation="10 MB",  # 文件大小超过 10MB 时轮转
        retention="7 days",  # 保留 7 天
        compression="zip"  # 压缩旧日志
    )
    
    logger.info(f"Logger initialized - Level: {log_level}")
```

---

## 🧪 测试脚本

### 测试 1: 测试邮件读取 (scripts/test_mail_reader.py)

```python
import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.reader import EmailReader
from src.utils.logger import setup_logger

def main():
    """测试邮件读取"""
    setup_logger("DEBUG")
    
    reader = EmailReader()
    
    print("=" * 60)
    print("Testing Mail Reader")
    print("=" * 60)
    
    # 获取未读邮件
    emails = reader.get_unread_emails(limit=5)
    
    print(f"\n找到 {len(emails)} 封未读邮件:\n")
    
    for i, email in enumerate(emails, 1):
        print(f"{i}. {email.subject}")
        print(f"   发件人: {email.sender_name} <{email.sender}>")
        print(f"   日期: {email.date}")
        print(f"   Message ID: {email.message_id}")
        print(f"   内容长度: {len(email.content)} 字符")
        print(f"   附件数: {len(email.attachments)}")
        print(f"   已读: {email.is_read}")
        print(f"   已标记: {email.is_flagged}")
        print()

if __name__ == "__main__":
    main()
```

### 测试 2: 测试 Notion API (scripts/test_notion_api.py)

```python
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.notion.client import NotionClient
from src.config import config
from src.utils.logger import setup_logger

async def main():
    """测试 Notion API 连接"""
    setup_logger("DEBUG")
    
    client = NotionClient()
    
    print("=" * 60)
    print("Testing Notion API")
    print("=" * 60)
    print(f"Token: {config.notion_token[:20]}...")
    print(f"Database ID: {config.email_database_id}")
    print()
    
    # 测试查询数据库
    print("查询数据库...")
    results = await client.query_database()
    print(f"✅ 成功！找到 {len(results)} 个 Pages")
    
    # 测试检查邮件是否存在
    print("\n测试检查邮件是否存在...")
    exists = await client.check_page_exists("test-message-id-12345")
    print(f"✅ 成功！邮件存在: {exists}")
    
    print("\n" + "=" * 60)
    print("所有测试通过！")

if __name__ == "__main__":
    asyncio.run(main())
```

### 测试 3: 手动同步单封邮件 (scripts/manual_sync.py)

```python
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.mail.reader import EmailReader
from src.notion.sync import NotionSync
from src.utils.logger import setup_logger

async def main():
    """手动同步邮件"""
    setup_logger("DEBUG")
    
    reader = EmailReader()
    sync = NotionSync()
    
    print("=" * 60)
    print("Manual Email Sync")
    print("=" * 60)
    
    # 获取未读邮件
    emails = reader.get_unread_emails(limit=5)
    
    if not emails:
        print("没有未读邮件")
        return
    
    print(f"\n找到 {len(emails)} 封未读邮件:\n")
    
    for i, email in enumerate(emails, 1):
        print(f"{i}. {email.subject}")
        print(f"   发件人: {email.sender_name}")
    
    # 选择邮件
    choice = input("\n请选择要同步的邮件编号（输入 0 同步全部）: ")
    
    try:
        choice = int(choice)
        
        if choice == 0:
            # 同步全部
            for email in emails:
                print(f"\n正在同步: {email.subject}")
                await sync.sync_email(email)
        
        elif 1 <= choice <= len(emails):
            # 同步选中的
            email = emails[choice - 1]
            print(f"\n正在同步: {email.subject}")
            await sync.sync_email(email)
        
        else:
            print("无效的选择")
    
    except ValueError:
        print("请输入数字")

if __name__ == "__main__":
    asyncio.run(main())
```

---

## 🚀 部署指南

### 1. 初始化项目

```bash
# 克隆或创建项目
mkdir email-notion-sync
cd email-notion-sync

# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 创建必要的目录
mkdir -p logs
mkdir -p /tmp/email-attachments
```

### 2. 配置环境变量

创建 `.env` 文件：

```bash
cat > .env << 'EOF'
# Notion 配置
NOTION_TOKEN=ntn_YOUR_TOKEN_HERE
EMAIL_DATABASE_ID=2df15375830d8094980efd1468ca118c

# 用户配置
USER_EMAIL=lucien.chen@tp-link.com
MAIL_ACCOUNT_NAME=Exchange

# 同步配置
CHECK_INTERVAL=5
MAX_BATCH_SIZE=10

# 日志配置
LOG_LEVEL=INFO
LOG_FILE=logs/sync.log

# 附件配置
MAX_ATTACHMENT_SIZE=10485760
EOF
```

✅ **Database ID 已配置**: `2df15375830d8094980efd1468ca118c`

✅ **Database ID 已配置**: `2df15375830d8094980efd1468ca118c`

你可以直接跳过获取 Database ID 的步骤。

### 4. 测试各个组件

```bash
# 测试邮件读取
python3 scripts/test_mail_reader.py

# 测试 Notion API
python3 scripts/test_notion_api.py

# 手动同步单封邮件
python3 scripts/manual_sync.py
```

### 5. 启动服务

```bash
# 前台运行（用于测试）
python3 main.py

# 后台运行
nohup python3 main.py > logs/app.log 2>&1 &

# 查看日志
tail -f logs/sync.log
```

### 6. 配置为系统服务（推荐）

创建 LaunchAgent 配置：

```bash
cat > ~/Library/LaunchAgents/com.lucien.email-notion-sync.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lucien.email-notion-sync</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/venv/bin/python3</string>
        <string>/path/to/email-notion-sync/main.py</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>/path/to/email-notion-sync/logs/app.log</string>
    
    <key>StandardErrorPath</key>
    <string>/path/to/email-notion-sync/logs/error.log</string>
    
    <key>WorkingDirectory</key>
    <string>/path/to/email-notion-sync</string>
</dict>
</plist>
EOF

# 加载服务
launchctl load ~/Library/LaunchAgents/com.lucien.email-notion-sync.plist

# 启动服务
launchctl start com.lucien.email-notion-sync

# 查看状态
launchctl list | grep email-notion-sync
```

---

## 📊 Notion Database 字段映射

确保 Notion Database 中的字段名与代码中的一致：

| 代码中的字段名 | Notion 中的字段名 | 类型 |
|--------------|-----------------|------|
| Subject | Subject | Title |
| From | From | Email |
| From Name | From Name | Text |
| To | To | Text |
| CC | CC | Text |
| Date | Date | Date |
| Message ID | Message ID | Text |
| Processing Status | Processing Status | Select |
| Is Read | Is Read | Checkbox |
| Is Flagged | Is Flagged | Checkbox |
| Has Attachments | Has Attachments | Checkbox |
| Thread ID | Thread ID | Text |

**如果字段名不匹配，修改代码中的字段名或在 Notion 中重命名字段。**

---

## ⚡ 性能优化建议

1. **批量同步**: 如果有大量历史邮件需要同步，可以修改 `MAX_BATCH_SIZE`
2. **异步并发**: 可以使用 `asyncio.gather()` 同时处理多封邮件
3. **缓存机制**: 缓存已同步的 Message ID，避免重复查询
4. **限流**: 注意 Notion API 的速率限制（每秒 3 个请求）

---

## 🐛 常见问题

### 1. Notion API 返回 401 Unauthorized
- 检查 `NOTION_TOKEN` 是否正确
- 确认 Integration 已被添加到 Database

### 2. AppleScript 执行失败
- 确保 Mail.app 正在运行
- 检查 macOS 隐私设置是否允许 Terminal 控制 Mail.app

### 3. 邮件内容转换失败
- 检查日志中的具体错误
- 复杂的 HTML 邮件可能需要调整转换逻辑

### 4. 附件上传失败
- Notion API 不直接支持文件上传
- 需要先上传到外部存储（如 S3），然后在 Notion 中引用 URL

---

## 📝 下一步优化

1. **反向同步**: Notion → Mail.app（根据 AI 处理结果更新邮件状态）
2. **附件上传**: 集成 S3/Cloudflare R2 实现真正的附件上传
3. **错误重试**: 添加更完善的错误重试机制
4. **监控告警**: 添加监控和告警功能
5. **Web 界面**: 创建简单的 Web 界面查看同步状态

---

完整的技术文档已完成！你现在可以开始实施了。建议按照以下顺序：

1. ✅ 创建项目结构
2. ✅ 配置环境变量
3. ✅ 运行测试脚本验证各组件
4. ✅ 手动同步几封邮件测试
5. ✅ 启动实时监听服务
6. ✅ 配置为系统服务（可选）

遇到任何问题随时告诉我！🚀
