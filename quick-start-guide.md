# Email to Notion 实时同步 - 快速开始指南

## 🎯 项目概述

自动将 Mail.app 的邮件实时同步到 Notion，触发 AI Agent 自动分类、分析和生成回复建议。

**已配置信息**：
- ✅ Notion Token: `ntn_P569517748514sTqbObMLErEyhmO4sZaqnqfSqZTLZddiG`
- ✅ Email Database ID: `2df15375830d8094980efd1468ca118c`
- ✅ 文件上传功能：已支持（使用 Notion 官方文件上传 API）

---

## 🚀 15 分钟快速启动

### Step 1: 创建项目（2 分钟）

```bash
# 创建项目目录
mkdir ~/email-notion-sync
cd ~/email-notion-sync

# 创建项目结构
mkdir -p src/{mail,converter,notion,utils} scripts logs

# 创建虚拟环境
python3 -m venv venv
source venv/bin/activate
```

### Step 2: 安装依赖（2 分钟）

创建 `requirements.txt`:
```bash
cat > requirements.txt << 'EOF'
notion-client==2.2.1
beautifulsoup4==4.12.2
html2text==2020.1.16
lxml==4.9.3
pydantic==2.5.0
pydantic-settings==2.1.0
python-dotenv==1.0.0
loguru==0.7.2
aiofiles==23.2.1
Pillow==10.1.0
EOF
```

安装：
```bash
pip install -r requirements.txt
```

### Step 3: 配置环境（1 分钟）

创建 `.env` 文件：
```bash
cat > .env << 'EOF'
# Notion 配置
NOTION_TOKEN=ntn_P569517748514sTqbObMLErEyhmO4sZaqnqfSqZTLZddiG
EMAIL_DATABASE_ID=2df15375830d8094980efd1468ca118c

# 用户配置
USER_EMAIL=lucien.chen@tp-link.com
MAIL_ACCOUNT_NAME=Exchange

# 同步配置
CHECK_INTERVAL=60
MAX_BATCH_SIZE=10
SYNC_EXISTING_UNREAD=true  # 启动时是否同步现有的未读邮件

# 日志配置
LOG_LEVEL=INFO
LOG_FILE=logs/sync.log

# 附件配置
MAX_ATTACHMENT_SIZE=10485760
ALLOWED_ATTACHMENT_TYPES=.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx
EOF
```

### Step 4: 复制核心代码（5 分钟）

#### 4.1 配置管理 (`src/config.py`)

```python
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List

class Config(BaseSettings):
    notion_token: str = Field(..., env="NOTION_TOKEN")
    email_database_id: str = Field(..., env="EMAIL_DATABASE_ID")
    user_email: str = Field(..., env="USER_EMAIL")
    mail_account_name: str = Field(default="Exchange", env="MAIL_ACCOUNT_NAME")
    check_interval: int = Field(default=5, env="CHECK_INTERVAL")
    max_batch_size: int = Field(default=10, env="MAX_BATCH_SIZE")
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    log_file: str = Field(default="logs/sync.log", env="LOG_FILE")
    max_attachment_size: int = Field(default=10485760, env="MAX_ATTACHMENT_SIZE")
    allowed_attachment_types: List[str] = Field(
        default=[".pdf", ".png", ".jpg", ".jpeg", ".docx", ".xlsx", ".pptx"],
        env="ALLOWED_ATTACHMENT_TYPES"
    )
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

config = Config()
```

#### 4.2 数据模型 (`src/models.py`)

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

@dataclass
class Attachment:
    filename: str
    content_type: str
    size: int
    path: str

@dataclass
class Email:
    message_id: str
    subject: str
    sender: str
    sender_name: Optional[str] = None
    to: str = ""
    cc: str = ""
    date: datetime = field(default_factory=datetime.now)
    content: str = ""
    content_type: str = "text/plain"
    is_read: bool = False
    is_flagged: bool = False
    has_attachments: bool = False
    attachments: List[Attachment] = field(default_factory=list)
    thread_id: Optional[str] = None
    
    def __post_init__(self):
        if not self.message_id:
            raise ValueError("message_id is required")
        if not self.subject:
            self.subject = "(No Subject)"
        if not self.sender_name:
            self.sender_name = self.sender.split("@")[0]
        self.has_attachments = len(self.attachments) > 0
```

#### 4.3 日志配置 (`src/utils/logger.py`)

```python
import sys
from pathlib import Path
from loguru import logger

def setup_logger(log_level: str = "INFO", log_file: str = "logs/sync.log"):
    logger.remove()
    
    logger.add(
        sys.stdout,
        level=log_level,
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan> - <level>{message}</level>",
        colorize=True
    )
    
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    
    logger.add(
        log_file,
        level=log_level,
        format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message}",
        rotation="10 MB",
        retention="7 days",
        compression="zip"
    )
```

**其他核心代码文件请参考完整技术文档**：
- `src/mail/applescript.py` - AppleScript 封装
- `src/mail/reader.py` - 邮件读取器
- `src/mail/watcher.py` - 邮件监听器
- `src/converter/html_converter.py` - HTML 转换器
- `src/converter/eml_generator.py` - EML 生成器
- `src/notion/client.py` - Notion API 客户端（含文件上传）
- `src/notion/sync.py` - 同步逻辑（含附件上传）
- `main.py` - 主程序

### Step 5: 运行测试（3 分钟）

#### 5.1 测试 Notion 连接

创建 `scripts/test_notion_api.py`:
```python
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from notion_client import AsyncClient
from src.config import config

