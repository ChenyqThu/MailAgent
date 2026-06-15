---
title: 安装桌面 App
description: 从 GitHub Releases 下载对应架构的 .dmg、拖进应用程序、首次启动绕过 Gatekeeper、授予权限，把 MailAgent 桌面 App 装好。
---

桌面 App 是后端的图形界面：三栏收件箱、AI 面板、全文搜索、一键翻译、回复撰写都在这里。它读取后端写好的本地数据库，并通过后端执行写操作。

:::caution[先有后端，再装 App]
桌面 App 不能脱离后端独立工作——它读的是后端维护的 `data/sync_store.db`。如果还没跑通后端，先回到 **[安装后端](/101/install-backend/)** 与 **[首次同步](/101/initial-sync/)**。后端没在跑时，App 打开会提示找不到数据库。
:::

## 第 1 步：下载对应架构的 .dmg

到 [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases) 找最新版本，按你的 Mac 处理器下载：

- **Apple Silicon**（M1 / M2 / M3 / M4 Mac）：`MailAgent-x.y.z-arm64.dmg`
- **Intel Mac**：`MailAgent-x.y.z-x64.dmg`

不确定自己是哪种？点 **苹果菜单  → 关于本机**，看"芯片 / 处理器"：写 `Apple M*` 的是 Apple Silicon（选 arm64），写 `Intel Core` 的选 x64。

## 第 2 步：装到"应用程序"

1. 双击下载的 `.dmg` 文件。
2. 把 `MailAgent` 图标拖到 `Applications`（应用程序）文件夹。
3. 拖完可以推出（弹出）那个 .dmg 磁盘映像。

## 第 3 步：首次启动，绕过 Gatekeeper

MailAgent 目前是 **ad-hoc 签名**（没有 Apple 付费的 Developer ID），所以第一次打开会被 macOS 的 Gatekeeper 拦下。这是预期行为，按下面做即可：

1. 在"应用程序"里找到 `MailAgent`，**右键点击 → 打开**。
2. 弹窗里再点 **打开 / 仍然打开**。

:::tip
只有**第一次**需要右键打开。信任之后，以后从 Launchpad、Spotlight（`⌘ Space` 输入 "MailAgent"）或 Dock 直接启动即可。如果右键也被拦，去 **系统设置 → 隐私与安全性**，页面下方会出现"仍要打开 MailAgent"的按钮，点它。
:::

## 第 4 步：授予权限

首次启动时，macOS 会弹出几个权限请求，点 **允许**：

- **文稿（Documents）文件夹访问**：App 默认从 `~/Documents/MailAgent/data/` 读数据库。
- **自动化权限**：执行标已读 / 旗标 / 起草草稿等操作时用到。

如果某个权限当时没给、后来需要补，去 **系统设置 → 隐私与安全性 → 自动化**，勾上 `MailAgent` 下的 `Mail` 子项。

### 完全磁盘访问（可选但推荐）

数据库默认在 `~/Documents/MailAgent/data/`，上面的"文稿文件夹访问"通常就够了。但如果你把数据库路径改到了 `~/Library/...` 等受保护目录，需要手动加完全磁盘访问：

**系统设置 → 隐私与安全性 → 完全磁盘访问权限 → +**，添加 `MailAgent.app`。

## 启动后你会看到什么

第一次打开 App，它会引导你完成应用内的首次配置（外观、收件箱轮询、AI 后端、密钥等）。这一段在下一节详细走查。

配置完成后，主界面就是三栏收件箱：左侧文件夹与 AI Agents、中间邮件列表、右侧详情与 AI 字段面板。

:::note[App 与后端 CLI 别同时写]
当你用桌面 App 时，请确保后端的 PM2 `mail-sync` 进程**已停止**（`pm2 stop mail-sync`），避免 App 和 CLI 同时往数据库写引发冲突。如果你用的是 DavMail，`davmail-poc` 这个桥接进程要保留（它不打进 App）。
:::

## 接下来

- 配置 App：**[应用内首次配置](/101/onboarding/)**。
- 开始用：**[日常工作流：收件箱](/101/daily-inbox/)**。
- 装不上 / 打开闪退？看 **[故障排查 FAQ](/101/troubleshooting/)**。

---

> 深入了解：[前端安装手册 INSTALL.md](https://github.com/ChenyqThu/MailAgent/blob/main/frontend/INSTALL.md) · [打包与发布](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/packaging/packaging-release.md)
