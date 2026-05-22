# Handoff — Dual-Backend Architecture (Mail.app + DavMail)

> **Status**: 评估 + 工作量估算阶段, 实施未启动.
> **Author handoff date**: 2026-05-22
> **Reader**: 下一个负责评估 / 实施这次重构的 session.
> **Self-contained**: 不依赖前一个 session 的对话上下文; 所有关键事实在本文档或引用的文件里.

---

## 0. TL;DR (60 秒掌握)

**目标**: 把 MailAgent 后端从单一 "Mail.app + AppleScript" 架构, 重构成 **支持双后端驱动 (AppleScript / DavMail IMAP+SMTP+CalDAV)**, **DavMail 主, AppleScript fallback**, 自动 health-check 切换, 工业级架构.

**为什么**:
1. AppleScript GUI 注入富文本 Reply All 一直是痛点 (已有 HTML clipboard 半成品)
2. Mail.app 锁死 macOS, 阻碍未来 Linux/Docker 部署
3. DavMail PoC (2026-05-21~22) 已验证协议层 100% 替代可行: SMTP 富文本 + 线程折叠 ✅ / IMAP UID/FETCH/STORE ✅ / CalDAV ✅ / 4× 比 AppleScript 快

**为什么不一次切死**:
1. 公司 IT 审批未通过, 当前 DavMail OAuth 用 Outlook well-known client_id 是擦边球, **不可上生产**
2. AppleScript + Mail.app 现在稳定 (v3 + Sprint 15 outbox) , 切死风险高
3. EWS 2026-10 退役, DavMail Graph API 路线图未 merge, 长期方案待定
4. Fallback 提供安全网, 即便 DavMail 哪天挂了 (refresh token 过期 / Microsoft 风控 / EWS 关停), 系统仍能 degrade 到 AppleScript

**当前状态**: DavMail PM2 已稳定运行, 接口 SMTP `1025` / IMAP `1143` / CalDAV `1080`, 可作为实验环境平行接入.

---

## 1. 不变的事实 (Read First)

### 1.1 当前生产架构 (v3 + Sprint 15 outbox + v4 SQLite-SSoT)

`CLAUDE.md` 顶部"项目概述"+ "架构版本"是最权威描述. 简要:

- **正向同步**: `sqlite_radar` 监听 Mail.app `Envelope Index` SQLite (~5ms) → `applescript_arm.fetch_email_content_by_id(internal_id)` 拉完整 MIME (~1s) → `NotionSync.create_email_page_v2`
- **反向同步**: Notion 端 property 改变 → Notion automation webhook → Redis → `handle_flag_changed / handle_completed / handle_ai_reviewed` → 写 `email_outbox` 表 → `FanoutWorker` 异步 dispatch → AppleScript STORE flag/read
- **主键**: `internal_id = SQLite ROWID = AppleScript id` (127× 性能基础, 见 `docs/applescript_id_optimization.md`)
- **v4 SQLite-SSoT** 已上线 Phase 1-4 灰度: body + 附件双写 SQLite, FTS5 索引, `mailagent email resync` CLI

### 1.2 已验证的 DavMail 能力 (PoC)

完整记录: **`davmail-poc/POC-RESULTS.md`** (本地 gitignored, 含 client_id 伪装细节, 不进 git history).

跨 session memory: **`~/.claude/projects/-Users-chenyuanquan-Documents-MailAgent/memory/project_davmail_poc_2026_05.md`**.

| v3 能力 | DavMail 对应 | 实测数据 |
|---|---|---|
| `sqlite_radar` 5ms 检测 | `IMAP STATUS UIDNEXT` polling | 30s 间隔 (邮件 minute 级 latency 完全够; IMAP IDLE 6.3/6.7 都不 push, fallback polling) |
| `applescript_arm.fetch_email_content_by_id` | `IMAP UID FETCH BODY[]` | **236ms** (vs AppleScript ~1s, 4× 快) |
| 反向 STORE \\Flagged / \\Seen | `IMAP UID STORE +FLAGS` | 同步生效, 1:1 映射 |
| AppleScript GUI 注入 (富文本 Reply All 痛点) | `SMTP submission` (multipart/alternative + In-Reply-To) | 富文本 + 线程折叠完美 ✅ |
| 邮件中 .ics 解析 (`meeting_sync`) | 不替代 (仍用 .ics 解析) | — |
| 无 | `CalDAV` 直读 Outlook 服务端日历 | **新能力**, 全景日历, 给 LLM agent 处理邮件时知道日程 |

