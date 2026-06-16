# network-intel 邮件发送能力 — 接入 Handoff

> 交付对象：network-intel（nintel，daily.omada.ink）项目组 / Claude Code
> 来源：MailAgent 项目（lucien.chen 的 macOS 邮件同步系统，含 davmail Exchange 桥）
> 目标：让 network-intel 具备「定时 + 手动」发送舆情洞察报告邮件的能力，**或**先创建草稿由人工确认后手动发送（更保险）。
> 日期：2026-06-16
>
> **本文件自包含**——可直接复制进 network-intel 仓库（建议落 `docs/EMAIL-SENDING-HANDOFF.md`），不需要回看 MailAgent 源码即可实现。文末附录给出 MailAgent 侧参考实现的精确指针（文件:行）以备深挖。

---

## 0. TL;DR（先看这段）

- **你已经有现成的邮件 HTML**：`nintel.engine.render.render_email(report) -> str` 已经把 contract 渲染成邮件客户端安全的表格版 HTML（`daily_email.html.j2` / `weekly_email.html.j2`）。**缺的只是「传输」**——把这段 HTML 装进 MIME 然后发出去 / 存成草稿。
- **推荐方案：直接走 davmail 的 SMTP（发送）+ IMAP APPEND（草稿），用 Python 标准库 `smtplib` / `imaplib` 即可，不依赖 MailAgent 的任何 HTTP API，不需要 MailAgent 改一行代码。** davmail 把本机 SMTP/IMAP 桥接到 Exchange（O365），发出去的邮件就是从你真实的 Omada 邮箱（`lucien.chen@omadanetworks.com`）寄出，落 Sent、对方看到的就是公司邮箱身份。
- **「能不能跨网络」的答案**：davmail **默认只听 127.0.0.1**，但 MailAgent 这台 Mac 上的 davmail 实例已经配成 `bindAddress=0.0.0.0 + allowRemote=true`，所以**同一 LAN 内**的 mac-mini 是能连过去的。不过更干净的做法是**在 mac-mini 本地再跑一个 davmail**（loopback，零跨网络、零跨机依赖）——见 §4.1 的两种拓扑。
- **认证极简**：davmail 的 SMTP/IMAP 用户名 = 邮箱地址，**密码 = davmail 的 cipher key（一个你自己设的字符串），不是 O365 密码**。详见 §4.2。
- **MailAgent 的 HTTP `/api/email/send` 和 `/api/email/draft` 不适合你**：它们是「回复/转发已有邮件」语义，强制要求一个已存在邮件的 `internalId`，**没有「从零撰写新邮件」的路径**；而且远程调用要过 Cloudflare Access（机器对机器拿不到带 email 的 JWT）。详见附录 A。
- **⚠️ 死硬约束**：davmail 这条路有明确的「保质期」——**Microsoft EWS 将于 2026-10-01 关停**，davmail 6.7 仍走 EWS。也就是说这套发送方案大约还能稳跑 3.5 个月，之后必须迁移到 Microsoft Graph。请把它当**过渡桥**，并行规划长期方案（§6）。

---

## 1. 背景与目标

network-intel 当前形态（来自仓库实测）：
- Python FastAPI 应用，pm2 跑 `nintel-api`(:8000) + `nintel-web`(:5173)，Cloudflare tunnel `daily.omada.ink → :5173 → /api → :8000`。
- 报告**生成是独立 batch 作业**，launchd/cron 调度：日报 08:30 `build --type daily --publish`，周报周一 09:00 `build --type weekly`（落 `data/pending/` 等人工 approve）。
- CLI 入口 `python -m nintel.pipeline`（`build` / `approve` / `render` / `kb` 子命令，argparse）。
- **已有邮件渲染**：`engine/render.py::render_email(report)` 输出完整 HTML；`pipeline.py` 已有 `render` 子命令把 HTML 打到 stdout。

需求：在此之上加「发送」——
1. **定时**：日报/周报生成后自动发给一组收件人。
2. **手动**：随时手动触发发送某份报告。
3. **保险模式**：先生成**草稿**进你的邮箱草稿箱，你在 Outlook/OWA 里看一眼再手动点发送。

---

## 2. 现状盘点：MailAgent 这边能提供什么

