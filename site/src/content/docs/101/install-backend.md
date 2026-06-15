---
title: 安装后端（CLI + mail-sync）
description: 克隆仓库、建虚拟环境、装 mailagent CLI、填 .env 五项必填、选 DavMail 或 AppleScript 后端、授予 macOS 权限，并启动 mail-sync 同步服务。
---

后端是整个 MailAgent 的引擎：它在后台同步邮件、跑 AI 分类、维护本地数据库。桌面 App 只是它的图形界面。**先把后端跑通，再装 App。**

整个过程分五步，照着做大约 15 分钟。

:::note
本页假设你已读过 [MailAgent 是什么](/101/overview/) 的系统要求。需要：macOS 12+、Python 3.11+、一个 Notion 工作区、一个 Exchange / Mail.app 邮箱。
:::

## 第 1 步：克隆仓库并建虚拟环境

打开终端（Terminal 或 iTerm2），执行：

```bash
git clone https://github.com/ChenyqThu/MailAgent.git ~/Documents/MailAgent
cd ~/Documents/MailAgent
python3 -m venv venv
source venv/bin/activate
pip install -e ".[cli,dev]"
cp .env.example .env
```

最后一行 `pip install -e ".[cli,dev]"` 会把 `mailagent` 命令装进虚拟环境，`-e`（可编辑安装）让你 `git pull` 拉到的代码改动立刻生效，不用重装。

验证装好了：

```bash
which mailagent      # 应指向 venv/bin/mailagent
mailagent --version  # 期望输出 3.0.0
```

:::caution[每次开终端都要先激活 venv]
`mailagent` 命令只在激活了虚拟环境的终端里可用。每次新开终端，先 `cd ~/Documents/MailAgent && source venv/bin/activate`。如果 `mailagent` 找不到，十有八九是忘了这步。
:::

## 第 2 步：在 Notion 里建好数据库（关键且容易漏）

MailAgent 把邮件同步到两个 Notion 数据库：一个存邮件，一个存日历。**这两个库需要你先在 Notion 里建好，并按下表配齐字段**——字段名和类型必须对得上，否则同步会失败。

### 2a. 创建 Integration，拿 Token

