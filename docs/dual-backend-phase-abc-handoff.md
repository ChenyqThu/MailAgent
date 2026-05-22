# Handoff — Dual-Backend Phase A + B + C 实施完成, 待 review / test / 切换验收

> **Status**: 代码 ship 完成 (3 commit), 主服务未切换. 下次 session 任务 = 代码 review + 单测/系统测试 + davmail 切换验收.
> **Author handoff date**: 2026-05-22
> **Reader**: 下一个负责验证 + 切换 davmail 的 session
> **Self-contained**: 不依赖前一个 session 的对话上下文; 所有关键事实在本文档或引用的 commit 里
> **关联**: `docs/dual-backend-architecture-handoff.md` (设计 + 决策原始文档)

---

## 0. TL;DR (60 秒掌握)

- **3 个 commit 落地**, `sprint14-chat` 分支: `a7ec5f2` (Phase A) → `ebb7494` (Phase B) → `77801c9` (Phase B.3 + C)
- **mail-sync 主服务未受影响** — 仍跑 applescript 模式 ~10h online, AppleScript 路径 100% 向后兼容, 303 测试全过
- **davmail mode 一键可切** — `echo 'MAILAGENT_BACKEND=davmail' >> .env && pm2 restart mail-sync`, 已端到端 dry-run (subject 3/3 match)
- **下次 session 工作**:
  1. **代码 review** — 3 个 commit (~3400 行) 完整审一遍, 找 bug / 边界 / 风格
  2. **补单测 / 系统测试** — backend wire 集成测试; davmail 模式 outbox/fanout/handler 路径覆盖
  3. **切换验收** — 实际 `MAILAGENT_BACKEND=davmail` + pm2 restart, 跑 1-2 天观察 (正向 sync / 反向 flag / draft / LLM / 飞书)
- **Future scope 标记不做** (5 个月内不碰):
  - ❌ Microsoft Graph SDK 直连 (跳过 DavMail) — EWS 2026-10 关停前再启动
  - ❌ DavMail 正式 IT 审批 (申请 Graph app 注册) — 等政策放开
  - ❌ Shadow mode 对账工具 — single-driver 切换不需要
  - ❌ 自动 health-check + circuit-breaker fallback — single-driver 不需要

---

## 1. 不变的事实 (Read First)

### 1.1 三个 commit 的内容速览

| Commit | 范围 | 行数 |
|---|---|---|
| `a7ec5f2` Phase A | backend 抽象层 (Protocol + types + factory) + AppleScriptBackend wrapper + DavMailBackend 新 IMAP impl + DB v12→v13 (3 列 + 2 索引 + AUTOINCREMENT seq) + config 7 字段 + main.py probe + NewWatcher 接 backend 参数 + 21 backend 单测 + dry-run 脚本 | 2482 |
| `ebb7494` Phase B | DavMailBackend 加 arm/radar 兼容层 alias methods (self.arm = self, self.radar = self), 让 NewWatcher/fanout/handler 19+ 处 self.arm/self.radar 调用零改动支持 davmail mode + main.py 删 davmail 阻断 + fetch_recent 真实现 (RFC 2047 decode + thread_id 提取) | 240 |
| `77801c9` Phase B.3 + C | handle_create_draft 加 davmail branch (IMAP APPEND 替代 sh GUI 注入) + davmail_uid_mapper 后台 backfill 存量 8857 邮件 imap_uid + caldav_reader (CalDAV→LLM context, build_llm_caldav_context helper) + cfg 加 2 字段 | 667 |

总计: 18 new files, 8 modified files, ~3400 lines new code, 303 tests passing.

### 1.2 当前服务状态

