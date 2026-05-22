# Roadmap — Post DavMail Cutover (2026-05-22 起)

> **Status**: 主路径 = davmail mode, AppleScript 作 emergency fallback. 这份 roadmap 汇总 cutover 后短中长期工作.
> **Companion**: [`sprint16-cutover-complete.md`](./sprint16-cutover-complete.md) 全程纪要 / [`next-session-handoff.md`](./next-session-handoff.md) cold-pickup / [`dual-backend-architecture-handoff.md`](./dual-backend-architecture-handoff.md) 设计 + 决策
> **Last updated**: 2026-05-22 PDT

---

## 0. TL;DR (60 秒掌握当前坐标)

```
当前 backend           : davmail (PoC mode, 本机 IT 未审批)
mail-sync uptime       : 稳定运行 30min+ 起步, 1.5h 内 4 封 davmail-origin 邮件全 synced
uid-mapper 进度        : ~50% (4593/8877 backfilled), 0 failed, ~85min 内跑完
AppleScript 路径       : 仍保留, .env 切回即激活 (emergency fallback)
关键死线              : EWS 2026-10-01 关停, DavMail 6.7 仍依赖 EWS 桥, Graph 路线图未 merge
最高优先级            : 观察 1-2 天稳定性 → uid backfill 完成 → 评估 AppleScript 下架时间表
```

---

## 1. 当前坐标 (cutover 后第一手数据)

### 1.1 服务

```
pm2 ls
├── davmail-poc       online   15h+ uptime   IMAP 1143 / SMTP 1025 / CalDAV 1080
└── mail-sync         online   30min+        davmail mode, uid-mapper 后台跑

LaunchAgent           pm2.chenyuanquan.plist (RunAtLoad=true, 重启自恢复)
```

### 1.2 数据 (snapshot)

```
total emails           : 8903
backend_origin         : applescript=8899  +  davmail=4
sync_status            : synced 6543 + skipped 2360 + ... (其余 cutover 前)
imap_uid backfill     : 4593 backfilled / 4284 pending (uid-mapper running)
date_received 格式    : 100% iso_with_tz (DST 自动 PDT/-07:00)
```

### 1.3 文档生态

| 主题 | 文档 |
|---|---|
| Sprint 16 全程纪要 | [`sprint16-cutover-complete.md`](./sprint16-cutover-complete.md) |
| Cold-pickup handoff | [`next-session-handoff.md`](./next-session-handoff.md) |
| Dual-backend 设计 + 决策 | [`dual-backend-architecture-handoff.md`](./dual-backend-architecture-handoff.md) |
| Phase A/B/C 实施 | [`dual-backend-phase-abc-handoff.md`](./dual-backend-phase-abc-handoff.md) |
| 本 roadmap | (本文档) |
| v3 主架构 + Sprint 15 outbox | [`CLAUDE.md`](../CLAUDE.md) |
| v4 SQLite SSoT 进展 | [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md), `phase{1,2,3,4}-complete.md` |
| DavMail PoC 验证 | `davmail-poc/POC-RESULTS.md` (gitignored) + memory `project-davmail-poc-2026-05.md` |

---

## 2. P0 — 观察期 (1-2 天, 本周内)

### 2.1 稳定性观察

| 项 | 期望 | 验证命令 |
|---|---|---|
| mail-sync restart 次数 | ≤ 1 / 天 | `pm2 describe mail-sync \| grep restart` |
| davmail-poc 内存稳定 | < 250MB (JVM cutover 后短暂涨到 227MB, 应回落 ~110MB) | `pm2 describe davmail-poc \| grep memory` |
| 新邮件抓回 | ≤ 2min latency (30s 轮询 + 5s LLM + ~30s Notion API) | 自己发一封, 看 Notion 出现时间 |
| 反向 flag 同步 | ≤ 30s outbox + fanout 派发 IMAP STORE 生效 | `mailagent notion update-flag <id> --is-read=true` 后看 Outlook |
| 草稿创建 | ≤ 30s Outlook Drafts 出新草稿, 富文本完整, In-Reply-To 线程折叠 | 前端 AI Chat → Craft 按钮 |

### 2.2 端到端 happy-path 测试 (一次跑通)

自己发一封测试邮件, 全链路走一遍:

