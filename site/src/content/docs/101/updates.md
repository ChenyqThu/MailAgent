---
title: 更新、升级与卸载
description: 怎么把 MailAgent 升到新版本（应用内更新或手动替换）、怎么单独升级后端 CLI，以及怎么彻底卸载（含清理钥匙串）。
---

这一节讲三件事：把桌面 App 升到新版本、单独升级后端命令行（CLI），以及彻底卸载。升级时你的邮件数据库不会被动，所以升级后不用重新初始化、也不用重走配置向导。

## 升级桌面 App

### 方式一：应用内更新（最省事）

1. App 启动约 10 秒后会自动检查一次更新；有新版本时状态栏右下会提示 **更新就绪**。
2. 进 **设置 → 应用更新**，点 **下载更新**。
3. 下完点 **重启并安装**，App 自动重启完成升级。

:::note[应用内自动安装目前可能装不上]
当前版本是 ad-hoc 签名，应用内的"重启并安装"在部分情况下装不上更新。如果点了没反应，请改用下面的**手动升级**。
:::

### 方式二：手动升级（最可靠）

到 [GitHub Releases](https://github.com/chenyqthu/MailAgent/releases) 下载最新版本的 App，然后**严格按顺序、一步做完再做下一步**：

```bash
# 1. 退出旧版 App
osascript -e 'tell application "MailAgent" to quit'

# 2. 用新版替换 /Applications 里的旧版（等它完全结束）
ditto ~/Downloads/MailAgent.app /Applications/MailAgent.app

# 3. 替换完成后再打开
open /Applications/MailAgent.app
```

:::caution[这三步必须串行，不能抢跑]
**退出 → 替换 → 打开** 三步必须一个接一个，不要在替换还没完成时就去打开 App。如果替换过程中 App 被拉起来，App 包会处于"半成品"状态，启动时报缺少动态库而崩溃（容易被误判成"新版本有 bug"）。真出现这种崩溃，把 `/Applications/MailAgent.app` 删掉、重新完整替换一次即可修复。
:::

升级后第一次启动：

- **跳过配置向导** —— 你的设置和数据都在，App 会识别为"已配置"直接进主界面；
- 后端如需数据库结构升级，会在启动时**自动迁移**，无需你干预。

:::note[用 .app 时记得停掉旧的后台同步]
如果你之前用 PM2 跑着 `mail-sync`，改用桌面 App 后请把它停掉，避免两个进程同时写数据库（双写）。DavMail 桥接进程 `davmail-poc` 不在此列，保留它。
:::

## 单独升级后端 CLI

如果你只想更新命令行后端（不动桌面 App）：

```bash
cd ~/Documents/MailAgent
git pull
source venv/bin/activate
pip install -e ".[cli]" --upgrade
pm2 restart mail-sync
```

升级后用 `mailagent --version` 确认版本，并看一眼 `pm2 logs mail-sync --lines 20 --nostream` 启动日志里没有报错。

## 彻底卸载

```bash
# 1. 退出 App
osascript -e 'tell application "MailAgent" to quit'

# 2. 删掉 App
rm -rf /Applications/MailAgent.app

# 3. 清前端独立数据（AI 对话历史 + 应用内设置）
rm -rf ~/.mailagent/frontend/
rm -rf ~/Library/Application\ Support/MailAgent/

# 4. 清钥匙串里的 3 个密钥
security delete-generic-password -s mailagent-cli-api-key 2>/dev/null || true
security delete-generic-password -s mailagent-llm-api-key 2>/dev/null || true
security delete-generic-password -s mailagent-custom-api-key 2>/dev/null || true
```

如果你连后端和邮件归档一起不要了，再加这一步：

```bash
# 5.（可选）停后端 + 删整个仓库（连同 6 万封邮件的本地数据库一起没了）
pm2 stop mail-sync && pm2 delete mail-sync
rm -rf ~/Documents/MailAgent
```

:::caution[别忘了清钥匙串]
你的 CLI / LLM / Custom 三个密钥是写在 macOS **钥匙串**里的，不在任何文件里。只删 App 不会清掉它们 —— 想彻底干净，第 4 步的 `security delete-generic-password` 不能省。
:::

## 只想重置、不想卸载

如果只是配置乱了、想从头配一遍（但保留邮件数据库），做上面的第 3、4 步即可。

:::caution[绝不要在重置前端时删 sync_store.db]
后端的 `~/Documents/MailAgent/data/sync_store.db` 是邮件同步服务拥有的，里面是你全部邮件的本地副本。重置前端时**千万别碰它** —— 删了等于 6 万封邮件要重新初始化同步。
:::

## 常见疑问

- **升级后启动崩溃 / 报缺库？** 多半是手动替换时三步抢跑导致 App 包损坏，删掉 `/Applications/MailAgent.app` 重新完整替换一次。
- **升级后设置没了？** 正常情况设置会保留；若确实丢了，参见[首次配置](/101/onboarding/)重配一遍。
- **改了后端 Python 代码后桌面 App 没生效？** 桌面 App 内嵌的是打包时的后端，需要重新打包才进包；只改前端界面则不用。
