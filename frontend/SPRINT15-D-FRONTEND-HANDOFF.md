# Sprint 15 D 块 — 前端 callsite 切换 Handoff

**为下个 session 准备**。后端 A+B+C 已 ship 并在生产灰度 enable 实测通过，
前端 D 块（4 处 callsite 改造 + 新 IPC + ElectronApi 类型）可直接开工。

> **前置阅读**：[`SPRINT15-HANDOFF.md`](./SPRINT15-HANDOFF.md) §3 工作目标 + §3.5 灰度切换计划
>
> **后端报告**：[`../docs/sprint15-backend-complete.md`](../docs/sprint15-backend-complete.md)
>
> **当前分支**：`sprint15-backend`（10 atomic commits + 1 hotfix `942c6c4`）

---

## 0. TL;DR

| 项 | 状态 |
|---|---|
| DB v9 → v10 migration | ✅ 已在生产 mail-sync 升级 |
| `MAILAGENT_OUTBOX_ENABLED=True` | ✅ .env 已开 |
| FanoutWorker 跑 | ✅ poll 5s, concurrency 3 |
| 反向 handler 退化 | ✅ `outbox_repo` 注入，handler 走 outbox 路径 |
| `mailagent email flag` CLI | ✅ smoke 实测：53897 flagged true ↔ false 双向通过 |
| Mail.app 真改 | ✅ `osascript get flagged status` 真翻 |
| Notion 端真改 | ✅ `[notion-fanout] applied page_id=...` 日志确认 |
| 反向 webhook → outbox 链路 | ✅ 看到 Notion webhook 触发 outbox(target=mailapp) 又被 fanout 消费 |
| **前端 4 处 callsite** | ⏳ 待 D 块 sprint 切换 |

实测命令记录：
```bash
$ mailagent admin db-version -o json | jq -c '.data'
{"version":10,"expected":10,"compatible":true,"db_path":"data/sync_store.db"}

$ mailagent admin queue-depth -o json | jq -c '.data.outbox'
{"pending":0,"processing":0,"failed":0,"dead_letter":0,"done":5,"total":5}

$ mailagent email flag 53897 --is-flagged --allow-concurrent -o json | jq -c '.data.outbox_entries'
[{"internal_id":53897,"mailapp_outbox_id":3,"notion_outbox_id":4}]

# 等 12s fanout 消费
$ osascript -e 'tell application "Mail" to get flagged status of (... whose id is 53897)'
true   # ← AppleScript 真调了

$ mailagent email flag 53897 --no-is-flagged --allow-concurrent -o json
$ osascript ...
false  # ← 双向通过
```

---

## 1. 待切换的 9 处 Callsite

`grep -rn "notion.updateFlag" frontend/src` 实查结果：

### 1.1 EmailRow 3 态 flag cycle — `frontend/src/shared/components/email/EmailRow.tsx`

```
L234   await mailApi.notion.updateFlag(email.internal_id, { isFlagged: true })
L237   await mailApi.notion.updateFlag(email.internal_id, { ... isFlagged + processingStatus })
L244   await mailApi.notion.updateFlag(email.internal_id, { isFlagged: false })
L255   await mailApi.notion.updateFlag(email.internal_id, { ... batch })
```

**改造**：4 处 `mailApi.notion.updateFlag` → `mailApi.email.flag`，参数形状不变
（`{isRead?, isFlagged?, processingStatus?}` → 同 shape）。

文件头注释 L10-L18 写过 deprecation breadcrumb，**保留**但状态从「待切换」改为「Sprint 15 D 块已切，回退路径见 §8」。

### 1.2 EmailDetail toggle — `frontend/src/shared/components/email/EmailDetail.tsx`

```
L358   await mailApi.notion.updateFlag(internalId, { isRead: !currentIsRead })
L380   await mailApi.notion.updateFlag(internalId, { isFlagged: !currentIsFlagged })
```

**改造**：2 处 `notion.updateFlag` → `email.flag`。

### 1.3 BatchActionBar (新版) — `frontend/src/shared/components/email/BatchActionBar.tsx`

```
L122    mailApi.notion.updateFlag(id, { isRead: true })
L134    mailApi.notion.updateFlag(id, { isFlagged: true })
L146    mailApi.notion.updateFlag(id, { isFlagged: false, processingStatus: '已完成' })
L161    mailApi.notion.updateFlag(id, { isFlagged: false, processingStatus: '已完成' })
```

