---
title: 隐私政策
description: MailAgent 如何处理邮件数据、Notion 授权信息与本地配置——本地优先架构下各类数据的处理方式说明。
---

:::note[适用范围]
本页说明官方分发的桌面 App（含内置后端）与配套的 Notion OAuth 授权代理如何处理数据。如果你从源码自行部署 mail-sync 后端，或用自己创建的 Notion internal integration（不走一键授权），数据处理方式完全在你自己的掌控之下，本页只描述官方分发渠道的默认行为。
:::

## 本地优先：邮件数据不上传开发者服务器

MailAgent 是一个本地优先的桌面应用。邮件正文、附件、AI 分类结果都存在你自己 Mac 上的本地数据库（SQLite），由 App 直接与你配置的邮箱服务（Exchange / Microsoft 365 经 DavMail，或 macOS 自带 Mail.app）读写。这条链路里**没有开发者运营的服务器**——你的邮件内容不会经过、也不会存储在 MailAgent 开发者控制的任何机器上。

## 你主动开启的可选功能

下面这些功能默认关闭，或需要你自行配置凭证才会生效，只有你启用后才会把数据发往对应的第三方服务，且都是**你自己的账号、你自己的数据**：

| 功能 | 数据去向 | 由谁控制 |
|---|---|---|
| Notion 镜像同步 | 你自己的 Notion 工作区 | 你的 Notion 账号 |
| AI 分类 / AI Chat | 你配置的 LLM 网关（Anthropic 兼容 API 或 Notion Custom Agent） | 你自己的 API Key |
| 飞书通知 | 你自建的飞书应用 | 你自己的飞书凭证 |
| 灵动岛通知 | 同一台 Mac 上的本地进程间通信，不出网 | 本机 |
| 运行统计上报 | 仅当你显式配置 `STATS_REPORT_URL` 时生效，上报聚合的运行状态（如同步计数、健康心跳），不含邮件正文或附件 | 你的选择，默认未配置 |

## Notion OAuth 授权

「连接 Notion」是一键授权入口，用来替代手动创建 Notion Integration、复制 Token 的步骤。它的数据处理方式：

- 授权本身发生在 Notion 官方页面，MailAgent 不经手你的 Notion 账号密码。
- 用授权码换取 Access Token 这一步，经由一个部署在 MailAgent 运维的服务器上的**无状态代理**完成——作用仅仅是让集成密钥（`client_secret`）不需要打进桌面 App 安装包。该代理**不写入任何数据库、不保存你的 Access Token**，日志只记录请求结果、来源 IP 与时间戳，用于限流与故障排查；授权码与 Token 本身不进日志。
- 换回的 Access Token 只保存在你自己 Mac 的本地配置文件里，与手动创建 Integration 得到的 Token 存放方式完全一致。
- MailAgent 不会主动刷新或延长这个授权——如果你在 Notion 里撤销了对 MailAgent 的授权，同步会在下次调用时失败，App 会提示你重新连接。

## 你的控制权

- **随时撤销**：去 Notion 的 **设置 → 我的连接**（Settings → Connections）可以随时收回对 MailAgent 集成的授权。
- **随时移除本机配置**：App 设置页提供「从本机移除连接」，会清除本机保存的 Token、数据库 ID 与工作区信息（不会代你去 Notion 那边撤销授权，需要你自己按上一条操作）。
- **随时关闭各功能**：AI 分类、Notion 镜像、飞书通知等均可在设置页单独关闭，关闭后对应的数据流转随之停止。
- **卸载即清空**：卸载 App 会移除本机存储的邮件数据库与配置；这些数据从未离开过你的设备，也不存在需要联系开发者"删除云端数据"的场景。

## 变更

本页随功能演进更新，重大变更会体现在版本发布说明里。

## 联系方式

MailAgent 是一个开源个人项目。问题或反馈请通过 [GitHub Issues](https://github.com/ChenyqThu/MailAgent/issues) 提出。