MailAgent 用 **davmail** 作为主邮件后端：davmail 是一个 JVM 进程，对外暴露**本机标准 IMAP/SMTP/CalDAV**，内部用 OAuth 桥接到 Exchange（O365）的 EWS。MailAgent 自己所有的收发、草稿、归档都是走这个本机 IMAP/SMTP 完成的。

对 network-intel 而言，有两个「接口面」可选：

| 接口面 | 是什么 | 适合裸发报告邮件？ |
|---|---|---|
| **davmail 本机 SMTP/IMAP** | 标准协议端口（SMTP 1025 / IMAP 1143），用 `smtplib`/`imaplib` 直连 | ✅ **适合**——这就是为发新邮件设计的标准协议 |
| **MailAgent serve-api HTTP**（`mail.chenge.ink/app` 背后那套 FastAPI） | `/api/email/send`、`/api/email/draft` 等 | ❌ **不适合**——这俩是「回复/转发已有邮件」，强制要 `internalId`，无裸发路径；远程鉴权也过不去（附录 A） |

所以下面只展开 davmail 方案。

---

## 3. 方案对比

| # | 方案 | 复用 Exchange 身份 | 跨网络/跨机依赖 | 改 MailAgent 代码 | 草稿支持 | 风险/成本 | 评价 |
|---|---|---|---|---|---|---|---|
| **A** | **mac-mini 本地跑一个独立 davmail**，nintel → 127.0.0.1 SMTP/IMAP | ✅ | 无（loopback） | 否 | ✅ IMAP APPEND | 需在 mac-mini provision davmail + 一次 OAuth 引导；含 EWS/PoC 风险 | **⭐ 首推**：最解耦、最稳、nintel 团队完全自持 |
| **B** | 复用 MailAgent 这台 Mac 已开的 davmail（`0.0.0.0`），nintel → `<mac的LAN-IP>` SMTP/IMAP | ✅ | 同 LAN + Mac 常开 | 否 | ✅ IMAP APPEND | **必须共用同一 cipher key**，否则会污染 token（§4.2 红线）；和 MailAgent 抢同一实例/token | 最快上手，但有跨机依赖 + token 争用风险 |
| **C** | 走 MailAgent serve-api HTTP `/api/email/*` | ✅ | 跨机 + 要过 CF Access | **是**（要新增裸发端点） | 需新增 | 端点语义/鉴权都要改造（附录 A） | 仅当你还想顺带要「落 Sent + 同步 Notion」时才值得 |
| **D** | nintel 自己接 Microsoft Graph `sendMail` 或 SES/Resend（独立邮箱/域名） | 取决于配置 | 无（云 API） | 否 | Graph 支持 | 需正式 app 注册 / 域名 / 独立凭据 | **长期正解**，去 davmail/EWS 风险；但要 IT 走审批，起步成本高 |

**结论**：**先用方案 A 把功能跑起来**（过渡桥），**同时把方案 D 列入路线图**（EWS 2026-10 关停前迁移）。方案 B 是「今天就要、且和 Mac 同 LAN」时的快捷替代。方案 C 不推荐，除非有「发件也要进 MailAgent 的统一视图/Notion」的强需求。

---

## 4. 推荐方案详解（A / B）：davmail SMTP 发送 + IMAP APPEND 草稿

### 4.1 拓扑

```
方案 A（首推，mac-mini 本地 davmail，零跨网络）
┌────────────────────────── mac-mini ──────────────────────────┐
│  network-intel (nintel.pipeline)                             │
│        │ smtplib → 127.0.0.1:1025 (发送)                      │
│        │ imaplib → 127.0.0.1:1143 (APPEND 草稿)               │
│        ▼                                                     │
│  davmail JVM (本地新实例, 自己的 token.dat)                    │
│        │ OAuth + EWS                                          │
└────────┼─────────────────────────────────────────────────────┘
         ▼
   Exchange / O365  →  从 lucien.chen@omadanetworks.com 寄出, 落 Sent

方案 B（复用 Mac 的 davmail, 同 LAN）
  mac-mini: nintel ──smtplib/imaplib──▶ <Mac-LAN-IP>:1025 / :1143
  Mac:      davmail(已 bindAddress=0.0.0.0, allowRemote=true) ──▶ Exchange
  ⚠️ nintel 必须用与 MailAgent 完全相同的 cipher key（见 §4.2 红线）
```

