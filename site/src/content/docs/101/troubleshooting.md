---
title: 故障排查 FAQ 与术语表
description: 启动空白、CLI 不在 PATH、找不到数据库、自动化被拒、网关测试失败、磁盘权限、AppleScript 超时、邮箱名错、看日志、死信邮件 —— 加上多文件夹同步、知识大脑、监控看板的用户向说明与术语表。
---

遇到问题先别急着改配置。这一页把最常见的故障按"症状 → 原因 → 怎么修"列清楚，照着排查通常几分钟就能解决。页尾还有几个进阶功能的用户向说明，以及一份术语表 —— 你在日志或报错里撞见的那些词，这里都有人话解释。

## 故障排查 FAQ

### App 启动后窗口空白 / 提示「mailagent CLI not on PATH」

桌面 App 需要找得到后端命令行。最常见的原因是启动 App 的环境里没装好 / 没激活 venv。

修法二选一：

```bash
# 方法 A：在已激活 venv 的终端里启动 App
source ~/Documents/MailAgent/venv/bin/activate
open /Applications/MailAgent.app
```

```bash
# 方法 B：给系统设一个全局的 CLI 路径，然后重启 App
launchctl setenv MAILAGENT_BIN "$(which mailagent)"
```

### 提示「sync_store.db not found」（找不到数据库）

后端同步服务还没跑过，本地数据库尚未生成。先启动后端：

```bash
python3 ~/Documents/MailAgent/main.py
# 或用 PM2 后台跑
pm2 start ~/Documents/MailAgent/main.py --name mail-sync --interpreter ./venv/bin/python3
```

跑起来后数据库会在 `~/Documents/MailAgent/data/sync_store.db` 自动创建。

### Mail.app 自动化失败 / 提示「macOS 自动化权限被拒」

MailAgent 通过 AppleScript 操作 Mail.app（标已读、标旗、起草），首次会被 macOS 拦下来。

1. 打开 **系统设置 → 隐私与安全性 → 自动化**；
2. 找到 `MailAgent`，勾上它下面的 `Mail`；
3. 同样在 `osascript` 下勾上 `Mail`（命令行调用路径）。

如果列表里**没有** MailAgent，先在 App 里对任意邮件点一次 **起草回复**，触发权限请求，再回到上面的位置勾选。

### LLM 网关测试失败

进 **设置 → 密钥（Secrets）**，多半是 LLM API Key 没填或失效了。

1. 从你的 LLM 网关重新拿一个 key；
2. 粘进 **LLM API Key**，保存；
3. 点 **测试网关** 验证联通。

### SQLite 无法访问 / 需要完全磁盘访问

如果数据库放在了 `~/Library/...` 等受保护目录（不是默认的 `~/Documents`），macOS 会拦读取。手动放行：

**系统设置 → 隐私与安全性 → 完全磁盘访问权限 → +**，把 `MailAgent.app`（或运行后端的终端 App）加进去。

:::tip
默认数据库在 `~/Documents/MailAgent/data/`，Documents 访问权限弹窗就够用，一般不需要单独开完全磁盘访问。
:::

### AppleScript 超时

在 AppleScript 备用模式下，操作 Mail.app 偶尔会超时。调大超时时间：

```bash
# 在 .env 里调（默认 200 秒）
APPLESCRIPT_TIMEOUT=300
```

改完重启后端。

### 邮箱名称配置错了

如果同步范围不对、或某个邮箱找不到，多半是邮箱名填错了。列出 Mail.app 里真实的账户和邮箱名：

```bash
mailagent debug mail-structure
```

照输出里的真实名称去校正 `.env`（`MAIL_ACCOUNT_NAME` 等）。注意发件箱在 AppleScript 里的名字是「已发送邮件」。

### 怎么看日志

排查任何问题，日志都是第一手线索：

```bash
tail -f ~/Documents/MailAgent/logs/sync.log   # 实时跟同步日志
pm2 logs mail-sync --lines 30 --nostream      # 看 PM2 进程最近 30 行
```

### 有邮件进了「死信」队列

少数邮件多次同步失败后会被搁进**死信（dead-letter）**队列，不再自动重试，以免反复失败拖累整体。查看和重试：

```bash
# 看有多少封进了死信
sqlite3 ~/Documents/MailAgent/data/sync_store.db \
  "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'"

# 列出死信邮件
mailagent admin dead-letter list

# 把某封重置为待处理，让它重新排队
mailagent admin dead-letter retry <internal_id>
```

少量死信通常是个别邮件格式特殊或临时网络问题，重试一下往往就过了。

---

## 进阶功能（用户向说明）

### 同步多个文件夹

默认 MailAgent 只同步收件箱（和发件箱）。如果你在 Exchange 里整理了自定义文件夹（比如「项目 A」「重要客户」，中文名也支持），可以把它们也纳入同步：

```bash
# 在 .env 里，用 JSON 数组列出要同步的文件夹名
SYNC_FOLDERS=["项目A","重要客户"]
```

