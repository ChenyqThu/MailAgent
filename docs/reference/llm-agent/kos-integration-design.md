# MailAgent ⇄ Jarvis KOS (gbrain fork) 集成设计

> **状态**：✅ **M2 已 ship**（Sprint 19，2026-05-23 起）。本设计替换原 plan D1（自研 SQLite wiki）作为 M2 Wiki 实施路径，三层 flag（`MAILAGENT_KOS_INGEST_ENABLED` / `_CONSUMER_ENABLED` / `_L1_HOT_BLOCK_ENABLED`）默认全关，见根 `CLAUDE.md` 开关表。
> **决策反转**：从"自研 SQLite `wiki_pages` + 借鉴 gbrain 闪光点"反转为"**MailAgent 作为外部 KOS 第二大脑的第 4 个消费者**"
> **关联架构**：旧自研 harness 设计文档（`architecture_agent_harness.md` / `agent-harness-design.md`）已归档存史（S3，2026-07-03，见 `docs/archive/2026-06/`）；当前 chat 引擎架构见 [`ai-sdk-gateway-architecture.md`](./ai-sdk-gateway-architecture.md)

---

## 1. Why（决策反转的理由）

### 1.1 原 plan D1 的问题

M1 之前 plan 锁的是 "M2 在 `chat_db.ts` 加 `wiki_pages` + `wiki_fts` + `agent_memory_kv` 表，自研一套邮件域 wiki"。M1 ship 时 schema 已建好留位（PR-1a）。

**新认知**：用户已经有 **Jarvis KOS v2** —— gbrain fork，运行在 mac mini，公网 `kos.chenge.ink` 已可达；存了用户工作 / 学习 / 生活全域知识（参考上游量级：~146k pages / 24k people / 5k companies）；已有 3 个消费者（Notion Knowledge Agent / OpenClaw / Feishu signal detector）。

**自研 wiki 等于在外部 KOS 之上建邮件孤岛**：
- 用户从 Notion 端记录的 "Bob 是 Acme CTO" 跟邮件里的 "Bob @ acme.com" 没法关联（自研 wiki 看不到 Notion 端 entity）
- chat agent 问 "Bob 上次提的集成方案" → 只能搜邮件 body，看不到用户从 Slack / 会议 / Notion 手记里抽的 Bob 档案
- 用户要 review wiki 内容时要在 N 个工具里跳

### 1.2 KOS 已具备的能力（不重写）

`README §1 + JARVIS-ARCHITECTURE.md`：

| 能力 | 来源 |
|---|---|
| 自动 typed-link 提取（零 LLM）：`attended` / `works_at` / `invested_in` / `founded` / `advises` | 上游 gbrain |
| 知识图谱多跳遍历 + backlink-boosted ranking | 上游 gbrain |
| 混合检索：vector (HNSW) + BM25 + RRF 融合 + ZeroEntropy 重排（v0.36.2+ 默认） | 上游 gbrain + fork 已 patch |
| `## Facts` markdown 围栏 → typed metric columns + temporal trajectory（`mrr=50000` / `arr=2000000`） | 上游 gbrain v0.35.7+ |
| 夜间 consolidate / 矛盾检测 / 引用修复 | 上游 gbrain cron 系统 |
| 自动 entity merge：邮件里 `bob@acme.com` 跟 Notion 里 `[[people/bob]]` 自然合到同一节点 | 上游 gbrain entity resolution |
| KOS quality layer (Lucien fork)：DIKW compilation / E0-E4 evidence / 置信度评分 / lint patrol | fork 自己加的 |
| Backup cron (`com.jarvis.gbrain-backup`) + Postgres engine | fork 部署 |
| `kos-compat-api` HTTP boundary：`/query /ingest /digest /status /health` | fork `server/kos-compat-api.ts` |

**结论**：90% 我们要的 wiki 能力（entity / graph / hybrid search / Facts / cross-domain）KOS 已有。自研只是把这些抄一遍但少 100×。M2 的实施成本应该是 *接入 KOS 写 client* 而不是 *重新实现 wiki*。

---

## 2. Architecture（MailAgent 作为 KOS 第 4 消费者）