L61 注释说"single-row notion.updateFlag calls are cheap"，**应优化**：50 封批量
用 `mailApi.email.flag({ ids: [...], ...payload })` 一次调用（后端
`mailagent email flag --ids 1,2,3` 已支持），减少 9× 进程 fork 开销。

如果暂时不优化，循环单条调用也可（fanout 端 batch enqueue 是单 SQL INSERT，
50 条 outbox 也很快）。

### 1.4 BatchActionBar (legacy) — `frontend/src/shared/components/batch/BatchActionBar.tsx`

```
L138    unit: (id) => mailApi.notion.updateFlag(id, { isRead: true })
```

需确认是否仍在使用 — 如果是 legacy dead code，可直接删；如果还在 EmailList 某入口
被引用，与 §1.3 同步切。

### 1.5 HttpApi stub — `frontend/src/shared/api/HttpApi.ts`

```
L69    updateFlag: () => notImplemented('notion.updateFlag')
```

**保留**（V2 Web SPA 回退路径），但加一个对应的 `email.flag` stub：

```typescript
email = {
  flag: () => notImplemented('email.flag'),
  // ... 现有
}
```

---

## 2. 后端接口面（前端要消费）

### CLI（IPC fork 调用）

```bash
mailagent email flag <internal_id> \
  [--is-read/--no-is-read] \
  [--is-flagged/--no-is-flagged] \
  [--processing-status STATUS] \
  [--ids 1,2,3] \
  [--dry-run] [--allow-concurrent] [--api-key TOKEN] \
  [-o json]
```

**重要 flag**：
- `--allow-concurrent` — **必须传**。pm2 mail-sync online 时写命令默认 exit 9
  E_PM2_RUNNING；前端 IPC 永远在 mail-sync 跑着的环境下用，必传此 flag
- `--api-key` — 生产配置了 `MAILAGENT_CLI_API_KEY`，必须经 keytar 取 token
  传入；前端已有 keytar wiring 给 `email:resync` / `notion:updateFlag` 用，
  `email:flag` 走同一套
- 输入字段语义：参 [`docs/cli-schema/email-flag.schema.json`](../docs/cli-schema/email-flag.schema.json)
  - `--is-read` / `--no-is-read`：标记已读/未读；不传 = 不改
  - `--is-flagged` / `--no-is-flagged`：旗标 on/off；不传 = 不改
  - `--processing-status STATUS`：Notion `Processing Status` select 值
    （`已完成` / `AI Reviewed` / etc.）；只入 outbox(target=notion)，
    SQLite 不存（Notion-only property）

### 输出 envelope

```jsonc
{
  "status": "success",
  "schema_version": 1,
  "data": {
    "dry_run": false,
    "updated_ids": [53897],
    "payload": {"is_flagged": true},
    "outbox_entries": [
      {
        "internal_id": 53897,
        "mailapp_outbox_id": 3,
        "notion_outbox_id": 4
      }
    ],
    "not_found": []  // 可选: payload ids 中 metadata 找不到的
  },
  "meta": {"duration_ms": 12, "count": 1, "not_found_count": 0}
}
```

`mailapp_outbox_id` 可能为 `null`（只传 `--processing-status`，无 mailapp 字段时）。

### 退出码（前端 cliQueue.run 已处理）

| 退出码 | 含义 |
|---|---|
| 0 | success |
| 2 | E_INVALID_ARG（参数错） |
| 4 | E_AUTH_FAILED（缺 token） |
| 9 | E_PM2_RUNNING（mail-sync online + 没 --allow-concurrent） |

---

## 3. 新 IPC handler 实现（参考 write_ops.ts 模板）

### 3.1 `frontend/src/electron/main/handlers/write_ops.ts` 新增

参 `notion:updateFlag` handler (L201-222) 完全照搬模板：

