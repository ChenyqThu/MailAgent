# Sprint 15 后端完成报告

**Branch**: `sprint15-backend` (9 atomic commits)
**Status**: ✅ Backend ship, awaiting 前端 D 块切换 + 灰度切换
**Last regression**: 851/851 pytest passed (2026-05-19)

---

## TL;DR — 给前端 sprint 用

Sprint 15 后端把 SQLite SSoT inversion 4 块（A 后端 + B handler 退化 +
C `mailagent email flag` CLI + D 前端 callsite 切换）的 A+B+C 全部 ship。
前端 D 块（4 处 callsite 切到 `mailApi.email.flag`）此时可以开工，**后端 surface
已稳定就位**，前端实现期间不需要回头改后端。

同时一次性补齐了配置面 / 实时推送 / 管理面 3 块前端可能要的接口：

| 你要做的 | 调什么 | 备注 |
|---|---|---|
| 切 EmailRow / EmailDetail / BatchActionBar flag callsite | `mailagent email flag <id> --is-read --is-flagged --processing-status STATUS` | 双 target outbox, source='cli' |
| 批量 50 封 BatchActionBar | `mailagent email flag --ids 1,2,3 --is-flagged` | 一次写多条 outbox |
| 设置页读 / 写配置 | `mailagent admin config show / get / set` | 敏感字段 mask, set 写 .env restart 生效 |
| Dashboard 综合状态 | `mailagent admin queue-depth` | sync_store + outbox + llm 一次拿全 |
| FTS5 / PM2 健康度 | `mailagent admin fts-health` / `admin pm2-status` | dashboard 用 |
| 实时事件订阅 | SSE `GET /api/events/stream` (webhook-server) | 替代长轮询 `/api/command/{id}/result` |

---

## 9 个 Atomic Commits

```
942f755 stage 4 — admin fts-health + pm2-status + queue-depth + stats outbox
6086149 stage 3 — admin config CLI + .env 补全 + dashboard_password
be28e8e stage 2 — SSE publisher + endpoint + 4 接入点
4a714c9 stage 1.6 — email flag CLI + schema + RFC
085f381 stage 1.4 — 反向 handler 退化为 outbox intent
beb59dc stage 1.5 — main.py 启动 FanoutWorker + 4 outbox flag
c247329 stage 1.3 — FanoutWorker + MailApp/Notion fanout (30 tests)
4904b5c stage 1.2 — OutboxRepository (40 tests)
0dba7a3 stage 1.1 — DB v10 + email_outbox 表 (7 tests)
```

---

## 1. SQLite SSoT Inversion (Sprint 15 §3)

### A. `email_outbox` 表 (DB v10)

```sql
CREATE TABLE email_outbox (
    outbox_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    internal_id   INTEGER NOT NULL REFERENCES email_metadata(internal_id) ON DELETE CASCADE,
    op_type       TEXT NOT NULL,                 -- flag_sync / processing_status_sync
    target        TEXT NOT NULL,                 -- mailapp | notion (CHECK)
    payload_json  TEXT NOT NULL,
    source        TEXT,                          -- frontend | notion_webhook | ai_reviewed_handler | cli
    status        TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed|dead_letter (CHECK)
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    next_retry_at REAL,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL
);
-- 3 索引: idx_outbox_pending (status,next_retry_at WHERE pending/failed) +
--          idx_outbox_internal_id + idx_outbox_target_status
```

迁移路径: SyncStore._init_database 自动检测 db_version 升 v9 → v10，加表 + 索引；
不动 email_metadata。pm2 restart mail-sync 即触发。

### B. OutboxRepository (`src/sync/outbox.py`)

```python
from src.sync.outbox import OutboxRepository, OutboxEntry, OutboxStats

repo = OutboxRepository("data/sync_store.db")

# Public API
oid = repo.enqueue(internal_id=..., op_type='flag_sync',
                   target='mailapp', payload={...}, source='cli')   # → outbox_id; -1 表 echo skip
ids = repo.enqueue_many([{...}, {...}])                              # 批量
entries = repo.poll_ready(target='mailapp', limit=20)                # FIFO
repo.mark_processing(outbox_id)
repo.mark_done(outbox_id)
repo.mark_failed(outbox_id, error, max_attempts=5)                   # 退避 60/300/900/3600/7200s
repo.retry_dead_letter(outbox_id)                                    # admin 介入
repo.list_dead_letter()
repo.get_stats() → OutboxStats(by_status, by_target, age_buckets, total)
```

**幂等**: 同 (internal_id, op_type, target, status='pending') 已存在 → merge payload + 刷 updated_at, 不重复 INSERT。