```
┌─────────────────────────────────────────────────────────────────┐
│  Mac mini @ Tailscale 100.98.144.119                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Jarvis Knowledge OS v2 (gbrain fork)                     │   │
│  │  - Postgres engine, 24k+ people / 5k+ companies          │   │
│  │  - server/kos-compat-api.ts on 127.0.0.1:7225           │   │
│  │  - dream cycle / consolidate / autopilot cron            │   │
│  │  - upstream-patches (gemini embed shim @ 7222)           │   │
│  └───────────┬──────────────────────────────────────────────┘   │
│              │                                                  │
│  ┌───────────▼──────────────────────────────────────────────┐   │
│  │  Reverse proxy → public boundary kos.chenge.ink         │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────┬──────────────────────────────────────────────────────┘
           │ HTTPS (Bearer KOS_API_KEY)
           │
   ┌───────┴────────┬──────────────────┬─────────────────┐
   ▼                ▼                  ▼                 ▼
┌──────────┐  ┌──────────┐      ┌──────────┐    ┌──────────────┐
│MailAgent │  │  Notion  │      │ OpenClaw │    │Feishu signal │
│ (新, M2) │  │Knowledge │      │ (existing)│    │detector      │
│          │  │ Agent    │      │          │    │ (existing)   │
└────┬─────┘  └──────────┘      └──────────┘    └──────────────┘
     │
     │ 两条路径
     │
     ├─── producer (mail-sync 后端):
     │      每封 sync 完的邮件 → POST /ingest
     │      page 路径 `mail/{internal_id}` + scope=mail-agent
     │      全文 markdown + frontmatter, KOS 自动抽实体并入主图
     │
     └─── consumer (chat agent harness):
            chat 工具 kos_query / kos_digest → POST /query, /digest
            返回跨域 page list + score + entity refs
            LLM 拿这些 cross-context 决定如何回话
```

### 2.1 两条数据流分工

| 路径 | 触发 | 频率 | 责任 |
|---|---|---|---|
| **Producer**（mail-sync 后端 Python） | 每封邮件 sync 到 Notion 后 fire-and-forget | ~10-50 封/天 | 邮件 markdown → KOS `/ingest`；失败仅 warning 不阻塞主同步 |
| **Consumer**（chat agent harness，Electron 前端 main process） | 用户 chat 时 LLM 调 tool | ~per chat turn | KOS `/query` / `/digest` → tool_result → LLM |

**关键**：写入是后端统一驱动（避免 chat 路径里 LLM 自己决定写什么、写多少 — 图谱污染风险）；读出走 chat agent tool。

### 2.2 邮件 → KOS page 映射

每封邮件 = 一个 KOS page：

```markdown
---
path: mail/{internal_id}
scope: mail-agent
source: mailagent
source_id: {internal_id}
subject: <subject>
sender: <name> <email@addr>
recipients:
  to: [...]
  cc: [...]
date: 2026-05-22T10:30:00+08:00
thread_id: <thread_id>
notion_page_id: <if synced>
ai_priority: important
ai_action: 需要回复
mailbox: 收件箱
---

# {subject}

From: {sender_name} <{sender_addr}>
Date: {date_iso}

{body_markdown}

## Facts
priority=important
action_required=true
deadline=2026-06-01
```

KOS 拿到后：
- 自动从 sender/recipients/body 抽 `people/...` `companies/...` 节点 + typed link（`emailed_with` / `attended` 等）
- `## Facts` 围栏的 `priority=important` 进 typed metric column → 可走 trajectory eval（这周哪些 critical 邮件、本月跟 Bob 的互动是否 trending）
- entity 跟用户已有的 `people/bob-acme`（Notion / Slack 端写的）自然合并 — 邮件流自动丰富 Bob 档案

### 2.3 Chat agent 读 KOS

chat harness 暴露 2 个 tool（替换原 plan 的 6 个本地 wiki_* tool）：

