# 后端服务层 — 端到端真机验收 Runbook（D2c ⑤）

> **目的**：服务化重构（A1→D2b，写操作矩阵已 100% 绿，软件验收全过）的最后一道闸 —— 每个写操作从 **CLI / 本地 Electron / 远程 web** 三条传输各实跑一遍，确认 in-process service 在真实 serve-api + Notion + davmail + 邮箱下行为正确。
> **为什么单列 runbook**：这些步骤含**真发邮件 / 真改生产 Notion / 真移动邮件**（不可逆 + 外发），不能在无人值守的 agent session 里跑。由人照此清单在真机执行。
> **配套**：架构 [`docs/claude/service-layer-architecture.md`](../architecture/service-layer-architecture.md) · 看板 [`docs/backend-service-migration-matrix.md`](../architecture/backend-service-migration-matrix.md)。

## 🔴 安全红线（执行前必读）

1. **挑一封专用「测试邮件」贯穿全程** —— 拿到它的 `internal_id`（`mailagent email search "<关键词>" -o json | jq '.data[].internal_id'`）。可用记忆里的 Test Page（Notion `31a15375830d81798e75fcfce933808b`）对应的那封。
2. **每个写操作先 `--dry-run` 看 plan，再真跑** —— dry-run 不写、跳 auth/pm2，先确认编排形状对。
3. **`send` = 真发邮件**：收件人**只填自己 / 测试地址**，**绝不**用真实业务收件人。先 `email draft` 落草稿肉眼确认正文，再 `email send`。
4. **`archive` = davmail IMAP MOVE 真移动邮件**到「存档」：只对测试邮件做，验完可手动移回收件箱。
5. **数据源差异**（易错）：
   - CLI 默认读**主仓** `data/sync_store.db`（或 `--db-path` 指定）。
   - 本地 Electron `.app` 读 **app 库** `~/Library/Application Support/mailagent-frontend/data/sync_store.db`。
   - 用 `.app` 时 **pm2 `mail-sync` 必须停**（防双写）；davmail 用户 `davmail-poc` 留 pm2。
6. 远程 web 写经 serve-api（CF JWT），与本地 Electron（Main 转发 + 本地 token）是**两条鉴权腿**，都要验。

## 前置：起 serve-api + 校验存活

```bash
# 本地 dev（非打包态）：手动起 serve-api（打包 .app 会自动起，dev 不接管）
source venv/bin/activate
mailagent serve-api            # bind 127.0.0.1:8200

# 健康检查（无鉴权 liveness）
curl -s http://127.0.0.1:8200/api/health | jq .   # 期望 200 + healthy

# 远程：serve-api + cloudflared + CF Access（team tplinkomada）→ https://mail.chenge.ink/app
# 起法见记忆 project_v2_remote_web_access（serve-api 读 app 库，非主仓 pm2）
```

写命令鉴权（C2 双层鉴权，两条腿，按你打哪个传输选）：

- **CLI** 写命令带 `--api-key "$MAILAGENT_CLI_API_KEY"`（CLI 自己的 api-key 闸，`export MAILAGENT_CLI_API_KEY=<key>`）。
- **直打 serve-api**（下方 batch_resync curl）带 header `X-MailAgent-Local-Token: $MAILAGENT_LOCAL_API_TOKEN` —— 本地 token 由 Electron `randomBytes(32)` 单源生成并注入 serve+serve-api（见 `frontend/src/electron/main/local_token.ts`）；dev 手动 `mailagent serve-api` 时自己 `export MAILAGENT_LOCAL_API_TOKEN=<任意 32B hex>` 设同一值即可。本地 Electron / 远程 web 走 UI 时无需手动管 token（Main 转发自带本地 token / 远程走 CF JWT）。

## 验收矩阵（每 cell 跑通打 ✅）

| 写操作 | CLI | 本地 Electron | 远程 web | 验证点 |
|---|:--:|:--:|:--:|---|
| set_flags（已读/旗标）| ⬜ | ⬜ | ⬜ | outbox 出 `flag_sync` intent + Notion `Is Read`/`Is Flagged` 变 + Mail.app 变 |
| resync | ⬜ | ⬜ | ⬜ | Notion 页面重建，`action` 对（created/replaced）|
| archive | ⬜ | ⬜ | ⬜ | 邮件移到「存档」+ Notion `Mailbox` 变 |
| pin / unpin | ⬜ | ⬜ | ⬜ | `email_metadata.is_pinned` 变 |
| llm_run | ⬜ | ⬜ | ⬜ | Notion `AI Action`/`AI Priority` 填充 |
| compose_draft | ⬜ | ⬜ | ⬜ | Drafts 文件夹出现草稿，正文 = 建议 + 原文引用 |
| send | ⬜ | ⬜ | ⬜ | 邮件真发出（收件人=自己）|
| batch_resync（长任务）| ⬜ | ⬜ | ⬜ | `POST /api/jobs` 起 job + `job.*` SSE 进度 + 终态 |