async def main():
    client = AsyncClient(auth=config.notion_token)
    
    print("Testing Notion API...")
    print(f"Token: {config.notion_token[:20]}...")
    print(f"Database ID: {config.email_database_id}")
    
    # 查询数据库
    results = await client.databases.query(database_id=config.email_database_id)
    print(f"✅ Success! Found {len(results['results'])} pages")

if __name__ == "__main__":
    asyncio.run(main())
```

运行：
```bash
python3 scripts/test_notion_api.py
```

**预期输出**：
```
Testing Notion API...
Token: ntn_P56951774851...
Database ID: 2df15375830d8094980efd1468ca118c
✅ Success! Found X pages
```

#### 5.2 测试邮件读取

创建 `scripts/test_mail_reader.py`（代码见完整文档）

运行：
```bash
python3 scripts/test_mail_reader.py
```

### Step 6: 启动服务（1 分钟）

```bash
# 前台运行（测试用）
python3 main.py

# 后台运行
nohup python3 main.py > logs/app.log 2>&1 &

# 查看日志
tail -f logs/sync.log
```

---

## 🎉 验证工作流程

### 1. 发送测试邮件

给自己发一封测试邮件：`lucien.chen@tp-link.com`

主题：`[测试] Email to Notion 同步测试`
内容：包含一些文本和图片

### 2. 观察同步过程

查看日志：
```bash
tail -f logs/sync.log
```

你应该看到：
```
📬 New email received: [测试] Email to Notion 同步测试
Syncing email to Notion: [测试] Email to Notion 同步测试
Uploaded attachment: image.png
Uploaded .eml file: 20260106_120000_测试_Email_to_Notion_同步测试.eml
✅ Email synced successfully: [测试] Email to Notion 同步测试
```

### 3. 在 Notion 中查看

1. 打开 Notion Email Inbox Database
2. 找到新创建的 Page
3. 查看字段：
   - ✅ Subject, From, Date 等基本信息
   - ✅ Processing Status = "未处理"
   - ✅ Original EML 字段中有 .eml 文件
   - ✅ 邮件内容已转换为 Notion Blocks
   - ✅ 附件已上传并显示

### 4. 等待 AI Agent 处理

几秒到几分钟后，Notion AI Agent 会自动：
- ✅ 填充 Priority（优先级）
- ✅ 填充 Category（类别）
- ✅ 填充 Language（语言）
- ✅ 填充 AI Summary（摘要）
- ✅ 填充 Key Points（关键点）
- ✅ 填充 Reply Suggestion（回复建议）
- ✅ 更新 Processing Status = "已完成"

---

## 📊 关键功能验证清单

- [ ] Notion API 连接成功
- [ ] Mail.app 邮件读取成功
- [ ] 新邮件自动检测（5秒内）
- [ ] 邮件内容转换为 Notion Blocks
- [ ] HTML 格式正确显示
- [ ] 附件成功上传到 Notion
- [ ] .eml 文件成功上传
- [ ] AI Agent 自动分类
- [ ] AI Agent 生成回复建议
- [ ] Processing Status 自动更新

---

## 🔧 常见问题排查

### Q1: Notion API 返回 401
**问题**：Token 无效或没有权限

**解决**：
1. 确认 Integration 已添加到 Database
2. 在 Notion 中点击 Database 右上角 "..." → "Connections" → 添加你的 Integration

### Q2: 邮件读取失败
**问题**：Mail.app 权限不足

**解决**：
1. 确保 Mail.app 正在运行
2. 系统偏好设置 → 安全性与隐私 → 隐私 → 自动化
3. 允许 Terminal 控制 Mail.app

### Q3: 附件上传失败
**问题**：文件太大或格式不支持

**解决**：
1. 检查 `MAX_ATTACHMENT_SIZE`（默认 10MB）
2. 检查 `ALLOWED_ATTACHMENT_TYPES`
3. 查看日志了解具体错误

### Q4: AI Agent 没有自动填充
**问题**：AI Autofill Prompt 未配置

**解决**：
1. 在 Notion Database 中点击每个 AI 字段
2. 启用 "AI Autofill"
3. 粘贴对应的 Prompt（见 Notion 数据库创建指南）

---

## 🚀 配置为系统服务（可选）

创建 LaunchAgent：

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
        <string>/Users/lucien/email-notion-sync/venv/bin/python3</string>
        <string>/Users/lucien/email-notion-sync/main.py</string>
    </array>
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>KeepAlive</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>/Users/lucien/email-notion-sync/logs/app.log</string>
    
    <key>StandardErrorPath</key>
    <string>/Users/lucien/email-notion-sync/logs/error.log</string>
    
    <key>WorkingDirectory</key>
    <string>/Users/lucien/email-notion-sync</string>
</dict>
</plist>
EOF

# 记得修改路径为实际路径
# 加载服务
launchctl load ~/Library/LaunchAgents/com.lucien.email-notion-sync.plist

# 启动服务
launchctl start com.lucien.email-notion-sync
```

---

## 📝 下一步

1. **验证基本功能**：发送几封测试邮件，确认同步正常
2. **调整 AI Prompt**：根据实际效果优化 Notion AI Agent 的 Prompt
3. **反向同步开发**：开发 Notion → Mail.app 的状态同步（阶段 2）
4. **性能优化**：根据实际邮件量调整 `CHECK_INTERVAL` 和 `MAX_BATCH_SIZE`

---

## 🆘 需要帮助？

遇到问题时：
1. 查看 `logs/sync.log` 日志文件
2. 确认所有配置正确
3. 运行测试脚本逐个排查
4. 随时联系我获取支持

**完整技术文档**：
- Part 1: 基础架构和核心组件
- Part 2: Notion 同步和部署指南

祝你使用愉快！🎉
