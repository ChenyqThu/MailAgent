# MailAgent 后端 4 接口面 — 前端依赖参考

> 给前端工程师的后端契约速查。**不规定前端实现**，仅梳理"前端能调什么 / 调了会拿到什么"。
>
> 完整调研历史在归档 [`archive/frontend-integration-spec.md`](./archive/frontend-integration-spec.md)。
>
> **关联**:
> - [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3-§4 数据流图 + 模块清单
> - [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) Sprint 依赖关系
> - 后端 [`../CLAUDE.md`](../CLAUDE.md) CLI 全集 / Notion DB schema
> - [`../docs/agent-cli-rfc.md`](../docs/agent-cli-rfc.md) CLI 完整 RFC
> - [`../docs/cli-schema/`](../docs/cli-schema/) 45+ JSON Schema 文件

---

## 0. TL;DR — 4 个接口面

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          前端（V1 + V2）                                  │
└──────────────────────────────────────────────────────────────────────────┘
       ↓ CLI fork             ↓ HTTP (V2)            ↓ Redis            ↓ SQLite 直读
┌─────────────────┐      ┌────────────────┐    ┌──────────────┐    ┌──────────────┐
│ mailagent CLI   │      │ webhook-server │    │   Redis      │    │ sync_store   │
│ (10 group       │      │ FastAPI 远程    │    │ events 队列  │    │  .db (SSoT)  │
│  + 45+ schema)  │      │ (8100 / nginx) │    │ DB 2 (远程)  │    │ 本地         │
│                 │      │                │    │              │    │              │
│ 本地 typer app  │      │ Notion webhook │    │ 远 ↔ 本      │    │ FTS5 / body  │
│ 走 SQLite SSoT  │      │ → Redis 入队   │    │ event bus    │    │ / attach     │
└─────────────────┘      └────────────────┘    └──────────────┘    └──────────────┘
                                                                          ▲
                                ┌─────────────────────────────────────────┘
                                │
                         ┌──────┴─────────┐
                         │ 本地 FastAPI   │ ← V2 新增 (127.0.0.1:8200)
                         │ mailagent-api  │   给前端用的 read/write API
                         │ (V2 新增)      │   走 cloudflared tunnel 暴露到 mail.chenge.ink
                         └────────────────┘
```

**前端怎么选**:

| 前端形态 | 推荐接口 | 性能 |
|---|---|---|
| **V1 Electron 本机** | SQLite 直读（读）+ CLI fork（写）| ~4ms / ~200ms |
| **V2 Web SPA 远程** | 本地 FastAPI HTTPS（读 & 写）+ Cloudflare Tunnel | ~200-400ms |
| **Island plugin** | Unix socket → ping-island；事件 fire-and-forget | 同步 ~5ms |
| **外部 agent / 第三方** | 远程 webhook-server `/command`（X-API-Key）| ~50-200ms |

---

## 1. 接口面 1 — `mailagent` CLI（本机 typer app）

### 1.1 命令组（10 个）

| Group | 主要命令 | 前端用途 |
|---|---|---|
| `email` | get / list / body / search / resync | 列表 / 详情 / 全文搜索 / 重传 |
| `attachment` | list / download / derive | 附件下载 / Office 衍生 |
| `llm` | run / selftest / retry-failed / stats / compare-paths | AI 字段补跑 / 健康检查 / 成本面板 |
| `notion` | resync / update-flag / archive / page-orphans / file-link-audit | 反向写 / 修复孤儿 |
| `calendar` | expand / recurring discover / recurring replay | 周期会议 |
| `debug` | email-source / mail-structure / inline-images / applescript-fetch | 调试（前端基本不用） |
| `backfill` | body / derivatives | 历史回填（admin 面板用） |
| `project-progress` | sync | 项目周报（专项） |
| `init` | fetch-cache / analyze / fix-properties / all | 初始化（前端基本不调） |
| `admin` | stats / health / db-version / dead-letter / cleanup-* / repair-* | 运维面板 |

### 1.2 输出契约（全局 `-o json` 必加）

```jsonc
{
  "status": "success" | "error",
  "schema_version": 1,
  "data": <command-specific>,           // success 时
  "error": {                             // error 时
    "code": "E_NOT_FOUND" | "E_INVALID_ARG" | "E_PM2_RUNNING" | "E_MAX_FAILURES" | ...,
    "message": "human-readable",
    "hint": "actionable suggestion"
  },
  "meta": {
    "duration_ms": 123,
    "schema_version": 1
  }
}
```

详细 schema: [`../docs/cli-schema/`](../docs/cli-schema/) 45+ JSON Schema 文件 + `_common.schema.json` wrapper。

### 1.3 退出码

| 码 | 含义 | HTTP 映射（V2 FastAPI 用） |
|---|---|---|
| 0 | success | 200 |
| 1 | 通用错误 / 资源未找到 | 404 / 500 |
| 2 | 参数错误 | 400 |
| 4 | 鉴权失败 | 401 / 403 |
| 5 | 网络 / 上游错误 | 502 / 503 |
| 6 | partial_failure (batch) | 207 |
| 7 | aborted (SIGINT 首次) | 499 |
| 8 | max-failures 熔断 | 503 |
| 9 | PM2 冲突（写命令被拒绝） | 409 |
| 130 | SIGINT 二次强退 | - |

### 1.4 鉴权

- **读命令**: 无
- **写命令**: `MAILAGENT_CLI_API_KEY` env + `--api-key` flag 同值
- **dev 模式**: `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 显式放行
- **dry-run**: 跳过鉴权

### 1.5 长任务契约（batch / backfill / init）

- 自动写 `cli_checkpoints` 表（每 50 unit）→ 中断后同 `<command, target_key>` 续跑
- SIGINT 首次 → 退 7；二次 → 退 130
- 连续失败超 `--max-failures` → 退 8
- PM2 mail-sync online 时写命令默认拒绝（exit 9，可 `--allow-concurrent` 绕）

### 1.6 前端集成（V1 Electron）— REVIEW-LOG C-02 / H-06 / H-07 重写

> **原版本 4 个问题**：(a) `if (exitCode !== 0) throw` 分支不可达（execa 默认非 0 reject），(b) catch 仅识别 exit=9 漏 1/2/4/5/6/7/8/130，(c) stdout 既流又 JSON.parse 无 fallback，(d) 无 abort cleanup / 并发限流 / 路径缓存。下面是 review 后定稿。

```typescript
// src/electron/main/cli_runner.ts
import { execa, type ExecaChildProcess, type ExecaError } from 'execa';
import { Semaphore } from './sem';                // 自写 4-line 实现
import { getApiKey } from './keychain';
import { app } from 'electron';
import { resolveSync } from 'which';

// 启动时缓存绝对路径，避开 macOS Spotlight 抓 venv 抖动
const MAILAGENT_BIN: string = (() => {
  // 优先用 user-config 路径（settings.json），fallback 走 `which`
  return process.env.MAILAGENT_BIN ?? resolveSync('mailagent');
})();

// 标准化错误码（与 docs/cli-schema/error-codes.md 同步）
const EXIT_CODE_MAP: Record<number, string> = {
  0: 'OK', 1: 'GENERIC', 2: 'INVALID_ARG', 4: 'AUTH', 5: 'UPSTREAM',
  6: 'PARTIAL', 7: 'ABORTED', 8: 'MAX_FAILURES', 9: 'PM2_CONFLICT', 130: 'SIGINT2',
};

export class CliError extends Error {
  constructor(
    public readonly errorCode: string,            // E_NOT_FOUND / E_PM2_RUNNING / ...
    public readonly exitCode: number,
    public readonly hint?: string,
    public readonly rawStdout?: string,
    public readonly rawStderr?: string,
  ) { super(`CLI exit ${exitCode} (${errorCode})`); }
}

// 读写分类限流，避免无限制 fork
class CliQueue {
  private readSem = new Semaphore(4);            // 读最多 4 并发
  private writeSem = new Semaphore(1);           // 写完全串行
  private inFlight = new Set<ExecaChildProcess>();

  async run(args: string[], opts: { write: boolean; signal?: AbortSignal }) {
    const sem = opts.write ? this.writeSem : this.readSem;
    await sem.acquire();
    try {
      return await this._exec(args, opts.signal);
    } finally {
      sem.release();
    }
  }

  private async _exec(args: string[], parentSignal?: AbortSignal) {
    const ac = new AbortController();
    // 父 signal abort 时也 abort
    parentSignal?.addEventListener('abort', () => ac.abort());

    const sub = execa(MAILAGENT_BIN, args, {
      signal: ac.signal,
      reject: false,                              // 关掉默认 reject，自己判 exitCode
      timeout: 60_000,                            // 兜底 60s timeout（长任务用 stream 路径，不走这里）
      buffer: true,
      all: false,                                 // stdout / stderr 分流
    });
    this.inFlight.add(sub);
    try {
      const result = await sub;
      const { stdout, stderr, exitCode, timedOut, killed } = result;

      // stdout 是 CLI JSON 唯一通道；stderr 是日志（forward to renderer log panel）
      if (stderr) mainWindow?.webContents.send('cli:log', stderr);
      if (timedOut) throw new CliError('E_TIMEOUT', exitCode ?? -1, 'CLI exceeded 60s', stdout, stderr);
      if (killed) throw new CliError('E_ABORTED', 7, 'CLI killed by abort', stdout, stderr);

      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseErr) {
        // CLI 输出非 JSON（崩溃 / 老 CLI / stdout 截断）— 用 exit code + stderr 兜底
        throw new CliError(
          EXIT_CODE_MAP[exitCode] ?? 'E_PARSE_FAIL',
          exitCode,
          `stdout not valid JSON: ${String(parseErr).slice(0, 100)}`,
          stdout, stderr,
        );
      }

      if (exitCode === 0 && parsed.status === 'success') return parsed.data;

      // 错误分发：parsed.error.code (CLI 自报) 优先，否则按 exit code 映射
      const errorCode = parsed?.error?.code ?? `E_${EXIT_CODE_MAP[exitCode] ?? 'UNKNOWN'}`;
      throw new CliError(errorCode, exitCode, parsed?.error?.hint, stdout, stderr);
    } finally {
      this.inFlight.delete(sub);
    }
  }

  killAll() {
    // 窗口关闭时清理所有 in-flight 子进程，避免孤儿
    for (const sub of this.inFlight) sub.kill('SIGTERM');
    this.inFlight.clear();
  }
}

export const cliQueue = new CliQueue();

// App lifecycle cleanup（REVIEW-LOG C-02 critical: 关 Electron 窗口时孤儿化）
app.on('before-quit', () => cliQueue.killAll());

// 高层封装 — 给 IPC handler 调用
export async function callCli(
  args: string[],
  opts: { needsAuth?: boolean; write?: boolean; signal?: AbortSignal } = {},
) {
  const apiKey = opts.needsAuth ? await getApiKey() : null;
  const fullArgs = ['-o', 'json', ...args, ...(apiKey ? ['--api-key', apiKey] : [])];
  return cliQueue.run(fullArgs, { write: opts.write ?? false, signal: opts.signal });
}

// IPC 中怎么用：
// ipcMain.handle('email:list', async (_evt, opts: ListOpts, signal: AbortSignal) =>
//   callCli(['email', 'list', ...optsToFlags(opts)], { signal })
// );
//
// 写命令 IPC 标 write: true（与读隔离限流）+ needsAuth: true：
// ipcMain.handle('email:resync', async (_evt, id: number) =>
//   callCli(['email', 'resync', String(id), '--replace-existing'], { needsAuth: true, write: true })
// );
```

**关键改进**:
- `reject: false` 关掉默认 throw，自己判 `exitCode` —— 之前 catch 永远拿不到 exit code map。
- stdout / stderr 分流：stdout 是 JSON 唯一通道；stderr 是日志 forward。
- `parsed.error.code` (CLI 自报) 优先，exit-code map 兜底 —— 全 11 个退出码（0/1/2/4/5/6/7/8/9/130/-1 timeout）都有归口。
- `CliQueue` 按读/写分类限流（读 4 并发，写串行）—— SQLite WAL 多读单写顺势对齐；写 vs 读不互斥（WAL 设计就支持）。
- `app.on('before-quit', killAll)` —— Electron 退出时清理在途子进程，避免孤儿（之前 review C-02 critical）。
- `MAILAGENT_BIN` 启动时缓存绝对路径 —— 避开 macOS Spotlight 抓 venv 的启动抖动。
- `timeout: 60_000` 兜底（长任务 backfill / batch resync 走 spawn + stream 不走这里，详 §1.5）。

---

## 2. 接口面 2 — 本地 FastAPI（V2 新增）vs 远程 webhook-server（现有）

**两个 FastAPI 服务，职责完全不同。**

### 2.1 对比表

| 维度 | 本地 mailagent-api（V2 新增）| 远程 webhook-server（现有） |
|---|---|---|
| 位置 | MacBook Pro 本机 | 腾讯云 (170.106.181.89) |
| 端口 / 域名 | `127.0.0.1:8200` → Cloudflare Tunnel → `mail.chenge.ink` | `170.106.181.89:8100` → `mailagent.chenge.ink` |
| 主要消费方 | 前端 React (Electron renderer / Web SPA / PWA) | Notion Automation / 外部 agent (Openclaw / 飞书) |
| 端点形态 | `/api/email/*` `/api/attachment/*` `/api/llm/*` `/api/admin/*` | `/webhook/notion` `/command` `/dashboard/*` `/stats/report` |
| 数据来源 | 直接 `from src.repository import EmailRepository` + subprocess CLI | Redis 入队 → 本地服务消费 |
| 鉴权 | Cloudflare Access (Zero Trust OAuth) | Notion HMAC / X-API-Key / DASHBOARD_PASSWORD |
| 启动 | PM2 `mailagent-api`，与 mail-sync 同机器但独立进程 | PM2 `mailagent-webhook` |
| 关停影响 | 远程前端不可用，本机 Electron 不受影响 | Notion → Mail 实时同步停 |
| **V2 是否动** | 🆕 新建 | ❌ 不动 |

### 2.2 远程 webhook-server `/command` 入口（外部 agent 用）

```jsonc
POST /command
Headers: X-API-Key: <secret>
Body: {
  "event": "query_mail" | "fetch_mail_content" | "search_email_bodies" | "create_draft",
  "data": { /* event-specific */ },
  "source": "openclaw" | "feishu" | ...,
  "user_id": "..."
}

Response: { "event_id": "uuid", "queued": true }
GET /command/{event_id}  → Redis BLPOP 结果回写后取
```

**前端不直接调远程 webhook-server `/command`** — 这是给外部 agent 用的。前端走本地 FastAPI。

### 2.3 远程看板端点

| 方法 | 路径 | 鉴权 |
|---|---|---|
| `GET /dashboard` | Cookie session | 看板 SPA (dashboard.html, V0 原生 JS) |
| `GET /dashboard/login` | 无 | 登录页 |
| `GET /dashboard/api/stats` | Cookie | 看板 API |

V2 之后 V1 Electron 内 `/admin` 看板取代该 V0 看板，但 V0 不下线（远程访问场景仍有用）。

### 2.4 本地 FastAPI（V2 新增）端点

详 [`REMOTE-ACCESS.md`](./REMOTE-ACCESS.md) §3。简表：

| 端点 | 实现 | 复用 CLI schema |
|---|---|---|
| `GET /api/email/list` | `EmailRepository` 直查 | `email-list.schema.json` |
| `GET /api/email/{id}` | `EmailRepository.get` | `email-get.schema.json` |
| `GET /api/email/{id}/body?format=markdown\|html\|raw` | `EmailRepository.get_body_*` | `email-body.schema.json` |
| `GET /api/email/search?q=...` | `EmailRepository.search_email_bodies` (FTS5 bm25 + snippet) | `email-search.schema.json` |
| `POST /api/email/{id}/resync` | `subprocess: mailagent email resync ...` | RFC §5 长任务契约 |
| `POST /api/email/{id}/update-flag` | `subprocess: mailagent notion update-flag ...` | |
| `GET /api/attachment/list/{internal_id}` | `EmailRepository.get_attachments` | `attachment-list.schema.json` |
| `GET /api/attachment/{att_id}/download` | `StreamingResponse(open(local_path, 'rb'))` | binary |
| `POST /api/llm/run/{id}` | `subprocess: mailagent llm run ...` | |
| `GET /api/llm/stats?days=7` | `EmailRepository`-style 查 `llm_processing` | `llm-stats.schema.json` |
| `GET /api/admin/stats` | 复用 webhook-server `/admin/stats` 形状 | |
| `GET /api/admin/health` | 同 `mailagent admin health` | `admin-health.schema.json` |

**统一响应包装**（与 CLI JSON 一致）+ HTTP 状态码 → CLI exit 映射（§1.3）。

---

## 3. 接口面 3 — Redis 事件队列（本地 ↔ 远程双向）

### 3.1 事件类型（8 个 handler）

定义在 `src/events/handlers.py`：

| 事件 | 触发 | 处理（本地服务） |
|---|---|---|
| `flag_changed` | Notion Is Read/Is Flagged 变化 | 同步到 Mail.app |
| `ai_reviewed` | Notion Processing Status → AI Reviewed | Mail.app 标旗 + 飞书通知 + 状态 → 已同步 |
| `completed` | Notion Processing Status → 已完成 | 移除 Mail.app 旗标 |
| `create_draft` | Notion 按钮 / 飞书按钮 | AppleScript 创建 Mail.app 草稿 |
| `query_mail` | 外部 agent | 搜邮件 metadata (FTS5 + filter) |
| `fetch_mail_content` | 外部 agent | 通过 internal_id 拉 body (SQLite 直读 ~4ms) |
| `search_email_bodies` | 外部 agent | FTS5 全文 + bm25 + snippet |
| `page_updated` | Notion 通用 | 自动路由到上面 4 个 handler |

### 3.2 队列形态

- Key: `mailagent:events`（FIFO list, BLPOP）
- Payload: JSON `{event, data, source, user_id, event_id, timestamp}`
- 结果回写: `mailagent:result:<event_id>`（TTL 5min）

### 3.3 前端不直接连 Redis

敏感 — Redis 在远程腾讯云。前端通过远程 webhook-server `/command` 入相同事件总线。

---

## 4. 接口面 4 — SQLite 直读（本地 SSoT, V1 Electron 主路径）

### 4.1 库结构

| 表 | 主键 | 内容 |
|---|---|---|
| `email_metadata` | `internal_id` (INTEGER) | sender / subject / dates / sync_status / notion_page_id / 11 AI 字段 |
| `email_body` | `internal_id` FK CASCADE | `body_html` + `body_markdown` + `raw_mime_sha256` |
| `email_attachment` | `id` AUTOINCREMENT | filename / size / content_type / local_path / notion_file_id / `derived_from` 自指 FK |
| `email_body_fts` | virtual (rowid=internal_id) | FTS5 全文索引 |
| `cli_checkpoints` | (command, target_key) | 长任务 resume |
| `llm_processing` | internal_id | LLM cost / latency / retry queue |
| `v4_rollout_stats` | id | hit rate / latency / body_miss audit |
| ~~`ai_sessions`~~ | ~~(email_id, backend_id)~~ | ⛔ **REVIEW-LOG C-05 改方案**：不在 `sync_store.db` 加表（违反后端 DB_VERSION 升级流程）。改前端独立 SQLite `~/.mailagent/frontend/ai_chat.db`，schema 见 §4.6 |
| `cli_dispatch` | 🆕 island_dispatch | 🆕 Island Sprint 2 加 — envelope 发送审计 |

### 4.2 接口层 `EmailRepository` (Python)

```python
from src.repository import EmailRepository, AttachmentStore

repo = EmailRepository(
    db_path="data/sync_store.db",
    attachment_store=AttachmentStore("data/attachments"),
)

# 读
html = repo.get_body_html(internal_id)
md = repo.get_body_markdown(internal_id, max_chars=12000)
atts = repo.get_attachments(internal_id)
bytes_ = repo.get_attachment_bytes(att.id)
hits = repo.search_email_bodies(query, limit=20, mailbox=..., since_date=..., until_date=...)

# 写
id_map = repo.commit_email_with_body(internal_id, body, attachments, message_id=...)
repo.update_notion_links(internal_id, file_id_map={att_id: notion_file_id})
repo.delete_email_full(internal_id)
```

### 4.3 直读层 (TypeScript / better-sqlite3 in Electron main)

```typescript
// src/electron/main/db.ts
import Database from 'better-sqlite3';

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');     // 与 mail-sync 共存
db.pragma('busy_timeout = 5000');

// IPC handler 示例
ipcMain.handle('email:list', async (event, opts: ListOpts) => {
  const where = buildWhereClause(opts);
  const rows = db.prepare(
    `SELECT * FROM email_metadata ${where.sql} ORDER BY date_received DESC LIMIT ? OFFSET ?`
  ).all(...where.params, opts.limit, opts.offset);
  return { status: 'success', schema_version: 1, data: rows };  // 与 CLI 一致 wrapper
});
```

### 4.4 附件路径

- 根目录: `data/attachments/{internal_id}/`
- `local_path` 是绝对路径，Electron `file://` 直接访问
- 远程 Web 必须走 V2 FastAPI `/api/attachment/{id}/download` 中转

### 4.5.1 前端独立 SQLite（`ai_chat.db`）— REVIEW-LOG C-05 新增

AI Chat panel 的 per-email 对话持久化**不能**写 `data/sync_store.db`（后端 mail-sync 拥有 schema，DB_VERSION=6）。前端独立维护：

```sql
-- ~/.mailagent/frontend/ai_chat.db (前端独自管理 schema_version)
CREATE TABLE ai_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,                -- 不是 FK（跨 db），仅引用
    backend_kind TEXT NOT NULL,                -- 'notion-agent' | 'custom-api'
    backend_model TEXT,                        -- 'claude-sonnet-4-6' / 'gpt-5.4' / ...
    backend_agent_page_id TEXT,                -- Notion Agent 时填
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(email_id, backend_kind, backend_agent_page_id)
);

CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                        -- 'user' / 'assistant' / 'system' / 'tool'
    content TEXT NOT NULL,                     -- 完整文本或 tool_call JSON
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd REAL,
    model TEXT,
    status TEXT NOT NULL,                      -- 'pending' / 'streaming' / 'complete' / 'error' / 'aborted'
    error_message TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_session ON ai_chat_messages(session_id, created_at);
```

切换邮件中断流式：把 `status='streaming'` 的最后一条改 `aborted`，下次进入该 session 不重放。

### 4.5.2 FTS5 中文搜索注意

SQLite 自带的 `unicode61` tokenizer 把**连续 CJK 字符当一个 token**（不分词）：
- 精确搜 `"产品"` 命不中 token `"本周产品评审"`
- 变通：用 `产品*` 前缀通配匹配
- 邮件正文里如果 "产品" 周围有 markdown 标记（`*` / `[` / 空格）会自动切出独立 token
- 单测 / 纯中文文本：必须用 `*`
- 未来可接 jieba 或 signal-fts5-tokenizer

---

## 5. 鉴权矩阵（前端用哪条）

| 接口面 | 鉴权 | 前端适用 |
|---|---|---|
| CLI 读 | 无 | V1 Electron 本机 |
| CLI 写 | `MAILAGENT_CLI_API_KEY` + `--api-key` | V1 Electron (keytar 取) |
| 本地 FastAPI 读/写 | Cloudflare Access (Cf-Access-Jwt-Assertion) | V2 Web SPA / PWA |
| 远程 webhook-server `/command` | `X-API-Key` | 外部 agent (前端不用) |
| 远程 webhook-server `/dashboard/*` | Cookie session (DASHBOARD_PASSWORD) | V0 看板（V1 不用，V2 web 替代） |
| 远程 webhook-server `/webhook/notion` | Notion HMAC | Notion 自动（不给前端） |
| Redis | 不开放 | 不给前端 |
| SQLite 直读 | 文件权限 (macOS FDA) | V1 Electron 本机 |
| Unix socket `/tmp/island.sock` | 无（本机权限） | Island plugin |

---

## 6. 实时性

| 需求 | 当前方案 | 前端走 |
|---|---|---|
| Mail.app 新邮件到 Notion | 5s 雷达轮询 | `email list --since <now>` 5s 轮询 |
| Notion 字段变更 → Mail.app | Notion webhook → Redis → handler（亚秒级）| `/dashboard/api/stats` 或 SSE 推 |
| LLM 处理完 | fire-and-forget asyncio task | DB `llm_processing.updated_at` 轮询 / SSE |
| 看板统计 | 60s `stats_reporter` 上报 | 30s 轮询 |

**V1 推荐**：全轮询（简单稳定）。V2.1 视需要补 SSE / WS。

---

## 7. 数据契约速查

| 数据 | 来源 | 形状 | Schema |
|---|---|---|---|
| 邮件 metadata | `email_metadata` / CLI `email get` | 44 字段（sender / subject / dates / sync_status / 11 AI 字段）| `email-get.schema.json` |
| 邮件 body | `email_body` / CLI `email body` | str（markdown/html/raw） | `email-body.schema.json` |
| 邮件搜索 | CLI `email search` (FTS5) / Redis `search_email_bodies` | `[{internal_id, snippet, rank, ...}]` | `email-search.schema.json` |
| 附件 | `email_attachment` / CLI `attachment list` | `[{id, filename, size, sha256, derived_from, ...}]` | `attachment-list.schema.json` |
| LLM stats | `llm_processing` / CLI `llm stats` | `{input_tokens, cache hit rate, cost, latency}` | `llm-stats.schema.json` |
| v4 rollout | `v4_rollout_stats` / `/dashboard/api/stats` | `{hit_rate, fallback_count, p99_latency, body_miss_ids}` | （无独立 schema）|
| Event payload | Redis queue | `{event, data, source, user_id, event_id}` | （见 handlers.py） |

---

## 8. AI 字段 enum（Notion DB schema 镜像）— V1 实际渲染 8 个 + 3 候选 V1.5

> REVIEW-LOG H-14: 之前 "11 字段" 表述误，实际 V1 mockup 仅 8 个；Action Items / Tags 是 LLM 提取的 multi-select，没在 Sprint 2 `<AIFieldsBlock>` mockup 渲染。Sprint 1 末 mockup/schema 对账时再校。

**V1 `<AIFieldsBlock>` 渲染（8 个）**:

| Notion property | 类型 | enum / 范围 | 备注 |
|---|---|---|---|
| `AI Action` | Select | 需要回复 / 需要决策 / 需要 Review / 需要会议 / 需要跟进 / 等待响应 / 仅供参考 / 已完结 | **LLM 输出** |
| `AI Priority` | Select | Critical / Urgent / Important / Normal / Low | **LLM 输出**，DESIGN.md §2.3 5 色映射 |
| `AI Review Status` | Select | Pending / Reviewed | LLM 处理状态 |
| `Sentiment` | Select | 紧急 / 严肃 / 中性 / 友好 | **LLM 输出** |
| `Processing Status` | Select | 未处理 / AI Reviewed / 已同步 / 已完成 / 草稿已创建 | 反向同步驱动 |
| `Is Read` | Checkbox | true/false | Mail.app ↔ Notion 双向 |
| `Is Flagged` | Checkbox | true/false | 同上 |
| `Mailbox` | Select | 收件箱 / 发件箱 / ... | 同步时填 |

`Has Attachments` 已经在 EmailRow 的 paperclip + count 表达，AIFieldsBlock 不重复。

**V1.5 候选（mockup 未渲染）**:

| Notion property | 类型 | 状态 |
|---|---|---|
| `Action Items` | Multi-select | LLM 提取，前端展示形式未定（行内 chips? 行下 list?）— V1.5 议题 |
| `Tags` | Multi-select | 同上 |
| `Translated Body` | Text (cache) | V1 内存缓存 / V1.5 持久化（详 PROJECT-PLAN §2 Sprint 3） |

完整字段定义在 [`../CLAUDE.md`](../CLAUDE.md) "Notion 数据库结构" 段。

---

## 9. 不在本文档范围

- ❌ 后端 schema 变更流程（mail-sync 已稳定 v4）
- ❌ Notion 数据库 schema 设计 — 详 CLAUDE.md
- ❌ 飞书 / Openclaw callback 协议 — webhook-server 内部
- ❌ Notion Markdown API 边界 — 详 `docs/notion_markdown_api.md`

---

> 本文档随后端 CLI / FastAPI / schema 演进同步更新。前端发现契约差异立即开 issue。