| Tool | 调谁 | LLM 看到的描述 |
|---|---|---|
| `kos_query` | `POST /query` | 跨域知识检索：人物 / 公司 / 邮件 / 会议 / 手记。query 自然语言，返排序后的 page list + snippet + entity refs。用于"Bob 上次提的 X / Acme 项目最近怎么样 / 我跟这个供应商的历史 / 类似邮件之前怎么处理"。 |
| `kos_digest` | `POST /digest` | 拉指定 entity 的 digest 卡（people/{slug} / companies/{slug} / projects/{slug}）。用于 chat 开场注入"当前邮件发件人 = Bob @ Acme，KOS 档案显示 ..." |

**LLM 不调 ingest** — 写入路径由 mail-sync 后端独占，chat 路径只读。这避免 LLM 把 chat 上下文里幻觉的 "事实" 主动塞进图谱。

---

## 3. Client 设计（PR-2c 已实施 2026-05-23）

> **协议反转**: 2026-05-17 §6.28 KOS cutover 后，原 KOS-v1 REST + `KOS_API_KEY` plaintext bearer 退役 (`kos-compat-api.ts` 进 `_archived/`)。现在走 **OAuth 2.1 client_credentials + MCP JSON-RPC over HTTP with SSE response**。完整 wire spec: mac mini `~/Projects/jarvis-knowledge-os-v2/docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`。

### 3.1 配置（.env）

```bash
# 公网 MCP endpoint (跨机器都可达; 本机如需 LAN 备份可加 KOS_MCP_FALLBACK)
KOS_MCP_BASE=https://kos.chenge.ink

# OAuth client_credentials 凭据 (跟 Lucien 申请, 凭据本地源
# ~/.gbrain/oauth-clients/mailagent.json mode 600; gitignored)
KOS_OAUTH_CLIENT_ID=gbrain_cl_xxxxxxxxxxxx
KOS_OAUTH_CLIENT_SECRET=gbrain_cs_xxxxxxxxxxxx

# 总开关 - producer / consumer 各自独立 (M2 ship 前默认 false)
MAILAGENT_KOS_INGEST_ENABLED=false        # PR-2d producer (邮件推 KOS)
MAILAGENT_KOS_CONSUMER_ENABLED=false      # PR-2e/2f consumer (chat agent 查 KOS)

# Producer 触发阈值 (high signal 优先; 低优先级邮件不推避免图谱噪声)
KOS_INGEST_PRIORITY_FLOOR=normal          # 推: critical/urgent/important/normal; 不推: low

# Producer dry-run - 跑完整 payload builder + 不真发 (灰度用)
KOS_INGEST_DRY_RUN=false

# Per-call timeout (秒)
KOS_TIMEOUT_SECONDS=10
```

### 3.2 Auth flow + protocol

```
1. 启动 (lazy) 第一次调 tool 时:
   POST $KOS_MCP_BASE/token
     Content-Type: application/x-www-form-urlencoded
     grant_type=client_credentials & client_id=... & client_secret=... & scope=read+write
   →  {access_token, token_type:'bearer', expires_in:3600, scope:'read write'}

2. tools/call 调用:
   POST $KOS_MCP_BASE/mcp
     Authorization: Bearer <access_token>
     Content-Type: application/json
     Accept: application/json, text/event-stream
     Body: {jsonrpc:'2.0', id, method:'tools/call', params:{name, arguments}}
   →  Content-Type: text/event-stream
       Body: "event: message\ndata: <jsonrpc envelope>\n\n"
   → 提取 'data: ' 行 JSON.parse → result.content[0].text → JSON.parse 再得 caller-friendly value

3. 401 → 自动 refetch token + retry 一次 (无限循环防死循环). 无 refresh_token.

4. Token cache: in-memory + expires_at, 60s 安全缓冲. 单进程足够 (mail-sync /
   chat agent 都是单 process). 重启进程重换 token (3600s × 50 req limit 充裕).
```

### 3.3 Client API（TypeScript + Python 双份, 算法 1:1 对齐）

**Python**（`src/kos/client.py`, ship 2026-05-23）：