```
$ pm2 ls
┌────┬────────────────┬───┬─────────┬──────────┬────────┐
│ id │ name           │ … │ ↺       │ status   │ uptime │
├────┼────────────────┼───┼─────────┼──────────┼────────┤
│ 0  │ mail-sync      │ … │ 35      │ online   │ ~10h   │  ← AppleScript 模式
│ 1  │ davmail-poc    │ … │ 1       │ online   │ ~1h    │  ← PoC DavMail JVM 跑
└────┴────────────────┴───┴─────────┴──────────┴────────┘

git branch: sprint14-chat
git log -3 --oneline:
  77801c9 feat(backend): Phase B.3 + C — davmail draft IMAP APPEND + UID backfill + CalDAV LLM context
  ebb7494 feat(backend): Phase B — davmail mode 主流程完整 wire (正向 sync + 反向 flag)
  a7ec5f2 feat(backend): dual-backend abstraction Phase A — DavMail driver + AppleScript wrapper

测试: pytest tests/mail/ tests/sync/ tests/events/ tests/repository/ tests/mail/backend/ → 303 passed
DB: v13 (auto-migrated, sync_store.db 已含 imap_uidvalidity/imap_uid/backend_origin 列)
.env: 当前未配 MAILAGENT_BACKEND, 默认 applescript
```

### 1.3 backend 抽象的物理边界

**走 backend 抽象**:
- 写入 SQLite 的数据源 (正向 sync: fetch + 雷达)
- SQLite outbox fanout 写回的接口 (反向 sync: flag/read + draft create)

**不走 backend 抽象**:
- SQLite SSoT 本身 / NotionSync / LLM Agent / FanoutWorker 调度 / handler 入口 / webhook / 飞书通知 / meeting_sync iCalendar 解析 / 前端 IPC

详见 plan §"切换边界 — 什么走 backend, 什么不走" (在 `~/.claude/plans/ultrathink-docs-dual-backend-architectur-fluttering-bentley.md`).

### 1.4 主键策略

- `email_metadata.internal_id` 仍是 PRIMARY KEY (不动)
- AppleScript 时代 internal_id = Mail.app SQLite ROWID (< 1_000_000_000)
- DavMail 时代 internal_id = `sync_store.allocate_davmail_internal_id()` 起点 1_000_000_000 atomic
- `(imap_uidvalidity, imap_uid)` 副字段定位 IMAP 端实际邮件
- `backend_origin` 列标记哪个 backend 生成的

---

## 2. 下次 session 的三大任务

### 2.1 任务 A — 代码 review (估 2-3h)

**对象**: `a7ec5f2` / `ebb7494` / `77801c9` 三个 commit, 约 3400 行新代码.

**review 重点 (按文件)**:

| 文件 | review 焦点 |
|---|---|
| `src/mail/backend/base.py` | IMailBackend Protocol 8 个方法签名是否合理; runtime_checkable 是否足够 |
| `src/mail/backend/types.py` | EmailContent.to_legacy_dict() 字段跟 AppleScriptArm.fetch_email_content_by_id 返回 dict 是否真完全对齐 (尤其 "date" vs "date_received"); DraftRequest 字段是否够 |
| `src/mail/backend/factory.py` | create_backend probe 失败时是否 raise 干净; davmail mode 强制 sync_store 注入是否合理 |
| `src/mail/backend/applescript_backend.py` | wrap arm/radar 是否真零改动行为; AppleScriptArm.fetch_emails_by_position 转 EmailMeta 时 thread_id 处理 |
| `src/mail/backend/imap_client.py` | IMAP/SMTP context manager 异常处理; cipher key fallback 默认值 'mailagent-poc-shared-key' 是否泄露安全 (commit 已警告) |
| `src/mail/backend/davmail_backend.py` | **重点 review** ~700 行: RFC 2047 header decode 完整性 (`_decode_mime_header`); UID FETCH BODY[] 解析 multipart MIME / content 提取逻辑; IMAP UID STORE flag 操作是否真幂等; APPEND 文件夹名 detection (SPECIAL-USE + fallback) 容错; arm/radar 兼容层 alias method 是否真覆盖所有 19 处调用场景 (尤其 NewWatcher 没显式调用但 fanout/handler 间接用的) |
| `src/mail/backend/davmail_uid_mapper.py` | batch backfill 限流是否合理 (50/batch); sync_state 续传逻辑是否真 work; -1 sentinel for permanent miss 是否会被后续误处理 (查 fetch_email_by_id 是否检查 imap_uid > 0) |
| `src/calendar_notion/caldav_reader.py` | vobject 解析是否完整 (Teams 链接抽取的 regex 边界); window filter 是否正确处理 timezone naive vs aware |
| `src/mail/sync_store.py` v13 migration | DB_VERSION = 13 + ALTER TABLE 3 列 + `allocate_davmail_internal_id` BEGIN IMMEDIATE 原子性 + sync_sequence seed |
| `src/events/handlers.py` | EventHandlers 加 backend 参数; `_create_draft_via_imap` 计算 reply-all 收件人逻辑 (排除自己 + dedup + Re: subject 处理); `_split_addrs` 边界 (引号 / 中文 / IDN) |
| `src/mail/new_watcher.py` | NewWatcher.__init__ backend 参数; backend wrap arm/radar 那段 hasattr 检查 |
| `main.py` | EmailNotionSyncApp 启动序列改动 (probe / keep_alive 禁用 / wire backend 给 handlers / backfill task fire-and-forget); 关闭时 cleanup task list |
| `src/config.py` | 9 个新字段 (mailagent_backend / davmail_*) Field description + env 命名 |

