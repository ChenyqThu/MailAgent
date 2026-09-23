---
title: 安装桌面 App
description: macOS 下载 .dmg（Apple 芯片）、Windows 下载 .exe（x64）；首次打开时系统会提示什么，以及应用内自动更新怎么运作。
---

MailAgent 是一体化的桌面 App：邮件同步、AI 分类、事项、通讯录、资料库、对话全部内置在一个安装包里，不需要另外安装 Python 或命令行。macOS 与 Windows 的安装方式不同，按你的系统选一条路径。

## macOS（Apple 芯片）

### 第 1 步：下载 .dmg

到 [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases) 下载最新版本的 `MailAgent-x.y.z-arm64.dmg`。

:::note[目前只支持 Apple 芯片]
当前版本只发布 Apple 芯片（M 系列）构建，Intel Mac 暂不提供安装包。
:::

### 第 2 步：装到「应用程序」

双击下载的 `.dmg` 文件，把 `MailAgent` 图标拖进 `Applications` 文件夹，然后推出这个磁盘映像。

### 第 3 步：首次打开

MailAgent 使用 Apple Developer ID 签名并经过公证。首次打开时，macOS 通常只会提示「这是从互联网下载的应用，是否要打开」，点 **打开** 即可，不需要额外去系统设置里操作。

之后可以从 Launchpad、Spotlight（`⌘ Space` 输入 "MailAgent"）或 Dock 直接启动。

### 第 4 步：走完首次配置向导

第一次启动会进入配置向导：检测系统权限、选择邮件后端、连接 Notion（可选）、首次同步、按需开启功能。完整走查见 **[应用内首次配置](/101/onboarding/)**。

## Windows（x64）

### 第 1 步：下载 .exe

到 [GitHub Releases](https://github.com/ChenyqThu/MailAgent/releases) 下载最新版本的 `MailAgent-x.y.z-win-x64.exe`。

### 第 2 步：运行安装程序

双击 `.exe`，按提示选择安装目录并完成安装。Windows 安装包目前没有代码签名，安装或首次运行时可能出现 **Windows 已保护你的电脑**（SmartScreen）提示——点 **更多信息**，再点 **仍要运行**。

### 第 3 步：准备好 Outlook（若使用本机 Outlook 后端）

Windows 上推荐的邮件后端是本机**经典版 Outlook**（不是新版「New Outlook」，新版没有自动化接口）。安装前确认：

- 已安装并登录经典版 Outlook；
- 同步期间保持 Outlook 处于运行状态；
- 首次运行 MailAgent 时，Outlook 会弹出「有程序正尝试访问」的授权提示，选 **允许访问** 并选最长时长。

企业 Exchange / Microsoft 365 邮箱也可以改用 DavMail，见 [用 DavMail 接入企业邮箱](/101/davmail-setup/)。

:::caution[Windows 暂不提供日历]
本机 Outlook 后端目前不同步日历。需要日历功能的话，改用 DavMail 后端。
:::

### 第 4 步：走完首次配置向导

同 macOS，见 **[应用内首次配置](/101/onboarding/)**。

## 应用内自动更新

两个平台都会在启动约 10 秒后自动检查一次更新，此后定期复查。有新版本时会在应用内提示下载；下载完成后点一下即可重启并完成安装。数据库如果需要升级，会在启动时自动完成——**升级后无法回退到更早的版本**，细节见 [更新、升级与卸载](/101/updates/)。

## 接下来

- 配置向导详解：**[应用内首次配置](/101/onboarding/)**。
- 企业邮箱用 DavMail：**[用 DavMail 接入企业邮箱](/101/davmail-setup/)**。
- 装不上 / 打开报错？看 **[故障排查 FAQ](/101/troubleshooting/)**。

---

> 深入了解：[打包与发布流程](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/packaging/packaging-release.md)