### 4.2 认证模型（关键，先理解再写代码）

davmail 的本机 SMTP/IMAP 登录非常简单：

```
SMTP AUTH / IMAP LOGIN:
  username = <你的邮箱>            例: lucien.chen@omadanetworks.com
  password = <davmail 的 cipher key>   一个你自己设定的字符串, **不是 O365 密码**
```

- davmail 在 O365Manual 模式下，用一个 **StringEncryptor 口令（cipher key）** 加密本地缓存的 OAuth refresh token（`token.dat`）。**本机 IMAP/SMTP 登录的「密码」就是这个 cipher key。** 真正的 O365 认证（账号/MFA）只在**首次 OAuth 引导**时在浏览器里做一次，之后都靠缓存 token 自动刷新。
- MailAgent 侧这个值来自 env `DAVMAIL_CIPHER_KEY`；PoC 默认值是 `mailagent-poc-shared-key`（仅 PoC/dev）。

> **🔴 红线（方案 B 必读）**：连**同一个** davmail 实例的所有客户端**必须用同一个 cipher key**。如果 nintel 用了和 MailAgent 不同的 key 去连 Mac 上那个 davmail，会触发 `BadPaddingException` → **OAuth token 被搞坏 → MailAgent 和 nintel 一起认证失败**，需要重新交互式 OAuth。
> **所以方案 A（mac-mini 独立实例 + 独立 token.dat + 独立 key）天然规避这个坑**——你自己挑一个 key，和 MailAgent 互不干扰。

> 关于「发件人身份」：davmail 通过你认证的邮箱发信，**From 只能是该邮箱本身**（Exchange 会校验/改写，不能伪造任意 From）。报告邮件的发件人 = 你登录的 Omada 邮箱。

### 4.3 在 mac-mini provision davmail（方案 A）

> 方案 B 跳过本节，直接用 Mac 上现成的 davmail（拿 LAN IP + 它的 cipher key 即可）。

1. **装 Java + 下 davmail**（6.7.0）。davmail 是单 jar：`java -jar davmail.jar <properties 路径>`。

2. **写 `davmail.properties`**（放 nintel 能管的目录，比如 `apps/api/infra/davmail/davmail.properties`）：

   ```properties
   davmail.mode=O365Manual
   davmail.url=https://outlook.office365.com/EWS/Exchange.asmx
   davmail.oauth.tokenFilePath=/Users/<you>/network-intel/apps/api/infra/davmail/token.dat
   # PoC well-known Outlook client id（与 MailAgent 同；正式上线需走 IT 申请自有 app 注册）
   davmail.oauth.clientId=d3590ed6-52b3-4102-aeff-aad2292ab01c
   davmail.oauth.redirectUri=urn:ietf:wg:oauth:2.0:oob
   # 本地端口（独立实例，避免和别的 davmail 撞端口即可）
   davmail.imapPort=1143
   davmail.smtpPort=1025
   davmail.caldavPort=0
   davmail.ldapPort=0
   davmail.popPort=0
   # 方案 A：只听 loopback 最安全
   davmail.bindAddress=127.0.0.1
   davmail.allowRemote=false
   davmail.server=true
   davmail.disableUpdateCheck=true
   # 明文（loopback 无需 TLS）
   davmail.smtpStartTls=false
   davmail.imapStartTls=false
   davmail.imapAutoExpunge=false
   davmail.logFilePath=/Users/<you>/network-intel/apps/api/infra/davmail/davmail.log
   log4j.logger.davmail=WARN
   ```

3. **首次 OAuth 引导（一次性，交互）**：启动 davmail 后，用任意 IMAP 客户端（或下面的 smoke 脚本）发起一次登录，username = 邮箱、password = **你这次自己定的 cipher key**（记住它，后面 nintel 一直用这个）。davmail 会在日志/控制台打印一个 O365 授权 URL → 浏览器打开 → 用 Omada 账号登录 + MFA → 把回调 URL 贴回 davmail。成功后 `token.dat` 落盘，之后无人值守自动刷新。
   - 该 cipher key 在「新实例首次登录」时即被设定为加密 `token.dat` 的口令，**之后所有连接都用它当密码**。