被列入的文件夹会**和收件箱享受完全一样的待遇** —— AI 分类、Notion 同步、全文搜索、线程关系、写操作都一样。配套还有几个细调开关：

| 开关 | 默认 | 作用 |
|---|---|---|
| `SYNC_FOLDERS` | 空 | 要同步的自定义文件夹白名单（JSON 数组）。空 = 完全维持现状 |
| `FOLDER_NOTIFY_ENABLED` | 不推 | 自定义文件夹默认**不**推飞书；想推的用 JSON 白名单单独打开 |
| `FOLDER_LLM_DISABLED` | 全跑 | 默认所有文件夹都跑 AI；用 JSON 黑名单可以关掉某些文件夹的 AI |
| `FOLDER_SYNC_PAST_DAYS` | 90 | 首次同步往回追多少天 |
| `FOLDER_SYNC_MAX_MESSAGES` | 2000 | 单个文件夹首次同步的封数上限 |

:::note[仅 DavMail 模式]
多文件夹同步只在 DavMail 模式下可用。改完 `.env` 记得重启后端。
:::

### 知识大脑（KOS）

KOS 是一个**跨来源的知识库**：它把你的邮件语料、个人笔记、产品知识汇到一起，让 AI 在回信或对话时能"先查一下大脑里已知什么"。开启后，最直观的变化是 **AI Chat 里多了检索能力** —— 比如你问"这个供应商以前的合同条款是什么"，AI 会去知识库里找相关邮件和资料，回答时带上来源出处，而不是凭空编。

KOS 是三层独立开关，默认全部关闭：

| 开关 | 作用 |
|---|---|
| `MAILAGENT_KOS_INGEST_ENABLED` | 把邮件入库（让大脑"记住"邮件） |
| `MAILAGENT_KOS_CONSUMER_ENABLED` | 让 AI Chat 能检索知识库（回话时查大脑） |
| `MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED` | 热点知识块（进阶优化） |

开启 KOS 后你会注意到：AI Chat 的回答更"有据可依"，会引用具体邮件/资料来源；问到人/公司/产品背景时，AI 能补上你邮箱以外的上下文。如果知识库临时连不上，AI 会自动退回普通的本地全文搜索，不影响对话。

:::note[需要先配好 KOS 接入凭据]
KOS 是外部服务，开启前需要配好对接凭据（地址 + 授权）。缺凭据时它会静默不工作（既不报错也不生效）。
:::

### 监控看板

如果你部署了远程监控看板，可以在浏览器里一眼看到 MailAgent 的整体健康状况，不用登到服务器看日志。看板对非开发者也友好，主要看这几块：

- **同步概览**：已同步多少封、还有多少待处理、有没有积压；
- **服务状态**：同步进程是不是活着、上次活动是什么时候；
- **告警**：有没有触发异常告警（同步连续失败、死信堆积等）；
- **队列**：事件队列是否正常流转。

你不需要看懂每个数字的技术含义，重点关注两件事：**服务状态是不是"在线"**，以及**有没有红色告警**。两者都正常，就说明 MailAgent 在好好干活。

---

## 术语表

在日志、报错或本文档里你可能撞见这些词，下面是人话版解释：

| 术语 | 大白话 |
|---|---|
| **SSoT（单一真实来源）** | 数据"以谁为准"。MailAgent 以本机 SQLite 数据库为准，Notion 只是它的镜像。 |
| **dead-letter（死信）** | 多次同步失败、被暂时搁置不再自动重试的邮件，需手动重试。 |
| **internal_id** | 每封邮件在本机的内部编号（整数），用它定位邮件极快。报错和 CLI 里常以它指代某封邮件。 |
| **DavMail** | 一个本地桥接程序，让 MailAgent 用标准协议（IMAP/SMTP/CalDAV）和 Exchange / Outlook 通信。当前生产主路径。 |
| **FanoutWorker** | 后台的"派发员"：你做了标记/标旗等操作后，由它异步把改动分发到 Mail.app 和 Notion，所以偶尔会有几秒延迟。 |
| **outbox** | 待派发的操作暂存区。你的标记/标旗先落到这里，再由 FanoutWorker 取走执行。 |
| **AppleScript 模式 / DavMail 模式** | 两种邮件后端。DavMail 是主路径；AppleScript（直接驱动 Mail.app）是始终保留的备用路径。 |
| **FTS5** | SQLite 的全文搜索引擎，支撑你在收件箱里搜邮件正文和附件文本。 |

:::note[EWS 关停提醒]
DavMail 当前通过 EWS 桥接 Exchange。微软已宣布 **EWS 将于 2026-10-01 关停**，届时 DavMail 6.7 的当前路径将不可用。迁移方案详见 `docs/reference/architecture/roadmap-post-cutover.md` §5.1。AppleScript 备用路径不依赖 EWS，始终可用。
:::

> 还没解决？到 [GitHub Issues](https://github.com/chenyqthu/MailAgent/issues) 反馈，附上 `logs/sync.log` 的相关片段会更快定位。