**review 风格建议**: 跑 `codex code-reviewer` agent 或 `oh-my-claudecode:code-reviewer` 全量过一遍, 重点逻辑边界, 写 inline comment 标 severity (critical/major/minor/nit).

```bash
# 推荐命令
git diff a7ec5f2^..77801c9 -- src/ tests/ main.py | head -3000
# 或者按 commit 分:
git show a7ec5f2 --stat
git show ebb7494 --stat
git show 77801c9 --stat
```

### 2.2 任务 B — 补单测 / 系统测试 (估 3-4h)

**单测覆盖空白 (按优先级)**:

| 优先级 | 测试范围 | 文件 |
|---|---|---|
| 高 | DavMailBackend arm/radar 兼容层 alias methods (mock IMAP server) | `tests/mail/backend/test_davmail_backend.py` (new) |
| 高 | `_create_draft_via_imap` reply-all 收件人计算 / Re: 主题 / extra_to/cc merge / 自己邮箱排除 (mock backend.append_draft) | `tests/events/test_handlers_davmail_draft.py` (new) |
| 高 | `DavMailUidMapper._fetch_batch_to_backfill` + `_backfill_one_batch` (mock IMAP, 验证 batch sql / UPDATE 副字段) | `tests/mail/backend/test_davmail_uid_mapper.py` (new) |
| 中 | `CalDAVReader._parse_event` 各种 vEVENT 形状 (all-day / multi-attendee / Teams link / recurring expansion); window filter timezone 边界 | `tests/calendar_notion/test_caldav_reader.py` (new) |
| 中 | `allocate_davmail_internal_id` 并发原子性 (multi-thread 抢序列) | `tests/mail/test_sync_store_v13_migration.py` (new) |
| 低 | `_decode_mime_header` 各种 charset (gb2312, gbk, big5, utf-8, base64 vs quoted-printable) | `tests/mail/backend/test_davmail_backend.py` |

**系统测试 (端到端, mock 服务)**:

```bash
# 1. backend switching dry-run (已有)
python scripts/dev/test_backend_switch.py --backend both --samples 5
# 期望: 5/5 subject 一致

# 2. davmail mode 完整启动 + 跑 1 个 poll cycle (新加 dry-run 脚本):
# scripts/dev/test_davmail_poll_cycle.py  (待写)
# - 启动 EmailNotionSyncApp (davmail mode)
# - 手动触发 watcher._poll_cycle() 一次
# - 验证 SQLite email_metadata 有新邮件 (backend_origin='davmail', imap_uid 填充)

# 3. outbox fanout davmail dry-run:
# scripts/dev/test_davmail_outbox.py  (待写)
# - 注入一条 outbox(target='mailapp', payload={is_read: True})
# - 启动 FanoutWorker (davmail backend) 跑一 tick
# - 验证 IMAP STORE +\Seen 真生效 (UID FETCH 验证 flag)

# 4. draft IMAP APPEND dry-run:
# scripts/dev/test_davmail_draft.py  (待写)
# - 模拟 webhook event {properties: {reply_suggestion, ...}}
# - 调 EventHandlers.handle_create_draft (davmail mode)
# - 验证 Drafts 文件夹有新草稿 (IMAP UID SEARCH 验证)
# - 验证 Notion page Processing Status = '草稿已创建'
```