4. **用 pm2 常驻**（和 nintel 现有服务一致的管理方式）：在 `ecosystem.config.cjs` 加一个 app：
   ```js
   {
     name: 'nintel-davmail',
     cwd: path.join(ROOT, 'apps/api/infra/davmail'),
     script: 'java',
     args: '-Dsun.net.inetaddr.ttl=0 -jar /opt/davmail/davmail.jar davmail.properties',
     interpreter: 'none',
     autorestart: true,
     max_restarts: 10,
   }
   ```

### 4.4 发送配方（SMTP，可直接跑）

新建 `apps/api/src/nintel/engine/mailer.py`：

```python
"""Email transport via local davmail (SMTP send + IMAP draft).

davmail 把本机 SMTP(1025)/IMAP(1143) 桥接到 Exchange。认证: user=邮箱,
password=davmail cipher key（非 O365 密码）。详见 EMAIL-SENDING-HANDOFF.md §4.2。
"""
from __future__ import annotations

import imaplib
import smtplib
import time
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid


def build_report_message(
    *,
    from_email: str,
    from_name: str,
    to: list[str],
    cc: list[str] | None,
    subject: str,
    html: str,
    text: str | None = None,
) -> EmailMessage:
    """组 multipart/alternative（plain 兜底 + HTML 正文）。"""
    msg = EmailMessage()
    msg["From"] = formataddr((from_name, from_email))
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=from_email.split("@")[-1])
    # 先 set_content（text/plain 兜底），再 add_alternative（text/html）——
    # 顺序决定 MIME 里 HTML 是首选展示版本。
    msg.set_content(text or "本报告需支持 HTML 的邮件客户端查看。")
    msg.add_alternative(html, subtype="html")
    return msg


def send_via_davmail(
    msg: EmailMessage,
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    recipients: list[str],
    timeout: int = 120,
) -> str:
    """SMTP 发送。recipients = to+cc+bcc 的并集（信封收件人）。返回 Message-ID。"""
    with smtplib.SMTP(host, port, timeout=timeout) as s:
        s.ehlo()
        # davmail.smtpStartTls=false → 明文，**不要** starttls()
        s.login(user, password)
        s.send_message(msg, from_addr=user, to_addrs=recipients)
    return msg["Message-ID"]
```

### 4.5 草稿配方（IMAP APPEND，「保险模式」）

同一个 `mailer.py` 里加：

```python
def append_draft_via_davmail(
    msg: EmailMessage,
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    drafts_folder: str = "Drafts",
    timeout: int = 60,
) -> None:
    """把邮件存进 Exchange 草稿箱（IMAP APPEND）。你在 Outlook/OWA 里复核后手动发。

    \\Draft \\Seen 标志：Outlook 约定草稿由发件人创建即 seen，否则草稿箱会有未读计数。
    drafts_folder：Outlook 中文环境可能是 "Drafts" 或 "草稿"；先试 "Drafts"，
    不行用 §4.5b 的探测。
    """
    raw = msg.as_bytes()
    imap = imaplib.IMAP4(host, port, timeout=timeout)  # imapStartTls=false → 明文
    try:
        imap.login(user, password)
        typ, data = imap.append(
            drafts_folder, "(\\Draft \\Seen)",
            imaplib.Time2Internaldate(time.time()), raw,
        )
        if typ != "OK":
            raise RuntimeError(f"IMAP APPEND failed: {data!r}")
    finally:
        try:
            imap.logout()
        except Exception:
            pass
```

**§4.5b 草稿箱文件夹名探测（可选，更稳）**：用 RFC 6154 SPECIAL-USE `\Drafts` 标志找文件夹，避免中英文名差异：

```python
import re
_DRAFTS = re.compile(rb"\\Drafts", re.IGNORECASE)

def discover_drafts_folder(imap: imaplib.IMAP4) -> str:
    typ, data = imap.list()
    if typ == "OK" and data:
        for entry in data:
            if entry and _DRAFTS.search(entry):
                # entry 形如: b'(\\HasNoChildren \\Drafts) "/" "Drafts"'
                name = entry.decode("utf-8", "replace").rsplit(" ", 1)[-1].strip('"')
                return name
    return "Drafts"
```