**Echo prevention**: source='notion_webhook' + target='notion' → silent skip + 返 -1。
防止 Notion → handler → outbox → fanout → Notion 回环。

### C. FanoutWorker (`src/sync/fanout.py`)

```python
worker = FanoutWorker(
    outbox_repo=...,
    mailapp_fanout=MailAppFanout(sync_store=..., arm=...),   # AppleScript subprocess in to_thread
    notion_fanout=NotionFanout(sync_store=..., notion_sync=...),  # async pages.update
    poll_interval_sec=5, concurrency=3, max_attempts=5,
)
asyncio.create_task(worker.run())
```

**幂等**: 每条 op 执行前查 sync_store 当前 state；payload 与 current 一致 → mark_done skip。

### D. 反向 handler 退化 (`src/events/handlers.py`)

3 个 webhook handler (handle_flag_changed / handle_completed / handle_ai_reviewed)
检测 `self.outbox_repo`：注入则走新路径（写 outbox + 立即 sync_store.update_local_flags
做 echo prevention）；未注入则保留老 AppleScript 直调路径（灰度回退）。

**handle_ai_reviewed** 用 `source='ai_reviewed_handler'`（不是 notion_webhook），所以
target='notion' 不被 echo prevention 拦——这是 mailagent 主动 ack Notion 状态。

### main.py 启动

```python
# 灰度: MAILAGENT_OUTBOX_ENABLED=false → 整套 outbox 不启动, handler 走老逻辑
if config.mailagent_outbox_enabled:
    self.outbox_repo = OutboxRepository(...)
    self.fanout_worker = FanoutWorker(...)
    # 注入到 EventHandlers
    handlers = EventHandlers(..., outbox_repo=self.outbox_repo)

# 启动并行任务
fanout_task = asyncio.create_task(self.fanout_worker.run())
```

### `mailagent email flag` CLI

```bash
# 单封
mailagent email flag 53675 --is-read --is-flagged --dry-run -o json
mailagent email flag 53675 --no-is-flagged --processing-status '已完成'
# 批量
mailagent email flag --ids 53674,53675,53677 --is-read

# 输出 envelope:
# {dry_run, updated_ids, payload, outbox_entries: [{internal_id, mailapp_outbox_id, notion_outbox_id}], not_found?}
# 退出码: 0 / 4 auth / 9 PM2 / 2 invalid
```

Source 标记 'cli'，不触发 echo prevention，写双 target outbox (mailapp + notion)。
`--processing-status` 只入 outbox(target=notion), SQLite 不存（Notion-only）。

---

## 2. 实时推送 SSE (Stage 2)

### Publisher (`src/events/publisher.py`)

同步 redis 客户端 + fire-and-forget publish。redis 不可达 silent fail, 主链路不烧穿。

**8 个事件类型**（详 `docs/sse-events.md`）:

| event_type | 触发 | data 字段 |
|---|---|---|
| `email.synced` | sync_store.mark_synced_v3 | `{notion_page_id}` |
| `email.failed` | _update_for_retry | `{status, retry_count, next_retry_at, error}` |
| `email.dead_letter` | 达 max retry | `{retry_count, error}` |
| `outbox.enqueued` | OutboxRepository.enqueue (INSERT 新行) | `{outbox_id, op_type, target, source}` |
| `outbox.done` | mark_done | `{outbox_id}` |
| `outbox.failed` | mark_failed (未达 dead_letter) | `{outbox_id, attempts, last_error, next_retry_at}` |
| `outbox.dead_letter` | mark_failed (达上限) | `{outbox_id, attempts, last_error}` |
| `llm.success` / `llm.failed` / `llm.gave_up` | LLMProcessingStore | `{model, tokens, latency_ms}` / `{retry_count, error}` |

### SSE endpoint (`webhook-server/app.py`)

```bash
# 鉴权同 /api/command (X-Webhook-Token / Authorization Bearer)
curl -N -H "X-Webhook-Token: $SECRET" https://mailagent.chenge.ink/api/events/stream

# 每条事件: event: mailagent, data: <json>
# 每 15s: event: ping (心跳防中间件断连)
```

依赖: `sse-starlette>=2.1.0` 已加入 `webhook-server/requirements.txt`。

**部署**: `./scripts/deploy-webhook.sh` 会 `pip install -r requirements.txt` 自动装新依赖。

---

## 3. 配置面 (Stage 3)

### `admin config show / get / set`