```
收到邮件 → davmail UIDNEXT increment 触发 radar
        → SQLite save_email(backend_origin='davmail', internal_id≥10^9)
        → reader.parse_email_source + EmailRepository.commit (含 markdown)
        → NotionSync.create_email_page_from_sqlite
        → LLMRunner (backend.arm IMAP fetch) → AILabels → Notion 写 12 字段
        → Notion automation → webhook → handle_ai_reviewed
        → outbox(target=mailapp) → FanoutWorker → IMAP STORE +\Flagged +\Seen
        → 飞书 App Bot 卡片
```

期望: 全程 ≤ 3min, 任一环节出错 → pm2 logs 看 trace.

### 2.3 cutover-only bug watch

[`sprint16-cutover-complete.md`](./sprint16-cutover-complete.md) §2.3 列了 5 个 cutover 时现场发现的 bug (A-E). 5 个都已 patch, 但**观察期重点关注**:
- `date_received` 在 DST 边界 (11/01 PDT→PST 自动切换) 是否正确
- LLM runner 接 backend 的代码路径在长时间运行下是否泄漏 IMAP connection
- IMAP UID 跨 UIDVALIDITY 变更是否触发 (Microsoft 端 mailbox 重建会 +1 UIDVALIDITY, 极少见)

---

## 3. P1 — 收尾 (1 周内)

### 3.1 uid-mapper backfill 跑完

期望状态: `sync_state['davmail_backfill_progress']` = `completed:processed=8877 backfilled=N missing=M failed=K`. 完成后:
- 反向 flag / fetch 走 `imap_uid` 直接路径 (~200ms vs ~1s message_id 反查)
- `email_metadata.imap_uid IS NULL` 的 row 数应 < 100 (mail.app 时代 message_id 空的历史 row)

监控:
```bash
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='davmail_backfill_progress'"
# running:processed=N backfilled=B missing=M failed=K
# 目标: status → completed
```

### 3.2 文档 cutover 同步 (本 commit 范围)

- [x] `docs/roadmap-post-cutover.md` (本文档)
- [x] `CLAUDE.md` 加 Sprint 16 dual-backend 章节 (类似已有的 Sprint 15 outbox 段)
- [x] `README.md` 加 dual-backend 章节 — 数据源不再只有 Mail.app
- [x] `.env.example` 加 davmail 9 字段 (MAILAGENT_BACKEND / DAVMAIL_*)

### 3.3 还没做的收尾 (待 next session 推进)

- [ ] `mailagent admin health` 加 backend probe 段: davmail-poc 进程存活 + IMAP login + UIDNEXT 可读
- [ ] webhook-server dashboard 加 `backend_origin` 维度统计 (davmail vs applescript)
- [ ] `mailagent admin backend-stats` 新 CLI: 每天每 backend 邮件量 + 失败率 + 平均 latency

---

## 4. P2 — 巩固 (1 月内)

### 4.1 AppleScript 路径下架评估

观察期满 (~1 周稳定) 后, 评估是否完全下架 AppleScript 路径:

候选删除范围:
- `src/mail/applescript_arm.py` (~600 行)
- `src/mail/applescript.py` (底层封装)
- `src/mail/sqlite_radar.py` (Mail.app SQLite radar)
- `src/mail/backend/applescript_backend.py` (wrapper)
- `scripts/create_reply_draft.sh` + `html_clipboard.py` (旧 NSPasteboard 注入)

**判断标准**:
- davmail mode 3 个月零事故 → 可删
- 否则保留作 emergency fallback (代码体量可接受, 维护成本低)

**短期不删的理由**:
- EWS 2026-10 关停未解决, DavMail Graph 路线图未 merge → AppleScript 仍是 last-resort 兜底
- 跨 backend marker 不兼容 (见 [`next-session-handoff.md`](./next-session-handoff.md) §3.1), 删了反而不好回切

### 4.2 监控告警建设

| 告警项 | 阈值 | 现状 |
|---|---|---|
| `davmail-poc` 进程挂掉 | PM2 down event 立即 alert | ❌ 现在没 watchdog |
| `mail-sync restart_count > 5/day` | 滚动 24h 窗口 | ❌ |
| `imap_uid IS NULL` 邮件数突增 | > 1000 (uid-mapper stalled) | ❌ |
| DavMail OAuth refresh 失败 | 单次 ERROR | ❌ (davmail-poc logs 内, 没接 stats_reporter) |
| `email_outbox` pending > 100 持续 5min | fanout worker 卡 | ❌ |

实现路径: 接 `src/notify/alert.py` (已有飞书告警机器人) + 接 `STATS_REPORT_URL` (已有看板上报). 写在 `src/stats_reporter.py` 加新 metric.

### 4.3 cross-backend marker 分独立 key (设计层面遗留)