### 4.6 接入 `nintel.pipeline`（CLI 子命令 + 定时）

你的 `pipeline.py` 已经是 argparse 子命令结构，且已有 `render.render_email(report) -> str`。加一个 `send`：

```python
# pipeline.py 内
def _cmd_send(args: argparse.Namespace) -> int:
    from . import render
    from .engine import mailer
    from .config import settings  # 你的 Settings；下面 §4.7 加字段

    report = build(args.type, persist_items=False)   # 或加载已 publish 的报告
    html = render.render_email(report)
    subject = f"Network Intel · {report.date} · {'周报' if args.type=='weekly' else '日报'}"

    msg = mailer.build_report_message(
        from_email=settings.mail_from, from_name="Network Intel",
        to=settings.mail_to, cc=settings.mail_cc, subject=subject, html=html,
    )
    common = dict(host=settings.davmail_host, port_smtp=settings.davmail_smtp_port,
                  port_imap=settings.davmail_imap_port,
                  user=settings.davmail_user, password=settings.davmail_cipher_key)

    if args.draft:   # 保险模式
        mailer.append_draft_via_davmail(
            msg, host=common["host"], port=common["port_imap"],
            user=common["user"], password=common["password"])
        print(f"draft appended → {report.report_id}")
    else:
        mid = mailer.send_via_davmail(
            msg, host=common["host"], port=common["port_smtp"],
            user=common["user"], password=common["password"],
            recipients=[*settings.mail_to, *(settings.mail_cc or [])])
        print(f"sent {report.report_id} → {mid}")
    return 0

# 在 main() 的 subparsers 里注册：
p_send = sub.add_parser("send", help="send (or draft) a report email via davmail")
p_send.add_argument("--type", required=True, choices=["daily", "weekly"])
p_send.add_argument("--draft", action="store_true",
                    help="存草稿到邮箱草稿箱（人工复核后手动发），而非直接发送")
p_send.set_defaults(func=_cmd_send)
```

**定时**：复用你现有的 launchd/cron。两种接法：
- 直接在生成后链式发送：日报作业改成 `... build --type daily --publish && ... -m nintel.pipeline send --type daily`。
- 或新增一个 launchd plist 在生成后 N 分钟触发 `send`。
- **保险模式定时**：把 `send` 换成 `send --draft`，每天定时把草稿丢进草稿箱，你早上看一眼手动发。

### 4.7 需要新增的 `.env` / Settings 配置

`.env.example` 追加：

```bash
# --- Email delivery via davmail (SMTP send / IMAP draft) ---
NINTEL_DAVMAIL_HOST=127.0.0.1            # 方案A=127.0.0.1；方案B=<Mac的LAN-IP>
NINTEL_DAVMAIL_SMTP_PORT=1025
NINTEL_DAVMAIL_IMAP_PORT=1143
NINTEL_DAVMAIL_USER=lucien.chen@omadanetworks.com
NINTEL_DAVMAIL_CIPHER_KEY=<你设的 davmail cipher key>   # 方案B 必须与 MailAgent 一致
NINTEL_MAIL_FROM=lucien.chen@omadanetworks.com
NINTEL_MAIL_TO=someone@omadanetworks.com,team@omadanetworks.com   # 逗号分隔
NINTEL_MAIL_CC=
NINTEL_MAIL_MODE=send                   # send | draft（保险模式默认 draft）
```

`config.py::Settings` 加对应字段（沿用你现有的 `os.getenv` + dataclass 风格；收件人 split 逗号）。**`NINTEL_DAVMAIL_CIPHER_KEY` 是 secret**，跟 `ANTHROPIC_API_KEY` 一样只放 `.env`，别进 plist/crontab。

### 4.8 验证（冒烟）