## 分操作步骤（以 `<TEST_ID>` = 测试邮件 internal_id）

```bash
# set_flags
mailagent email flag <TEST_ID> --is-read --dry-run -o json     # 先看 plan
mailagent email flag <TEST_ID> --is-read --api-key "$MAILAGENT_CLI_API_KEY" -o json
sqlite3 data/sync_store.db "SELECT op_type,target,status,payload_json FROM email_outbox WHERE internal_id=<TEST_ID> ORDER BY outbox_id DESC LIMIT 3"

# resync
mailagent email resync <TEST_ID> --dry-run -o json
mailagent email resync <TEST_ID> --api-key "$MAILAGENT_CLI_API_KEY" -o json   # 看 action

# archive（davmail-only，真移动；验完可手动移回）
mailagent email archive <TEST_ID> --dry-run -o json
mailagent email archive <TEST_ID> --api-key "$MAILAGENT_CLI_API_KEY" -o json

# pin / unpin
mailagent email pin <TEST_ID> --api-key "$MAILAGENT_CLI_API_KEY" -o json
mailagent email unpin <TEST_ID> --api-key "$MAILAGENT_CLI_API_KEY" -o json

# llm_run（dry-run 真跑 LLM 不写 Notion）
mailagent llm run <TEST_ID> --dry-run -o json
mailagent llm run <TEST_ID> --api-key "$MAILAGENT_CLI_API_KEY" -o json

# compose_draft → 肉眼确认草稿 → send（🔴 收件人=自己）
mailagent email draft <TEST_ID> --dry-run -o json
mailagent email draft <TEST_ID> --api-key "$MAILAGENT_CLI_API_KEY" -o json     # 落草稿
mailagent email send <TEST_ID> --yes --api-key "$MAILAGENT_CLI_API_KEY" -o json # 真发
```

**本地 Electron**：打开 `.app` → 选测试邮件 → 工具栏/详情页点 已读·旗标·归档·pin → 回复面板写草稿/发送。写经 Main 进程转发 daemon，验证：操作后其它端（如 Notion）收到变更 + 该端 `outbox.enqueued` SSE。

**远程 web**：`https://mail.chenge.ink/app`（过 CF Access）→ 同 UI 操作 → 验证写落到 app 库 outbox + Notion 变更。

**batch_resync（长任务）**：本地 Electron / 远程 web 列表多选 → 点「重传 Notion」→ 看 sticky 进度 toast 跑到终态（ok/partial/cancelled）。或 CLI 直打：

```bash
curl -s -X POST http://127.0.0.1:8200/api/jobs \
  -H "X-MailAgent-Local-Token: $MAILAGENT_LOCAL_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jobType":"resync","targetKind":"batch","params":{"internal_ids":[<ID1>,<ID2>],"replace_existing":true}}' | jq .
# → 拿 job_id，轮询 GET /api/jobs/{job_id} 看 progress + 终态
```

## 迁移监控（验收期间盯）

```bash
sqlite3 data/sync_store.db "SELECT status,COUNT(*) FROM email_outbox GROUP BY status"
# dead_letter 无异常增长
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_outbox WHERE status='dead_letter'"
# gt_30m pending 堆积（突增即回切上一阶段）
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_outbox WHERE status='pending' AND created_at < strftime('%s','now')-1800"
# async_jobs 终态分布
sqlite3 data/sync_store.db "SELECT status,COUNT(*) FROM async_jobs GROUP BY status"
```

## 验收签收

全部 cell ✅ + dead_letter/gt_30m 无异常 → 在看板 [`docs/backend-service-migration-matrix.md`](../architecture/backend-service-migration-matrix.md) 的「最终验收 gate」勾上 e2e/监控两项，重构正式收官归档。

| 执行人 | 日期 | 结果 | 备注 |
|---|---|---|---|
|  |  |  |  |
