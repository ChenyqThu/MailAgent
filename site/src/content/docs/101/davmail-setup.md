---
title: 用 DavMail 接入企业邮箱（推荐）
description: DavMail 是什么、为什么把它作为推荐的邮箱源、怎么装与认证（含伪装 Outlook 桌面 client_id 的 OAuth 流程与卡顿 workaround）、怎么确认服务在跑、怎么用 PM2 做成守护进程。
---

如果你的邮箱是**企业 Exchange / Microsoft 365**，我们推荐用 **DavMail** 作为 MailAgent 的邮箱源，而不是默认的 AppleScript。它更快、更稳，且把"富文本回复全部 + 线程折叠 + 多文件夹 + 日历直读"这些能力真正打通。

本页从零讲清 DavMail：是什么、为什么、怎么装、怎么认证、怎么确认、怎么守护。

:::note
本页接在[安装后端](/101/install-backend/)之后。建议你先按那一篇把 `mailagent` CLI、Notion 数据库、`.env` 五项必填配好，再回到这里把后端从 AppleScript 切到 DavMail。
:::

## DavMail 是什么

DavMail 是一个开源的**邮件协议网关**（Java 程序）。它把微软 Exchange 的私有协议（EWS / Graph）翻译成标准的 **IMAP / SMTP / CalDAV / LDAP**，在你本机起一组本地端口：

```
Mail.app / Outlook 私有路径          DavMail 路径
─────────────────────────           ───────────────────────────────
后端 → AppleScript → Mail.app        后端 → 本地 IMAP/SMTP → DavMail → Exchange
（驱动 GUI，单封约 1 秒）             （标准协议，单封约 236 毫秒）
```

对 MailAgent 来说，启用 DavMail 后整条邮箱接入链路**不再依赖 Mail.app 这个 GUI**——后端直接用标准 IMAP 收信、SMTP 发信、CalDAV 读日历。DavMail 在后台常驻，负责跟 Exchange 服务端维持 OAuth 会话。

## 为什么推荐它

| 维度 | DavMail（推荐） | AppleScript（兜底） |
|---|---|---|
| **取信速度** | 单封约 236 毫秒（IMAP `UID FETCH`） | 单封约 1 秒（驱动 Mail.app） |
| **GUI 依赖** | 无——不需要 Mail.app 常开/前台 | 需要 Mail.app 登录好邮箱并保持运行 |
| **富文本回复全部** | 真正可用：`multipart/alternative` + `In-Reply-To`，Outlook 端正确折进原对话 | GUI 注入受限，富文本/线程折叠不稳 |
| **多文件夹同步** | 支持（勾选自定义 Exchange 文件夹并入主链路） | 不支持 |
| **CalDAV 日历直读** | 支持（直接读 Outlook 服务端日历） | 不支持 |
| **系统权限** | 几乎不需要 macOS 自动化/辅助功能权限 | 需要完全磁盘访问 + 自动化 + 辅助功能等一整套 |
| **跨平台** | 标准协议，为将来迁 Linux 部署铺路 | 绑死 macOS + Mail.app |

一句话：**Exchange 用户用 DavMail 体验明显更好**。AppleScript 仍然是零额外组件、随时可用的兜底——任何时候把 `MAILAGENT_BACKEND` 改回 `applescript` 就能回切。

## 前置条件