```bash
cd apps/api
# 0) davmail 活着？
nc -vz 127.0.0.1 1025 && nc -vz 127.0.0.1 1143        # 方案B 换成 Mac 的 IP

# 1) 纯协议层 smoke（不渲染报告，先验证认证+通路）：发给自己一封
.venv/bin/python - <<'PY'
from nintel.engine import mailer
from nintel.config import settings
msg = mailer.build_report_message(
    from_email=settings.mail_from, from_name="Network Intel",
    to=[settings.mail_from], cc=None, subject="[smoke] davmail send",
    html="<h1>hello</h1><p>davmail 发送通路 OK</p>")
print(mailer.send_via_davmail(msg, host=settings.davmail_host,
    port=settings.davmail_smtp_port, user=settings.davmail_user,
    password=settings.davmail_cipher_key, recipients=[settings.mail_from]))
PY
# → 收件箱应收到这封；登录失败=cipher key 不对/token 过期；连接拒绝=davmail 没起/端口/IP

# 2) 草稿 smoke
.venv/bin/python -m nintel.pipeline send --type daily --draft   # → 邮箱草稿箱出现一封
# 3) 真发
.venv/bin/python -m nintel.pipeline send --type daily
```

发出去的邮件**是否自动落 Sent**取决于 Exchange 行为；davmail 多数情况下会，但若发现没落 Sent，可补一步 IMAP APPEND 到 Sent 文件夹（`\Seen` 标志，文件夹名用 `\Sent` SPECIAL-USE 探测，逻辑同 §4.5b）。MailAgent 侧有现成实现可参考（附录 B）。

---

## 5. 死硬约束 / 风险（务必周知）

1. **🔴 EWS 2026-10-01 关停**：davmail 6.7 走 EWS，这条发送链大约还能稳跑到 2026 年 10 月。**这是过渡桥，不是终态。** 必须在关停前迁移到 Graph（§6）。
2. **🔴 PoC client_id**：上面 properties 里的 `d3590ed6-...` 是 Outlook for Windows 的 well-known client_id（伪装 PoC），**不是公司 IT 审批的正式 app 注册**。内部舆情报告短期自用风险可接受，但**正式/对外发布前必须走 IT 申请自有 Azure app 注册**（同时也是 Graph 迁移的前置）。
3. **🔴 cipher key 契约（方案 B）**：连同一 davmail 实例必须同 key，否则污染 token、两边一起挂。方案 A 用独立实例规避。
4. **token.dat 脆弱性**：device 被移出租户 / 长期不刷新 / 密码重置，都可能让 refresh token 失效，需要重新交互式 OAuth（浏览器登录一次）。无人值守作业要有「认证失败 → 告警 → 人工重新引导」的兜底，别让报告静默发不出去。
5. **davmail 必须常驻**：用 pm2 管 + autorestart；作业里对「连接拒绝/认证失败」要 fail loud（打日志 + 非零退出码），别吞异常。
6. **From 不可伪造**：发件人只能是你认证的邮箱本身。
7. **明文传输**：loopback（方案 A）无所谓；方案 B 跨机是 LAN 明文，仅限可信内网，别把 1025/1143 暴露到公网。

---

## 6. 更优的长期方案（去 davmail / 去 EWS）

EWS 关停后（或想一步到位上生产），把传输换成下列之一，`mailer.py` 是唯一改动点（`build_report_message` 完全复用，只换发送函数）：

- **Microsoft Graph `POST /me/sendMail`（推荐，正式正路）**：走 IT 审批的 Azure app 注册（client_credentials 或 delegated），用 `httpx` 调 Graph，发信仍是 Omada 邮箱身份，落 Sent，**无 EWS 依赖**。这是 MailAgent 自己路线图里也指向的终态。
- **专用域名 + 事务邮件服务（SES / Resend / SendGrid）**：若报告将来要发给**外部**收件人、要退订/可达性/统计，用 `omada.ink` 之类的发信域名 + DKIM/SPF，最稳。代价是发件人不再是个人 Exchange 邮箱。

建议：**A 先上线**满足「现在就要发」，**同时立项 D（Graph）**，在 2026-09 前完成切换演练。

---

## 附录 A：MailAgent serve-api 的 HTTP 接口（为什么不直接用 + 若要用需改什么）

MailAgent 有一套 FastAPI（serve-api，本机 :8200，远程经 cloudflared 暴露成 `mail.chenge.ink/app`，背后 Cloudflare Access）。和「发邮件」相关的端点：

