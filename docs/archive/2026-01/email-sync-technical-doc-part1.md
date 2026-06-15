> ⚠️ **已归档存史（2026-01 原始技术文档）**：架构已历经 v3/Sprint15/Sprint16/v4 多轮演进，本文仅存历史。当前总览见 `ARCHITECTURE.md`，深度见 `docs/reference/architecture/`。

# Email to Notion 实时同步脚本 - 技术文档

## 📋 项目概述

### 目标
开发一个 Python 后台服务，实时监听 macOS Mail.app 的新邮件，并自动同步到 Notion Email Inbox Database，触发 AI Agent 自动处理。

### 核心功能
1. **实时监听**：监听 Mail.app 新邮件到达事件
2. **邮件读取**：读取邮件完整内容（主题、正文、附件）
3. **格式转换**：将邮件内容转换为 Notion Blocks 格式
4. **同步到 Notion**：通过 Notion API 创建 Page
5. **附件处理**：上传附件和原始 .eml 文件
6. **去重机制**：避免重复同步同一封邮件

---

## 🛠️ 技术栈选型

### 核心技术栈

| 组件 | 技术选型 | 版本 | 选择理由 |
|------|---------|------|---------|
| **编程语言** | Python | 3.11+ | 异步支持好、库丰富、开发快速 |
| **Notion API** | notion-client | 2.2.1 | 官方 Python SDK，异步支持 |
| **Mail.app 交互** | AppleScript + subprocess | 内置 | macOS 原生支持 |
| **HTML 解析** | BeautifulSoup4 | 4.12+ | 强大的 HTML 解析能力 |
| **邮件解析** | email (内置) | - | Python 标准库，解析 .eml |
| **异步框架** | asyncio | 内置 | 高并发处理 |
| **文件监听** | watchdog | 3.0+ | 监听 Mail.app 数据目录变化 |
| **日志** | loguru | 0.7+ | 美观的日志输出 |
| **配置管理** | pydantic-settings | 2.0+ | 类型安全的配置管理 |

### 可选增强库

| 库名 | 用途 | 是否必需 |
|------|------|---------|
| **html2text** | HTML 转纯文本 | 推荐 |
| **Pillow** | 图片处理（压缩、格式转换） | 推荐 |
| **python-magic** | 文件类型检测 | 可选 |
| **aiofiles** | 异步文件操作 | 推荐 |

---

## 🏗️ 架构设计

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Mail.app (Exchange)                      │
│                 lucien.chen@tp-link.com                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ 新邮件到达
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  Email Monitor Service                       │
│  ┌────────────────────────────────────────────────────┐    │
│  │  MailWatcher                                        │    │
│  │  - 监听 Mail.app 新邮件事件                          │    │
│  │  - 检测间隔：5 秒（可配置）                          │    │
│  └────────────────────────┬───────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │  EmailReader                                        │    │
│  │  - 通过 AppleScript 读取邮件                         │    │
│  │  - 提取主题、发件人、内容、附件                       │    │
│  └────────────────────────┬───────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │  EmailConverter                                     │    │
│  │  - HTML → Notion Blocks                             │    │
│  │  - 处理图片、附件                                    │    │
│  │  - 生成 .eml 备份                                    │    │
│  └────────────────────────┬───────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│  ┌────────────────────────────────────────────────────┐    │
│  │  NotionSync                                         │    │
│  │  - 检查是否已同步（基于 Message ID）                 │    │
│  │  - 创建 Notion Page                                 │    │
│  │  - 上传附件                                          │    │
│  └────────────────────────┬───────────────────────────┘    │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Notion API                                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Email Inbox Database                                 │  │
│  │  - 新建 Page                                          │  │
│  │  - Status = "未处理"                                  │  │
│  └────────────────────────┬─────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           │ Trigger: New Page Created
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Notion AI Agent (自动触发)                      │
│  - 分类（Priority, Category, Language）                     │
│  - 分析（Summary, Key Points）                              │
│  - 生成回复建议（Reply Suggestion）                          │
│  - 更新 Status = "已完成"                                    │
└─────────────────────────────────────────────────────────────┘
```

### 核心类设计

```python
# 1. 配置管理
class Config(BaseSettings):
    """配置类"""
    notion_token: str
    email_database_id: str
    user_email: str
    check_interval: int = 5  # 检查间隔（秒）
    
