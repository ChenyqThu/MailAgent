---
title: 首次同步
description: 装好 App 并配好邮件源后，后端会自动开始同步邮件；大邮箱进度在 App 里可见，不需要手动跑任何命令。
---

装好桌面 App、完成[应用内首次配置](/101/onboarding/)后，App 内嵌的后端会**自动开始同步**——先同步从此刻起新到的邮件，并按需把历史邮件灌入本地库。进度在 App 主界面可见，你不需要手动跑任何命令。

## App 自动同步

后端启动后，它会：

1. **实时同步新邮件**：每隔几秒检测一次邮箱变化，新邮件一到就自动抓取、（如启用）AI 分类。
2. **灌入历史邮件**：在后台把你过去几个月、几年的存量邮件一次性拉进本地库，建立可检索的归档。

整个过程对你透明——打开 App 就能看邮件，历史邮件会陆续出现，不需要等同步完才能用。

## 在 App 里核对结果

同步跑起来后，打开 MailAgent 的邮件列表，应该能看到邮件陆续出现，每一行带着主题、发件人、日期、邮箱归属。如果启用了 AI 分类，优先级 / 动作建议等字段也会被填上。

几个核对要点：

- **去重正确**：同一封邮件不应出现两次（靠 `Message ID` 去重）。
- **线程成形**：同一话题的回复应归属到同一线程。
- **全文搜索可用**：用 `⌘K` 打开搜索，试着搜一封你知道有的邮件，应该能找到。

（若启用了 Notion 镜像）也可以打开你的 Notion 邮件数据库核对：邮件应陆续出现，带 `Message ID`、`Thread ID`、`AI Priority` 等字段。

## 大邮箱要等多久

首次同步是一次性的重活，耗时取决于邮箱规模和所选后端：

- **小邮箱（几千封）**：通常几分钟到十几分钟。
- **大邮箱（6–7 万封）**：可能要一两个小时甚至更久。MailAgent 的 v3 架构专门为大邮箱优化过，单封邮件获取约 1 秒（AppleScript）或约 236 毫秒（DavMail）。

历史邮件同步在后台进行，不影响你实时查看新邮件。

---

## 开发者：用 CLI 手动初始化（从源码运行时）

:::note[普通用户不需要这一节]
如果你用的是桌面 App，后端已自动处理同步，无需手动跑 CLI。以下内容仅适用于从源码运行后端的开发者。
:::

### 一键完整初始化（推荐）

绝大多数情况，一条命令搞定：

```bash
source venv/bin/activate
mailagent init all --yes
```

`init all` 会按正确顺序跑完整套初始化流程，`--yes` 跳过逐步确认。它内部依次完成：抓取邮件缓存 → 分析 → 修正属性 → 修复关键问题 → 重建线程父子关系 → 同步新邮件。

如果你想先限定抓取规模（比如只灌最近的 3000 封收件 + 500 封发件），可以先单独跑缓存抓取，再跑 `init all`：

```bash
mailagent init fetch-cache --inbox-count 3000 --sent-count 500
mailagent init all --yes
```

### 分步执行（需要更细控制时）

`init` 拆成 7 个子动作，必要时可单独跑某一步（例如某步失败后续跑）：

| 子动作 | 做什么 |
|---|---|
| `fetch-cache` | 抓取邮件到本地缓存（可用 `--inbox-count` / `--sent-count` 限规模） |
| `analyze` | 分析缓存里的邮件 |
| `fix-properties` | 修正 Notion 页面属性 |
| `fix-critical` | 修复关键问题 |
| `update-parents` | 重建线程的父子关联（`Parent Item`） |
| `sync-new` | 同步新邮件到 Notion |
| `all` | 按上面顺序跑完全部 |

例如只重建线程关系：

```bash
mailagent init update-parents --yes
```

:::tip[让它安心跑完]
首次同步建议用 PM2 后台跑，或在一个不会关掉的终端里跑，中途可以去忙别的。`init` 是**可断点续传**的——万一中断，用相同命令再跑一次会从上次的进度接着走，不会重头来。进度和报错都会写进日志，`tail -f logs/sync.log` 随时看。
:::

如果 10 分钟过去邮件一封都没出现，多半不是慢、而是卡住了——去 [故障排查 FAQ](/101/troubleshooting/) 对照检查（常见是权限没给全、Integration 没连到数据库、或字段名对不上）。

也可以用 SQL 查本地数据库里各状态的邮件分布，确认没有大量卡在失败状态：

```bash
sqlite3 data/sync_store.db \
  "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
```

---

## 接下来

- 想了解日常怎么用？看 **[日常工作流：收件箱](/101/daily-inbox/)**。
- 找不到某封邮件？看 **[全文搜索](/101/search/)**。

---

> 深入了解：[README 初始化同步](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [CLI 命令全表](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md)