| 方法 | 路径 | 语义 | 对 nintel 可用？ |
|---|---|---|---|
| POST | `/api/email/send` | SMTP 真实发送 | ❌ body 强制 `internalId`（必须指向一封**已存在**的本地邮件），mode ∈ {reply, reply-all, forward}，**无裸发新邮件路径** |
| POST | `/api/email/draft` | IMAP APPEND 草稿 | ❌ 同上，回复/转发语义 |
| DELETE | `/api/email/draft/{id}` | 删草稿 | — |
| POST | `/api/email/{id}/draft-plan` | 草稿 dry-run 预填 | — |

**两个硬阻塞**：
1. **语义**：`send`/`draft` 内部走 `MailWriteService._prepare_draft()` → `sync_store.get(internal_id)`，记录不存在直接 `ServiceNotFoundError`。它本质是「对某封已收到的邮件做回复/转发」，**不是撰写全新邮件**。要支持裸发，需在 MailAgent 新增一个 compose 端点（构造一个不依赖原邮件的 `DraftRequest{to,cc,subject,body_html}` 直接喂 `backend.send_email()` / `append_draft()`——底层 `build_outgoing_mime` 本身是支持 "new" 模式的，只是上层入口没开）。
2. **鉴权**：远程访问要么过 **Cloudflare Access JWT**（要求 claim 里有白名单内的 `email`——机器对机器的 service token 默认不带 email claim，会被 L2 拒），要么用**同机 ephemeral local token**（`X-MailAgent-Local-Token`，由 Electron 主进程每会话随机生成注入后端进程 env，**异机的 nintel 拿不到**）。所以跨机 M2M 调 serve-api 没有现成的鉴权路子。

**结论**：除非你明确想要「发件也进 MailAgent 的统一邮件视图 + 镜像到 Notion」，否则别走 serve-api——davmail 直连用 30 行标准库就够了，零耦合。若将来确实要走，需要 MailAgent 侧：(a) 新增裸发端点，(b) 为 nintel 开一条 M2M 鉴权（CF Access service token + 放宽 L2，或单独的 API key 腿）。

---

## 附录 B：MailAgent 侧参考实现指针（要深挖时按图索骥）

> 路径相对 MailAgent 仓库根。davmail 直连的认证/MIME/发送逻辑都在这里，nintel 的 `mailer.py` 基本是它们的精简版。

- **davmail 连接 + 认证**：`src/mail/backend/imap_client.py`
  - `imap_connect()`（行 91）/`smtp_connect()`（行 136）：`login(user_email, cipher_key)` 就在这——印证「密码 = cipher key」。
  - `get_cipher_key()`（行 55）：cipher key 解析 + PoC fallback（`mailagent-poc-shared-key`）。
- **MIME 构造（Exchange/Outlook 兼容黄金参考）**：`src/mail/backend/sender.py::build_outgoing_mime()`（行 36，multipart/alternative + From display + threading 头 + 附件 multipart/mixed）。`davmail_backend.py::_build_mime`（行 1001）委托给它。
- **SMTP 发送 + 可选归 Sent**：`src/mail/backend/sender.py::smtp_send()`（行 150）+ `_append_to_sent()` 兜底 APPEND 到 Sent（行 129）。
- **草稿 APPEND**：`src/mail/backend/davmail_backend.py::append_draft()`（行 782），`imap.append(folder, "(\\Draft \\Seen)", None, mime_bytes)`。
- **草稿箱/Sent 文件夹 SPECIAL-USE 探测**：`src/mail/backend/imap_client.py::discover_drafts_folder()`（行 192）+ `_DRAFTS_FLAG_PATTERN`/`_SENT_FLAG_PATTERN`（行 36/44）。
- **davmail 配置样例**：`davmail-poc/config/davmail.properties`（含 `bindAddress=0.0.0.0 / allowRemote=true / smtpPort=1025 / imapPort=1143 / O365Manual`）。
- **serve-api 端点**：`src/api/routers/email.py`（`/draft` 行 952、`/send` 行 1021）；写服务编排 `src/services/mail_write.py`（`_prepare_draft` 行 1126、`send` 行 1402、`compose_draft` 行 1250）；鉴权 `src/api/auth.py`。

---

*Handoff 完。有疑问回 MailAgent 项目侧确认；davmail 实例的具体 cipher key / token 状态请直接问 lucien。*
