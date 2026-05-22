# Sprint 16 — Dual-Backend Cutover Complete

> **Status**: ✅ 完成 — davmail mode 已切换上线 2026-05-22 14:20 PDT, mail-sync 主服务运行稳定.
> **Author**: 收尾会话 2026-05-22
> **Scope**: Sprint 16 dual-backend 全程纪要 — 设计、review、修复、cutover 执行、cutover-only bug 发现修复
> **Companion**: [`dual-backend-architecture-handoff.md`](./dual-backend-architecture-handoff.md) 设计原始 / [`dual-backend-phase-abc-handoff.md`](./dual-backend-phase-abc-handoff.md) 实施完成 handoff

---

## 0. TL;DR

- **Goal**: AppleScript + Mail.app 单一驱动 → DavMail IMAP/SMTP + AppleScript 双 backend, env 切换
- **Why**: macOS Mail.app 慢路径 (~100s) + 锁屏 / GUI 依赖 / EWS 2026-10 关停应对
- **How**: `IMailBackend` Protocol + alias 兼容层让 NewWatcher / fanout / handler 19+ 处零改动
- **Cutover**: `MAILAGENT_BACKEND=davmail` + `DAVMAIL_POC_MODE=1` 写 `.env` 重启 mail-sync 即生效

---

## 1. Review 修复 (commits `2df739f..bcba082`)

oh-my-claudecode:code-reviewer (opus max-effort) 对 Phase A/B/C 三个 commit (~3400 行) 跑完整 review, 发现 **3 CRITICAL + 8 HIGH + ~14 MEDIUM**, 全部修复.

| Severity | # | 修复 |
|---|---|---|
| CRITICAL | 3 | 1) `_decode_mime_header` import 顺序 ; 2) `allocate_davmail_internal_id` 接通主键策略 ; 3) IMAP SELECT/STATUS RFC 3501 §6.3.10 合规 + READ-ONLY check |
| HIGH | 8 | discover_drafts close bug / SEARCH HEADER quote / arm-alias int+str dispatch / References chain / ISO 8601 / caldav defensive / executemany batch / dropped log |
| MEDIUM | ~14 | imap_uid > 0 / UID 回写 / appenduid regex / concat 不 break / display name+UA / `\Seen` flag / UIDNEXT 窗口 / `getaddresses` / POC_MODE gate / case-insensitive mailbox |

测试: **101 个新单测**覆盖 (`tests/mail/backend/test_davmail_backend.py` × 44, `tests/events/test_handlers_davmail_draft.py` × 11, `tests/mail/backend/test_davmail_uid_mapper.py` × 6, `tests/mail/test_sync_store_v13_migration.py` × 15, `tests/calendar_notion/test_caldav_reader.py` × 31), 跑 410 passed (review handoff §2.2 列的回归集).

**Cross-backend merge guard** (commit `ea1e371`): `_save_email_v3` 加 message_id UNIQUE 冲突保护. 跨 backend 切换时同 message_id 不 INSERT OR REPLACE 杀老 row, 只 UPDATE backend 字段, 保留 `notion_page_id` / `sync_status='synced'` / `thread_id`. 防 cutover 时数据丢失.

**Malformed JSON guard** (commit `bcba082`): frontend SQL `json_extract(labels_json, '$.x')` 加 `CASE WHEN json_valid(...)` 守卫 + LLM 写入路径 `_truncate_long_fields` 截字段值 (而非整 JSON 字符串). 一封 4000-char truncated row 触发整个 listEnriched 炸的事故修了, 防御 fundamentals.

---

## 2. Cutover 执行 (2026-05-22 14:14 → 14:53 PDT)

### 2.1 Baseline

```
total: 8899 emails
all backend_origin='applescript'
sync_status: 6537 synced / 2360 skipped / 1 dead_letter / 1 deleted
last_max_row_id: 54222 (Mail.app ROWID)
davmail-poc PM2 13h online
mail-sync PM2 22h online
```

### 2.2 切换步骤

