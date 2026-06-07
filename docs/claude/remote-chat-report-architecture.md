# V2.1 远程 chat + report/agent 架构（B-pure-unified）

> **何时读**：动 chat 引擎 / 远程 web 访问 / serve-api chat 端点 / report agent 远程化前。
> **配套**：[详设](../v2.1-stage3-chat-platform-design.md)（ChatPlatform 接口 + cutover 枚举 + D1-D5/D-3c 决策）· [验收看板](../v2.1-remote-chat-report-matrix.md)（能力×层矩阵 + 残留检测 + 进度日志）· 服务层基座见 [`service-layer-architecture.md`](./service-layer-architecture.md)（serve-api in-process + 双层鉴权 + daemon 转发）。
> 分支 `feat/v2.1-remote-chat-report`，阶段 1+2 已上线，阶段 3 cutover 落地（commit 至 `2942abd`）。

## 0. 定位

V2（[`mail.chenge.ink/app`](https://mail.chenge.ink/app)）让远程 web 能**看**邮件列表 / 详情 / 日历。V2.1 在此基础上补三块：

| 阶段 | 能力 | 实现摘要 |
|---|---|---|
| 1 | 远程看 Agent 配置 + 报告 | serve-api report 端点 + `HttpApi.ReportApi`；修 agents 慢（fork CLI ~759ms → in-process ~ms）|
| 2 | 远程看 chat 历史（只读） | serve-api chat 5 读端点（`ChatDb` verbatim 镜像 `chat_db.ts`）|
| 3 | **远程跑 chat 多轮对话** | **B-pure-unified**：chat 引擎下沉 `shared/chat/`，electron + browser 都经一份 `HttpChatPlatform` → 一份 serve-api（含读写工具 / notion-agent / KOS）|

阶段 3 是重头，本文档主述。核心 = **一份引擎 + 一份后端 + 一份传输层 = 零 parity**。

## 1. 为什么 B-pure-unified

远程要跑 chat，但 chat 引擎（harness 多轮 loop / dispatcher / custom-api 解析 / notion-agent execa / 工具 / 持久化）原本全在 **electron main 进程**（依赖 execa / better-sqlite3 / IPC，浏览器跑不了）。

三条路：

- **A — 远程独立实现一套 chat**：parity 地狱，两套引擎必漂移（哪个工具/分支/exit 码漏对齐都是线上 bug）。✗
- **B-pure-unified — 引擎下沉 `shared/chat/`（零 Electron），UI 进程跑，经一份 `ChatPlatform` → 一份 serve-api**：引擎单一真源，本地/远程仅 `baseUrl + reads + 鉴权` 差异，全对引擎透明。✅
- C — 远程瘦客户端只发 prompt、服务端跑全 harness：服务端要起多轮 agent runtime + 流式回推，等于把引擎搬服务端再造一遍。✗

选 B。代价 = chat 工具读不再走 IPC 直读 SQLite（改 fetch loopback serve-api），但工具读非热路径，可接受。

## 2. 全貌（cutover 后数据流）

```
┌ UI 进程（shared React + shared/chat 引擎都跑这里）──────────────────────┐
│  useEmailChat → mailApi.chat (ChatRuntime)                               │
│    ├ harness 多轮 loop → dispatcher → backend.stream()                   │
│    │    · 流式 token 直接 emit 给 React（进程内 emitter，无 IPC 推流）   │
│    │    · confirmation = React 弹窗 → resolveConfirmation（同进程 promise，无 IPC）│
│    └ 所有后端原语 → HttpChatPlatform（一份）→ fetch serve-api           │
└───────────────────────────┬─────────────────────────────────────────────┘
       本地 renderer (file://) │ 远程 browser (https://mail.chenge.ink)
   token: main webRequest 注入 │ 鉴权: CF Access cookie
                              ▼
            ┌ serve-api（FastAPI 8200，唯一 chat 后端，无 harness 逻辑）┐
            │ POST /api/chat/llm-proxy    注入 key + 透传 Anthropic/OpenAI SSE（不解析）│
            │ POST /api/chat/notion-agent asyncio spawn CLI，Python 复刻 thread/gate/exit │
            │ chat 持久化 9 写 + 3 单读 + 5 读端点（ChatDb 镜像 chat_db.ts）            │
            │ GET  /api/chat/config       运行配置快照（前端构造 platform 前预取）       │
            │ 工具 /api/email/* · /api/attachment/search · /api/chat/kos-call|save-to-kos │
            └────────────────────────────────────────────────────────────────────────────┘
                              │
            ai_chat.db（schema owner = 前端 chat_db.ts，serve-api 绝不建表）
```

**关键：流式 token 不跨进程**。cutover 前是 `harness(main) → webContents.send('chat:stream') → renderer`（IPC 推流）；cutover 后 harness 就在 renderer 同进程跑，token 经进程内 `ChatStreamEmitter` 直驱 React，confirmation 弹窗结果经同进程 `resolveConfirmation` promise 回灌——**零 IPC 往返**。serve-api 只做"后端原语"（LLM 透传 / 子进程 spawn / DB 读写 / 工具代理），不含任何 harness 编排逻辑。

## 3. 三层

### 3.1 引擎层 `shared/chat/`（一份，UI 进程跑，零 Electron）

| 文件 | 职责 |
|---|---|
| `runtime.ts` `createChatRuntime(deps)` | 组装 dispatcher + HttpChatPlatform + emitter sink → 完整 `ChatApi`（electron/web 唯一入口）|
| `dispatcher.ts` `createChatDispatcher({platform,getBackend,toolRegistry})` | startChat / editChatMessage / runStream（per-instance `_inflight`，rapid-click guard）|
| `harness.ts` | 多轮 agent loop（maxIter/maxCostUsd gate、tool_use 收集 → 确认 → 执行 → 回灌、终态持久化）|
| `emitter.ts` `ChatStreamEmitter` | 进程内 sink fan-out（快照遍历 + handler 隔离，取代 IPC `chat:stream`）|
| `platform.ts` | 分层接线板接口（见 §3.2）|
| `http_platform.ts` `HttpChatPlatform` | 全四板 fetch serve-api（见 §3.2）|
| `backends/custom_api.ts` `createCustomApiBackend(platform)` | custom-api 双协议 SSE 解析（Anthropic/OpenAI），调 `platform.llmFetch` |
| `backends/notion_agent_http.ts` `createHttpNotionAgentBackend(platform)` | notion-agent 薄包，调 `platform.notionAgentStream`（execa 已删）|
| `tools/builtin/` `createBuiltinTools(platform)` | 20 工具单一真源（registry 注入式，`kosConfigured` gate 9 KOS 工具）|
| `tools/confirmation.ts` `resolveConfirmation` | 写工具确认 promise registry（同进程，无 IPC）|
| `model.ts` | 纯类型 + `backendSupportsTools` |

### 3.2 传输层 `HttpChatPlatform`（一份，分层接线板）

`platform.ts` 把外部能力按「变更频率 + 职责」拆成独立小板（用户拍板「分层接线板」），组件各取所需：

| 板 | 含 | 消费方 |
|---|---|---|
| `ChatInfraPlatform` | persist（ai_chat.db 12 法）/ loadEmailContext / resolveConfig / prefetchSenderDigest | harness + dispatcher |
| `ChatModelPlatform` | llmFetch（custom-api SSE）/ getCachedSenderDigest / modelConfig | custom_api backend |
| `ChatNotionAgentPlatform` | notionAgentStream（仅 http 实现）| notion_agent_http backend |
| `ChatToolPlatform` | 8 读 + flag/draft + kosCallTool / kosConfig / saveToKos | tools/builtin |

`HttpChatPlatform` 实现全四板 = fetch serve-api 对应端点。构造 `(httpApi, baseUrl, config?)`：
- **持久化 cadence（D1）**：`streamContent` per-messageId trailing throttle ~1s（累积 buffer 覆盖 + 仅空闲 arm timer）→ PATCH `/stream`；`finalizeMessage` **先 flush 待发增量再写终态**（防晚到 stream 覆盖终态，harness 终态带 `content=buffer` 双保险）；electron 旧路径是同步直写，cutover 后统一走此 debounce。
- **工具 8 读零投影**委托 `httpApi.email.*` / `attachment.list`（`api/types` = `cli.gen` 别名/超集）。
- **config 快照**：第三参带远程默认 `DEFAULT_HTTP_CONFIG`；runtime 预取 `GET /chat/config` 覆盖（D-3c-3，本地/远程都精确，不被硬编码默认覆盖）。

### 3.3 后端层 serve-api（一份，无 harness 逻辑）

`src/api/routers/chat.py` + `src/chat/`（`db.py` ChatDb / `notion_agent.py` + `notion_agent_gate.py` Python 复刻）：

- **`POST /api/chat/llm-proxy`**：注入 `config.llm_api_key`，透传上游 SSE（仅 2xx passthrough，不解析；解析在 shared custom_api）。
- **`POST /api/chat/notion-agent`**：`asyncio` spawn CLI，Python **逐语义复刻** `notion_agent.ts`（thread_id 探测 / 串行 gate / exit 75=RATE_LIMIT/77=AUTH/127=NOT_INSTALLED 分类 / idle 看门狗覆盖读+wait 双相 / token_v2 cookie 不泄漏）→ 语义 event SSE。
- **chat 持久化 9 写 + 3 单读 + 5 读**：`ChatDb` SQL **verbatim 镜像** `chat_db.ts`（`IS NULL` 分支 / `key in patch` 复刻 `!== undefined` / append 后 bump session 同事务）。单读返 `row|null` 不 404（契约是 `…|null`）。**绝不建表**（schema owner = 前端 `chat_db.ts`）。
- **`GET /api/chat/config`**：8 字段运行配置快照（读 `config.py`/env，归一化对齐 electron getter）。
- **工具**：复用 `/api/email/*`（D1 已有读写）+ 补 `GET /attachment/search` + `POST /api/chat/kos-call`·`save-to-kos`（复用 `src/kos/client.py`，Python `kos_save` frontmatter 字节对齐）。

## 4. 鉴权：本地 token vs 远程 CF cookie

| | 本地 electron renderer | 远程 browser |
|---|---|---|
| renderer Origin | `file://`（打包态，Origin `null`）/ `localhost:5173`（dev）| `https://mail.chenge.ink` |
| 鉴权 | main `chat_local_bridge.ts` 用 `webRequest` 拦截 loopback 8200：`onBeforeSendHeaders` 注 `X-MailAgent-Local-Token`（**renderer 不持 token**，main 单例）；`onHeadersReceived` 注 CORS（仅打包态 `file://` 跨 origin 需要）| CF Access cookie（`ALLOWED_ORIGINS=["https://mail.chenge.ink"]` 白名单）|
| serve-api 鉴权腿 | `auth.py` 本地 token 腿（`compare_digest`）先于 CF JWT | CF JWT |

`webRequest` 对 serve-api + harness **全透明**：ALLOWED_ORIGINS 不为本地开特例，token 留 main 不进 renderer（安全），远程 CF cookie 不受影响。

## 5. ChatRuntime 组装（cutover 的支点）

`createChatRuntime({reads, baseUrl}): ChatApi`（`reads` = 工具读委托的 `MailApi`，**不**用 `reads.chat` 避免循环）：

- **emitter + sink 构造期即建**（`onStream` 在首次 `start` 前被 `useEmailChat` 订阅）。
- **engine lazy**（首次跑方法前 `ensureEngine`）：`await GET /chat/config` → `new HttpChatPlatform(reads,baseUrl,snapshot)` → `createBuiltinTools(platform)` 注册（kosConfigured gate）→ backends `{custom-api, notion-agent}` → `createChatDispatcher`。promise 缓存幂等 + 失败清缓存重试。
- **方法映射**：start/editMessage → engine.dispatcher；abort/confirmTool/deleteSession/读 → **不触发 engine**（confirmTool 同进程 resolveConfirmation，读直接 fetch）。
- **接线**：web = `HttpApi` 构造 `this.chat = createChatRuntime({reads:this, baseUrl})`；electron = `ElectronApi` 构造 `createElectronChatRuntime`（`reads:new HttpApi(loopback)` + `openPopout` override 回 IPC）。
- **破循环**：`HttpApi.chat` 是 **lazy getter**（首访构造 runtime）→ electron 注入的 `new HttpApi(loopback)` 只取 email/attachment、不碰 `.chat`，其 lazy chat 永不构造。
- **端口透传**：renderer 无 `process.env` → main 三 load 入口（createWindow / popout / onboarding reloadToMain）注 `?apiPort=<resolveApiPort()>`，`loopbackChatBaseUrl()` 读 `window.location.search`，回退 8200。

## 6. 两类后端的不对称（有意，按性质分）

- **custom-api = HTTP**：serve-api llm-proxy 注入 key 后透传原始 SSE，shared custom_api 在 UI 进程**解析**（解析逻辑单一真源在 shared）。
- **notion-agent = 子进程**：execa 不能在浏览器跑，spawn + 解析 stdout + thread 探测（需 fs）天然在服务端。serve-api Python **复刻**，TS `notion_agent.ts` 删除。

两者最终都是单一实现（custom_api = shared TS / notion_agent = Python）→ 零 parity。

## 7. 关键决策

**阶段 3 总纲（D1-D5）**：
- **D1** 持久化 cadence 由 platform 控（streamContent debounce / finalizeMessage flush），守 harness 单一真源。
- **D2** custom-api 解析留 shared / notion-agent 复刻 Python（按后端性质分，各单实现）。
- **D3** 3a 保 main 执行（经 ElectronChatPlatform 零回归），3c 才搬 renderer。
- **D4** notion-agent 统一进 harness，删 dispatcher legacy 单遍（见 §8）。
- **D5** 本地也走 serve-api（读写引擎单一路径）。

**cutover 3 fork（D-3c-1~3）**：
- **D-3c-1** 提取 shared `ChatRuntime`，electron + web 都走 serve-api。
- **D-3c-2** main `webRequest` 拦截 loopback 8200 注 token + CORS。
- **D-3c-3** 新建 `GET /api/chat/config`（serve-api 暴露运行配置，前端预取）。

## 8. 不变式 / 已知行为

- 🔴 **不变式 1：`shared/chat/` 零 Electron/Node-only 依赖**（方案成败根本）。每次动 shared/chat 后 `pnpm build:web` 验证（无 `from 'electron'` / `better-sqlite3` / `execa` / `handlers/`）。
- 🔴 **本地 chat 依赖 serve-api 在跑**：cutover 后 electron chat 经 loopback serve-api（C2 软门控 + 崩溃自拉起兜底）。serve-api 不可达时 chat **graceful 降级**（读返 `[]` / 写 throw `E_DISPATCH` → toast，不白屏 crash）。
- 🟠 **D4 语义变化 —— harness-off 逃生阀消失**：cutover 删了 dispatcher 的 `harnessEnabled && backendSupportsTools` gate，`runStream` 无条件走 harness。`MAILAGENT_AGENT_HARNESS=0` **不再退化成 legacy 单遍纯文本路径**；notion-agent 经 harness（empty tools → 首轮 end_turn）等价单遍。**生产默认 `MAILAGENT_AGENT_HARNESS=ON`，无实际影响**；但若需排障回退单遍，该逃生阀已不存在（需代码层处理）。
- 🟠 **flag 命名澄清 —— `MAILAGENT_REMOTE_ACCESS_ENABLED` 名不副实**：它名为「远程访问」，**实为本地 daemon / serve-api 总开关**。自 D1（前端写收编 daemon）起本地写、cutover 后本地 chat 都依赖它；`=false` **连本地 chat / 写都挂**（非仅关远程）。默认起，纳入 BackendLifecycleManager 自启。
- 🟡 **ai_chat.db schema owner = 前端 `chat_db.ts`**（`CHAT_DB_VERSION`，better-sqlite3 在 main `getChatDb()` lazy migrate）。serve-api `ChatDb` 绝不建表 → main boot 须显式 `getChatDb()` bootstrap（首次 HTTP 写前 schema 在）。
- 🟡 **debounce 正确性**：`streamContent`（fire-and-forget throttle）/ `finalizeMessage`（flush 先于终态）拆分，防终态被旧增量覆盖。harness 终态带 `content=buffer` 双保险。

## 9. 关键文件索引

| 层 | 文件 |
|---|---|
| 引擎（shared） | `frontend/src/shared/chat/{runtime,dispatcher,harness,emitter,platform,http_platform,model}.ts` + `backends/{custom_api,notion_agent_http}.ts` + `tools/builtin/` + `tools/confirmation.ts` |
| electron 接线 | `frontend/src/shared/api/ElectronApi.ts`（`createElectronChatRuntime`）· `frontend/src/electron/main/chat_local_bridge.ts`（webRequest token+CORS）· `index.ts`（三 load 入口注 apiPort + `getChatDb()` bootstrap）|
| web 接线 | `frontend/src/shared/api/HttpApi.ts`（`chat` lazy getter）|
| serve-api | `src/api/routers/chat.py` · `src/chat/{db,notion_agent,notion_agent_gate}.py` · `src/kos/client.py` |
| 鉴权 | `src/api/auth.py`（本地 token 腿 + CF JWT）· `frontend/src/electron/main/local_token.ts` |

## 10. 阶段 1（report/agent）+ 阶段 2（chat 只读）

同样的 serve-api 模式，更简单：

- **阶段 1 report/agent**：`src/api/routers/reports.py` 6 端点（in-process `ReportStore` 不 fork CLI）+ `src/reports/wire.py`（CLI + serve-api 读形状/patch 单一真源）。`HttpApi.ReportApi` 接 6 端点。本地 getConfig 改走 serve-api in-process resolve（~ms，取代 fork CLI ~759ms = agents 慢根因）。
- **阶段 2 chat 只读**：`src/chat/db.py` ChatDb 5 读端点（SQL verbatim 镜像 `chat_db.ts`，graceful 库不存在 → `[]`）。本地阶段 2 保留直读 replica，阶段 3 cutover 后统一走 serve-api（D5）。

ai_chat.db 路径 = `DATA_ROOT/frontend/ai_chat.db`（serve-api 注入 `MAILAGENT_DATA_ROOT`，对齐 `chat_db.ts` resolveChatDbPath）。serve-api 读 **app 库** `~/Library/Application Support/mailagent-frontend/data/sync_store.db`（非主仓 PM2 库）。