```bash
# 列全部, 敏感字段自动 mask
mailagent admin config show -o json

# 单字段
mailagent admin config get sync_mailboxes -o json

# 写 .env (atomic, 保留注释, 类型 coerce)
mailagent admin config set mailagent_outbox_enabled true -o json --dry-run
mailagent admin config set log_level DEBUG -o json     # 需 auth
mailagent admin config set llm_api_key "***" --dry-run  # 敏感字段 envelope 自动 mask

# 输出: data.restart_required = true 提示前端 pm2 restart 让运行时生效
```

**敏感字段判定**: 字段名含 `token` / `secret` / `password` / `api_key` 任一即 mask。

**类型 coerce**: bool ∈ {true,yes,on,1} / {false,no,off,0,''}; int / float / str。
非法 → exit 2 E_INVALID_ARG。

**新增 Settings 字段**: `dashboard_password`（之前只在 .env.example 文档化）。

**.env.example 补**: `MEETING_EXPANSION_INTERVAL_SECONDS`, `MEETING_EXPANSION_HORIZON_WEEKS`,
`MAILAGENT_OUTBOX_ENABLED` 等 4 个 Sprint 15 灰度 flag。

---

## 4. 管理面 (Stage 4)

```bash
# FTS5 索引健康度
mailagent admin fts-health -o json
# → {body_rows, fts_rows, gap, integrity_check, healthy}

# PM2 mail-sync 状态 (前端冲突侦察)
mailagent admin pm2-status -o json
# → {pm2_available, mail_sync: {online, pid, uptime_sec, memory_mb, cpu_percent}|null}

# 综合 backlog 视图
mailagent admin queue-depth -o json
# → {sync_store: {...}, outbox: {...}, llm_processing: {...}}

# admin stats 加 outbox section
mailagent admin stats --section outbox -o json
mailagent admin stats --section all -o json    # 含 outbox 段
```

---

## 5. 灰度切换计划 (Stage 5)

### 步骤 1: 部署 (默认关闭)

```bash
# 后端代码 ship
git checkout sprint15-backend
git merge sprint15-backend → sprint10  (or main)
# .env 保留 MAILAGENT_OUTBOX_ENABLED=false (默认)
pm2 restart mail-sync

# 验证 DB 升 v10:
mailagent admin db-version -o json | jq .data.version    # 期望 10
mailagent admin health -o json | jq .data.healthy        # 期望 true
```

### 步骤 2: 单封烟雾测试

```bash
# 把开关切 true (.env 改一行 或用 admin config set)
mailagent admin config set mailagent_outbox_enabled true --dry-run
mailagent admin config set mailagent_outbox_enabled true   # 需 auth
pm2 restart mail-sync

# 选一封 test email 跑 flag (用项目记忆里的 test page: 31a15375830d81798e75fcfce933808b)
TEST_ID=$(mailagent email list --limit 1 -o json | jq -r '.data[0].internal_id')
mailagent email flag $TEST_ID --is-read --dry-run -o json     # plan
mailagent email flag $TEST_ID --is-read -o json               # 真跑

# 立即:
mailagent admin queue-depth -o json | jq .data.outbox
# 期望: pending=2 (mailapp + notion target)

# 1 分钟内:
sleep 60
mailagent admin queue-depth -o json | jq .data.outbox
# 期望: done=2, pending=0
```

### 步骤 3: SSE 验证

```bash
# Terminal A
curl -N -H "X-Webhook-Token: $WEBHOOK_SECRET" \
     http://localhost:8100/api/events/stream

# Terminal B
mailagent email flag $TEST_ID --no-is-read -o json

# Terminal A 应在 ~1s 内看到:
# event: mailagent  data: {"event_type":"outbox.enqueued","internal_id":...,...}
# (×2 — mailapp + notion)
# event: mailagent  data: {"event_type":"outbox.done","internal_id":...,...}
# (×2)
# 每 15s: event: ping
```

### 步骤 4: 前端 D 块灰度切换

按 SPRINT15-HANDOFF.md §3.5：

1. 前端 ship D 块代码（`email:flag` IPC handler + `ElectronApi.email.flag`），
   **callsite 仍用 `notion.updateFlag`** — IPC 就位但 0 使用（回归看老链路没破）
2. 切第 1 处 callsite（`EmailRow` flag 三态）→ 用 `mailApi.email.flag` → 24h 观察
3. 全切 4 处（EmailRow / EmailDetail / BatchActionBar / legacy BatchActionBar）
4. 一周稳定后：删 `mailApi.notion.updateFlag` 路径，stub 成 `throw NotImplementedError`

### 步骤 5: 老反向 handler 路径下线