```typescript
// 文件头注释加一行:
//   email:flag         → mailagent email flag <id> [--is-read|--is-flagged|--processing-status]

export interface EmailFlagOpts {
  isRead?: boolean
  isFlagged?: boolean
  processingStatus?: string  // e.g. '已完成' / 'AI Reviewed'
  ids?: number[]             // 批量: BatchActionBar 50 封一次性
  allowConcurrent?: boolean  // 默认 true，前端 IPC 永远要传
}

function emailFlagArgs(internalId: number | undefined, opts: EmailFlagOpts): string[] {
  // 单封 vs --ids 互斥
  const args = ['email', 'flag']
  if (opts.ids && opts.ids.length > 0) {
    args.push('--ids', opts.ids.join(','))
  } else if (typeof internalId === 'number') {
    args.push(String(internalId))
  } else {
    throw new Error('emailFlag requires internal_id or opts.ids')
  }
  if (typeof opts.isRead === 'boolean') args.push(opts.isRead ? '--is-read' : '--no-is-read')
  if (typeof opts.isFlagged === 'boolean') args.push(opts.isFlagged ? '--is-flagged' : '--no-is-flagged')
  if (opts.processingStatus) args.push('--processing-status', opts.processingStatus)
  if (opts.allowConcurrent !== false) args.push('--allow-concurrent')
  return args
}

/** email flag is single-row INSERT + bounded short. */
export async function runEmailFlag(
  internalId: number | undefined,
  opts: EmailFlagOpts = {}
): Promise<unknown> {
  return callCli(emailFlagArgs(internalId, opts), { needsAuth: true, write: true })
}

// 在 registerWriteOpsHandlers() 末尾加:
ipcMain.handle(
  'email:flag',
  async (
    _evt,
    internalId: unknown,                              // 单封 ID; 批量传 null
    opts: EmailFlagOpts = {}
  ): Promise<WriteEnvelope<unknown>> => {
    const o = opts ?? {}

    // 至少一个字段
    if (o.isRead === undefined && o.isFlagged === undefined && !o.processingStatus) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'email:flag requires at least one of isRead / isFlagged / processingStatus'
      }
    }

    // 单封 vs 批量
    if (Array.isArray(o.ids) && o.ids.length > 0) {
      return envelopeFromCli(runEmailFlag(undefined, o))
    }
    const idOrErr = ensureInternalId(internalId, 'email:flag')
    if (typeof idOrErr !== 'number') return idOrErr
    return envelopeFromCli(runEmailFlag(idOrErr, o))
  }
)
```

### 3.2 `frontend/src/shared/api/ElectronApi.ts` 新增 EmailWriteApi

参 `ElectronNotionWriteApi`（L271 附近）模板：

```typescript
import type { EmailFlagOpts } from '../../electron/main/handlers/write_ops'

export interface EmailWriteApi {
  flag(internalId: number | null, opts: EmailFlagOpts): Promise<unknown>
}

class ElectronEmailWriteApi implements EmailWriteApi {
  async flag(internalId: number | null, opts: EmailFlagOpts): Promise<unknown> {
    return window.electron.ipcRenderer.invoke('email:flag', internalId, opts)
  }
}

// ElectronApi class 现有 notion / llm / admin 旁边加:
email: EmailWriteApi = new ElectronEmailWriteApi()
```

### 3.3 `frontend/src/shared/api/HttpApi.ts` V2 stub

```typescript
email = {
  // ... 现有 read 方法
  flag: () => notImplemented('email.flag')
}
```

### 3.4 `frontend/src/preload.ts` 暴露 channel

加 `'email:flag'` 到 preload 允许列表（看现有 `'notion:updateFlag'` 在哪同样加一条）。

---

## 4. Callsite 改造样例

### EmailRow.tsx L234 (典型 single-row flag toggle)

```diff
- await mailApi.notion.updateFlag(email.internal_id, { isFlagged: true })
+ await mailApi.email.flag(email.internal_id, { isFlagged: true, allowConcurrent: true })
```

`allowConcurrent: true` 必须显式传（前端 IPC 永远在 mail-sync 在线场景）。
如果 IPC handler 默认 `allowConcurrent !== false` 已加，可省略。

### EmailRow.tsx L237 (flag + processingStatus 一起)

```diff
- await mailApi.notion.updateFlag(email.internal_id, {
-   isFlagged: true,
-   processingStatus: '已同步',
- })
+ await mailApi.email.flag(email.internal_id, {
+   isFlagged: true,
+   processingStatus: '已同步',
+ })
```

### BatchActionBar.tsx L122 (50 封批量) — **优化版**

```diff
- // 旧: 50 次单独调用 (50 次 fork CLI)
- await Promise.all(selectedIds.map(id =>
-   mailApi.notion.updateFlag(id, { isRead: true })
- ))
+ // 新: 1 次调用, 后端 enqueue 50×2 = 100 行 outbox, FanoutWorker 并发消费
+ await mailApi.email.flag(null, { ids: selectedIds, isRead: true })
```

如果不优化，单条循环也跑：
```diff
- mailApi.notion.updateFlag(id, { isRead: true })
+ mailApi.email.flag(id, { isRead: true })
```

---

## 5. 联调验证 Checklist

执行步骤（前端 sprint 完成 D 块后）：