**回归测试**:

```bash
# 必须保持 303 测试通过
pytest tests/mail/ tests/sync/ tests/events/ tests/repository/ tests/mail/backend/ -v
# 期望: 303 passed (含 21 backend 单测)

# 整体回归 (含 Notion / LLM / 项目周报 / 日历)
pytest tests/ -q --tb=short
# 注意: 全量回归可能含 davmail-poc / fixtures 依赖, 看是否需要 setup
```

### 2.3 任务 C — davmail 切换验收 (估 1-2 天观察)

**切换步骤**:

```bash
# 0. 切换前 baseline
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_metadata WHERE backend_origin='applescript'"
# 记录: 应该是 ~24000+ (现有存量)
pm2 logs mail-sync --lines 50 --nostream > /tmp/baseline.log

# 1. 停服务
pm2 stop mail-sync

# 2. 启用 davmail
echo 'MAILAGENT_BACKEND=davmail' >> .env

# 3. 重启
pm2 start mail-sync

# 4. 等 30s 验证启动日志
sleep 30
pm2 logs mail-sync --lines 100 --nostream | grep -E "backend=|davmail|IMAP|backfill|keep_alive|ERROR"
# 期望:
#   [backend-factory] backend='davmail' probe ok: DavMail OK (uidvalidity=1, drafts='Drafts')
#   [main] keep_alive 自动禁用 (davmail backend 走 IMAP/SMTP, 不需要 UI session)
#   Using NewWatcher (backend=davmail, SQLite Radar + AppleScript Arm)
#   [davmail-uid-mapper] start backfill, pending=8857
#   (后续 ~40min) [davmail-uid-mapper] batch done internal_id≤X: +50 backfilled ...
```

**验收 checklist (1-2 天观察)**:

| 验收项 | 测试动作 | 期望 | 失败时 |
|---|---|---|---|
| 正向同步 (新邮件 → Notion) | 自己发一封测试邮件 | ≤2min Notion 出现 (davmail 30s 轮询 + Notion API ~30s) | 看 pm2 logs 找 IMAP / Notion error |
| 反向 flag (Notion → Mail) | Notion 上标某邮件 Is Read=True | ≤30s outbox + fanout 派发 IMAP STORE 生效 (Outlook 端变已读) | sqlite3 看 email_outbox status; logs 找 fanout error |
| AI Reviewed → flag + 飞书 | Notion 改 Processing Status=AI Reviewed | ≤1min 飞书卡片到 + Outlook 旗标 + Notion 状态'已同步' | 看 pm2 logs handler trace |
| Draft 创建 (Craft 按钮) | 前端 AI Chat 点 Craft | ≤30s Outlook Drafts 出新草稿 (富文本完整 + In-Reply-To 线程折叠) | IMAP APPEND 失败看 davmail-poc PM2 log |
| LLM 字段填充 | 等下一封新邮件 (60s 内) | Notion AI Action / Priority / Reply Suggestion 等填齐 | LLM_AGENT_ENABLED 是否 true |
| FTS5 全文搜索 | 前端搜索框搜关键词 | 命中 SQLite (跟 backend 无关) | sanity check, 不期望 break |
| UID Backfill 完成 | `sqlite3 .. "SELECT value FROM sync_state WHERE key='davmail_backfill_progress'"` | `completed:processed=8857 backfilled=N ...` (~40min) | 跑 `mailagent admin dead-letter list` 看死信 |
| 反向 fetch 快路径 | sqlite3 random pick 一封, 测 `python -c "backend.fetch_email_by_id(N)"` 时间 | <500ms (backfill 完成后用 imap_uid 直接 FETCH) | 验证 imap_uid 列不是 NULL |

**回滚步骤** (任何环节出问题):

```bash
pm2 stop mail-sync
sed -i.bak 's/^MAILAGENT_BACKEND=davmail/MAILAGENT_BACKEND=applescript/' .env
pm2 start mail-sync
# AppleScript 路径完全兼容, 切回不丢数据 (sync_store 主键 internal_id 不变)
```

