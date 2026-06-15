# Next Session Handoff — Post Cutover (2026-05-22)

> **Status**: davmail mode cutover 完成且稳定运行 ~30min. 这份文档给下一个 session cold-pickup.
> **Self-contained**: 不依赖前一个 session 对话上下文.
> **Reader**: 接手 cutover 监控 + 后续 roadmap 推进的下一个 session

---

## 0. 60 秒掌握

```
当前模式: davmail mode (MAILAGENT_BACKEND=davmail, DAVMAIL_POC_MODE=1)
服务进程: pm2 → mail-sync + davmail-poc (LaunchAgent 自启, 重启系统会恢复)
mail.app / Outlook 客户端: 可关 (主链路不依赖)
keep_alive 防锁屏: 自动禁用 (davmail mode logs 已确认)
数据: 8899 emails, ssot 完整, 时间格式 ISO 8601 with tz (含 DST)
测试: 410 全过 (review fix +101 新增)
首封 davmail 邮件: internal_id=1000000000 (Re: Incorrect information in Roadmap), LLM ok
飞书 App Bot: 测试卡片已发, ok
```

---

## 1. 关键文件入口 (cold-pickup 阅读顺序)

```
docs/
├── sprint16-cutover-complete.md          ← 本次 cutover 全程纪要 (推荐先读)
├── dual-backend-architecture-handoff.md  ← 设计原始 + 决策 (含 5 个 open question)
├── dual-backend-phase-abc-handoff.md     ← Phase A/B/C 实施完成 handoff
├── next-session-handoff.md               ← 本文档
└── roadmap-post-cutover.md               ← 短中长期 roadmap

src/mail/backend/                          ← 抽象核心
├── base.py                                ← IMailBackend Protocol
├── types.py                               ← EmailContent / EmailMeta / DraftRequest 等
├── factory.py                             ← create_backend(cfg, sync_store) + probe
├── imap_client.py                         ← IMAP/SMTP connect/auth + cipher key
├── applescript_backend.py                 ← FALLBACK wrapper for arm + radar
├── davmail_backend.py                     ← PRIMARY IMAP/SMTP impl (~700 行)
└── davmail_uid_mapper.py                  ← 后台 UID backfill task

src/mail/sync_store.py                     ← DB v13 + _normalize_date_received_iso + _local_tz + allocate_davmail_internal_id + cross-backend merge guard
src/llm_agent/runner.py:104-119            ← backend 注入路径
src/cli/commands/llm.py                    ← _maybe_create_davmail_backend helper
scripts/dev/
├── audit_davmail_vs_sqlite.py             ← 周期对账工具 (反向 lookup, 不卡时间窗口)
├── normalize_date_received_iso.py         ← 一次性归一 backfill (已跑)
└── fix_date_received_tz.py                ← 修第一版 +08:00 hardcode bug 用 (已跑)
```

---

## 2. 当前状态快照 (跑命令一眼掌握)

```bash
# Service health
pm2 ls

# Last 24h sync status
sqlite3 -header data/sync_store.db "
  SELECT sync_status, COUNT(*) FROM email_metadata
   WHERE date_received >= datetime('now','-1 day')
   GROUP BY sync_status;"

# Backend origin distribution
sqlite3 -header data/sync_store.db "
  SELECT backend_origin, COUNT(*) FROM email_metadata GROUP BY backend_origin;"

# uid-mapper progress (期望逐步从 8873 → 0)
sqlite3 -header data/sync_store.db "
  SELECT value FROM sync_state WHERE key='davmail_backfill_progress';
  SELECT 'with imap_uid: ' || COUNT(*) FROM email_metadata WHERE imap_uid > 0;
  SELECT 'permanent miss (-1): ' || COUNT(*) FROM email_metadata WHERE imap_uid = -1;"

# LLM processing 健康
sqlite3 data/sync_store.db "
  SELECT status, COUNT(*) FROM llm_processing GROUP BY status;"

# Verify time format SSoT (期望全 iso_with_tz)
sqlite3 -header -column data/sync_store.db "
  SELECT CASE WHEN date_received LIKE '%T%+%' OR date_received LIKE '%T%-%' THEN 'iso_with_tz'
              WHEN date_received LIKE '%T%' THEN 'iso_naive'
              ELSE 'other' END AS fmt, COUNT(*)
   FROM email_metadata GROUP BY fmt;"
```

---

## 3. 已知隐患 + Watchout

### 3.1 marker 跨 backend 不兼容 (设计层面)

`sync_state['last_max_row_id']` 在 applescript mode 是 Mail.app ROWID (~54200), 在 davmail mode 是 IMAP UIDNEXT (~147000). cutover 时旧 marker 跟新 backend 类型不匹配 → 触发"看到 93k 新邮件" 误抓.