```bash
pm2 stop mail-sync
echo 'MAILAGENT_BACKEND=davmail' >> .env
echo 'DAVMAIL_POC_MODE=1' >> .env
echo '' >> .env  # ← 切换中发现必须加 trailing newline 否则 pydantic 解析全文 short-circuit
pm2 start mail-sync
sleep 30 && pm2 logs mail-sync --lines 100 --nostream | grep "backend='davmail'"
```

### 2.3 Cutover-only Bug 现场发现 + 修复

切换过程中**真实暴露** 3 个 cutover-only bug, 全部修复 (commits `0de1f3a`, `9c0e634`, `dd29ff2`):

#### Bug A — `DAVMAIL_POC_MODE=1` 不被 Pydantic 读取

- **现象**: 启动 `❌ DAVMAIL_CIPHER_KEY required` 即便 .env 设了 `DAVMAIL_POC_MODE=1`
- **根因**: `imap_client.get_cipher_key` 用 `os.environ.get("DAVMAIL_POC_MODE")`, 但 Pydantic-Settings 不会把 unknown env 写入 `os.environ` (即便 `extra='ignore'`)
- **修**: Config 加 `davmail_poc_mode: bool = Field(default=False, env='DAVMAIL_POC_MODE')` 字段, imap_client 改 `getattr(cfg, 'davmail_poc_mode', False)`

#### Bug B — `last_max_row_id=54222` (Mail.app ROWID) 触发 davmail 抓 93k 历史邮件

- **现象**: mail-sync 启动看到 `Detected ~93534 new emails (row_id 54222 -> 147756)` — davmail UIDNEXT 跟 Mail.app ROWID 数值比对
- **根因**: cross-backend marker 不兼容. AppleScript marker = Mail.app ROWID (~54200), DavMail marker = IMAP UIDNEXT (~147000). cutover 时旧 marker 跟新 backend 类型不匹配.
- **修**: 手动 `UPDATE sync_state SET value='147756' WHERE key='last_max_row_id'` 重 baseline 到当前 IMAP UIDNEXT, 跳过 93k 历史 fetch (这些 mail.app 时代已 synced 到 Notion, 不需要重抓). Cross-backend merge guard 保护数据不会因 cutover marker 错配丢失.
- **遗留**: marker 跨 backend 不兼容是设计原 limitation (single-driver explicit cutover 假设), 来回切需要 manual reset. 未来如需支持来回切, 应该把 marker 按 backend 分独立 key (`sync_state['applescript_last_rowid']` / `sync_state['davmail_last_uidnext']`).

#### Bug C — LLM runner 仍调 AppleScript fetch, davmail-origin 邮件 LLM 字段空

- **现象**: 第一封 davmail 抓的邮件 (`internal_id=1000000000`) Notion 上 AI 字段全空; logs 报 `AppleScript fetch failed for internal_id=1000000000`
- **根因**: `LLMRunner._lazy_arm()` hardcoded `AppleScriptArm()`. davmail-origin `internal_id >= 10^9` → AppleScript `whose id = 1.0E+9` 找不到 Mail.app 的邮件 → fetch 失败
- **修**: `LLMRunner.__init__` 加 `backend` 参数, `_lazy_arm` 优先用 `backend.arm` (davmail mode 走 IMAP fetch). `new_watcher.py` + `src/cli/commands/llm.py` 启动 LLMRunner 时传 backend.

#### Bug D — HTML link `Invalid URL for link` 死信 (顺手修)

- **现象**: cutover 后扫存量发现 1 封死信 `回复: 酒店portal认证` 5 次 retry 全挂
- **根因**: 邮件 HTML 含 `http://%3ccontroller-domain%3e/.well-known/acme-challenge/` (URL-encoded `<>` placeholder), Notion API 解码后拒
- **修**: `html_converter._sanitize_link_url` 加 `_LINK_PLACEHOLDER_RE = r"%3[cCeE]"` reject URL-encoded angle brackets. `mailagent email resync 54043` 救活该死信.

#### Bug E — `date_received` SSoT 时间格式不统一 (用户提)

