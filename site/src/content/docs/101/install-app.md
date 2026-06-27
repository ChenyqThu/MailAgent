---
title: 安装桌面 App
description: 从 GitHub Releases 下载对应架构的 .dmg、拖进应用程序、首次启动绕过 Gatekeeper、授予权限，把 MailAgent 桌面 App 装好。
---

桌面 App 是 MailAgent 的主体：三栏收件箱、AI 面板、全文搜索、一键翻译、回复撰写都在这里。**它内嵌了完整的同步后端（自带运行环境，无需另装 Python 或 CLI）**——装好打开就能用，邮件数据存在你自己 Mac 的本地数据库里。

:::note[只需要装这一个 App]
不用先装"后端"。旧版那套 `git clone` + 虚拟环境 + `mailagent` CLI 是给开发者从源码跑的进阶玩法（见 [（开发者）从源码运行后端](/101/install-backend/)）。普通用户**直接下载下面的 App 即可**，后端已经打包在里面、随 App 自动启动。唯一的额外一步是：企业 Exchange / Microsoft 365 邮箱需要单独跑一个 DavMail 邮件源（[下一节](/101/davmail-setup/)讲）。
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

:::note[App 自带后端 · DavMail 要单独留着]
App 内嵌的后端会随 App 自动启动，你不需要再跑任何 `mail-sync` 进程。**唯一需要单独运行的是 DavMail**（企业 Exchange 邮件源桥接，不打进 App）——下一节讲怎么把它跑成后台守护。如果你之前从源码跑过 CLI 后端（PM2 `mail-sync`），用 App 时请先把它停掉（`pm2 stop mail-sync`），避免两个后端同时往同一个数据库写。
:::

## 接下来

- 企业 Exchange / Microsoft 365 邮箱？先配邮件源：**[用 DavMail 接入企业邮箱](/101/davmail-setup/)**。
- 配置 App：**[应用内首次配置](/101/onboarding/)**。
- 开始用：**[日常工作流：收件箱](/101/daily-inbox/)**。
- 装不上 / 打开闪退？看 **[故障排查 FAQ](/101/troubleshooting/)**。

---

> 深入了解：[前端安装手册 INSTALL.md](https://github.com/ChenyqThu/MailAgent/blob/main/frontend/INSTALL.md) · [打包与发布](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/packaging/packaging-release.md)
