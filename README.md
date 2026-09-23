# MailAgent

**以邮件为起点的个人 AI 工作台。**

MailAgent 把邮件、日历、事项、联系人与资料收进同一台本机工作台，让一组有名字、有边界的 AI Agent 替你读信、跟进、起草、整理。只有需要你拍板的事，才会来到面前；每一步，都能追溯到原文。

[官网](https://mailagent.chenge.ink) · [使用指南](https://mailagent.chenge.ink/101/overview/) · [下载最新版](https://github.com/ChenyqThu/MailAgent/releases/latest) · [English](https://mailagent.chenge.ink/en/)

---

## 它能做什么

**今日与邮件**
今日把当天需要你过问的事收在一页：等你拍板的审批、今天的会、待回邮件、临期事项，以及 agent 刚交出的成果。每封邮件入库即被读完——类别、优先级、一句话摘要、下一步动作与回复草稿，以结构化字段写进邮件本身。本地全文索引覆盖正文与附件，支持中文子串与字段语法。

**事项**
把一件要推进的事变成对象：背景与目标、行动项、干系人、往来邮件、会议与文件，都在同一页。行动项可以派给 agent 执行；跟进 Agent 替你盯着进展，但只提案，由你逐条采纳。

**人与时间**
通讯录从往来邮件与会议为每个人建档，按邮箱归并成人；AI 画像句句带出处。日历把邮箱日程、事项截止与 agent 排程叠在一张表上，拖动即可改期。

**资料库**（macOS）
邮件附件、对话附件、agent 写下的文档与挂载的本机文件夹，汇成一棵文件树。文件留在原处，每次写入留快照；语义检索在本机运行，agent 的写入范围由服务端强制。

**Agent 团队**
主 Agent 有自己的名字与头像。自定义 Agent 按定时、新邮件、日程变化、会前等触发器醒来，按能力卡授予的权限做事，每次执行都留下完整记录。报告 Agent 生成日报、周报、月报，统计由代码计算。群聊（Labs）让几位 Agent 在同一个群里接力。

**对话与连接**
在任何页面唤起主 Agent，`@` 邮件、事项、资料或其他 Agent；模型可在 18 家服务商之间自由选择。还可以通过 MCP 接入 Notion、Jira、GitHub 等外部服务（Labs），在飞书私聊里对话并用按钮审批，或用按权限签发的密钥把收件箱能力交给你自己的 agent。

## 设计原则

- **本地优先**：邮件正文、附件、索引与文件存在本机，SQLite 是唯一的事实来源；Notion 只是可选镜像。
- **有边界**：每个工具都有审批档位（直接执行 / 先确认 / 禁用）。发送邮件、执行命令、安装技能、修改 Agent 恒需确认；写入范围由服务端判定，不由 agent 自己决定。
- **可追溯**：摘要、画像与报告里的结论都能点回原文；报告中的数字与链接由代码回填，模型给出的编号会被校验。
- **人只管例外**：可逆的日常操作交给 agent，需要判断的事汇总到今日与通知中心。

## 下载与安装

从 [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases/latest) 下载最新版本：

| 平台 | 安装包 | 要求 |
|---|---|---|
| macOS | `.dmg` | macOS 12 及以上，Apple 芯片 |
| Windows | `.exe` | x64 |

桌面 App 内置后端服务，装好即可使用，之后在应用内自动更新。首次启动时，向导会引导你：

1. **选择邮件后端**：DavMail（经 IMAP / SMTP / CalDAV 桥接 Exchange 与 Microsoft 365），或 Windows 上直接使用本机 Outlook（此模式暂不提供日历）；
2. **连接 Notion**（可选）：一键授权，自动复制数据库模板；
3. **配置模型**：添加你自己的模型服务商与密钥。

完整步骤见使用指南的 [安装桌面 App](https://mailagent.chenge.ink/101/install-app/) 与 [首次配置](https://mailagent.chenge.ink/101/onboarding/)。

> [!IMPORTANT]
> DavMail 目前经 Exchange Web Services（EWS）访问 Exchange Online。微软计划自 2026 年 10 月 1 日起默认阻断 EWS，2027 年 4 月 1 日完全退役。迁移进展见 [`roadmap-post-cutover.md`](./docs/reference/architecture/roadmap-post-cutover.md) §5.1。

## 从源码运行

**后端**（Python 3.9+，推荐 3.11+）：

```bash
git clone https://github.com/ChenyqThu/MailAgent.git
cd MailAgent
python3 -m venv venv && source venv/bin/activate
pip install -e ".[cli,dev]"     # 安装后端与 mailagent 命令行
cp .env.example .env            # 硬必填只有 USER_EMAIL，其余见文件内注释
python3 main.py                 # 同步服务（等价于 mailagent serve）
mailagent serve-api             # 本机 API，默认 127.0.0.1:8200
```

**桌面前端**（Electron，pnpm）：

```bash
cd frontend
pnpm install
pnpm dev
```

开发模式下，桌面 App 不托管后端进程，需要先按上面的方式启动两个后端服务。打包、签名与发布流程见 [`packaging-release.md`](./docs/reference/packaging/packaging-release.md)；命令行用法见 [`cli-reference.md`](./docs/reference/cli/cli-reference.md)。

## 架构概览

```
邮件后端（DavMail · 本机 Outlook · AppleScript 备用）
        │  取信 / 回写
        ▼
SQLite：邮件正文与附件的唯一来源 · FTS5 全文索引 · 事项 · 通讯录 · 通知
        │                                     └──▶ Notion（可选镜像）
        ├─ Python 服务：同步、分类、报告、事项、通讯录、资料库、日历
        └─ 内嵌 AI Gateway：对话、工具与审批、自定义 Agent、群聊
                │
     桌面 App（macOS / Windows）· 远程网页 · 飞书 · MCP
```

已读、旗标这类状态修改先写入 SQLite，再由后台异步派发到邮件服务器与 Notion；AppleScript 路径始终保留，作为紧急回切。详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 与 [`architecture-internals.md`](./docs/reference/architecture/architecture-internals.md)。

## 文档

- **使用者**：[官网使用指南](https://mailagent.chenge.ink/101/overview/)，按「开始使用 → 每天的工作 → 工作对象 → AI 与 Agent → 连接与远程」组织。
- **开发者**：[`CLAUDE.md`](./CLAUDE.md) 是项目索引，含文档地图与功能开关表；子系统的常青文档在 [`docs/reference/`](./docs/reference/)，例如：
  - [服务层与写操作](./docs/reference/architecture/service-layer-architecture.md) · [AI Gateway](./docs/reference/llm-agent/ai-sdk-gateway-architecture.md) · [模型服务商](./docs/reference/llm-agent/llm-provider-registry.md)
  - [事项](./docs/reference/matters/matters-architecture.md) · [通讯录](./docs/reference/contacts/contact-directory.md) · [资料库](./docs/reference/library/library-architecture.md) · [通知中心](./docs/reference/notify-center/notification-center.md)
  - [外部连接（MCP）](./docs/reference/llm-agent/mcp-connectors.md) · [飞书对话](./docs/reference/llm-agent/im-feishu-chat.md) · [搜索语法](./docs/reference/search/search-query-syntax.md)
- **官网源码**：[`site/`](./site/)（Astro + Starlight，部署在 Cloudflare Pages）。

## 许可证

MailAgent 以 [GNU General Public License v3.0](./LICENSE) 发布。你可以自由使用、修改和再分发；分发修改后的版本时，须以同一协议公开源代码。