- **现象**: SQLite 里 5146 行 space-naive (mail.app SQLite radar 路径) + 3751 行 ISO with tz (raw MIME 解析路径), 字典序排序混乱, 前端 EmailList 跟 Outlook 显示时间对不上
- **修**: 两步
  1. `_normalize_date_received_iso` helper 入口归一, `_local_tz()` 用 `/etc/localtime` 解析 IANA zone (e.g. `America/Los_Angeles`) 自动处理 DST. 第一版 hardcode `+08:00` 假设北京时间, 用户在 PDT 系统下错标 — 已修 (Bug E.1).
  2. `scripts/dev/fix_date_received_tz.py` 一次性 backfill 5153 行, 现在 8899/8899 全 iso_with_tz, DST 边界自动识别 (5月 `-07:00`, 1月 `-08:00`).

### 2.4 验证证据

```
✓ davmail probe ok: uidvalidity=1, drafts='Drafts'
✓ NewWatcher backend=DavMailBackend, arm/radar alias 转 IMAP
✓ uid-mapper 后台跑 8873 emails backfill
✓ 第一封 davmail-origin: internal_id=1000000000, backend_origin='davmail', imap_uid=147733
✓ LLM 链路: mailagent llm run 1000000000 success, prompt cache r=8646 hit
✓ 飞书 App Bot 测试卡片: ok=True, message_id=om_x100b6e3979c42ca0c2d723610cf98e1
✓ 48h 对账: 265/266 命中 (1 封 mail.app 时代 message_id 留空, 不算漏)
✓ 时间格式: 8899/8899 iso_with_tz, DST 边界正确
✓ 410 测试全过
```

---

## 3. 当前状态 (2026-05-22 收尾时)

```bash
$ pm2 ls
mail-sync       online      33m uptime  davmail mode
davmail-poc     online      15h uptime  IMAP 1143 / SMTP 1025 / CalDAV 1080

$ sqlite3 data/sync_store.db ...
total emails: 8899
backend_origin distribution:
  applescript: 8897
  davmail: 2 (internal_id 1000000000, 1000000001)
imap_uid backfill: 6 / 8873 (uid-mapper 后台跑中)
last_max_row_id: 147756 (IMAP UIDNEXT 起点)
sync_status: 6539 synced + 2360 skipped + 0 failed + 0 dead_letter

.env additions:
  MAILAGENT_BACKEND=davmail
  DAVMAIL_POC_MODE=1

PM2 自启: pm2 save --force 已执行, LaunchAgent pm2.chenyuanquan.plist 配置 RunAtLoad=true
```

---

## 4. Commit 集 (按时间倒序)

```
dd29ff2 fix(llm): runner 接 backend, davmail mode 用 IMAP fetch 而非 AppleScript
9c0e634 fix(sync_store): date_received 用系统 IANA tz (修第一版 hardcode +08:00 bug)
25eef50 fix(sync_store): date_received 统一归一为 ISO 8601 带 tz
1d9ce8f fix(html_converter): reject URL-encoded angle bracket placeholders
0de1f3a fix(config): 加 davmail_poc_mode 字段 — cutover PoC fallback 没生效
25274a7 Merge PR #7 from sprint14-chat (含 review fix 全套 + Sprint 14 chat 主题)
  ├─ bcba082 fix(json): malformed labels_json 防御
  ├─ ea1e371 fix(sync_store): cross-backend merge guard
  ├─ 91417b8 test(backend): 5 个新测试文件 +101 tests
  ├─ 4f26924 fix(sync_store): v13 加 processing_status ALTER + CLI DB_VERSION 同步
  ├─ 2df739f fix(backend): review CRITICAL × 3 + HIGH × 8 安全闭环
  └─ b4b4e85, 77801c9, ebb7494, a7ec5f2 (Phase A/B/C 原始 + handoff)
```

---

## 5. 后续工作

详见 [`next-session-handoff.md`](./next-session-handoff.md) 和 [`roadmap-post-cutover.md`](./roadmap-post-cutover.md).