# 2. 邮件数据模型
@dataclass
class Email:
    """邮件数据模型"""
    message_id: str
    subject: str
    sender: str
    sender_name: str
    to: str
    cc: str
    date: datetime
    content: str  # HTML 或纯文本
    is_read: bool
    is_flagged: bool
    attachments: List[Attachment]
    
# 3. 监听器
class MailWatcher:
    """监听新邮件"""
    async def watch(self):
        """持续监听新邮件"""
        
# 4. 邮件读取器
class EmailReader:
    """读取邮件内容"""
    def get_unread_emails(self) -> List[Email]:
        """获取未读邮件"""
        
    def get_email_details(self, message_id: str) -> Email:
        """获取邮件详细内容"""
        
# 5. 格式转换器
class EmailConverter:
    """转换邮件格式"""
    def to_notion_blocks(self, email: Email) -> List[Dict]:
        """转换为 Notion Blocks"""
        
    def save_as_eml(self, email: Email) -> str:
        """保存为 .eml 文件"""
        
# 6. Notion 同步器
class NotionSync:
    """同步到 Notion"""
    async def sync_email(self, email: Email):
        """同步邮件到 Notion"""
        
    async def check_if_synced(self, message_id: str) -> bool:
        """检查邮件是否已同步"""
```

---

## 📦 项目结构

```
email-notion-sync/
├── README.md
├── requirements.txt
├── .env                          # 环境变量配置
├── config.yaml                   # 可选：YAML 配置文件
├── main.py                       # 主入口
├── src/
│   ├── __init__.py
│   ├── config.py                 # 配置管理
│   ├── models.py                 # 数据模型
│   ├── mail/
│   │   ├── __init__.py
│   │   ├── watcher.py           # 邮件监听器
│   │   ├── reader.py            # 邮件读取器
│   │   └── applescript.py       # AppleScript 封装
│   ├── converter/
│   │   ├── __init__.py
│   │   ├── html_converter.py   # HTML 转 Notion Blocks
│   │   ├── attachment_handler.py # 附件处理
│   │   └── eml_generator.py    # .eml 生成器
│   ├── notion/
│   │   ├── __init__.py
│   │   ├── client.py            # Notion API 封装
│   │   ├── sync.py              # 同步逻辑
│   │   └── block_builder.py    # Block 构建器
│   └── utils/
│       ├── __init__.py
│       ├── logger.py            # 日志配置
│       └── helpers.py           # 辅助函数
├── scripts/
│   ├── test_mail_reader.py     # 测试邮件读取
│   ├── test_notion_api.py      # 测试 Notion API
│   └── manual_sync.py          # 手动同步脚本
└── logs/
    └── sync.log                 # 日志文件
```

---

## 🔧 环境配置

### 1. 创建 .env 文件

```bash
# .env

# Notion 配置
NOTION_TOKEN=ntn_YOUR_TOKEN_HERE
EMAIL_DATABASE_ID=2df15375830d8094980efd1468ca118c

# 用户配置
USER_EMAIL=lucien.chen@tp-link.com
MAIL_ACCOUNT_NAME=Exchange

# 同步配置
CHECK_INTERVAL=5  # 检查新邮件的间隔（秒）
MAX_BATCH_SIZE=10  # 每次最多同步的邮件数

# 日志配置
LOG_LEVEL=INFO
LOG_FILE=logs/sync.log

# 附件配置
MAX_ATTACHMENT_SIZE=10485760  # 10MB
ALLOWED_ATTACHMENT_TYPES=.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx
```

### 2. 获取 Notion Database ID

✅ **已提供**: `2df15375830d8094980efd1468ca118c`

你的 Email Inbox Database ID 已经配置好，可以直接使用。

如果将来需要获取其他 Database 的 ID，可以：

**方法 1**: 从 URL 获取
```
https://www.notion.so/{workspace}/{database_id}?v=...
                                  ^^^^^^^^^^^^^^^^
                                  这是 Database ID
```

**方法 2**: 通过 API 查询
```python
import asyncio
from notion_client import AsyncClient

async def get_databases():
    notion = AsyncClient(auth="ntn_YOUR_TOKEN_HERE")
    results = await notion.search(filter={"property": "object", "value": "database"})
    
    for db in results["results"]:
        title = db.get("title", [{}])[0].get("plain_text", "Untitled")
        print(f"Database: {title}")
        print(f"ID: {db['id']}")
        print("---")

