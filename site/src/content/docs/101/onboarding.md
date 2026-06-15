---
title: 应用内首次配置
description: 桌面 App 设置面板逐项走查——外观与强调色、收件箱轮询频率、AI 后端、密钥（存进钥匙串）、存储路径、应用更新，以及如何测试 LLM 网关。
---

第一次打开桌面 App，花两分钟把设置过一遍，后面用起来会顺很多。随时可以从侧边栏点 **设置**，或按 `⌘,` 打开设置面板。

下面按设置面板的分区逐项说明。**多数项保持默认就好**，需要你动手的主要是 AI 后端和密钥两块。

## 外观（Appearance）

- **主题模式**：浅色 / 深色 / 跟随系统。默认跟随系统。
- **强调色**：6 种可选——coral（默认）/ cobalt / teal / rose / slate / olive。换一个试试，整个界面的高亮色会随之改变。

主题和强调色的选择会记住，下次打开仍是你选的。

## 收件箱（Inbox）

- **轮询频率**：App 多久检查一次新邮件。可选 5 秒（默认）/ 10 秒 / 30 秒 / 关闭。
- 把轮询关掉也没关系——你仍然可以手动刷新列表。

## AI 后端（AI Backends）

这一块决定 AI 分类和 AI Chat 用哪个"大脑"。MailAgent 支持两种后端，可以只配一个，也可以两个都配后随时切换。

| 字段 | 怎么填 |
|---|---|
| **Notion Agent page_id** | 一个 Notion Custom Agent 的 UUID。留空也行，会用 Custom API 兜底。 |
| **Notion Agent 显示名** | 自定义一个名字（比如 `Jarvis`），只影响界面显示。 |
| **Custom API 端点** | 一个 OpenAI / Anthropic 兼容网关的 base URL，例如 `https://crs.chenge.ink`。 |

### 想用 Notion Agent？先装它的 CLI

Notion Agent 后端依赖一个单独的命令行工具，按下面装好并拿到 page_id：

```bash
pipx install notion-agent-cli
notion-agent init          # 首次会走 Notion OAuth 登录
notion-agent agents list   # 列出你的 agent，复制对应的 UUID
```

把列出来的 UUID 填进 **Notion Agent page_id**。

:::note[两种后端的差别]
**Custom API**（自托管的 OpenAI / Anthropic 兼容网关）支持完整的工具调用，AI Chat 里的跨邮件检索、流式起草都靠它。**Notion Agent** 适合已有 Notion Custom Agent 的用户，但不支持工具调用协议，AI Chat 会自动退回到单轮模式。想体验完整 Chat 能力，建议配 Custom API。详见 [AI Chat 面板](/101/ai-chat/)。
:::

## 密钥（Secrets）

三个密钥槽位。**填进去的值经 keytar 写入 macOS 钥匙串，不会落进任何文件**，安全。

| 槽位 | 用途 | 从哪拿 |
|---|---|---|
| **CLI API Key** | 给写操作（重传 Notion / AI 重跑 / 标记）做鉴权 | 后端 `.env` 里的 `MAILAGENT_CLI_API_KEY` |
| **LLM API Key** | 一键翻译 + Custom API chat 后端 | 你的 LLM 网关 Key（如 `cr_xxx`） |
| **Custom API Key** | 自托管 OpenAI 兼容端点（和 LLM 同 Key 时可复用） | 网关 Key |

填好 LLM 密钥后，点 **测试网关 / Test Gateway** 验证联通。返回成功就说明翻译和 Chat 能用了；失败的话检查 Key 是否正确或过期。

## 存储（Storage）

- **数据库路径**：默认 `~/Documents/MailAgent/data/sync_store.db`。改路径会重启读取链；只接受绝对路径，含 `..` 的路径会被拒。
- **附件根目录**：默认 `~/Documents/MailAgent/data/attachments`。

一般不用动。除非你想把数据放到别的盘。

:::caution
数据库文件是后端 mail-sync 的"家当"——里面是你几万封邮件的归档。改路径前想清楚，别把后端和 App 指到不同的库。
:::

## 应用更新

在 About 旁边的"应用更新"区，可以看到：

- **当前版本**：实时读取，例如 `v0.7.2`。
- **渠道**：GitHub Releases · ad-hoc 签名。
- **检查更新**：手动触发；有新版本时按 **下载更新 → 重启并安装**。

App 启动 10 秒后会自动检查一次更新。开发模式下自动更新禁用，会显示灰色提示。手动升级的完整步骤见 [更新 / 升级 / 卸载](/101/updates/)（本节由其他 Lane 撰写）。

## 配置完成

设置过完，主界面就是你的工作台了。

- 上手日常操作：**[日常工作流：收件箱](/101/daily-inbox/)**。
- 配置遇到问题（比如网关测试失败）：**[故障排查 FAQ](/101/troubleshooting/)**。

---

> 深入了解：[前端安装与首次配置 INSTALL.md §3](https://github.com/ChenyqThu/MailAgent/blob/main/frontend/INSTALL.md)