```bash
# 0. 拉新分支
git checkout sprint15-backend
git pull
cd frontend
pnpm install
pnpm dev  # Electron dev mode

# 1. 单封 flag 切换实测
#    点 EmailRow 任意一封的 flag icon → 看 Mail.app 真改 + Notion 真改
#    用 pm2 logs 配合监控 fanout 日志:
pm2 logs mail-sync --lines 10 --raw | grep -E "outbox|fanout"

# 2. EmailDetail 切换实测  
#    打开任意邮件 → 点已读/旗标 toggle → 同样验证两端

# 3. BatchActionBar 批量实测
#    选 5 封 → 标已读 → outbox table +5*2=10 行 pending → fanout 12s 内全 done
sqlite3 data/sync_store.db "SELECT COUNT(*), status FROM email_outbox WHERE created_at > $(date +%s) - 60 GROUP BY status"

# 4. 反向回环验证（关键 — 防 Notion→fanout→Notion 循环）
#    在 Notion 端手改任意邮件页面 Is Flagged → webhook → handler → outbox
#    queue-depth 应该看到 target=mailapp 行入队, 不应该看到 target=notion 行
mailagent admin queue-depth -o json | jq -c '.data.outbox'

# 5. 灰度回退实测
mailagent admin config set mailagent_outbox_enabled false --api-key $KEY -o json
pm2 restart mail-sync
# 前端继续点旗标 → 走 email:flag IPC → CLI 仍写 outbox + sync_store
# 但 FanoutWorker 不启动 → outbox pending 堆积
# 此时 Mail.app + Notion 不再实时改 (这是 expected — 老链路 notion automation
# 走 reverse sync 仍工作, 只是慢)
# 重新开 flag = true → restart → fanout 消费历史 pending
```

### 通过条件

- [ ] 前端 typecheck 0 / lint 0 / vitest 全绿 / a11y `--strict` clean
- [ ] EmailRow 点旗标 → SQLite 立即写 + Mail.app + Notion 同步 < 10s
- [ ] EmailDetail toggle read/flag 同样 < 10s
- [ ] BatchActionBar 批量 50 封 → outbox 1 min 内全 done, 无 race
- [ ] Notion 端手改 → handler 只写 outbox(mailapp), 不回写 Notion（防回环）
- [ ] 灰度关 flag 后服务降级仍运行 OK

---

## 6. 灰度切换计划（复习 SPRINT15-HANDOFF.md §3.5）

1. **前端 ship D 块代码**，所有 callsite 切到 `mailApi.email.flag`
2. **保留 `mailApi.notion.updateFlag` 老路径**（HttpApi stub + ElectronApi method），
   暂不删 — 万一发现问题前端可一行 revert
3. **EmailRow 一处先切，24h 观察**：监控 outbox dead_letter / fanout 失败率
4. **全切**：EmailDetail / BatchActionBar / batch/BatchActionBar 同步切
5. **一周后稳定 → 删 `mailApi.notion.updateFlag` 老路径**：
   - `frontend/src/electron/main/handlers/write_ops.ts` 删 `notion:updateFlag` handler
   - `frontend/src/shared/api/ElectronApi.ts` 删 `ElectronNotionWriteApi`
   - HttpApi `notion.updateFlag` stub 删

---

## 7. 已知坑 & 注意

| 坑 | 应对 |
|---|---|
| `--allow-concurrent` 必传 | 后端 IPC handler `allowConcurrent !== false` 默认 true 自动加 |
| 单 callsite 改 props 名 | 后端 schema 是 snake_case (`is_read`)，前端 IPC 类型用 camelCase (`isRead`)，handler 内部 `emailFlagArgs` 做转换 |
| BatchActionBar 50 封 | **建议**改成 `flag(null, {ids: [...], ...})` 一次调用，避免 50× fork |
| Notion 端用户手改触发 outbox 时 source='notion_webhook' | 后端 outbox echo prevention：source='notion_webhook' + target='notion' silent skip，前端不用管 |
| `processing_status` 只走 Notion | SQLite 不存这字段；前端如果想 query「邮件是否已完成」必须读 Notion（通过 `email get` 经 metadata，但 SQLite 端 metadata 不含此字段）|
| dry-run 跳过 auth | 前端如果给「预览」按钮用 dry-run 可不传 token，方便实现 |
| pm2-status 检测 | 写命令前端可调 `mailagent admin pm2-status` 看 mail-sync 是否在线决定是否传 --allow-concurrent；但实际产品里 mail-sync 永远应该跑着，所以默认传就行 |

---

## 8. 回退方案

任何一步发现严重问题：