asyncio.run(get_databases())
```

### 3. 安装依赖

```bash
# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate  # macOS/Linux

# 安装依赖
pip install -r requirements.txt
```

**requirements.txt**:
```
# Notion API
notion-client==2.2.1

# HTML 解析
beautifulsoup4==4.12.2
html2text==2020.1.16
lxml==4.9.3

# 配置管理
pydantic==2.5.0
pydantic-settings==2.1.0
python-dotenv==1.0.0

# 日志
loguru==0.7.2

# 异步 IO
aiofiles==23.2.1

# 文件监听（可选）
watchdog==3.0.0

# 图片处理
Pillow==10.1.0

# 类型检查
mypy==1.7.0
```

---

## 💻 核心代码实现

### 1. 配置管理 (src/config.py)

```python
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List

class Config(BaseSettings):
    """配置类"""
    
    # Notion 配置
    notion_token: str = Field(..., env="NOTION_TOKEN")
    email_database_id: str = Field(..., env="EMAIL_DATABASE_ID")
    
    # 用户配置
    user_email: str = Field(..., env="USER_EMAIL")
    mail_account_name: str = Field(default="Exchange", env="MAIL_ACCOUNT_NAME")
    
    # 同步配置
    check_interval: int = Field(default=5, env="CHECK_INTERVAL")
    max_batch_size: int = Field(default=10, env="MAX_BATCH_SIZE")
    
    # 日志配置
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    log_file: str = Field(default="logs/sync.log", env="LOG_FILE")
    
    # 附件配置
    max_attachment_size: int = Field(default=10485760, env="MAX_ATTACHMENT_SIZE")  # 10MB
    allowed_attachment_types: List[str] = Field(
        default=[".pdf", ".png", ".jpg", ".jpeg", ".docx", ".xlsx", ".pptx"],
        env="ALLOWED_ATTACHMENT_TYPES"
    )
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

# 全局配置实例
config = Config()
```

### 2. 数据模型 (src/models.py)

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

@dataclass
class Attachment:
    """附件数据模型"""
    filename: str
    content_type: str
    size: int
    path: str  # 临时文件路径
    
@dataclass
class Email:
    """邮件数据模型"""
    message_id: str
    subject: str
    sender: str
    sender_name: Optional[str] = None
    to: str = ""
    cc: str = ""
    date: datetime = field(default_factory=datetime.now)
    content: str = ""  # HTML 或纯文本
    content_type: str = "text/plain"  # text/plain 或 text/html
    is_read: bool = False
    is_flagged: bool = False
    has_attachments: bool = False
    attachments: List[Attachment] = field(default_factory=list)
    thread_id: Optional[str] = None
    
    def __post_init__(self):
        """验证数据"""
        if not self.message_id:
            raise ValueError("message_id is required")
        if not self.subject:
            self.subject = "(No Subject)"
        if not self.sender_name:
            self.sender_name = self.sender.split("@")[0]
        self.has_attachments = len(self.attachments) > 0
```

### 3. AppleScript 封装 (src/mail/applescript.py)