```python
class KOSClient:
    def __init__(
        self,
        base_url: Optional[str] = None,      # env KOS_MCP_BASE
        client_id: Optional[str] = None,     # env KOS_OAUTH_CLIENT_ID
        client_secret: Optional[str] = None, # env KOS_OAUTH_CLIENT_SECRET
        *, timeout_seconds: float = 10.0, scope: str = "read write",
        http_client: Optional[httpx.Client] = None,  # 测试注入 MockTransport
    ): ...

    @property
    def configured(self) -> bool: ...

    # 免 auth, GET /health
    def health(self) -> dict: ...

    # 原始 tools/call, 401 自动 retry, 返 caller-friendly unwrapped value
    def call_tool(self, name: str, arguments: dict) -> Any: ...

    # 便捷方法
    def query(self, query: str, *, limit: int = 10, expand: bool = False) -> list[dict]: ...
    def list_pages(self, *, limit: int = 50, type=None, tag=None, ...) -> Any: ...
    def put_page(self, slug: str, content: str) -> dict: ...
```

**TypeScript**（`frontend/src/electron/main/kos/client.ts`, ship 2026-05-23）：算法 1:1 镜像 Python 版本；构造接受 `fetchImpl?: typeof fetch` 注入参数用作单测 mock。

### 3.4 KOSError code 矩阵

| code | 含义 | caller 该怎么办 |
|---|---|---|
| `E_KOS_NOT_CONFIGURED` | 3 env 至少一个缺 | producer 跳过 (sync 不阻塞); chat tool 返 fallback |
| `E_KOS_HEALTH` | `/health` 失败 | boot 期 → enabled=false; 中途 → log warning |
| `E_KOS_NETWORK` | fetch / connect / timeout | producer 跳过; chat tool 退到本地 FTS5 |
| `E_KOS_TOKEN_HTTP` | `/token` 非 200 (cred 错 / Lucien revoke) | 致命 — 飞书告警, enabled=false 等用户修 |
| `E_KOS_TOKEN_INVALID` | `/token` 200 但 access_token 缺 | 同上, 上游协议变了 |
| `E_KOS_UNAUTHORIZED` | `/mcp` 401 | client 自动 refresh + retry 一次. 第二次还 401 → 上抛 |
| `E_KOS_RATE_LIMIT` | `/mcp` 429 (50/15min) | producer 排队 / chat tool 等待 backoff |
| `E_KOS_HTTP` | `/mcp` 其他 4xx/5xx | log + 单次跳过 (不重试) |
| `E_KOS_PARSE` | SSE 提取或 JSON.parse 失败 | log + 跳过 |
| `E_KOS_RPC` | JSON-RPC envelope `error` 非空 | 业务错 (slug 冲突 / 参数非法 等), caller 视情况处理 |

### 3.5 不可达时的降级矩阵

| 场景 | KOS reachable | KOS unreachable / E_KOS_* |
|---|---|---|
| chat agent 检索 | `kos_query` 返跨域结果 | LLM 看到 ok:false → 转 `email_search_fulltext` 本地 FTS5 (PR-2a) |
| mail-sync ingest | `put_page` 异步 push, ~50-100ms 完成 | warning log; 邮件继续走 Notion sync 主路径; 不重试 |
| chat L1 hot block 注入 | 含当前 sender 的 KOS digest | 仅本地邮件 metadata, 无 cross-context |

### 3.6 测试

- Python: `tests/kos/test_client.py` — 39 个单测 (httpx.MockTransport 注入)
- TypeScript: `frontend/tests/main/kos/client.test.ts` — 36 个单测 (fetchImpl 注入)
- 共同覆盖: configured / health / OAuth /token flow / token cache + safety buffer / SSE + JSON 双 response 形式 parse / 401 retry / 429 / 5xx / JSON-RPC error envelope / SSE 异常 case
- 实测 (smoke against 真 KOS): `python -c "from src.kos import KOSClient; c = KOSClient(); print(c.health()); print(c.query('redis', limit=3))"` 已验证 protocol 跑通

---

## 4. M2 PR 拆分（替换 plan 原 M2.x）