### 1.3 当前 DavMail 部署 (生产就位)

- **进程**: PM2 `davmail-poc` (id 1, 跟 mail-sync 并列)
- **PM2 startup**: macOS launchd `~/Library/LaunchAgents/pm2.chenyuanquan.plist`, reboot 后自动 `pm2 resurrect`
- **jar**: `davmail-poc/jar/davmail.jar` (6.7.0 native, JDK 26 Temurin)
- **Config**: `davmail-poc/config/davmail.properties` (含 client_id 伪装, gitignored)
- **Token**: `davmail-poc/token/token.dat` (refresh token 90 天, StringEncryptor 加密)
- **监听**: `127.0.0.1:1025` (SMTP) / `1143` (IMAP) / `1080` (CalDAV) — 只 bind 本机
- **Cipher key**: 环境变量 `DAVMAIL_POC_CIPHER_KEY` 或默认 `"mailagent-poc-shared-key"` — **所有 client (mail-sync / CLI / 测试) 必须用同一个**

### 1.4 三个**死硬约束** (重构期间不可触碰)

1. **当前 DavMail 不可上生产** — 用了 Outlook for Windows well-known client_id (`d3590ed6-52b3-4102-aeff-aad2292ab01c`) 伪装, 违反公司 IT 政策 + Microsoft Identity Platform Terms. 生产化前必须走 IT 正规审批 (推荐直接申请 Graph API 应用, 不是 DavMail)
2. **EWS 关停时间**: 2026-10-01 — DavMail 6.7.0 main 仍走 EWS, Graph 路线图 (Issue #404) 未 merge. 若 5 个月内 Graph 不 ship, 方案归零, 必须切到原生 Graph SDK
3. **v3 + Sprint 15 当前稳定, AppleScript 路径不可破坏** — 任何重构都必须保证 AppleScript fallback 路径**始终可用**, 一旦 DavMail 不可用立即降级

---

## 2. Problem & Goal

### 2.1 痛点 (按优先级)

1. **富文本 Reply All 痛点** (最高): AppleScript 注入复杂格式不可靠. 现有 HTML clipboard 路径 (Path A: Notion 直接 → NSPasteboard → Mail.app) 已 work 但是 ugly. 用 SMTP 是工业标准方案.
2. **跨平台部署 blocker**: macOS only, 无法 Linux 部署 webhook 服务全栈.
3. **AppleScript 性能瓶颈**: `whose id is <int>` 已经从 100s 优化到 1s, 但仍比 IMAP FETCH 4× 慢; 大邮箱 (~24k 邮件) 场景下累计差距明显.
4. **`meeting_sync` 受限于邮件 .ics**: 用户在 Outlook 端直接创建 / 别人没邀请你的会议 / 共享日历的会议 — v3 都拿不到. CalDAV 可填补这个空白.

### 2.2 目标架构

```
┌──────────────────────────────────────────────────────────────┐
│  Application Layer (new_watcher / NotionSync / FanoutWorker) │
│                                                              │
│       depends on  →  IMailBackend (abstract interface)       │
└──────────────────────────────────────────────────────────────┘
                              ▲
            ┌─────────────────┼─────────────────┐
            │                                   │
    ┌───────┴────────┐                ┌─────────┴────────┐
    │ DavMailBackend │                │ AppleScriptBackend │
    │ (PRIMARY)      │                │ (FALLBACK)         │
    │                │                │                    │
    │ - SMTP (1025)  │                │ - applescript_arm  │
    │ - IMAP (1143)  │                │ - sqlite_radar     │
    │ - CalDAV(1080) │                │ - send via         │
    │                │                │   AppleScript      │
    └───────┬────────┘                └─────────┬──────────┘
            │                                   │
    ┌───────┴────────┐                ┌─────────┴──────────┐
    │ DavMail JVM    │                │ macOS Mail.app +   │
    │ (PM2 managed)  │                │ Envelope Index SQ  │
    │ → EWS / Graph  │                │                    │
    └────────────────┘                └────────────────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │  BackendRouter           │
                │  - health-check loop     │
                │  - primary→fallback      │
                │  - circuit breaker       │
                │  - hot reload config     │
                └──────────────────────────┘
```

**目标特性**:
- DavMail 是 primary, 所有 read/write 优先走它
- AppleScript 是 fallback, DavMail health-check 失败时自动接管
- 切换对 application layer 透明 (`IMailBackend` 接口)
- Fallback 触发条件: DavMail 端口不通 / OAuth refresh 失败 / IMAP/SMTP 超时 / Microsoft 风控
- 切回 primary 触发: 健康检查恢复 N 次成功后

---

## 3. 关键决策点 (Next Session 必须先回答)

### 3.1 Backend 抽象的粒度

**Option A: 协议级**: 抽象 `IMailReader` / `IMailWriter` / `IMailFlagger`, 每个 backend 各自实现.
- 优: 干净, 测试友好, 接口稳定
- 劣: 现有代码 (`new_watcher.py` / `applescript_arm.py`) 改动大

**Option B: 命令级**: 抽象现有 high-level 操作 (`fetch_email_by_id` / `set_flag` / `send_draft` 等)
- 优: 改动小, 平滑迁移
- 劣: AppleScript 现有命令跟 IMAP 语义不完全对齐 (`internal_id` vs `UID`)

**推荐**: B (命令级 + 适配器). 现实主义.

### 3.2 主键策略 — `internal_id` vs `(uidvalidity, uid)`

v3 用 `internal_id = AppleScript id = SQLite ROWID`. DavMail 提供 `(uidvalidity, uid)`.

**Option A: 完全切到 IMAP UID** — `internal_id` 字段废弃, SyncStore schema 大改, FK 全改
**Option B: 保留 `internal_id`, 加 `(uidvalidity, uid)` 副字段** — DavMail backend 用 UID 查, 但 SyncStore 主键不变
**Option C: 给每封邮件一个 `mailagent_id` 抽象主键, AppleScript id 和 IMAP UID 都作为 backend-specific 副字段**

**推荐**: B (短期) → C (长期). 短期最少改动跑通, 长期解耦.

### 3.3 Health-check 策略

什么算 DavMail 不健康?
- 端口 1025/1143/1080 任一不通?
- OAuth refresh 失败连续 N 次?
- 单次 IMAP 操作 timeout > T 秒?
- Microsoft 端 5xx 错误?

什么时候切回 primary?
- Health check 连续 N 次成功 (避免抖动)?
- 手动 admin 命令切?

**推荐**: 端口 + OAuth + 单次操作 timeout 三层. circuit-breaker 模式 (`open` / `half-open` / `closed`), 参考 Hystrix.

### 3.4 反向同步 (Sprint 15 outbox) 适配

当前: `OutboxRepository.enqueue(target='mailapp', ...)` → `FanoutWorker` 调 AppleScript STORE

DavMail 后:
- **Option A**: 新增 target `target='davmail'`, FanoutWorker 根据 target 路由 (适合双轨)
- **Option B**: 保持 `target='mailapp'`, FanoutWorker 内部根据 BackendRouter 当前 active backend 选实现 (透明切换)

**推荐**: B. 但 outbox table 加一列 `executed_via TEXT` 记录实际执行的 backend, 供 audit / debug.

### 3.5 灰度策略

**Option A**: 全量切 (一次性)
**Option B**: 按邮箱 (收件箱先, 发件箱后) 灰度
**Option C**: 按操作类型 (先 send, 后 fetch, 后 flag) 灰度
**Option D**: shadow mode — DavMail 跟 AppleScript 并行跑, diff 结果 (类似 v4 `mailagent llm compare-paths`)

**推荐**: D (shadow) → A (全量切+保留 fallback). 与 v4 灰度策略一致.

---

## 4. 实施 Phase 分解 (估算 ~Sprint 16-19, 3-4 月)

### Sprint 16 — Backend 抽象层 + DavMail 单 driver 跑通 (2-3 周)

- [ ] 定义 `src/mail/backend/base.py`: `IMailBackend` 接口 (基于决策 3.1 选 B 命令级)
- [ ] 实现 `src/mail/backend/applescript_backend.py`: 现有 `applescript_arm` / `sqlite_radar` 适配进接口
- [ ] 实现 `src/mail/backend/davmail_backend.py`: 用 `imaplib` + `smtplib` 实现
  - `fetch_email_by_id(uid)` → IMAP FETCH BODY[]
  - `set_flag(uid, flag)` → IMAP STORE +FLAGS
  - `send_message(mime_bytes)` → SMTP submission
- [ ] 实现 `src/mail/backend/router.py`: 简单 router (env 变量切, 不带 fallback)
- [ ] 测试: 用 `MAILAGENT_BACKEND=davmail` env 跑 mail-sync, 全功能跟 v3 行为对齐
- [ ] **不动 SyncStore schema** (用决策 3.2 Option B 副字段保留)

**Risk**: IMAP UID ↔ AppleScript internal_id 双向映射不完善时数据可能错位. 必须 shadow mode 跑 (决策 3.5 Option D) 几天对账.

### Sprint 17 — Router 增加 health-check + auto fallback (1-2 周)

- [ ] Health check loop: 端口 + OAuth refresh + 单次操作 timeout (决策 3.3)
- [ ] Circuit breaker: open/half-open/closed
- [ ] Fallback 触发时打 alert (飞书告警机器人)
- [ ] Fallback 回切策略
- [ ] 测试: 故意 `pm2 stop davmail-poc`, 看是否秒切 AppleScript

### Sprint 18 — Sprint 15 outbox FanoutWorker 适配 (1-2 周)

- [ ] `email_outbox` 加 `executed_via TEXT` 列 (决策 3.4)
- [ ] FanoutWorker 用 BackendRouter 选实现 (透明切)
- [ ] echo prevention 规则 review (DavMail 走 SMTP 是否会触发新 inbox 事件? 在 Outlook 端确认)
- [ ] 测试: 反向 flag 同步在 DavMail 主、AppleScript fallback 两个状态都通

### Sprint 19 — `meeting_sync` / CalDAV 集成 (可选, 1 周)

- [ ] `src/calendar_notion/caldav_reader.py`: 通过 DavMail CalDAV 读 Outlook 服务端日历
- [ ] 跟现有 `meeting_sync` (.ics 解析) 并存; CalDAV 是新数据源, 不替代
- [ ] LLM agent 处理邮件时把"今日会议"做为 context 注入 prompt (决策 3.1 在 `src/llm_agent/processor.py`)

### Sprint 20+ — 生产化前提 (跟 IT)

- [ ] 申请 Microsoft Graph API 应用注册 (跳过 DavMail 自有 client_id)
- [ ] DavMail config 切到正式 client_id
- [ ] 或者: 等 DavMail Graph API merge, 切到 Graph 模式
- [ ] 审计 + 合规 review

---

## 5. 工作量估算 Summary

| 阶段 | 周数 | 风险等级 | 主要不确定性 |
|---|---|---|---|
| Sprint 16 backend 抽象 + DavMail driver | 2-3 周 | 中 | IMAP UID ↔ internal_id 映射 |
| Sprint 17 router + fallback | 1-2 周 | 低 | health-check 调参 |
| Sprint 18 outbox 适配 | 1-2 周 | 中 | echo prevention 边界 |
| Sprint 19 CalDAV (optional) | 1 周 | 低 | scope creep |
| Sprint 20+ 生产化 | 几周-几月 | 高 | IT 审批 + EWS 退役时间窗 |
| **总计 (Sprint 16-19)** | **5-8 周** | — | — |

**全栈替换 (砍掉 AppleScript)**: +2-3 月 (要等 IT 审批 + EWS 替代方案确定).

---

## 6. 关键风险 & Open Questions

| 风险 | 等级 | 应对 |
|---|---|---|
| 公司 IT 审批 DavMail / Graph 应用注册被拒 | 高 | 维持双后端架构, AppleScript 永久作为 primary 之一 |
| Microsoft 风控触发 (Outlook well-known client_id) | 中 | 不能上生产; 当前 PoC 限本机用 |
| EWS 2026-10 退役, DavMail Graph 未 ship | 高 | 备选: 直接 Graph API SDK 直连, 跳过 DavMail |
| IMAP UID ↔ internal_id 双写一致性 bug | 中 | Shadow mode 跑 ~1 周对账, 写 diff 工具 |
| Sprint 15 outbox echo 在新 backend 下失效 | 中 | 加 `executed_via` 列 + 单元测试覆盖所有 source/target 组合 |
| DavMail 进程崩溃 / Token refresh 失败 | 低 | health-check + circuit breaker, fallback to AppleScript |
| Microsoft 改 client_id 政策 | 中 | 定期 watch DavMail Issue #404 + Microsoft Identity Platform changelog |

### Open Questions (next session 需 confirm)

1. Backend 抽象粒度选 A 命令级 还是 B 命令级? (默认 B)
2. 主键策略选 B (副字段) 还是 C (新抽象主键)? (默认 B → C 演进)
3. Fallback 切换是自动 (health-check 驱动) 还是手动 (admin 命令)? (默认自动 + 飞书告警)
4. CalDAV 是 Sprint 19 还是延后? (默认 Sprint 19, 加分项)
5. shadow mode 跑多久才切实 backend? (建议 ~1 周, 看 diff 数据)

---

## 7. 代码入口点 (start reading here)

```
src/mail/
├── new_watcher.py          # ← 主循环, 决策 3.1 影响这里
├── applescript_arm.py      # ← 现有 AppleScript 操作, 改名 AppleScriptBackend
├── sqlite_radar.py         # ← Mail.app SQLite 监听, 适配进 AppleScriptBackend
├── sync_store.py           # ← schema, 决策 3.2 影响主键
└── reverse_sync.py         # ← 反向同步, Sprint 15 outbox 集成

src/events/
└── handlers.py             # ← outbox handler, 决策 3.4 适配

src/mail/sync_store.py:95-410   # DB schema (DB_VERSION=5+), 加新列
docs/applescript_id_optimization.md   # internal_id 性能背景
docs/sprint15-backend-complete.md     # outbox 模型
docs/architecture_v4_sqlite_ssot.md   # v4 SSoT 状态

davmail-poc/                 # ← (本地 gitignored) PoC 工作产物
├── POC-RESULTS.md           #   完整验证记录 + 12 条经验沉淀
├── config/davmail.properties#   生产 DavMail config (含 cipher key 引用)
├── test_smtp_reply.py       #   SMTP 富文本 Reply All 测试 / 接入参考
├── test_imap_suite.py       #   IMAP UID/FETCH/STORE/IDLE 测试 / 接入参考
└── test_caldav.py           #   CalDAV 日历读取 / 接入参考

~/.claude/projects/-Users-chenyuanquan-Documents-MailAgent/memory/
└── project_davmail_poc_2026_05.md   # 跨 session 记忆 (PoC 结论摘要)
```

---

## 8. 立即可以开工的事

不需要等 IT 审批就能开做的:

1. **Sprint 16 backend 抽象**: 不涉及 DavMail 上生产, 接口设计 + AppleScriptBackend 适配 + DavMailBackend 实现 (用当前 PoC PM2 实例)
2. **Shadow mode 工具**: 类似 `mailagent llm compare-paths`, 同时跑 AppleScript + DavMail, diff 结果
3. **`meeting_sync` CalDAV 并联**: 不动现有 .ics 路径, 加 CalDAV 数据源做 enrichment
4. **写 health-check 监控**: DavMail 进程 + 端口 + OAuth 状态接进现有 `stats_reporter`

**先做** shadow mode (Option D 灰度) + backend 抽象骨架. 一周内能交出 PoC 级双写对照.

---

## 9. Out of Scope (本次重构不做)

- 完全砍掉 AppleScript 路径 — 这要等 IT 审批 + EWS 退役方案确定
- DavMail 上生产 (用当前伪装 client_id) — 合规不允许
- 自己 fork DavMail 改源码 — 路线图上但优先级低
- 切到 Microsoft Graph API 原生 SDK — Option, 但要等 IT 注册 Graph 应用
- 前端 / Frontend 改造 (Sprint 14/18 在做)
- v4 SQLite SSoT Phase 5 (Web 前端) — 独立 track

---

## 10. 联系 / 跟进

- DavMail PoC 经验: `davmail-poc/POC-RESULTS.md` (本地)
- 当前生产 PM2 状态: `pm2 ls` (`davmail-poc` 跟 `mail-sync` 并列)
- DavMail 上游 Graph API 进度: GitHub Issue [#404](https://github.com/mguessan/davmail/issues/404)
- Microsoft EWS 退役: [Microsoft 公告 2024-09](https://techcommunity.microsoft.com/blog/exchange/retirement-of-exchange-web-services-in-exchange-online/3924440)

---

## Appendix A — 决策快速选项 (供 next session 一句话回答)

```
□ Backend 抽象粒度 : [B 命令级 / A 协议级]                 推荐 B
□ 主键策略         : [B 副字段 / C 抽象主键 / A 完全切 UID]  推荐 B 短期, C 长期
□ Fallback 触发    : [自动 health-check / 手动 admin / 混合] 推荐 自动 + 飞书告警
□ CalDAV 集成      : [Sprint 19 / 延后 / 不做]              推荐 Sprint 19
□ 灰度策略         : [D shadow / A 全量 / B 邮箱 / C 操作]   推荐 D → A
```

签字: ____________________________  日期: __________

---

**End of handoff. Good luck.**
