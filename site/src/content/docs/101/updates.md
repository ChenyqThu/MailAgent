---
title: 更新、升级与卸载
description: 应用内自动更新怎么运作、手动升级的正确步骤、数据库升级后为什么不能回退，以及怎么彻底卸载或重置。
---

这一页讲三件事：把桌面 App 升到新版本、数据库升级的不可回退性，以及怎么卸载或重置。升级时你的邮件数据不会被清空，升级后也不需要重走配置向导。

## 应用内自动更新

App 启动约 10 秒后会自动检查一次更新，此后定期复查。macOS 与 Windows 都支持自动更新：

1. 有新版本时，设置里会出现提示。
2. 点 **下载更新**。
3. 下载完成后点 **重启并安装**，App 会自动重启完成升级。

:::note[Windows 安装包目前没有代码签名]
自动更新会照常下载并安装新版本；如果系统弹出 SmartScreen 一类的确认提示，按照与首次安装时相同的方式确认即可（见 [安装桌面 App](/101/install-app/)）。
:::

## 手动升级

如果应用内更新没有反应，或者你想直接安装某个特定版本，到 [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases) 下载对应平台的安装包。

### macOS

```bash
# 1. 退出旧版 App
osascript -e 'tell application "MailAgent" to quit'

# 2. 用新版替换 /Applications 里的旧版（等它完全结束）
ditto ~/Downloads/MailAgent.app /Applications/MailAgent.app

# 3. 替换完成后再打开
open /Applications/MailAgent.app
```

:::caution[这三步必须串行，不能抢跑]
**退出 → 替换 → 打开**必须一步做完再做下一步。如果替换过程中 App 被拉起来，App 包会处于「半成品」状态，启动时报缺少动态库而崩溃。真出现这种崩溃，把 `/Applications/MailAgent.app` 删掉、重新完整替换一次即可修复。
:::

### Windows

双击下载的 `.exe` 运行安装程序即可原地升级，不需要先手动卸载旧版本。

## 数据库升级：单向，不能回退

MailAgent 的本地数据库结构会随版本演进。**升级安装并启动新版本后，数据库会自动完成结构迁移，且这个迁移是单向的**——之后无法用旧版本的 App 再打开这份数据库。

:::caution[升级前请确认]
如果你需要保留回退到旧版本的可能性，请在升级前备份数据目录（见下方「数据在哪里」），或先在测试环境验证新版本。大邮箱首次启动的数据库迁移可能耗时较久，请等待迁移完成，不要中途强制退出。
:::

## 数据在哪里

打包版 App 的数据保存在系统的应用数据目录里，不在 `~/Documents` 下：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/mailagent-frontend/` |
| Windows | `%APPDATA%\mailagent-frontend\` |

里面包含邮件数据库（`data/sync_store.db`）、附件、日志和配置文件。重装或修复问题时，不要删除这个目录，否则等于清空全部本地邮件归档。

## 彻底卸载

### macOS

```bash
# 1. 退出 App
osascript -e 'tell application "MailAgent" to quit'

# 2. 删掉 App 本体
rm -rf /Applications/MailAgent.app

# 3. 删数据目录（邮件归档、索引、附件、配置全部在这里，删除后不可恢复）
rm -rf ~/Library/Application\ Support/mailagent-frontend/

# 4.（可选）清理钥匙串里保存的密钥
security delete-generic-password -s ink.chenge.mailagent -a cli-api-key 2>/dev/null || true
security delete-generic-password -s ink.chenge.mailagent -a llm-api-key 2>/dev/null || true
security delete-generic-password -s ink.chenge.mailagent -a llm-translate-api-key 2>/dev/null || true
security delete-generic-password -s ink.chenge.mailagent -a custom-api-key 2>/dev/null || true
security delete-generic-password -s MailAgent-SkillSecrets 2>/dev/null || true
```

### Windows

在「设置 → 应用」里卸载 MailAgent，再手动删除数据目录 `%APPDATA%\mailagent-frontend\`（同样会清空全部本地邮件归档）。

## 只想重置，不想卸载

如果只是配置乱了、想从头配一遍，删除数据目录里的 `.env`（配置文件）后重启 App 即可重新走一遍首次配置向导；**不要**删除 `data/sync_store.db`，否则邮件需要重新初始化同步。

## 常见疑问

- **升级后启动崩溃 / 报缺库？** 多半是 macOS 手动替换时「退出 → 替换 → 打开」三步抢跑导致 App 包损坏，删掉 `/Applications/MailAgent.app` 重新完整替换一次。
- **升级后设置没了？** 正常情况下设置会保留；如果确实丢了，按 [首次配置](/101/onboarding/) 重新配一遍即可，邮件数据不会因此丢失。
- **能不能先备份再升级？** 可以：升级前复制一份数据目录（见上表），保留到确认新版本运行正常为止。数据库一旦被新版本迁移就不能再被旧版本打开，所以备份要在升级**之前**做。