| PR | 范围 | LOC est |
|---|---|---|
| **PR-2a** | FTS5 中文 smart wrapper（CJK auto `*` 通配 + OR 融合）。保留作 KOS 不可达时的本地 fallback | ~300 |
| **PR-2b** | 附件文本化（pypdf / python-docx / python-pptx / xlsx CSV）+ `email_attachment_text` + `email_attachment_fts` + worker queue + `email_search_attachments` tool。同样作 fallback；附件文本不强制推 KOS（避免存储重复） | ~700 |
| **PR-2c** | **KOS client (TypeScript + Python)**: config / health check / retry / fallback URL / circuit breaker / typed envelopes | ~500 |
| **PR-2d** | **Producer pipeline**: mail-sync 在 `new_watcher._sync_single_email_v3` 写 Notion 成功后异步 `KOSClient.ingest`；page payload builder（按 §2.2 schema）；priority floor 过滤；KOS 不可达不阻塞 | ~400 |
| **PR-2e** | **Consumer tools**: `kos_query` / `kos_digest` tool 加入 `defaultToolRegistry`；wire 进 ToolDef `confirmationTier='silent'` category=`meta` | ~400 |
| **PR-2f** | **L1 hot block 注入**: chat harness 启动时若 emailContext.senderAddr 存在 → 异步 `kos_digest(people/{sender_slug})` 注入 system block；cache_control 双 breakpoint 保留；slug helper 集中 in client | ~300 |
| **PR-2g** | 整合 + dogfood pass：跑 20 eval scenario 看 KOS 在 vs off 的 lift；CLAUDE.md / architecture doc / SPRINT19-M2-HANDOFF | — |

**移除**（原 plan）：自研 `wiki_pages` 数据访问层、4 个本地 wiki 读 tool、`wiki_write` / `wiki_delete` confirmation 流、`[[wiki/path]]` link 提取 helper、`## Facts` 解析进 `agent_memory_kv` —— 全部由 KOS 自带能力覆盖。

**保留**（chat_db v3 schema 已建好的留位）：`wiki_pages` / `wiki_fts` / `agent_memory_kv` 表保留但**不主动写**。M3 可以评估是否要做"KOS 不可达时的离线缓存层"（把上次拿到的 digest 持久化下来）。

---

## 5. 安全与边界

### 5.1 Namespace 隔离

所有 mail-agent 写入的 page 走路径前缀 `mail/{internal_id}`，frontmatter `scope: mail-agent`。可走 KOS 的 path-based scope query 排除噪声。

**关键观察**：scope 只隔离 page 本身，**实体（people/companies）仍合并到全局**。这是设计上正确的：邮件里的 `bob@acme.com` 跟 Notion 手记里的 `[[people/bob-acme-cto]]` 是同一个 Bob，分离反而失去价值。

### 5.2 Priority floor

`KOS_INGEST_PRIORITY_FLOOR=normal` 防止 spam / 通讯录低优邮件污染图谱。`low` priority 邮件不推（mailing list / 广告 / 系统通知）。

### 5.3 Auth

`KOS_API_KEY` Bearer header（client 发 `Authorization: Bearer ${apiKey}`）。具体读 env var 名 + 是否 OAuth 包装由用户下一轮指定，client 提前留接口。

### 5.4 离线模式 / 隐私

- `MAILAGENT_KOS_ENABLED=0` 总开关：完全关闭 KOS 调用（不写不读），MailAgent 行为退化到 M1 单机 + 本地 FTS5
- 用户可在 Settings 切（M3 polish）

### 5.5 Dry-run / preview

mail-sync 启动时加 `KOS_INGEST_DRY_RUN=1` 选项：跑完整 producer pipeline 但不真发 `/ingest`，只 log payload。给上线灰度用。

---

## 6. 验证（M2 ship gate）

跟 M1 一样跑 `docs/eval/email_scenarios.md`（已归档存史，见 `docs/archive/2026-05/eval/email_scenarios.md`）。新增 KOS 专属 scenario（M2 补 5 个）：

- "Acme 项目最近一个月跟我的邮件互动" → 期望 `kos_query` 返跨 sender 的 page list
- "Bob 之前怎么提集成方案" → 期望 `kos_digest(people/bob-*)` 注入 + `kos_query` 补充邮件细节
- "我跟这家供应商以前的合同条款是什么" → 期望 `kos_query` 返合同档 + 邮件附件
- "本周 high priority 邮件总结" → producer pipeline 成功的标志（KOS 应有 7 day 视窗 entity）
- "KOS 关掉时同样 prompt 还能 work" → fallback 路径 (LLM 自动降级到 FTS5)

