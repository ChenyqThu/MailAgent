# MailAgent - 邮件 & 日历同步到 Notion

自动将 macOS Mail.app 的邮件和 Calendar.app 的日历事件实时同步到 Notion，支持 AI Agent 自动分类、分析和生成回复建议。

## ✨ 功能特性

### 📧 邮件同步
- 实时监听 Mail.app 新邮件
- 自动同步到 Notion Database
- 支持 HTML 内容转换
- 内联图片和附件处理
- 邮件线程关联

### 📅 日历同步
- 同步 Exchange 日历事件到 Notion
- 自动提取 Teams 会议链接、会议 ID、密码
- 支持表格内容解析（如 ABR 会议日程）
- 全天/跨天事件正确处理
- 多语言 Teams 格式支持（中/英文）

### 🔮 未来规划
- [ ] 可视化状态监控看板
- [ ] 实时消息告警（微信/Slack/Email）
- [ ] 同步异常自动恢复
- [ ] 性能指标统计

## 🚀 快速开始

### 1. 环境准备
```bash
cd /Users/chenyuanquan/Documents/MailAgent
source venv/bin/activate
pip install -r requirements.txt
```

### 2. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 填入你的配置
```

### 3. 测试连接
```bash
# 测试 Notion API
python3 scripts/test_notion_api.py

# 测试邮件读取
python3 scripts/test_mail_reader.py

# 测试日历读取
python3 scripts/test_eventkit.py
```

### 4. 手动同步测试
```bash
# 同步一封邮件
python3 scripts/manual_sync.py

# 同步日历（一次性）
python3 calendar_main.py --once
```

### 5. 启动服务

#### 方式一：PM2（推荐生产环境）
```bash
# 安装 PM2
npm install -g pm2

# 启动所有服务
pm2 start ecosystem.config.js

# 设置开机自启
pm2 save
pm2 startup

# 查看状态
pm2 status
pm2 logs
```

#### 方式二：前台运行（测试用）
```bash
# 邮件同步
python3 main.py

# 日历同步
python3 calendar_main.py
```

## ⚙️ 配置说明

### 环境变量 (.env)

| 变量 | 说明 | 示例 |
|------|------|------|
| `NOTION_TOKEN` | Notion Integration Token | `ntn_xxx...` |
| `EMAIL_DATABASE_ID` | 邮件数据库 ID | `2df15375...` |
| `CALENDAR_DATABASE_ID` | 日历数据库 ID | `2f015375...` |
| `USER_EMAIL` | 用户邮箱 | `user@example.com` |
| `MAIL_ACCOUNT_NAME` | Mail.app 账户名 | `Exchange` |
| `MAIL_INBOX_NAME` | 收件箱名称 | `收件箱` |
| `CALENDAR_NAME` | 日历名称 | `日历` |
| `CHECK_INTERVAL` | 邮件检查间隔(秒) | `60` |
| `CALENDAR_CHECK_INTERVAL` | 日历同步间隔(秒) | `300` |

完整配置请参考 `.env.example`

## 📊 Notion Database Schema

### 邮件数据库
| 字段 | 类型 | 说明 |
|------|------|------|
| Subject | Title | 邮件主题 |
| From | Email | 发件人邮箱 |
| From Name | Text | 发件人姓名 |
| Date | Date | 接收日期 |
| Message ID | Text | 用于去重 |
| Thread ID | Text | 邮件线程 |
| Processing Status | Select | 处理状态 |

### 日历数据库
| 字段 | 类型 | 说明 |
|------|------|------|
| Title | Title | 事件标题 |
| Event ID | Text | 用于去重 |
| Time | Date | 起止时间 |
| URL | URL | Teams 会议链接 |
| Location | Text | 地点 |
| Status | Select | confirmed/tentative/cancelled |
| Organizer | Text | 组织者 |
| Attendee Count | Number | 参会人数 |

## 🔍 故障排查

### 邮箱名称错误
```bash
python3 scripts/debug_mail_structure.py
```

### 日历权限问题
```bash
# 在终端运行以触发权限弹窗
python3 scripts/test_eventkit.py
```
然后在 系统设置 > 隐私与安全 > 日历 中授权。

### Teams 会议未识别
- 检查事件描述是否包含 Teams 信息
- 查看 `logs/sync.log` 中的解析日志
- 新格式和旧格式都已支持

### 查看日志
```bash
# 实时日志
tail -f logs/sync.log

# PM2 日志
pm2 logs

# 搜索错误
grep ERROR logs/sync.log
```

## 📁 项目结构

```
MailAgent/
├── main.py                 # 邮件同步入口
├── calendar_main.py        # 日历同步入口
├── ecosystem.config.js     # PM2 配置
├── .env                    # 环境配置
├── src/
│   ├── mail/              # 邮件读取（AppleScript）
│   ├── calendar/          # 日历读取（EventKit）
│   ├── notion/            # 邮件 Notion 同步
│   ├── calendar_notion/   # 日历 Notion 同步
│   │   ├── sync.py        # 同步逻辑
│   │   └── description_parser.py  # Teams 会议解析
│   ├── converter/         # HTML 转换
│   ├── models.py          # 数据模型
│   └── config.py          # 配置管理
├── scripts/               # 测试和调试脚本
└── logs/                  # 日志文件
```

## 🛠️ 开发指南

详细的架构说明和开发指南请参考 [CLAUDE.md](./CLAUDE.md)

## 📝 License

MIT License

---

🎉 祝使用愉快！
