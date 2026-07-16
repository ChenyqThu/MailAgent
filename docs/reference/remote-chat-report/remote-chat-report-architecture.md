# V2.1 远程 chat + report/agent 架构（B-pure-unified）

> **何时读**：动 chat 引擎 / 远程 web 访问 / serve-api chat 端点 / report agent 远程化前。
> **配套**：[详设](v2.1-stage3-chat-platform-design.md)（ChatPlatform 接口 + cutover 枚举 + D1-D5/D-3c 决策）· [验收看板](v2.1-remote-chat-report-matrix.md)（能力×层矩阵 + 残留检测 + 进度日志）· 服务层基座见 [`service-layer-architecture.md`](../architecture/service-layer-architecture.md)（serve-api in-process + 双层鉴权 + daemon 转发）。
> 分支 `feat/v2.1-remote-chat-report`，阶段 1+2 已上线，阶段 3 cutover 落地（commit 至 `2942abd`）。
> **🔴 web→ai-sdk（任务 A，2026-06-30 随 v1.0.1；S3 于 2026-07-03 转为唯一路径，无 flag）**：远程 web SPA 与本地 electron 现共享同一个 chat 引擎——嵌入式 **AI SDK Gateway**（Node，跑在 electron main 进程内，loopback 默认端口 8300）。本地 electron renderer 经 `?aiGatewayPort=` 直连 loopback gateway；远程 web 经 serve-api `ai_gateway_proxy.py`（`httpx.AsyncClient(stream=True)` + `aiter_raw` 原样透传字节，client 断开 → `aclose()` 传播 abort）反代到同机 loopback gateway，端点 1:1 镜像 `frontend/src/ai-gateway/server.ts`（`/api/ai/{chat,agui/chat,title,followups,approval/resolve,config}` + 裸 `/health`，**该列表非穷举**——S6/harness-chat 批陆续加了 `approval/pending`/`approval/decide`/`policy/remember`/`search-agent`/`agent-run`/`run/active`/`run/stop` 等端点，均同款反代，权威清单以 `server.ts` 路由表为准）。任务 A 落地时靠 `vite.web.config.ts` 3 个 define 翻默认；S3（`07-02-s3-remove-legacy-harness`）已把这些 build-time flag 连同 legacy TS 引擎一起整体移除——ai-sdk 路径现在是**唯一**路径，硬编码不可运行时回退（回退面 = 装回旧版 `.app`）。gateway 不可达 → 代理 502 / `/health` 探针失败 → 前端渲染 D7 错误态 + 重试按钮（**不再有 legacy 可静默降级**）。**2026-07-15 harness-chat 批**（[`ai-sdk-gateway-architecture.md` §13.22](../llm-agent/ai-sdk-gateway-architecture.md#1322-detached-chat-runs--chat-内审批主路径--未读2026-07-15-harness-chat-批)）新增 `GET /api/ai/run/active` + `POST /api/ai/run/stop` 两条代理路由（detach-tolerant run 的后台真值探针 + composer 显式停止，远程 web parity），审批 `pending`/`decide` 两条代理路由沿用 S6（§13.21.1）既有 parity，鉴权与 `/api/ai/chat` 同面（`verify_cf_access`）。

## 0. 定位

V2（[`mail.chenge.ink/app`](https://mail.chenge.ink/app)）让远程 web 能**看**邮件列表 / 详情 / 日历。V2.1 在此基础上补三块：

| 阶段 | 能力 | 实现摘要 |
|---|---|---|
| 1 | 远程看 Agent 配置 + 报告 | serve-api report 端点 + `HttpApi.ReportApi`；修 agents 慢（fork CLI ~759ms → in-process ~ms）|
| 2 | 远程看 chat 历史（只读） | serve-api chat 5 读端点（`ChatDb` verbatim 镜像 `chat_db.ts`）|
| 3 | **远程跑 chat 多轮对话** | **B-pure-unified**：chat 引擎下沉 `shared/chat/`，electron + browser 都经一份 `HttpChatPlatform` → 一份 serve-api（含读写工具 / notion-agent / KOS）|

阶段 3 是重头，本文档主述。核心 = **一份引擎 + 一份后端 + 一份传输层 = 零 parity**。

## 1. 为什么「一份引擎」（历史决策 + S3 后现状）

远程要跑 chat，但 chat 引擎不能各写一套，否则两套引擎必漂移（哪个工具/分支/exit 码漏对齐都是线上 bug）。阶段 3 cutover 当时的原始决策是 **B-pure-unified**：把引擎（harness 多轮 loop / dispatcher / custom-api 解析 / notion-agent execa / 工具 / 持久化）下沉到 `shared/chat/`（零 Electron 依赖），本地 electron renderer 和远程浏览器各自在自己的 UI 进程里跑同一份引擎代码，经一份 `ChatPlatform` → 一份 serve-api 取后端原语。当时否决的另外两条路：**A** 远程独立实现一套 chat（parity 地狱）；**C** 远程瘦客户端只发 prompt、服务端跑全 harness（等于把引擎在服务端再造一遍）。

**S3（2026-07-03）用一份更彻底的统一取代了 B-pure-unified**：引擎不再是"两边 UI 进程各跑一份相同代码"，而是收敛成**唯一一个运行中的引擎进程**——嵌入式 AI SDK Gateway，常驻 electron main 进程（Node）。本地 electron renderer 直连这个 loopback gateway；远程浏览器经 serve-api 反代（`ai_gateway_proxy.py`）打到同一个 gateway 进程。两条访问路径不再是"各自运行同一份代码"，而是"物理上共享同一个运行时"——比 B-pure-unified 的"一份代码两处跑"更进一步消除了行为分叉的可能性。

代价与 B-pure-unified 时代一致：chat 工具读不走 IPC 直读 SQLite，而是 fetch 同机 gateway（本地）或经 serve-api 反代（远程）；工具读非热路径，可接受。

## 2. 全貌（S3 后数据流）

```
┌ Electron main 进程（Node）──────────────────────────────────────────────┐
│  嵌入式 AI SDK Gateway（frontend/src/ai-gateway/，S3 起唯一引擎）        │
│    server.ts 路由 → chatRun.ts 多轮 loop → tools/* → persistTurn        │
│    persistTurn 由 ai_gateway_lifecycle.ts 注入，直调 chat_db.ts         │
│    （better-sqlite3，同进程免 IPC）写 ai_chat.db                        │
│    loopback 监听 :8300（MAILAGENT_AI_GATEWAY_PORT 可覆盖）              │
└───────────────────────────┬──────────────────────────────────────────────┘
     本地 electron renderer   │  远程 browser (https://mail.chenge.ink)
  `?aiGatewayPort=N` 直连     │  同源 '' → /api/ai/* 打 serve-api 反代
     loopback gateway         │
                              ▼
            ┌ serve-api（FastAPI 8200）─────────────────────────────────────┐
            │ /api/ai/{chat,agui/chat,title,followups,approval/resolve,   │
            │   config} + 裸 /health → ai_gateway_proxy.py：httpx 转发到    │
            │   127.0.0.1:8300（同机），逐字节透传（aiter_raw）             │
            │ 非引擎业务不变：chat 历史读 / report / email / attachment    │
            │   等端点见 §3.3（未随 S3 改动）                              │
            └────────────────────────────────────────────────────────────┘
```

**关键：turn 落库不跨进程**。gateway 核心（`server.ts`/`chatRun.ts`）本身是 pure 核，不 import electron/chat_db；`persistTurn` 回调由 `ai_gateway_lifecycle.ts`（跑在 electron main 同一个进程里）注入，直调 `chat_db.ts` 的 better-sqlite3 API 写 `ai_chat.db`——本地和远程会话最终都落在同一个 gateway 进程、同一个 `persistTurn` 实现里，无论请求是本地直连还是经 serve-api 反代到达。serve-api 对聊天引擎本身只做**转发**（§3.2），不再解析/编排任何 chat 内容。

## 3. 三层

### 3.1 引擎层 —— 嵌入式 AI SDK Gateway（一份，S3 起唯一实现，权威见 [`ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md) §13）

`frontend/src/ai-gateway/`（Node，`shared/chat/` 的完全替代品，S3 已把后者整体删除）：

| 文件/目录 | 职责 |
|---|---|
| `server.ts` | HTTP 路由（`/api/ai/{chat,agui/chat,title,followups,approval/resolve,config}` + `/health`），loopback 监听 |
| `chatRun.ts` | 多轮 loop（AI SDK 编排，工具调用 → HITL 审批 → 回灌） |
| `config.ts` | 运行配置装配 + `persistTurn`/`onTurnStart` 注入点（由 electron 侧填充，见 §3.2） |
| `tools/*.ts` | 内建工具注册（受 tool_catalog + flag 门控） |
| `searchAgentRun.ts` | 独立 headless 子 loop（agentic ⌘K 搜索专用，`present_results` 终结工具不进共享 registry）|
| `prompts/` | system prompt 组装（`buildStableSystemPrompt` + safety floor + soul，W3-A 从 `shared/chat` 迁入） |

**Pure-ish 纪律**：gateway 核心不 import `electron` / `chat_db` / `keytar`——依赖只有 `ai` SDK + zod + 自身 config/tools。真正碰 Electron-only 能力（持久化、密钥）的部分被拆到 electron 侧、经 config 里的回调注入（依赖倒置），使 gateway 本身可独立跑（供测试/headless 复用，如 `searchAgentRun.ts`）。

### 3.2 接线层 —— electron 生命周期注入 + 前端 transport 解析（S3 后新概念，取代旧 `HttpChatPlatform` 分层接线板）

- **electron 侧**（`frontend/src/electron/main/ai_gateway_lifecycle.ts`）：随 electron main 启动 gateway HTTP server；构造并注入 `persistTurn(turn)`（直调 `chat_db.ts` 的 better-sqlite3 API 写 `ai_chat.db`，`ui_message_json` canonical + 抽取的 legacy content 双写）与 `onTurnStart`（eager 写用户消息，防等待响应期间刷新丢输入）两个回调。
- **前端 transport 解析**（`frontend/src/shared/assistant/runtime/flags.ts` 的 `resolveAiGatewayBaseUrl()`）：3 分支——① URL 带 `?aiGatewayPort=N` → `http://127.0.0.1:N`（本地 electron，直连 loopback，不经 serve-api）；② 否则若是 web 构建（`VITE_BUILD_TARGET==='web'`）→ `''`（同源，命中 serve-api 反代）；③ 否则 → `null`（非 renderer 测试环境 / 端口缺失，面板走 D7 错误态）。消费方必须用 `=== null` 判空（`''` 是合法但 falsy 的同源值，不能用真值判断）。
- **实际请求发起**：`useMailAgentAiSdkRuntime.ts` 用 `@assistant-ui/react-ai-sdk` 的 `AssistantChatTransport` + `useChatRuntime`，`api` 字段 = `` `${gatewayBaseUrl}/api/ai/chat` ``（标准 Vercel AI SDK transport 风格，非自研 `ChatApi` 抽象，详见 §5）。

### 3.3 后端层 serve-api（一份，无 harness 逻辑）

`src/api/routers/chat.py` + `src/chat/`（`db.py` ChatDb / `notion_agent.py` + `notion_agent_gate.py` Python 复刻，后者现仅供 `notion_agent_chat` skill 工具进程内直调，见 §6）：

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

## 5. 前端 runtime 组装（S3 后：assistant-ui + AI SDK transport，取代 ChatRuntime/ChatApi）

`useMailAgentAiSdkRuntime()`（`frontend/src/shared/assistant/runtime/`）用 `@assistant-ui/react-ai-sdk` 标准接线，不再有自研 `ChatApi`/`createChatRuntime` 抽象（连同 `runtime.ts`/`dispatcher.ts`/`harness.ts` 一起随 S3 删除）：

- **transport 构造**：`AssistantChatTransport({ api: \`${gatewayBaseUrl}/api/ai/chat\` })` 喂给 `useChatRuntime`，`gatewayBaseUrl` 来自 `resolveAiGatewayBaseUrl()`（见 §3.2 三分支）。
- **端口透传**（本地 electron 场景，取代旧的"main 三 load 入口注 apiPort"逻辑，现在注的是 gateway 端口）：main 在 window load 时把 `?aiGatewayPort=<port>` 拼进 URL，renderer 读 `window.location.search` 拿到后直连该 loopback 端口，不再依赖 serve-api 中转。
- **不变式**：gateway 不可达（`resolveAiGatewayBaseUrl()` 返回 `null`，或 fetch 失败）→ 面板渲染 D7 错误态 + 重试按钮，**没有 legacy 引擎可回退**（旧 `HttpApi.chat` lazy getter / 破循环设计已随 `ChatApi` 抽象一起作废）。
- **历史会话**：`custom-api` / `notion-agent` 这两种旧 `backend_kind` 的会话仍可打开，但走 `ReadOnlyTranscript.tsx` 只读渲染（见 §6），不经过这条 transport。

## 6. 历史遗留：`custom-api` / `notion-agent` 现为只读会话 kind

S3 前，`custom-api`（HTTP 直连 Anthropic/OpenAI 兼容网关）和 `notion-agent`（子进程 spawn `notion-agent-cli`）是两条并存的可选 chat 后端，按性质不对称处理（custom-api 走 HTTP 流式解析，notion-agent 走子进程 stdout 解析 + Python 复刻）。

S3 起，前端聊天面板只构造 `'ai-sdk'` transport（见 §5），`custom-api` / `notion-agent` 不再是面板可选的实时后端。`ChatBackendKind` 类型仍保留三个字面量（`chat_db.ts` 的 CHECK 约束收不窄，旧会话行还在），但只有 `ai-sdk` 可写；`custom-api` / `notion-agent` 历史会话只能经 `ReadOnlyTranscript.tsx` 只读打开（`ui_message_json` 缺失退纯文本渲染，corrupt JSON 有 fallback），composer 对这两种 kind 隐藏输入框。serve-api 的 `POST /api/chat/llm-proxy`、`/notion-agent`、`/notion-agent-once` 三个 HTTP 端点已随 S6 死端点减法批删除（2026-07，全仓 grep 确认 S3 后零消费者）；`src/chat/notion_agent.py` / `notion_agent_gate.py` 模块本体保留——`notion_agent_chat` skill 工具（`src/skills/builtin/notion_agent.py`）仍在进程内直调 `run_notion_agent`，走 `/api/skills/invoke` 而非上述已删端点。Settings 页的 Notion Agent CLI 账户/模型配置读取（`src/api/routers/settings.py` 的 `/notion-agent/{config,models,agents}`）也仍可用——这里说的「退休」特指 AI SDK Gateway 聊天面板不再把它接成实时可选后端。

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

- 🔴 ~~不变式 1：`shared/chat/` 零 Electron/Node-only 依赖~~ **S3 后由"gateway 核心 pure-ish"取代**：`shared/chat/` 已整体删除，新的对应纪律是 gateway 核心（`server.ts`/`chatRun.ts`/`config.ts`/`tools/*`）不 import `electron` / `chat_db` / `keytar`（依赖倒置，回调注入见 §3.2）。
- 🔴 **本地 chat 不再依赖 serve-api 存活**（与 cutover 前相反）：本地 electron renderer 直连内嵌 gateway（`ai_gateway_lifecycle.ts` 随 electron main 启动、同进程监听 loopback），serve-api（Python，8200）挂了不影响本地 chat。**远程 web 才依赖 serve-api**——它是访问 embedded gateway 的唯一路径（§3.2 反代）。gateway 本身用 `/health` 探测，不可达（无论本地直连还是远程反代）→ 面板渲染 D7 错误态 + 重试按钮，**不再有 legacy 可静默降级**（旧"graceful 降级读 `[]` / 写 throw `E_DISPATCH`"是 cutover 前 serve-api-依赖时代的行为，已随之作废）。
- 🟠 ~~D4 语义变化——harness-off 逃生阀消失~~ **已随 flag 整体退役而彻底作废**：`MAILAGENT_AGENT_HARNESS` 在 S3 被完全从代码里删除（非仅默认值变化，见 [`ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md) §13.18.2），连这条 flag 本身都不存在了，"设为 0 退化成单遍"这个讨论从根上不再适用。**当前排障回退面 = 装回旧版 `.app`**（无运行时开关）。
- 🟠 **flag 命名澄清 —— `MAILAGENT_REMOTE_ACCESS_ENABLED` 名不副实**：它名为「远程访问」，**实为本地 daemon / serve-api 总开关**。自 D1（前端写收编 daemon）起本地写都依赖它；`=false` 会挂本地写（非仅关远程）。**S3 后不再影响本地 chat**（chat 已不依赖 serve-api，见上）。默认起，纳入 BackendLifecycleManager 自启。
- 🟡 **ai_chat.db schema owner = 前端 `chat_db.ts`**（`CHAT_DB_VERSION`，better-sqlite3 在 main `getChatDb()` lazy migrate）。serve-api `ChatDb` 绝不建表 → main boot 须显式 `getChatDb()` bootstrap（首次 HTTP 写前 schema 在）。此项 S3 未变。
- 🟡 ~~debounce 正确性~~ **持久化模型已变**：不再有 `streamContent`（增量 debounce 直写）/`finalizeMessage`（flush 先于终态）两段式；`persistTurn` 回调仅在**回合结束时**整体落库，`onTurnStart` 额外 eager 写一次用户消息（防面板在等待响应期间刷新丢失用户输入）。细节见 `ai_gateway_lifecycle.ts` 的 `persistTurn` / `onTurnStart` 注释。

## 9. 关键文件索引

| 层 | 文件 |
|---|---|
| 引擎（gateway 核心，S3 起唯一引擎，权威见 [`ai-sdk-gateway-architecture.md`](../llm-agent/ai-sdk-gateway-architecture.md) §13） | `frontend/src/ai-gateway/{server,chatRun,config}.ts` + `tools/*.ts` + `prompts/` + `searchAgentRun.ts` |
| electron 接线（生命周期 + 持久化注入） | `frontend/src/electron/main/ai_gateway_lifecycle.ts`（启动 gateway + `persistTurn`/`onTurnStart` 回调）· `chat_db.ts`（better-sqlite3，`CHAT_DB_VERSION`）|
| 前端消费（assistant-ui 接线） | `frontend/src/shared/assistant/runtime/{useMailAgentAiSdkRuntime,AiSdkRuntimeProvider}.tsx`（`AssistantChatTransport` + `useChatRuntime`）· `flags.ts`（`resolveAiGatewayBaseUrl` 三分支）· `ReadOnlyTranscript.tsx`（legacy custom-api/notion-agent 会话只读渲染）|
| serve-api（远程反代 + 历史读 + 非引擎业务） | `src/api/routers/ai_gateway_proxy.py`（反代 `/api/ai/*` + 裸 `/health`）· `src/api/routers/chat.py` · `src/chat/{db,notion_agent,notion_agent_gate}.py` · `src/kos/client.py` |
| 鉴权 | `src/api/auth.py`（本地 token 腿 + CF JWT）· `frontend/src/electron/main/local_token.ts` |

## 10. 阶段 1（report/agent）+ 阶段 2（chat 只读）

同样的 serve-api 模式，更简单：

- **阶段 1 report/agent**：`src/api/routers/reports.py` 6 端点（in-process `ReportStore` 不 fork CLI）+ `src/reports/wire.py`（CLI + serve-api 读形状/patch 单一真源）。`HttpApi.ReportApi` 接 6 端点。本地 getConfig 改走 serve-api in-process resolve（~ms，取代 fork CLI ~759ms = agents 慢根因）。
- **阶段 2 chat 只读**：`src/chat/db.py` ChatDb 5 读端点（SQL verbatim 镜像 `chat_db.ts`，graceful 库不存在 → `[]`）。本地阶段 2 保留直读 replica，阶段 3 cutover 后统一走 serve-api（D5）。

ai_chat.db 路径 = `DATA_ROOT/frontend/ai_chat.db`（serve-api 注入 `MAILAGENT_DATA_ROOT`，对齐 `chat_db.ts` resolveChatDbPath）。serve-api 读 **app 库** `~/Library/Application Support/mailagent-frontend/data/sync_store.db`（非主仓 PM2 库）。