**短期 mitigation**: 切换时手动 `UPDATE sync_state SET value=<new_marker>` reset. 这一次 cutover 已经做过.

**长期方案**: marker 按 backend 类型分独立 key (e.g. `applescript_last_rowid` / `davmail_last_uidnext`), 启动时 backend 拿对应 key 不冲突. **未做** — 用户决定 "仅考虑一次切换".

### 3.2 EWS 2026-10 关停

Microsoft 公布 Exchange Web Services 2026-10-01 关停. DavMail 6.7 仍在跑 (依赖 EWS 桥到 Graph), Issue #404 是 DavMail Graph migration roadmap. **如果**关停时 DavMail Graph 还没完成 → mail-sync 会挂.

**Plan B** (未实施): MailAgent 用 Microsoft Graph SDK 直连 (Authentication Library MSAL + Graph Mail API). 需要:
- Azure AD app 注册 (公司 IT 审批 — 当前卡这一步)
- 写 `src/mail/backend/graph_backend.py` 复用 IMailBackend Protocol
- IMailBackend.detect_new_emails / fetch_email_by_id / mark_as_read / append_draft 全部 Graph API 重写

**时间窗**: 2026-08 ~ 2026-10 必须完成切换 Graph 或确认 DavMail Graph mode 可用.

### 3.3 mail.app 时代 message_id 空 row

48h 对账 1 封 mail.app 时代抓的 `Pay Statement Notification` (`internal_id=54171`) `message_id` 字段空 — 历史 mail.app SQLite 对某些 Amazon SES 邮件偶发 message_id 提取失败. 邮件本身已 synced 到 Notion, 只是 SQLite 缺 message_id 索引. 不影响功能, 但 davmail backfill / 反查不会命中.

**修复成本**: 高 (需要重新从 Mail.app SQLite 或 IMAP 反查), **收益**: 低 (~10 封历史邮件). 当前**不做**.

### 3.4 cross-backend merge guard 误伤场景

`_save_email_v3` cross-backend merge guard 当 message_id 已存在但 internal_id 不同时, UPDATE 老 row 保留 sync_status. **但**: 跨 backend 切换时浪费 1 个 davmail sequence number (`allocate_davmail_internal_id` 已分配但 row 没建). 无害, 长期 sequence number 不会枯竭 (10^9 起点, 一天几百封, 几百万年才用完 7 位).

### 3.5 davmail-poc PM2 内存

cutover 后第一个 poll cycle (抓全历史时) davmail-poc 内存涨到 227 MB, 之后回落到 110 MB. JVM 正常行为. 长期监控如果持续涨需要 restart davmail-poc.

---

## 4. 优先级任务 (next session 推进)

### P0 (1-2 天观察期)

- [ ] **观察 cutover 1-2 天**, 看 davmail mode 跑稳定. 监控点:
  - mail-sync restart 次数 (期望 ≤ 1 / 天)
  - uid-mapper backfill 完成 (期望 8873 → ≤ 100 missing within ~40min)
  - 真新邮件到达时 davmail 抓回 + LLM 处理 + 飞书触发
  - 反向 flag 同步 (前端切已读 → IMAP STORE 生效 + Outlook 端看到)
  - Craft 创建草稿 → Outlook Drafts folder 出现

- [ ] **跑端到端测试**: 自己发一封测试邮件 (priority 应该 🟡 重要 + action 需要回复), 看是否走完链:
  ```
  收到邮件 → davmail UIDNEXT increment 触发 radar
  → SQLite save_email(backend_origin='davmail', internal_id≥10^9)
  → reader.parse_email_source + EmailRepository.commit (含 body markdown)
  → NotionSync.create_email_page_from_sqlite
  → LLMRunner (backend.arm IMAP fetch) → AILabels → Notion 写 12 字段
  → Notion automation → webhook → handle_ai_reviewed
  → outbox(target=mailapp) → FanoutWorker → IMAP STORE +\Flagged +\Seen
  → 飞书 App Bot 卡片
  ```

### P1 (1 周内)

- [ ] **uid-mapper backfill 跑完** (期望 ~40min): 看 `sync_state['davmail_backfill_progress']` 显示 `completed:processed=8873 backfilled=N missing=M failed=K`. backfill 完成后所有反向 flag / fetch 走快路径 (~200ms vs ~1s message_id 反查).

- [ ] **README.md 更新**: 加 dual-backend 章节, 反映 davmail mode 是当前主路径.

- [ ] **`.env.example` 更新**: 加 davmail 9 字段示例.

### P2 (1 月内)