- 一个 **Java 运行时**（JRE/JDK 8+）。验证：`java -version` 能打印版本号即可。没有的话 `brew install openjdk`（macOS 无需 sudo），或用 DavMail 自带的 `davmail azul` 拉一个内嵌 JRE。
- **DavMail 6.7.0**（jar 包）。本仓库已带在 `davmail-poc/jar/davmail.jar`，也可从 [davmail.sourceforge.net](https://davmail.sourceforge.net/) 下载。
- 一个**企业 Exchange / Microsoft 365 邮箱**，且租户允许 OAuth 登录（见下方第 2 步的 broker check 说明）。

## 第 1 步：写好 `davmail.properties`

DavMail 用一个 `.properties` 文件描述监听端口、OAuth 模式和凭据路径。在 `davmail-poc/config/davmail.properties` 写入：

```properties
# ===== O365 OAuth2 模式 =====
# O365Manual：启动后控制台打印 OAuth URL，浏览器走 MFA 后把 redirect URL 粘回 stdin
davmail.mode=O365Manual
davmail.url=https://outlook.office365.com/EWS/Exchange.asmx

# OAuth token 持久化路径（用绝对路径）
davmail.oauth.tokenFilePath=/绝对路径/MailAgent/davmail-poc/token/token.dat

# ===== 伪装 Outlook for Windows well-known client_id =====
# 用 Outlook 桌面端的公开 client_id 登录，绕开"第三方应用需 IT 审批"这道坎
davmail.oauth.clientId=d3590ed6-52b3-4102-aeff-aad2292ab01c
davmail.oauth.redirectUri=urn:ietf:wg:oauth:2.0:oob

# ===== 监听端口（IMAP + SMTP + CalDAV）=====
davmail.imapPort=1143
davmail.smtpPort=1025
davmail.caldavPort=1080
davmail.ldapPort=0
davmail.popPort=0

# ===== Server 模式（无 tray icon，适合后台常驻）=====
davmail.server=true
davmail.disableUpdateCheck=true

# 本地明文通信（host 内不出物理机），关掉 TLS
davmail.smtpStartTls=false
davmail.imapStartTls=false
```

:::caution[Java Properties 不支持行内注释]
`#` 必须**单独起一行**。写成 `davmail.imapPort=1143  # IMAP` 会把 `  # IMAP` 当成端口值的一部分，端口直接解析失败。
:::

`client_id` 那两行是关键，下一步详解为什么这么填。

## 第 2 步：首次 OAuth 认证（含伪装 Outlook client_id）

### 为什么要伪装 client_id

DavMail 自带的默认 client_id 是它自注册的第三方应用，多数企业租户会把它当独立第三方应用、要求 IT 审批才放行。而 **Outlook for Windows 的公开 client_id（`d3590ed6-52b3-4102-aeff-aad2292ab01c`）** 是微软官方桌面客户端，通常已在租户里被信任——用它登录就能直接拿到 EWS token，绕开审批这道坎。

### 认证流程

先**前台**跑一次 DavMail，看控制台输出：

```bash
cd ~/Documents/MailAgent/davmail-poc/jar
java -jar davmail.jar ../config/davmail.properties
```

1. 控制台打印一条 **OAuth URL**（里面能看到 `client_id=d3590ed6-...` 和你的 `login_hint`）。
2. 复制 URL → 浏览器打开 → 输入**公司账号 + MFA**。
3. 微软可能弹一个 **broker check**："正在尝试登录到 Microsoft Office 吗？仅在从信任的应用商店或网站下载应用时才继续。"——点**继续**即可。
   > 这是因为 client_id 对应 Outlook for Windows，但当前进程不是真 Outlook（没有微软设备签名），触发了应用真实性二次确认。能点"继续"过去，恰恰说明你的租户**没有对这个 client_id 做设备绑定的严校验**。
4. 点继续后会跳到一个**一直 loading 的空白页**（`urn:ietf:wg:oauth:2.0:oob` 这种回调方式现代浏览器已不原生支持，所以页面卡住——这是正常现象）。
5. **从卡住的页面里抠出授权码**：打开浏览器**开发者工具 → Network（网络）标签** → 找最后一个**失败/pending 的请求** → 从它的 Request URL 里复制 `code=...` 这一段参数。
6. 把完整的 `code=...` **粘回 DavMail 控制台的 stdin**，回车。
7. DavMail 用这个 code 换到 access token，跟 Exchange 建立会话，并把凭据落盘到 `token/token.dat`（约 2 KB）。**refresh token 默认 90 天有效**，之后重启免重新授权。

看到控制台不再要求授权、`token.dat` 生成，认证就成了。可以 `Ctrl-C` 停掉这次前台运行，第 5 步再用 PM2 把它做成守护进程。

:::note
DavMail 当前用 Outlook 桌面端 well-known client_id 伪装登录属评估用途，企业生产前建议走公司 IT 审批或直接申请 Graph API 应用；另微软已宣布 O365 的 EWS 协议将于 **2026-10-01 关停**，届时需切换到 Graph 路线。AppleScript 路径不受这两条影响，始终可作兜底。
:::

## 第 3 步：让 MailAgent 用 DavMail（改 `.env`）

回到 `~/Documents/MailAgent/.env`，把后端切到 davmail 并补几项：

```bash
MAILAGENT_BACKEND=davmail
DAVMAIL_USER=your@company.com          # 通常同 USER_EMAIL
DAVMAIL_CIPHER_KEY=任意一串固定字符串    # token 加密 key，见下方警告
DAVMAIL_IMAP_PORT=1143                  # 与 davmail.properties 一致
DAVMAIL_SMTP_PORT=1025
DAVMAIL_ROOT=/绝对路径/MailAgent/davmail-poc   # 打包桌面 App 时必填绝对路径
```

:::caution[`DAVMAIL_CIPHER_KEY` 所有 client 与所有重启之间必须完全一致]
DavMail 用**连接时 client 提供的 AUTH 密码**作为加密 `token.dat` 的 key。MailAgent 的多个组件（mail-sync、CLI、前端）都会连同一个 DavMail，**它们必须用同一个 cipher key**，否则解不开凭据，报 `BadPaddingException` 然后强制重新走 OAuth。这个 key 可以是任意字符串，但一旦定下，所有组件、所有重启都不能变。
:::

改完重启 mail-sync 让新后端生效：

```bash
pm2 restart mail-sync
```

## 第 4 步：确认 DavMail 在跑

```bash
# 1) 端口通不通（IMAP / SMTP）
nc -zv localhost 1143      # IMAP，期望 succeeded
nc -zv localhost 1025      # SMTP，期望 succeeded

# 2) DavMail 日志无认证错误
tail -n 30 ~/Documents/MailAgent/davmail-poc/logs/davmail.log

# 3) token 已落盘且较新
ls -la ~/Documents/MailAgent/davmail-poc/token/token.dat

# 4) 用 IMAP 实测能登录（把 KEY 换成你的 DAVMAIL_CIPHER_KEY）
python3 - <<'PY'
import imaplib
m = imaplib.IMAP4("localhost", 1143)
m.login("your@company.com", "KEY")   # 密码填 DAVMAIL_CIPHER_KEY
print(m.list()[0])                    # OK 即认证链路通
m.logout()
PY
```

再确认 MailAgent 后端整体健康：

```bash
mailagent admin health -o json | jq .data.healthy   # 期望 true
tail -f logs/sync.log                                # 不应有 ERROR 行
```

## 第 5 步：把 DavMail 做成守护进程（PM2）

DavMail 需要一直在后台跑，MailAgent 才能随时收发。用 PM2 让它常驻、开机自启、崩溃自拉起。**直接守护 `java` 进程**（不要靠终端前台）：

```bash
pm2 start "$(which java)" --name davmail-poc -- \
  -Xmx512M -Dsun.net.inetaddr.ttl=60 \
  -jar ~/Documents/MailAgent/davmail-poc/jar/davmail.jar \
  ~/Documents/MailAgent/davmail-poc/config/davmail.properties

pm2 save        # 固化进程列表
pm2 startup     # 按提示执行一次，开机自启
```

常用维护命令：

```bash
pm2 status                      # 看 davmail-poc 是否 online
pm2 logs davmail-poc            # 跟踪 DavMail 输出
pm2 restart davmail-poc         # 重启（改了 properties 后）
```

:::tip[启动顺序]
DavMail 要先于 mail-sync 起来。两个都交给 PM2 并 `pm2 save` 后，开机时 PM2 会一起拉起，顺序无需手动管。
:::

### token 失效时怎么办

`token.dat` 里的 refresh token 默认 90 天有效，DavMail 会自动续期，正常不用管。但如果你的设备被管理员**移出租户**，refresh token 会被**永久作废**（日志报 `AADSTS700003`）——这时自动续期救不回来，需要**重新走一遍第 2 步的交互认证**：删掉旧 `token.dat`，前台跑一次 DavMail 重新授权，再 `pm2 restart davmail-poc`。

> 备选守护方式：DavMail 6.7 自带的 `davmail` 启动脚本（`davmail <properties 路径> -notray`）或社区 Docker 镜像也能跑，但 PM2 守护 native `java` 进程是本项目验证过的稳定方式。

## 接下来

DavMail 跑通后，回到 **[首次同步](/101/initial-sync/)** 把历史邮件灌进 Notion，或继续 **[安装桌面 App](/101/install-app/)**。

---

> 深入了解：[安装后端](/101/install-backend/) · [架构内核（Sprint 16 双后端）](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/architecture-internals.md) · [EWS 关停迁移路线图 §5.1](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/architecture/roadmap-post-cutover.md)