P2 gate：≥ 85% pass rate（含 KOS scenario），且 cross-context query lift ≥ 30% (vs M1 仅本地 FTS5)。

---

## 7. 待用户给的剩余信息

1. ✅ Endpoint：`https://kos.chenge.ink` + `http://127.0.0.1:7225` —— 已确认
2. ✅ Ingest payload：全文 markdown + frontmatter —— 已确认
3. ✅ Namespace：`mail/{internal_id}` + `scope: mail-agent` —— 已确认
4. ⏳ **Auth**：API key bearer 的 env var 名 + 是否需要别的 header（`X-KOS-Tenant` / `X-Source` 之类）
5. ⏳ KOS `/ingest` 真实 request schema（frontmatter 字段是 `path` / `id` / `slug`？body 是 raw markdown / 还是 `{markdown, metadata}` 包装？）—— 我下次开始写 client 前 SSH 看一眼 `server/kos-compat-api.ts` 的 ingest route 即可（仅看 route 签名，不读 .env）
6. ⏳ `/query` 真实 response schema（hits[i] 字段名？是否含 entity refs？是否有 mode 参数？）—— 同上

我下次 session 开始时跑：
```bash
ssh chenyuanquan@100.98.144.119 \
  'cd ~/Projects/jarvis-knowledge-os-v2 && \
   grep -nE "app\\.(post|get).*['\''/]" server/kos-compat-api.ts | head -20'
```
就能拿到 5 个 endpoint 的 input/output schema 形态（不碰 .env）。

---

## 8. 不做的

- ❌ MCP stdio over ssh pipe（跨机 stdio 不稳定，且 MailAgent 已经走 HTTP IPC pattern）
- ❌ MailAgent 端自维护 entity / graph（让 KOS 自己跑 cron consolidate）
- ❌ LLM 直接调 `kos_ingest`（防 chat 路径污染图谱；写入由 mail-sync 后端独占）
- ❌ 把 KOS 改成 push notification 给 MailAgent（webhook 反向，复杂度爆炸；后端 polling KOS 也无场景）
- ❌ 内嵌 gbrain 本体到 MailAgent bundle（之前评估过 30-50MB bundle + Bun + PGLite 错配）
- ❌ ZeroEntropy / Voyage / 其他 embedding provider 自带（KOS 端已配置，MailAgent 不重复）

---

## 9. 路线时序

| 日历周 | 工作 |
|---|---|
| W1 | PR-2a/2b：本地 fallback（中文 FTS5 + 附件文本化）— 跟 KOS 解耦，先 ship |
| W2 | PR-2c/2d：KOS client + producer pipeline，dry-run 灰度 |
| W3 | PR-2e/2f：consumer tools + L1 hot block 注入 |
| W4 | PR-2g：dogfood 跑 eval gate；CLAUDE.md / architecture doc 更新；翻 `MAILAGENT_KOS_ENABLED=1` 默认 |

合计 ~3-4 周日历工作量（取决于用户投入节奏）。比原自研 plan（~1 周纯写 wiki 工具）多 ~2 周（因为多了 client + producer + ingest payload mapping），但拿到的能力远超自研（cross-domain graph / 24k people 档案 / hybrid retrieval / dream cycle / Facts trajectory）。

---

## 10. 关联文档

- 旧自研 harness 设计 ref（M2 段）：已归档存史，见 `docs/archive/2026-06/agent-harness-design.md` / `docs/archive/2026-06/architecture_agent_harness.md`
- 当前 chat 引擎架构：[`ai-sdk-gateway-architecture.md`](./ai-sdk-gateway-architecture.md)
- Roadmap：[`roadmap-post-cutover.md`](../architecture/roadmap-post-cutover.md) §5.3
- M2 handoff：`frontend/SPRINT19-M2-PLAN.md`（同 commit 新建）
- 决策记录：`~/.claude/plans/subagent-plan-lexical-moler.md` D1 撤销 / D9 新加（同 commit 更新）
- KOS 上游 fork：mac mini `~/Projects/jarvis-knowledge-os-v2/`，README + `docs/JARVIS-ARCHITECTURE.md`
