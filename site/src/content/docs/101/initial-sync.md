---
title: 首次同步
description: 用 mailagent init 把历史邮件灌进 Notion——一键完整初始化或分步执行，了解大邮箱耗时预期，并在 Notion 里核对同步结果。
---

后端跑起来后，它会**自动同步从此刻起新到的邮件**。但你过去几个月、几年的历史邮件还在邮箱里——首次同步就是把这批存量邮件一次性灌进 Notion，建立可检索的归档。

:::note[前置]
开始前确认：[后端已装好并在运行](/101/install-backend/)，`.env` 五项必填都填了，两个 Notion 数据库字段配齐且已连上 Integration。可以先跑 `mailagent admin health -o json | jq .data.healthy` 确认返回 `true`。
:::

## 一键完整初始化（推荐）

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

## 分步执行（需要更细控制时）

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

## 大邮箱要等多久

首次同步是一次性的重活，耗时取决于邮箱规模和所选后端：

- **小邮箱（几千封）**：通常几分钟到十几分钟。
- **大邮箱（6–7 万封）**：可能要一两个小时甚至更久。MailAgent 的 v3 架构专门为大邮箱优化过，单封邮件获取约 1 秒（AppleScript）或约 236 毫秒（DavMail）。

:::tip[让它安心跑完]
首次同步建议用 PM2 后台跑，或在一个不会关掉的终端里跑，中途可以去忙别的。`init` 是**可断点续传**的——万一中断，用相同命令再跑一次会从上次的进度接着走，不会重头来。进度和报错都会写进日志，`tail -f logs/sync.log` 随时看。
:::

如果 10 分钟过去 Notion 里一封邮件都没出现，多半不是慢、而是卡住了——去 [故障排查 FAQ](/101/troubleshooting/) 对照检查（常见是权限没给全、Integration 没连到数据库、或字段名对不上）。

## 在 Notion 里核对结果

同步跑起来后，打开你的邮件数据库，应该能看到邮件陆续出现，每一行带着主题、发件人、日期、邮箱归属。如果你已经启用了 AI 分类，`AI Priority` / `AI Action` / `AI Review Status` 等字段也会被填上。

几个核对要点：

- **去重正确**：同一封邮件不应出现两次（靠 `Message ID` 去重）。
- **线程成形**：同一话题的回复应通过 `Parent Item` 挂在线程头下。
- **数量大致对得上**：可以用下面的命令看本地数据库里各状态的邮件分布，确认没有大量卡在失败状态：

```bash
sqlite3 data/sync_store.db \
  "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
```

如果看到不少行卡在 `fetch_failed` 或 `failed`，先别慌——系统会按指数退避自动重试。持续不动的话，查日志定位原因。

## 同步之后会发生什么

首次同步完成后，后端就转入**常驻模式**：每隔几秒检测一次邮箱变化，新邮件一到就自动抓取、（如启用）AI 分类、镜像到 Notion。你不需要再手动跑 `init`。日常的标已读、标旗等操作也会双向同步。

接下来：

- 想要图形界面看邮件、用 AI Chat 和搜索？去 **[安装桌面 App](/101/install-app/)**。
- 想了解日常怎么用？看 **[日常工作流：收件箱](/101/daily-inbox/)**。

---

> 深入了解：[README 初始化同步](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [Notion 数据库结构](https://github.com/ChenyqThu/MailAgent/blob/main/README.md) · [CLI 命令全表](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md)
