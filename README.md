# MailAgent

macOS 邮件实时同步到 Notion，支持 AI 自动分类与处理。

## 功能概览

| 功能 | 数据源 | 说明 |
|------|--------|------|
| **邮件同步** | Mail.app | 邮件内容、附件、线程关系同步到 Notion |
| **会议邀请识别** | 邮件中的 .ics | 自动解析会议邀请创建日程 |
| **日历同步** | Calendar.app | 仅用于同步历史日程（可选） |

### 邮件同步特性
- **v3 SQLite-First 架构**：大邮箱（6-7 万封）支持，单封邮件获取 ~1s（vs 旧架构 ~100s）
- 基于 message_id 的 100% 准确去重
- 自动建立邮件线程 Parent-Child 关系
- **自动识别会议邀请**：检测邮件中的 iCalendar 附件，创建日程页面
- HTML 正文转 Notion Blocks（含内联图片）
- 附件上传到 Notion
- 失败自动重试（指数退避）

### 关于日历同步

`calendar_main.py` 是独立的日历同步服务，直接从 Calendar.app 读取事件。

**建议**：一般情况下**不需要运行** `calendar_main.py`，原因如下：
- 邮件同步 (`main.py`) 已包含会议邀请识别，能自动将邮件中的会议同步到日程
- Calendar.app 中的会议可能不完整（部分会议不会同步到本地日历）
- 邮件中的会议邀请信息更全面（包含完整描述、Teams 链接等）

**何时使用**：仅在需要一次性同步 Calendar.app 中的历史日程时使用：
```bash
python3 calendar_main.py --once
```

---

## 快速开始

### 1. 环境准备

```bash
git clone <your-repo-url>
cd MailAgent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### 2. 配置 `.env`

必填项：
```bash
NOTION_TOKEN=ntn_xxx...           # Notion Integration Token
EMAIL_DATABASE_ID=xxx...          # 邮件数据库 ID
CALENDAR_DATABASE_ID=xxx...       # 日历数据库 ID
USER_EMAIL=your@email.com
MAIL_ACCOUNT_NAME=Exchange        # Mail.app 账户名
```

完整配置参见 `.env.example`

### 3. 系统权限

**Full Disk Access**（必需）
- 系统设置 → 隐私与安全 → 完全磁盘访问权限 → 添加 Terminal

### 4. 测试连接

```bash
source venv/bin/activate
python3 scripts/test_notion_api.py   # Notion API
python3 scripts/test_mail_reader.py  # Mail.app（获取最新 5 封邮件）
```

### 5. 初始化同步

首次使用需将历史邮件同步到 Notion：

```bash
# 完整初始化流程
python3 scripts/initial_sync.py --action all --yes

# 或分步执行：
python3 scripts/initial_sync.py --action fetch-cache --inbox-count 3000 --sent-count 500
python3 scripts/initial_sync.py --action analyze
python3 scripts/initial_sync.py --action all --yes
```

### 6. 启动服务

**开发/测试：**
```bash
python3 main.py
```

**生产环境（PM2）：**
```bash
npm install -g pm2
pm2 start main.py --name mail-sync --interpreter python3
pm2 save && pm2 startup
```

---

## 架构说明

```
┌─────────────────────────────────────────────────────────────────┐
│                        main.py (邮件同步)                        │
├─────────────────────────────────────────────────────────────────┤
│  SQLite Radar ──检测变化──▶ AppleScript Arm ──获取邮件──▶        │
│                                    ↓                             │
│                             SyncStore (去重)                     │
│                                    ↓                             │
│                  ┌─────────────────┴─────────────────┐           │
│                  ↓                                   ↓           │
│         NotionSync (邮件页面)              MeetingInviteSync     │
│                  ↓                            (解析 .ics)        │
│            Notion Email DB                        ↓              │
│                                          Notion Calendar DB      │
└─────────────────────────────────────────────────────────────────┘
```

**核心流程**：
1. SQLite Radar 每 5 秒检测 Mail.app 数据库变化
2. 发现新邮件后，通过 AppleScript 获取完整内容
3. 解析邮件，同步到 Notion Email 数据库
4. 如果邮件包含会议邀请（.ics），自动创建日程到 Calendar 数据库

---

## Notion 数据库结构

### 邮件数据库

| 字段 | 类型 | 说明 |
|------|------|------|
| Subject | Title | 邮件主题 |
| Message ID | Text | 唯一标识（去重用） |
| Thread ID | Text | 线程标识 |
| From / To / CC | Text/Email | 收发件人 |
| Date | Date | 日期 |
| Parent Item | Relation (self) | 线程头关联 |
| Mailbox | Select | 收件箱/发件箱 |
| Is Read / Is Flagged | Checkbox | 状态 |
| Has Attachments | Checkbox | 是否有附件 |

### 日历数据库

| 字段 | 类型 | 说明 |
|------|------|------|
| Title | Title | 事件标题 |
| Event ID | Text | 唯一标识 |
| Time | Date | 起止时间 |
| URL | URL | Teams 会议链接 |
| Location | Text | 地点 |
| Organizer | Text | 组织者 |

---

## 常见问题

**邮箱名称错误**
```bash
python3 scripts/debug_mail_structure.py
```

**SQLite 权限问题**
- 系统设置 → 隐私与安全 → 完全磁盘访问权限 → 添加 Terminal

**AppleScript 超时**
- 增大 `.env` 中的 `APPLESCRIPT_TIMEOUT`（默认 200 秒）

**查看日志**
```bash
tail -f logs/sync.log
pm2 logs
```

---

## 项目结构

```
MailAgent/
├── main.py                 # 邮件同步入口（主服务）
├── calendar_main.py        # 日历同步入口（可选，一般不需要）
├── src/
│   ├── mail/               # 邮件模块
│   │   ├── new_watcher.py      # 监听器
│   │   ├── sqlite_radar.py     # SQLite 雷达
│   │   ├── applescript_arm.py  # AppleScript 获取器
│   │   ├── sync_store.py       # 同步状态存储
│   │   ├── meeting_sync.py     # 会议邀请同步
│   │   ├── icalendar_parser.py # iCalendar 解析
│   │   └── reader.py           # 邮件解析
│   ├── calendar/           # 日历模块（可选）
│   ├── notion/             # Notion 邮件同步
│   ├── calendar_notion/    # Notion 日历同步
│   ├── converter/          # HTML 转换
│   ├── models.py           # 数据模型
│   └── config.py           # 配置管理
├── scripts/
│   ├── initial_sync.py     # 初始化同步
│   └── test_*.py           # 测试脚本
├── data/
│   └── sync_store.db       # 同步状态数据库
└── logs/
```

---

## 开发文档

- [架构设计](./docs/new_architecture_design.md)
- [初始同步指南](./docs/initial_sync.md)
- [开发指南](./CLAUDE.md)

## License

MIT