- [ ] **观察期满后, 评估关 AppleScript 完全 fallback** (`src/mail/backend/applescript_backend.py`, `scripts/create_reply_draft.sh`, `src/mail/applescript_arm.py`). 短期保留作 emergency fallback.

- [ ] **如果观察期发现 DST 边界 / 时区显示问题**: 看 `scripts/dev/fix_date_received_tz.py` 是否需要二次跑 (尤其 11/1 PDT→PST 自动切换).

- [ ] **写 dashboard 监控告警**:
  - `davmail-poc` 进程挂掉 alert (现在没 watchdog)
  - `mail-sync restart_count > 5/day` alert
  - `imap_uid IS NULL` 邮件超 1000 alert (uid-mapper stalled)

### P3 (3-6 月)

- [ ] **EWS 2026-10 关停应对** — 详见 `roadmap-post-cutover.md` §3.

---

## 5. 重启 / 切换演练

### 5.1 系统重启后预期

```bash
# 自动启动顺序 (LaunchAgent → pm2 resurrect → dump.pm2)
1. davmail-poc 启动 (~10s 完成 OAuth token 加载 + 端口监听)
2. mail-sync 启动 (~5s 探测 davmail probe, 失败 fast-restart 直到 davmail ready)
3. 两个进程都 online → 正常运行

# 验证
pm2 ls
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='last_max_row_id'"
# 期望: 147756 或更高
```

### 5.2 回切 AppleScript (emergency)

如果 davmail 出现严重问题需要回切:

```bash
pm2 stop mail-sync
sed -i.bak 's/^MAILAGENT_BACKEND=davmail/MAILAGENT_BACKEND=applescript/' .env

# 关键: marker reset 到 Mail.app ROWID, 否则 applescript 看 marker=147756 永远 has_new=False
sqlite3 data/sync_store.db "
  UPDATE sync_state SET value = (
    SELECT MAX(internal_id) FROM email_metadata WHERE backend_origin='applescript'
  ) WHERE key='last_max_row_id';"

pm2 start mail-sync
```

**Cross-backend merge guard** 保护 davmail 时代抓的 (internal_id >= 10^9) row 不会丢 — 它们仍在 SQLite, mail.app 不会再写它们. 新 mail.app row 用 ROWID > 54222 (当前 max) 继续走.

### 5.3 davmail OAuth token 失效

如果 davmail-poc 报 token 过期 (`BadPaddingException` 之类):
```bash
cd davmail-poc
rm -f token/token.dat  # 清 token cache
# 手动重新跑 OAuth manual flow (浏览器 + 粘 callback URL)
pm2 restart davmail-poc
```

---

## 6. 测试 / 验证清单

```bash
# 全量回归
source venv/bin/activate
pytest tests/ -q --tb=short
# 期望: 410+ passed, 0 failed

# 端到端对账 (跟 IMAP server 真实比对)
DAVMAIL_POC_MODE=1 python scripts/dev/audit_davmail_vs_sqlite.py --hours 48
# 期望: davmail=X sqlite=Y intersect=Y, MISS ≤ 1-2 (mail.app 时代 message_id 空 row)

# Backend switch dry-run
DAVMAIL_POC_MODE=1 python scripts/dev/test_backend_switch.py --backend both --samples 5
# 期望: 5/5 subject 一致

# 时间格式 SSoT 一致
sqlite3 data/sync_store.db "
  SELECT COUNT(*) FROM email_metadata WHERE date_received LIKE '%T%+%' OR date_received LIKE '%T%-%';
  SELECT COUNT(*) FROM email_metadata WHERE date_received NOT LIKE '%T%';"
# 期望: 第一行 = total, 第二行 = 0
```

---

## 7. 上下游联动 / 文档地图

| 主题 | 文档 |
|---|---|
| 当前架构 (v3 + v4 SSoT + dual-backend) | `CLAUDE.md` |
| dual-backend 设计 + 决策 | `docs/dual-backend-architecture-handoff.md` |
| Phase A/B/C 实施 | `docs/dual-backend-phase-abc-handoff.md` |
| Sprint 16 cutover 实施 | `docs/sprint16-cutover-complete.md` |
| roadmap | `docs/roadmap-post-cutover.md` |
| DavMail PoC 探测 (cipher key / OAuth / 端口) | `davmail-poc/POC-RESULTS.md` |
| Sprint 15 outbox / fanout | `docs/sprint15-backend-complete.md` |
| LLM agent 启用 | `docs/LLM_AGENT_SETUP.md` |
| v4 SQLite SSoT | `docs/architecture_v4_sqlite_ssot.md` |
| frontend handoff | `frontend/SPRINT*-HANDOFF.md` |

---

签字 / Last updated: 2026-05-22 PDT