```python
import subprocess
from typing import List, Dict, Any
from loguru import logger

class AppleScriptExecutor:
    """AppleScript 执行器"""
    
    @staticmethod
    def execute(script: str) -> str:
        """执行 AppleScript"""
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                logger.error(f"AppleScript error: {result.stderr}")
                raise RuntimeError(f"AppleScript failed: {result.stderr}")
            
            return result.stdout.strip()
        
        except subprocess.TimeoutExpired:
            logger.error("AppleScript execution timed out")
            raise
        except Exception as e:
            logger.error(f"AppleScript execution failed: {e}")
            raise

class MailAppScripts:
    """Mail.app 相关的 AppleScript 脚本"""
    
    @staticmethod
    def get_unread_count(account: str = "Exchange") -> int:
        """获取未读邮件数量"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "INBOX"
                    return count of (messages whose read status is false)
                end tell
            end tell
        end tell
        '''
        result = AppleScriptExecutor.execute(script)
        return int(result) if result.isdigit() else 0
    
    @staticmethod
    def get_unread_message_ids(account: str = "Exchange", limit: int = 10) -> List[str]:
        """获取未读邮件的 Message ID 列表"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "INBOX"
                    set unreadMessages to (messages whose read status is false)
                    set messageIds to {{}}
                    
                    repeat with i from 1 to (count of unreadMessages)
                        if i > {limit} then exit repeat
                        set theMessage to item i of unreadMessages
                        set messageId to message id of theMessage
                        set end of messageIds to messageId
                    end repeat
                    
                    return messageIds
                end tell
            end tell
        end tell
        '''
        result = AppleScriptExecutor.execute(script)
        if not result:
            return []
        
        # AppleScript 返回的是逗号分隔的字符串
        return [mid.strip() for mid in result.split(",") if mid.strip()]
    
    @staticmethod
    def get_email_details(message_id: str, account: str = "Exchange") -> Dict[str, Any]:
        """获取邮件详细信息"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "INBOX"
                    set theMessage to first message whose message id is "{message_id}"
                    
                    set messageSubject to subject of theMessage
                    set messageSender to sender of theMessage
                    set messageDate to date received of theMessage
                    set messageContent to content of theMessage
                    set isRead to read status of theMessage
                    set isFlagged to flagged status of theMessage
                    set recipientTo to ""
                    set recipientCC to ""
                    
                    -- 获取收件人
                    try
                        set toRecipients to to recipients of theMessage
                        set recipientList to {{}}
                        repeat with recipient in toRecipients
                            set end of recipientList to (address of recipient)
                        end repeat
                        set AppleScript's text item delimiters to ", "
                        set recipientTo to recipientList as string
                        set AppleScript's text item delimiters to ""
                    end try
                    
                    -- 获取抄送人
                    try
                        set ccRecipients to cc recipients of theMessage
                        set ccList to {{}}
                        repeat with recipient in ccRecipients
                            set end of ccList to (address of recipient)
                        end repeat
                        set AppleScript's text item delimiters to ", "
                        set recipientCC to ccList as string
                        set AppleScript's text item delimiters to ""
                    end try
                    
                    -- 获取附件数量
                    set attachmentCount to count of mail attachments of theMessage
                    
                    -- 返回结果（使用特殊分隔符）
                    return messageSubject & "|||" & messageSender & "|||" & (messageDate as string) & "|||" & messageContent & "|||" & isRead & "|||" & isFlagged & "|||" & recipientTo & "|||" & recipientCC & "|||" & attachmentCount
                end tell
            end tell
        end tell
        '''
        
        result = AppleScriptExecutor.execute(script)
        parts = result.split("|||")
        
        if len(parts) < 9:
            raise ValueError(f"Invalid email details format: {result}")
        
        return {
            "subject": parts[0],
            "sender": parts[1],
            "date": parts[2],
            "content": parts[3],
            "is_read": parts[4].lower() == "true",
            "is_flagged": parts[5].lower() == "true",
            "to": parts[6],
            "cc": parts[7],
            "attachment_count": int(parts[8])
        }
    
    @staticmethod
    def save_attachments(message_id: str, save_dir: str, account: str = "Exchange") -> List[str]:
        """保存邮件附件"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "INBOX"
                    set theMessage to first message whose message id is "{message_id}"
                    set theAttachments to mail attachments of theMessage
                    set savedPaths to {{}}
                    
                    repeat with theAttachment in theAttachments
                        set attachmentName to name of theAttachment
                        set savePath to "{save_dir}/" & attachmentName
                        
                        try
                            save theAttachment in POSIX file savePath
                            set end of savedPaths to savePath
                        on error errMsg
                            log "Failed to save attachment: " & errMsg
                        end try
                    end repeat
                    
                    return savedPaths
                end tell
            end tell
        end tell
        '''
        
        result = AppleScriptExecutor.execute(script)
        if not result:
            return []
        
        return [path.strip() for path in result.split(",") if path.strip()]
    
    @staticmethod
    def get_email_source(message_id: str, account: str = "Exchange") -> str:
        """获取邮件原始源码（用于生成 .eml）"""
        script = f'''
        tell application "Mail"
            tell account "{account}"
                tell mailbox "INBOX"
                    set theMessage to first message whose message id is "{message_id}"
                    return source of theMessage
                end tell
            end tell
        end tell
        '''
        return AppleScriptExecutor.execute(script)
```

### 4. 邮件读取器 (src/mail/reader.py)