---

## 3. 待 polish 的细节 (review 时可同步处理)

### 3.1 必须做

- **`src/llm_agent/processor.py` 加 caldav inject 一行代码** (3 行, prompt 调优 sensitive 没碰):
  ```python
  from src.calendar_notion.caldav_reader import build_llm_caldav_context
  ctx = build_llm_caldav_context(self.cfg, horizon='today')
  if ctx:
      user_msg = f"今日日程 (来自 Outlook 日历):\n{ctx}\n\n---\n{user_msg}"
  ```
  需要 review LLM prompt 风格决定具体注入位置 (system 段 vs user 段).

- **DavMailBackend.fetch_email_by_id 检查 imap_uid > 0** (handle -1 sentinel for permanent miss):
  ```python
  if imap_uid and imap_uid > 0:
      # 快路径
  else:
      # message_id 反查 / 或 直接 return None
  ```

### 3.2 可选优化

- IMAP connection pooling (当前每个操作开新连接, ~100ms LOGIN overhead). 用 imapclient + pooling 可减 50% latency.
- IMAP IDLE 启用尝试 (PoC 说 6.3/6.7 不推送, 但 DavMail 升级到新版可能 work, `DAVMAIL_USE_IDLE=true` flag 留 future).
- `_create_draft_via_imap` 加附件 (forward / reply with attachments). 当前 DraftRequest.attachments 字段已留, 但 _build_reply_mime 未实现.
- IMAP UID SEARCH HEADER 批量化 (现在 1 个 SEARCH 1 个 message_id; 可用 OR HEADER 子句一次查多个, ~5x 加速 backfill).

### 3.3 文档同步

- `CLAUDE.md` 加一段 "Sprint 16 — dual-backend single-driver switch" (类似 Sprint 15 那段); 当前 CLAUDE.md 没记录这次架构改动.
- `.env.example` 加新字段示例 (MAILAGENT_BACKEND / DAVMAIL_HOST / DAVMAIL_IMAP_PORT 等).

---

## 4. ❌ 不做 (5 个月内不碰)