当前: `sync_state['last_max_row_id']` 在 applescript 模式 = Mail.app ROWID (~54200), 在 davmail 模式 = IMAP UIDNEXT (~147000). cutover 时需要 manual reset (这次 cutover 已做).

**短期决定不做** — 用户明示 "仅考虑一次切换". 但如果未来需要支持来回切, 应该:
- `sync_state['applescript_last_rowid']` / `sync_state['davmail_last_uidnext']` 分独立 key
- 启动时 backend 拿对应 key, 不冲突
- migration 一次性 split 现有 marker

工作量: ~2h. 优先级低, 仅在确定需要双向切换时再做.

### 4.4 DST 边界回归测试

`_normalize_date_received_iso` + `_local_tz()` 用 `/etc/localtime` 解析 IANA zone, 应自动处理 11/01 PDT→PST 切换. 但实测一次:
- 11/01 PST 生效后, 跑 `scripts/dev/fix_date_received_tz.py --dry-run`, 确认没有需要二次 backfill 的 row
- 否则一次性 backfill 跨 DST 边界邮件

---

## 5. P3 — 长期 (3-6 月)

### 5.1 EWS 2026-10 关停应对 (最重要)

**事实**:
- Microsoft 公布 Exchange Web Services for Office 365 **2026-10-01 关停**
- DavMail 6.7 main 仍走 EWS, Graph 路线图 [Issue #404](https://github.com/mguessan/davmail/issues/404) 未 merge
- 公司 IT 不开放 Azure 应用注册, 用户拿不到 Graph 应用注册资格 (PoC memory 记录)

**两条路径**:

**Path A: DavMail Graph 模式 (被动等)**:
- watch DavMail Issue #404 进展
- 2026-08 看 Graph beta 可用 → 切 DavMail Graph mode + 重测 IMAP/SMTP/CalDAV
- 切换成本: 低 (.env 改 `davmail.mode=graph`)
- 风险: 2026-10 前 Graph 未 merge → 必须切 Path B

**Path B: MailAgent 原生 Graph SDK (主动重写)**:
- 申请 Azure AD app 注册 (公司 IT 审批 — 当前**最大障碍**, PoC 期间未通过)
- 写 `src/mail/backend/graph_backend.py` 复用 IMailBackend Protocol
- 全部 6 个方法重写: `detect_new_emails` / `fetch_email_by_id` / `mark_as_read` / `set_flag` / `append_draft` / `discover_drafts_folder`
- 估工作量: 3-4 周 (有 davmail_backend.py ~700 行作参考)
- 优势: 不再走 EWS, 不依赖 DavMail JVM, 跨平台
- 风险: IT 审批不通过 → 全套方案归零

**时间窗**:
- 2026-06 ~ 07: 跟 IT 沟通 Graph app 注册可行性 (Path B 启动条件)
- 2026-08: DavMail Graph 进展 review, 二选一
- 2026-09: 必须 ship 或确认 Path A 可用
- 2026-10-01: EWS 关停

### 5.2 SQLite SSoT Inversion (Sprint 13 后单独 Sprint)

**memory 记录**: v4 SQLite SSoT 落地后, 所有 mutating 操作 (flag 三态、archive、createDraft 等) 应反转方向: 前端 → SQLite → 单向 fanout 到 Mail.app + Notion, 废弃 v3 时代 "Notion → webhook → Mail.app" 反向同步链路.

**当前状态 (cutover 后)**:
- Sprint 15 outbox 已经把 fanout 模式建好了, 但仅适用于反向 sync 的写入
- 前端 callsites (EmailRow.tsx:208/211/218/229) 仍调 `mailApi.notion.updateFlag`, 写 Notion 不写 SQLite
- `handle_flag_changed` / `handle_completed` / `handle_ai_reviewed` 仍是"Notion → handler → outbox → Mail.app" 流向 (Sprint 15 已加 SQLite intent 写入, 但语义仍是 Notion-driven)

**需要做的**:
1. 新增 `email.flag` / `email.updateLocalFlag` IPC, 直写 `email_metadata` + 排两条 fanout (Mail.app / Notion)
2. handler 退化成"Notion 意图通知 → 写 SQLite intent", 不再直接写 Mail.app
3. 前端 callsites 切到新 IPC
4. SyncStore 加 `email_flag_pending` 表 + idempotency 校验

**估工作量**: 1-2 周 (有 outbox 模型作底).
**触发条件**: davmail mode 稳定 + frontend Sprint 18 Settings 完成后启动.

### 5.3 Frontend Sprint 18 — Settings 页面重做

[`frontend/SPRINT18-SETTINGS-HANDOFF.md`](../frontend/SPRINT18-SETTINGS-HANDOFF.md) 已有 handoff. 当前 SettingsPage.tsx 1174 行存在但需要 audit / refactor. 跟 dual-backend cutover 后的关联:
- 加 backend 切换 UI (MAILAGENT_BACKEND 配置项)
- 加 davmail 健康状态展示 (probe 结果)
- 加 davmail 子配置面板 (host / ports / mailbox names)

**触发条件**: davmail mode 观察期满 + UID backfill 完成.

### 5.4 CalDAV 集成 (机会主义, 不阻塞)

`src/calendar_notion/caldav_reader.py` + `build_llm_caldav_context` 已经写好 (Phase C). 但没在 LLM processor 里 inject. 加 3 行代码:

```python
# src/llm_agent/processor.py 加 user_msg 拼接前
from src.calendar_notion.caldav_reader import build_llm_caldav_context
ctx = build_llm_caldav_context(self.cfg, horizon='today')
if ctx:
    user_msg = f"今日日程 (来自 Outlook 日历):\n{ctx}\n\n---\n{user_msg}"
```

**估工作量**: 1h (代码) + 半天 (prompt 调优 + A/B 测对比 LLM 输出质量).
**优先级**: 低, 仅当 LLM 误判被日程上下文能救回的真实 case ≥ 5 个再做.

---

## 6. 已知隐患 trace (持续观察)

(详见 [`next-session-handoff.md`](./next-session-handoff.md) §3)

| # | 隐患 | 等级 | 触发条件 | 应对 |
|---|---|---|---|---|
| H-1 | marker 跨 backend 不兼容 | 中 | 重新切回 applescript 时 | 手动 reset marker (P2 §4.3 永久解决) |
| H-2 | EWS 2026-10 关停 | 高 | 自动触发 | P3 §5.1 双轨方案 |
| H-3 | mail.app 时代 message_id 空 row (~10 封) | 低 | uid-mapper missing | 接受现状, 不修 |
| H-4 | cross-backend merge guard 浪费 sequence | 极低 | cutover 时 | 无害 (10^9 起点几百万年用不完) |
| H-5 | davmail-poc JVM 内存涨 | 低 | 长时间运行 | P2 §4.2 监控告警, 内存 > 250MB 重启 |
| H-6 | DavMail OAuth token 90 天过期 | 高 | 自动触发 | 80 天接近时手动 refresh; 或写 watchdog 自动 |
| H-7 | IT 政策变化 / 风控触发 | 中 | 不可预测 | AppleScript fallback 兜底 |
| H-8 | DavMail IMAP UID 越过 INT64 (极少) | 极低 | UID 超 2^63 | 不会发生 (Microsoft 通常 ≤ 10^7) |

---

## 7. 进度看板 (持续更新)

```
[●●●●●●●●●●] dual-backend Phase A-C 实施 + cutover 执行 (Sprint 16)        ✅ 2026-05-22
[●●●●●●●●●○] uid-mapper backfill (51.7%)                                   🟡 进行中
[●●●○○○○○○○] davmail mode 稳定性观察 (P0, 1-2 天)                          🟡 第一天
[○○○○○○○○○○] 监控告警建设 (P2 §4.2)                                       ⚪ 待启
[○○○○○○○○○○] AppleScript 下架评估 (P2 §4.1)                              ⚪ 等观察期满
[○○○○○○○○○○] EWS 2026-10 关停应对 (P3 §5.1)                              ⚪ 跟踪中
[○○○○○○○○○○] SQLite SSoT Inversion (P3 §5.2)                            ⚪ Sprint 18 后
[○○○○○○○○○○] Frontend Sprint 18 Settings 重做 (P3 §5.3)                  ⚪ 等 handoff
```

---

## 8. 下次 session 立即可做的事

按优先级:

1. **检查 uid-mapper 是否跑完** — `sqlite3 ... "SELECT value FROM sync_state WHERE key='davmail_backfill_progress'"`. 期望 `completed:processed=8877 ...`.
2. **跑端到端测试** — 自己发一封测试邮件, 走完 P0 §2.2 全链路.
3. **监控告警 P2 §4.2 起手** — 接 `notify/alert.py` 加 davmail 进程死亡 + restart_count 突增告警 (~半天).
4. **跟 IT 沟通 Graph app 注册** — P3 §5.1 Path B 启动条件, 越早越好.

---

签字 / Last updated: 2026-05-22 PDT