```bash
# Level 1 (轻): 关 outbox flag → handler 退回老 AppleScript 直调路径
mailagent admin config set mailagent_outbox_enabled false --api-key $KEY -o json
pm2 restart mail-sync
# 前端如果已经切到 email.flag，仍能跑 CLI 写 outbox + SQLite，但 FanoutWorker
# 不消费 → 等 outbox pending 堆积；老 reverse sync 同时仍工作

# Level 2 (中): 前端 callsite 回退 notion.updateFlag (1 个 git revert)
git revert <D-块 commit>
pnpm build

# Level 3 (重): 整条 sprint15-backend 分支不 merge, 留 sprint15-backend 待 fix
git checkout sprint10
pm2 restart mail-sync  # 回老代码, DB v10 表留着但不读
# email_outbox 表数据 OK 留着不动 (FK 不影响 v9 代码)
```

`mailagent admin queue-depth -o json | jq .data.outbox.dead_letter` 持续监控死信
堆积，>3 立即飞书告警。

---

## 9. 关键文件 ref

### 前端要改的文件

```
frontend/src/electron/main/handlers/write_ops.ts   # 新增 EmailFlagOpts + runEmailFlag + handler
frontend/src/shared/api/ElectronApi.ts             # 新增 EmailWriteApi + flag method
frontend/src/shared/api/HttpApi.ts                 # 新增 email.flag stub
frontend/src/preload.ts                            # 暴露 'email:flag' channel

frontend/src/shared/components/email/EmailRow.tsx          # L234/237/244/255 切 4 处
frontend/src/shared/components/email/EmailDetail.tsx       # L358/380 切 2 处
frontend/src/shared/components/email/BatchActionBar.tsx    # L122/134/146/161 切 4 处 (可批量优化)
frontend/src/shared/components/batch/BatchActionBar.tsx    # L138 切 1 处 (verify 是否 legacy)
```

### 后端 reference（不动）

```
src/cli/commands/email.py            # email flag subcommand 实现
src/sync/outbox.py                   # OutboxRepository.enqueue
src/sync/{mailapp,notion}_fanout.py  # 派发逻辑 + Stage 1.6 hotfix idempotency 修复
src/events/handlers.py               # 反向 handler 退化, outbox_repo 注入
docs/cli-schema/email-flag.schema.json
docs/sse-events.md                   # SSE 协议 (前端可订阅 outbox.done 实时更新)
docs/sprint15-backend-complete.md    # 后端完整 ship 报告
```

### Git refs

```
sprint15-backend
  942c6c4  fix(sync): hotfix — fanout 不再用 SQLite cache 做 idempotency
  8b4f342  docs: stage 5 — backend completion + 灰度切换指引
  942f755  feat(admin): stage 4 — fts-health + pm2-status + queue-depth + stats outbox
  6086149  feat(admin): stage 3 — admin config CLI + .env 补全
  be28e8e  feat(events): stage 2 — SSE publisher + endpoint + 4 接入点
  4a714c9  feat(cli): stage 1.6 — email flag CLI + schema + RFC
  085f381  feat(events): stage 1.4 — 反向 handler 退化
  beb59dc  feat(main): stage 1.5 — main.py 启动 FanoutWorker + outbox flag
  c247329  feat(sync): stage 1.3 — FanoutWorker + 2 fanout impl
  4904b5c  feat(sync): stage 1.2 — OutboxRepository (40 tests)
  0dba7a3  feat(sync_store): stage 1.1 — DB v10 + email_outbox 表
```

---

## 10. 启动 prompt（下次 session 复制粘贴）

> 我们要做 Sprint 15 D 块前端切换。后端 A+B+C 已在生产灰度通过实测，
> branch `sprint15-backend` HEAD `942c6c4`。请按
> `frontend/SPRINT15-D-FRONTEND-HANDOFF.md` 实施：
>   1. 新建 `email:flag` IPC handler + EmailFlagOpts type (write_ops.ts 模板)
>   2. ElectronApi 加 `email` namespace 含 `flag()` 方法
>   3. HttpApi V2 stub `email.flag = notImplemented`
>   4. preload.ts 暴露 channel
>   5. 9 处 callsite (EmailRow / EmailDetail / 2 个 BatchActionBar) 切
>      `mailApi.notion.updateFlag` → `mailApi.email.flag`
>   6. BatchActionBar 批量改成 `email.flag(null, {ids: [...], ...})`
>      减少 fork 开销
>   7. pnpm typecheck / lint / vitest / a11y --strict 全绿
>   8. 联调 §5 checklist
>
> 灰度切换按 §6，回退按 §8。