| 项目 | 为什么不做 | 时间窗 |
|---|---|---|
| Microsoft Graph SDK 直连 (跳过 DavMail) | EWS 2026-10 关停前的 backup plan, 但 DavMail 6.7 跟 Graph 路线图 (Issue #404) 仍在跑, 现状够用 | 等 2026-09 看 DavMail Graph merge 状态再启动 |
| DavMail 正式 IT 审批 (Graph app 注册) | 当前 well-known client_id 伪装擦边球, 但本机 127.0.0.1 自用合规风险可控 | 等 IT 政策放开 |
| Shadow mode 对账工具 (`mailagent backend compare-paths`) | user 选 single-driver 直 cutover, 自动 fallback 也不要 | 不做 |
| 自动 health-check + circuit-breaker fallback | 同上, single-driver 不需要 | 不做 |
| 改 fanout/handler/reverse_sync 真正接 backend 参数 (替代 self.arm) | Phase B 用 alias 兼容层让 self.arm = backend 透明 work, 不需要侵入式重写 | 不做 |
| AppleScript 路径完全下架 (`scripts/create_reply_draft.sh` + `html_clipboard.py`) | 保留作 fallback, DavMail 万一挂可立即切回 | 至少 davmail 稳跑 3 个月再考虑 |

---

## 5. 关键文件入口 (cold-pickup 阅读顺序)

```
docs/
├── dual-backend-architecture-handoff.md    ← 设计 + 决策原始文档 (1500 行, 含 plan §3 5 个 open question)
└── dual-backend-phase-abc-handoff.md       ← 本文档

~/.claude/plans/
└── ultrathink-docs-dual-backend-architectur-fluttering-bentley.md  ← 实施 plan, 含主键策略方案 D / 周边功能适配清单

src/mail/backend/                            ← 抽象核心
├── __init__.py                              ← public API
├── base.py                                  ← IMailBackend Protocol
├── types.py                                 ← EmailContent / EmailMeta / RadarTick / DraftRequest / DraftAppendResult
├── factory.py                               ← create_backend(cfg, sync_store) + probe
├── imap_client.py                           ← IMAP/SMTP connect/auth helper
├── applescript_backend.py                   ← FALLBACK wrapper for arm + radar
├── davmail_backend.py                       ← PRIMARY IMAP/SMTP impl (~700 行, 含 arm/radar 兼容层 alias)
└── davmail_uid_mapper.py                    ← Phase C.1 后台 backfill task

src/calendar_notion/
└── caldav_reader.py                         ← Phase C.2 CalDAV → LLM context

src/mail/sync_store.py:115-130              ← DB_VERSION 12→13 注释
src/mail/sync_store.py:640-700              ← v13 migration 块 (ALTER TABLE + AUTOINCREMENT seq)
src/mail/sync_store.py:1330-1380            ← allocate_davmail_internal_id()
src/events/handlers.py:32-77                ← EventHandlers __init__ 加 backend
src/events/handlers.py:467+                 ← handle_create_draft davmail branch
src/events/handlers.py:624+                 ← _create_draft_via_imap + _split_addrs
main.py:17-95                                ← EmailNotionSyncApp.__init__ backend wire
main.py:298-313                              ← uid_backfill_task fire-and-forget
src/config.py:359-415                       ← 9 个新 backend/davmail 字段

tests/mail/backend/                          ← 21 单测 (types/factory/applescript_backend)
scripts/dev/test_backend_switch.py          ← 端到端 dry-run 工具

davmail-poc/                                ← (gitignored) PoC 工作产物
├── POC-RESULTS.md                          ← 完整验证记录 + 12 条经验
├── test_imap_suite.py                      ← IMAP helper 参考实现
├── test_smtp_reply.py                      ← SMTP MIME 参考实现
└── test_caldav.py                          ← CalDAV 参考实现
```

---

## 6. Open Questions (review 时 cross-check)

1. **DavMailBackend arm/radar 兼容层覆盖完整吗?** — 我列了 19 处 self.arm/self.radar 调用 in NewWatcher; 是否还有 fanout/handler/reverse_sync 没覆盖到的 message_id 慢路径? (handlers.py L223/233/444/445 等 self.arm.mark_as_read(message_id, ...) 应该在 davmail mode 走 outbox=True 主路径, 不走老 fallback)
2. **davmail backend.append_draft 在 Outlook 端能正确 thread fold 吗?** — In-Reply-To 头加 < > 包裹是否对; References 缺失时是否要从原邮件 References + 原 Message-ID 合并
3. **CalDAV vobject.dtstart 是 datetime 还是 date 时 timezone 处理边界**
4. **AUTOINCREMENT seq 在不同进程 (CLI + mail-sync) 并发调用时是否真原子** — sqlite BEGIN IMMEDIATE 应该 OK, 但要单测验证
5. **IMAP cipher key 默认 fallback `'mailagent-poc-shared-key'` 是否泄露** — 已在 davmail-poc/.gitignore 排除, 但 src/config.py 描述里写了默认值, review 看是否要删

---

## 7. 推荐 review 工作流

```bash
# 1. 先看 3 个 commit overview
git log -3 --stat | head -100

# 2. 一个一个 commit 详读
git show a7ec5f2 | less
git show ebb7494 | less
git show 77801c9 | less

# 3. 委托 oh-my-claudecode:code-reviewer 跑 high effort review
# (要在新 session 跑, 因为 reviewer 不能在同 context 写完 + review)

# 4. 跑全量测试
pytest tests/ -q --tb=short

# 5. dry-run 端到端
python scripts/dev/test_backend_switch.py --backend both --samples 5

# 6. 准备切换决定 — 如果 review/test 都过, 按 §2.3 切换验收清单做

# 7. 切换后跑 1-2 天观察, 没问题就是 ship 完成. 出问题 sec 级回滚 (改 env + restart).
```

---

签字: ____________________________  日期: __________

**End of handoff.** 下次 session: 跑 review → 补 test → 切 davmail → 验收 1-2 天 → 关 Sprint.
