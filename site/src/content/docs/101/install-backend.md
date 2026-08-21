---
title: （开发者）从源码运行后端
description: 克隆仓库、建虚拟环境、装 mailagent CLI、填 .env 五项必填、选 DavMail 或 AppleScript 后端、授予 macOS 权限，并启动 mail-sync 同步服务。
sidebar:
  badge:
    text: 进阶
    variant: caution
---

:::caution[普通用户不需要这一页]
直接[装桌面 App](/101/install-app/) 即可，后端已打包在内，开箱即用。本页是给想从**源码运行后端**的开发者（贡献代码、自定义、调试）的进阶指南。
:::

后端是整个 MailAgent 的引擎：它在后台同步邮件、跑 AI 分类、维护本地数据库。从源码运行时，整个过程分五步，照着做大约 15 分钟。

:::note
本页假设你已读过 [MailAgent 是什么](/101/overview/) 的系统要求。需要：macOS 12+、Python 3.11+、一个 Exchange / Mail.app 邮箱。Notion 是可选的（见第 2 步）。
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

## 第 2 步：可选——建 Notion 镜像库

Notion 是**可选的**：MailAgent 的邮件正文和附件以本地 SQLite 为 SSoT，Notion 只是可选的额外归档镜像。只有想把邮件额外镜像到 Notion 才需要建库；纯本地 SQLite 使用可跳过本步，直接去第 3 步。

如果你需要 Notion 镜像，MailAgent 要用到两个 Notion 数据库：一个存邮件，一个存日历。**这两个库需要你先在 Notion 里建好，并按下表配齐字段**——字段名和类型必须对得上，否则同步会失败。

:::tip[桌面 App 用户有更快的路径]
本页讲的是**手填 Token + Database ID**，适用于本页场景（从源码跑后端，没有桌面 App 图形界面）或想用 internal integration 的进阶用户。如果你用的是[桌面 App](/101/install-app/)（多数用户），设置页有「连接 Notion」按钮：点一下跳系统浏览器完成 OAuth 授权，授权页选「使用开发者提供的模板」会自动复制配好字段的邮件库 + 日历库，App 自动识别两个库并写入配置，全程不用手填 Token、也不用从 URL 里抠数据库 ID；选「使用已有页面」则回到 App 后从下拉列表里选库，同样免手填。两条路径最终写入的是同一组配置（`NOTION_TOKEN` / `EMAIL_DATABASE_ID` / `CALENDAR_DATABASE_ID`），同步管线不区分来源。
:::

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
MAILAGENT_BACKEND=applescript   # 代码默认；企业 Exchange 用户建议改成 davmail
```

| 后端 | 怎么连邮箱 | 适合谁 | 速度 |
|---|---|---|---|
| **davmail**（推荐） | 通过 DavMail 桥接企业 Exchange（IMAP / SMTP / CalDAV） | 企业 Exchange / Microsoft 365 用户，要更快更稳、富文本回复 + 多文件夹 + 日历直读 | 单封约 236 毫秒 |
| **applescript** | 直接驱动 macOS 自带 Mail.app | 想零额外组件、随装随用的兜底 | 单封约 1 秒 |

**企业 Exchange / Microsoft 365 用户推荐用 DavMail**——更快更稳，且把富文本回复全部、多文件夹同步、CalDAV 日历直读这些能力真正打通。安装、认证（含伪装 Outlook client_id）、确认运行与守护进程的完整步骤见专页 **[用 DavMail 接入企业邮箱](/101/davmail-setup/)**。

只想最快跑起来、邮箱又已在 Mail.app 里登录好？保持 `applescript` 默认即可，无需任何额外组件，且随时可作兜底。

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

后端就绪后，下一步是把历史邮件灌进本地库：**[首次同步（CLI 方式）](/101/initial-sync/)**。如果也想要图形界面，去 **[安装桌面 App](/101/install-app/)**。

---

> 深入了解：[README 快速开始](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [CLI 命令全表](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · [DavMail 与架构内核](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/architecture-internals.md)