1. 浏览器打开 [www.notion.so/my-integrations](https://www.notion.so/my-integrations)。
2. 点 **New integration**，起个名字（如 `MailAgent`），关联到你的工作区。
3. 创建后复制 **Internal Integration Token**（以 `ntn_` 开头）——这就是 `.env` 里的 `NOTION_TOKEN`。

### 2b. 建邮件数据库（13 个字段）

新建一个 Notion 数据库（页面里输入 `/database` → Table - Full page），按下表加好字段。**字段名严格对应**：

| 字段名 | 类型 | 说明 |
|---|---|---|
| `Subject` | Title | 邮件主题（数据库自带的标题列改名即可） |
| `Message ID` | Text | 邮件唯一标识，用于去重 |
| `Thread ID` | Text | 线程标识，同一话题的邮件共享 |
| `From` | Email | 发件人地址 |
| `From Name` | Text | 发件人显示名 |
| `To` | Text | 收件人 |
| `CC` | Text | 抄送 |
| `Date` | Date | 邮件日期 |
| `Parent Item` | Relation（指向本数据库自身） | 线程头关联，串起一个话题 |
| `Mailbox` | Select | 收件箱 / 发件箱 / 存档 等 |
| `Is Read` | Checkbox | 是否已读 |
| `Is Flagged` | Checkbox | 是否已标旗 |
| `Has Attachments` | Checkbox | 是否有附件 |
| `AI Action` | Select | AI 建议动作（需要回复 / 仅供参考 / …） |
| `AI Priority` | Select | 选项：`Critical` / `Urgent` / `Important` / `Normal` / `Low` |
| `AI Review Status` | Select | 选项：`Pending` / `Reviewed` |

> `Parent Item` 是一个**指向自身**的 Relation：建字段时数据源选这个数据库本身。它让同一话题的回复挂到线程头下面。

建好后，打开数据库右上角 **⋯ → Connections（连接）→** 添加你刚建的 `MailAgent` Integration，否则它没有写入权限。数据库 URL 里那段 32 位十六进制就是 `EMAIL_DATABASE_ID`：

```
https://www.notion.so/<workspace>/<这一段是 DATABASE_ID>?v=...
```

### 2c. 建日历数据库（6 个字段）

同样新建一个数据库，配齐：

| 字段名 | 类型 | 说明 |
|---|---|---|
| `Title` | Title | 事件标题 |
| `Event ID` | Text | 事件唯一标识，用于去重 |
| `Time` | Date（含起止） | 事件起止时间 |
| `URL` | URL | Teams / 会议链接 |
| `Location` | Text | 地点 |
| `Organizer` | Text | 组织者 |

同样记得加上 Integration 连接，URL 里的 ID 就是 `CALENDAR_DATABASE_ID`。

:::tip
不想手搓字段？可以先建好 Integration 和两个空数据库，把字段一项项加齐——比从模板改省心。字段名大小写、空格要和上表完全一致。
:::

## 第 3 步：填 `.env` 的五项必填

用任意编辑器打开 `~/Documents/MailAgent/.env`，至少填好这五项：

```bash
NOTION_TOKEN=ntn_xxxxxxxx          # 第 2a 步拿到的 Integration Token
EMAIL_DATABASE_ID=xxxxxxxx         # 第 2b 步邮件数据库的 ID
CALENDAR_DATABASE_ID=xxxxxxxx      # 第 2c 步日历数据库的 ID
USER_EMAIL=your@company.com        # 你的邮箱地址
MAIL_ACCOUNT_NAME=Exchange         # Mail.app 里这个账户的名字（AppleScript 后端用）
```

不确定 Mail.app 里账户叫什么名字？跑一句：

```bash
mailagent debug mail-structure
```

它会列出 Mail.app 里所有账户和邮箱，把你的账户名填进 `MAIL_ACCOUNT_NAME`。

完整的可选配置（飞书、Redis、AI 网关、各功能开关）都在 `.env.example` 里有注释，按需取用。

## 第 4 步：选择邮箱后端

MailAgent 用一行配置在两条邮箱接入路径间切换：

```bash
MAILAGENT_BACKEND=applescript   # 代码默认；或改成 davmail
```

| 后端 | 怎么连邮箱 | 适合谁 | 速度 |
|---|---|---|---|
| **applescript** | 直接驱动 macOS 自带 Mail.app | 已经在 Mail.app 里配好邮箱、想最省事 | 单封约 1 秒 |
| **davmail** | 通过 DavMail 桥接企业 Exchange（IMAP / SMTP / CalDAV） | 企业 Exchange / Microsoft 365 用户，要更快更稳 | 单封约 236 毫秒 |

**先用 AppleScript 跑通**最简单：只要 Mail.app 里已经登录了邮箱，无需额外组件。等熟悉之后再考虑切 DavMail。

### 如果你要用 DavMail

DavMail 是一个独立的 Java 桥接程序，把 Exchange 翻译成标准邮件协议。除了上面那行，还要补：

```bash
MAILAGENT_BACKEND=davmail
DAVMAIL_USER=your@company.com          # 通常同 USER_EMAIL
DAVMAIL_CIPHER_KEY=xxx                 # 与本机 davmail.properties 的 cipher key 一致
# DAVMAIL_IMAP_PORT=1143               # 与 davmail.properties 一致
# DAVMAIL_SMTP_PORT=1025
# DAVMAIL_ROOT=/绝对路径/MailAgent/davmail-poc   # 打包 App 必填绝对路径
```

DavMail 进程一般用 PM2 以 `davmail-poc` 之名常驻。`DAVMAIL_CIPHER_KEY` 必须和本机 `davmail.properties` 里的 cipher key 完全一致，否则解不开凭据。

:::danger[DavMail 的两条硬约束，务必知道]
1. **EWS 关停**：DavMail 6.7 当前依赖微软的 EWS 协议，该协议将于 **2026-10-01 关停**。届时需要切到 DavMail 的 Graph 模式或申请 Graph API。详见[迁移路线图 §5.1](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md)。
2. **合规审批**：DavMail 当前以伪装客户端方式接入是评估性质（PoC），上生产前需走公司 IT 审批。

AppleScript 路径不受这两条影响，是始终可用的兜底。
:::

## 第 5 步：授予 macOS 权限，并启动服务

### 5a. 系统权限

运行 MailAgent 的终端 App（Terminal / iTerm2）需要下面这些权限。打开 **系统设置 → 隐私与安全性**逐项授予：

| 权限 | 位置 | 用途 |
|---|---|---|
| **完全磁盘访问权限** | 隐私与安全性 → 完全磁盘访问权限 | 读取 Mail.app 的本地数据库（SQLite 雷达） |
| **自动化 → Mail** | 隐私与安全性 → 自动化 | 用 AppleScript 操作 Mail.app（标已读 / 旗标 / 草稿） |
| **自动化 → System Events** | 隐私与安全性 → 自动化 | 创建草稿时模拟按键粘贴内容 |
| **辅助功能** | 隐私与安全性 → 辅助功能 | System Events 发送按键 |
| **屏幕录制** | 隐私与安全性 → 屏幕录制 | 仅在用 `--screenshot` 截图草稿时需要 |

> 如果系统没自动弹出权限请求，先跑一次 `mailagent debug mail-structure` 触发它，再到上面位置勾选。注意：PM2 启动的进程继承启动时所在终端的权限，换终端要重新授权。

### 5b. 启动 mail-sync

开发 / 测试，前台跑：

```bash
python3 main.py
```

生产 / 长期跑，用 PM2 后台守护（注意必须指定 venv 里的 Python 解释器）：

```bash
npm install -g pm2
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3
pm2 save && pm2 startup
```

常用 PM2 命令：

```bash
pm2 status                # 看进程是否 online
pm2 logs mail-sync        # 跟踪日志
pm2 restart mail-sync     # 重启
```

### 5c. 确认跑起来了

```bash
mailagent admin health -o json | jq .data.healthy   # 期望 true
tail -f logs/sync.log                                # 日志里不应有 ERROR 行
```

看到 SQLite 雷达每 5 秒跑一次、`healthy` 为 `true`，后端就装好了。

## 接下来

后端就绪后，下一步是把历史邮件灌进 Notion：**[首次同步](/101/initial-sync/)**。装完后端也想要图形界面的话，去 **[安装桌面 App](/101/install-app/)**。

---

> 深入了解：[README 快速开始](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [CLI 命令全表](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · [DavMail 与架构内核](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/architecture-internals.md)
