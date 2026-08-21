---
title: 使用条款
description: 使用 MailAgent 桌面 App 与配套服务前需要了解的条款——软件性质、免责声明、你的责任与知识产权。
---

## 关于本项目

MailAgent 是一个开源个人项目（[MIT License](https://github.com/ChenyqThu/MailAgent/blob/main/LICENSE)），由个人开发者维护，不代表任何公司或商业实体运营。使用本软件即表示你了解并接受这一点。

## 软件按现状提供

MailAgent 按「现状」（as is）提供，不附带任何明示或默示的担保，包括但不限于适销性、特定用途适用性或不侵权的担保。开发者不保证软件不含缺陷、不中断运行，也不对因使用本软件（含同步、AI 分类、Notion 镜像、飞书通知等任一功能）导致的数据丢失、账号问题或其他损失承担责任。**处理重要邮件或业务数据时，请自行保留必要的备份与核对手段。**

## 你的责任

- 你需要自行确保有权访问所连接的邮箱（Exchange / Microsoft 365 / Mail.app 账户）与所使用的第三方服务（Notion、LLM 网关、飞书等），并遵守这些服务各自的使用条款。
- 你对自己配置进 App 的凭证（API Key、Notion Token 等）负责，包括妥善保管与在需要时及时撤销。
- MailAgent 当前使用的 DavMail 桥接方式在企业环境下是否可用、是否需要 IT 审批，由你与所在组织自行判断。

## Notion OAuth 授权代理

MailAgent 提供的「连接 Notion」一键授权功能依赖一个部署在 MailAgent 运维服务器上的换 Token 代理（数据处理方式见[隐私政策](/privacy/)）。该代理是免费提供的辅助服务，不构成正式的服务等级承诺（SLA）：开发者可能因维护、滥用防护或架构调整，在不另行通知的情况下调整、限流或下线该服务；下线只影响新的一键授权，已经完成授权、已写入本机的配置不受影响，你也可以随时改用手动创建 Notion Integration 的方式继续使用。

## 知识产权

MailAgent 的源代码以 [MIT License](https://github.com/ChenyqThu/MailAgent/blob/main/LICENSE) 开源，具体权利与限制以该协议原文为准。

## 条款变更

本条款随项目演进可能更新，重大变更会体现在版本发布说明里；继续使用即视为接受更新后的条款。

## 联系方式

问题或反馈请通过 [GitHub Issues](https://github.com/ChenyqThu/MailAgent/issues) 提出。