灰度 +1 周后：
- 删 `src/events/handlers.py` 中 3 个 handler 的 `if not self.outbox_repo` 分支
- main.py 不再支持 `MAILAGENT_OUTBOX_ENABLED=false`（变成默认 true / 强制）

---

## 6. 回滚策略

任何一步发现问题：

```bash
# Level 1: 关 outbox flag, handler 自动回退老 AppleScript 路径
mailagent admin config set mailagent_outbox_enabled false
pm2 restart mail-sync
# (前端 callsite 仍调 mailagent email flag, 但 fanout 不消费, intent 留在 outbox 表)

# Level 2: 前端 callsite 回退 notion.updateFlag (代码改)

# Level 3: 整条 sprint15-backend 分支不 merge, 留在 sprint15-backend 分支待 fix
```

`mailagent admin queue-depth -o json | jq .data.outbox.dead_letter` 监控死信堆积。

---

## 7. 测试覆盖

```bash
pytest tests/                          # 851 passed
pytest tests/sync/                     # 70 (outbox + fanout)
pytest tests/events/                   # 25 (publisher + handlers outbox)
pytest tests/cli/test_email_flag.py    # 15
pytest tests/cli/test_admin_config.py  # 19
pytest tests/cli/test_admin_stage4.py  # 11
pytest tests/mail/test_sync_store_v10_migration.py  # 7
```

---

## 8. 已知遗留 / Future work

| 项 | 状态 | 备注 |
|---|---|---|
| `mailagent email draft <id>` CLI | 跳过本轮 | 包装 handle_create_draft，需 AppleScript subprocess，复杂度独立 sprint |
| V2 本地 FastAPI `mailagent-api` (127.0.0.1:8200) | 未做 | BACKEND-INTERFACES.md §2.4 列了 12 端点，留给 V2 Web SPA sprint |
| 看板 `/dashboard/api/stats` 迁 SQLite SSoT | 未做 | 仍 Notion-driven 一部分；独立 sprint |
| `mailagent main start/stop/status` PM2 包装 | 未做 | 复杂度低但跨进程信号麻烦，延后 |
| 灰度 +1 周后删反向 handler 老路径 | 待执行 | Stage 5 步骤 5 |

---

## 9. 关键文件清单

### 新增

```
src/sync/__init__.py             FanoutWorker / MailAppFanout / NotionFanout / OutboxRepository export
src/sync/outbox.py               OutboxRepository + OutboxEntry + OutboxStats
src/sync/fanout.py               FanoutWorker asyncio loop
src/sync/mailapp_fanout.py       AppleScript 派发 (idempotency check)
src/sync/notion_fanout.py        Notion API 派发 (page_id 不存在 skip)
src/events/publisher.py          EventPublisher + safe_publish + singleton
docs/sse-events.md               SSE 协议文档
docs/cli-schema/email-flag.schema.json
docs/cli-schema/admin-config-{show,get,set}.schema.json
docs/cli-schema/admin-{fts-health,pm2-status,queue-depth}.schema.json
docs/sprint15-backend-complete.md  本文档
tests/sync/{outbox,fanout_mailapp,fanout_notion,fanout_worker}.py
tests/events/{publisher,handlers_outbox}.py
tests/cli/{test_email_flag, test_admin_config, test_admin_stage4}.py
tests/mail/test_sync_store_v10_migration.py
```

### 修改

```
src/mail/sync_store.py       DB_VERSION 9 → 10, _init_database 加 email_outbox 表
                              mark_synced_v3 / _update_for_retry 加 SSE publish
src/events/handlers.py       EventHandlers.__init__ 加 outbox_repo 参数;
                              3 个反向 handler 加 outbox enabled 分支
src/sync/outbox.py           enqueue / mark_done / mark_failed 加 SSE publish
src/llm_agent/store.py       mark_success / mark_failed 加 SSE publish
src/cli/commands/admin.py    +EXPECTED_DB_VERSION=10, REQUIRED_TABLES 加 email_outbox;
                              +config show/get/set + fts-health + pm2-status +
                              queue-depth + stats outbox section
src/cli/commands/email.py    +email flag subcommand
src/config.py                 +4 outbox settings + dashboard_password
main.py                       +OutboxRepository / FanoutWorker 启动 (灰度 flag)
webhook-server/app.py         +/api/events/stream SSE endpoint
webhook-server/requirements.txt +sse-starlette
.env.example                  +Sprint 15 outbox section + MEETING_EXPANSION_*
docs/agent-cli-rfc.md         §4.2 末尾加 email flag spec
```

更多回滚 / 监控细节见 `frontend/SPRINT15-HANDOFF.md` §3.5 / §6 / §7。