```python
from typing import List, Optional
from datetime import datetime
from pathlib import Path
import tempfile
import os

from loguru import logger
from src.models import Email, Attachment
from src.mail.applescript import MailAppScripts
from src.config import config

class EmailReader:
    """邮件读取器"""
    
    def __init__(self):
        self.scripts = MailAppScripts()
        self.account = config.mail_account_name
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
        details = self.scripts.get_email_details(message_id, self.account)
        
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
        
        # 5. 构建 Email 对象
        email = Email(
            message_id=message_id,
            subject=details["subject"],
            sender=self._extract_email_address(details["sender"]),
            sender_name=sender_name,
            to=details["to"],
            cc=details["cc"],
            date=date,
            content=details["content"],
            content_type="text/html" if "<html" in details["content"].lower() else "text/plain",
            is_read=details["is_read"],
            is_flagged=details["is_flagged"],
            attachments=attachments
        )
        
        logger.debug(f"Email read successfully: {email.subject}")
        return email
    
    def _save_and_load_attachments(self, message_id: str) -> List[Attachment]:
        """保存并加载附件"""
        attachments = []
        
        try:
            # 创建临时目录
            email_temp_dir = self.temp_dir / message_id.replace("<", "").replace(">", "")
            email_temp_dir.mkdir(exist_ok=True)
            
            # 保存附件
            saved_paths = self.scripts.save_attachments(
                message_id,
                str(email_temp_dir),
                self.account
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
                if file_path.suffix.lower() not in config.allowed_attachment_types:
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
        return self.scripts.get_email_source(message_id, self.account)
    
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
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".txt": "text/plain",
            ".zip": "application/zip",
        }
        return extension_map.get(file_path.suffix.lower(), "application/octet-stream")
```

### 5. 邮件监听器 (src/mail/watcher.py)

```python
import asyncio
from typing import Set
from loguru import logger

from src.mail.reader import EmailReader
from src.config import config

class MailWatcher:
    """邮件监听器"""
    
    def __init__(self, on_new_email_callback):
        """
        初始化
        
        Args:
            on_new_email_callback: 新邮件回调函数，接收 Email 对象
        """
        self.reader = EmailReader()
        self.on_new_email = on_new_email_callback
        self.synced_message_ids: Set[str] = set()
        self.check_interval = config.check_interval
    
    async def start(self):
        """开始监听"""
        logger.info("Mail watcher started")
        logger.info(f"Check interval: {self.check_interval} seconds")
        
        # 初始化：标记当前所有未读邮件为已知
        await self._initialize_known_emails()
        
        # 开始监听循环
        while True:
            try:
                await self._check_new_emails()
                await asyncio.sleep(self.check_interval)
            except KeyboardInterrupt:
                logger.info("Mail watcher stopped by user")
                break
            except Exception as e:
                logger.error(f"Error in mail watcher: {e}")
                await asyncio.sleep(self.check_interval)
    
    async def _initialize_known_emails(self):
        """初始化已知邮件（避免启动时同步所有历史未读邮件）"""
        logger.info("Initializing known emails...")
        
        try:
            emails = self.reader.get_unread_emails(limit=100)
            self.synced_message_ids = {email.message_id for email in emails}
            logger.info(f"Initialized with {len(self.synced_message_ids)} known emails")
        except Exception as e:
            logger.error(f"Failed to initialize known emails: {e}")
    
    async def _check_new_emails(self):
        """检查新邮件"""
        try:
            # 获取未读邮件
            emails = self.reader.get_unread_emails()
            
            # 筛选出新邮件（不在已知列表中）
            new_emails = [
                email for email in emails
                if email.message_id not in self.synced_message_ids
            ]
            
            if not new_emails:
                return
            
            logger.info(f"Found {len(new_emails)} new emails")
            
            # 处理新邮件
            for email in new_emails:
                try:
                    # 调用回调函数
                    await self.on_new_email(email)
                    
                    # 标记为已知
                    self.synced_message_ids.add(email.message_id)
                    
                except Exception as e:
                    logger.error(f"Failed to process email {email.message_id}: {e}")
        
        except Exception as e:
            logger.error(f"Failed to check new emails: {e}")
    
    def mark_as_synced(self, message_id: str):
        """手动标记邮件为已同步"""
        self.synced_message_ids.add(message_id)
```

---

## 📄 完整实现文档（待续）

由于篇幅限制，我将创建第二部分文档，包含：
- HTML 转 Notion Blocks 转换器
- Notion 同步器
- 主程序入口
- 测试脚本
- 部署指南

请确认当前部分是否符合你的需求，然后我继续创建第二部分。
