# MCP Connectors（外部服务工具面 · harness 扩展 epic 阶段 1）

> 系统「现在如何」把**外部 MCP 服务**（首批 Notion / Atlassian）的工具接进 MailAgent 的 AI
> harness：连接与凭证、工具清单、五个调用方的授权、围栏与有界性、灰度开关。
> 来源 = task `08-01-mcp-connector-notion-jira-harness`（PR1-PR5）；决策真源见该 task 的
> `prd.md` 与 epic 的 `grill.md`。
>
> 对照阅读：[`skill-delivery-api.md`](./skill-delivery-api.md) 是**反向**的那一面（MailAgent 把
> 自己的能力交付给外部 agent —— 我们是 MCP **server**）；本文是我们当 MCP **client**。
> gateway 工具注册的总体架构见 [`ai-sdk-gateway-architecture.md`](./ai-sdk-gateway-architecture.md)。

`status: living` · `last-verified: 2026-08-06`（08-06 两笔 owner dogfood 拍板：③ **双轨预置
目录** —— Notion / Atlassian 回到自建 MCP 直连、其余 14 家留在 Composio 托管，见 §12；
④ **Connectors 独立配置台** —— 内置工具审批档与外部连接合并成 `/connectors` 一个页，
设置页那两个区降级成深链，见 §13。task `08-05-08-06-connector-dual-track-and-console`。
在此之前：08-05 两笔拍板 ① per-tool 三档 auto/ask/off（master-plan WP-10：默认档 auto、
write 可免卡、预处理 read 天花板拆除、im 写类跟随三档）；② Composio 预置目录 + BYOK
（WP-12，见 §11 —— 其「单轨」前提已被 ③ 证伪）。flag 仍默认 off）

---

## 1. 定位与边界

- **是什么**：connector 工具是 harness 里的**一等公民工具**——每个远端工具生成一个独立的
  AI SDK `Tool`（带远端自己的 `inputSchema`），名字 `mcp__<connector>__<slug>`，模型看得见参数。
- **MCP client 在 Python serve-api**（ADR 决策 1）：`src/connectors/` 持 `mcp` SDK 的
  `Client` + `OAuthClientProvider`，TS gateway 只生成工具信封、把调用转发给
  `POST /api/connector/{id}/tools/{name}/invoke`。延续「gateway 只带信封，Python 是执行权威」
  纪律（web / calendar / notion_agent / skill_supply 全同形）。决定性理由是**凭证**：master key
  在 Python 的 Keychain 通道，client 放 TS 就要新建一条跨进程取密钥的路（新攻击面）。
- **与 `notion_agent_chat` 正交**：那个是委派 Notion **自己的 AI** 办事（外呼、`outbound` class
  ⇒ 无 grant key、headless custom agent 结构性拿不到；per-tool 审批档**出厂默认 `ask`** +
  `danger_auto`（owner 设 auto 要过一次性红确认））；connector 是**结构化读写** Notion 的
  数据/页面。两者并存，description 互相划清边界。
  🔴 **原文「恒 HITL 且连 bypass 模式都不免卡」已于 08-05 WP-11 作废**（D1=a）：那句描述的
  `BYPASS_STILL_ASK` carve-out **已退役清空**，bypass 恢复字面「无例外」、压过一切 per-tool
  `ask` —— 开了 bypass 时 `notion_agent_chat` **会免卡执行**。它的保护从**代码地板**降级成
  **出厂默认档**（不可撤回的外呼这个理由本身没变，变的是它由什么承担）；owner 想让它永远弹卡
  的表达方式 = per-tool 设 `ask`/`deny` + 不开 bypass。判定梯子单源
  `frontend/src/ai-gateway/tools/types.ts` 的 needsApproval ③/④ 分支。
- **加一家服务 = 填一条目录数据**（`registry.CONNECTORS` 常量已于 08-05 WP-12 退役，见 §9.3）：
  直连轨填 `src/connectors/catalog.py::DIRECT_CATALOG`（`connector_id` / `server_url` /
  `display_name` + logo 元数据），托管轨填 `src/connectors/composio_catalog.py::COMPOSIO_CATALOG`
  （toolkit + curated 白名单）。双表模型天然通用，不需要改 schema。**连接行本身是一等实体**，
  解析恒「行优先 → 目录兜底」。
  当前直连两家：`notion` → `https://mcp.notion.com/mcp`，`atlassian` →
  `https://mcp.atlassian.com/v1/mcp/authv2`（08-06 双轨，§12）。
- **MVP 只做 Streamable HTTP**（两家目标服务都是）；`transport` 列留了 stdio 的位，不实现。
- **只做 tools**：MCP 的 `prompts` / `resources` 不做。

---

## 2. 数据模型

### 2.1 双表（`agent_config.db`）

DDL 单源 = `src/agent_config/store.py` 的 `_SCHEMA`。**backend-owned，不进 sync_store 的
`DB_VERSION` 体系**（`CREATE TABLE IF NOT EXISTS` 幂等 + 列缺失时 `ALTER TABLE` 补，与
`skill_secrets` / `external_credential` 同库同纪律）。路径覆盖 env = `MAILAGENT_AGENT_CONFIG_DB_PATH`。

| 表 | 装什么 | 关键列 |
|---|---|---|
| `connector` | 连接元数据（一 connector 一行） | `status` / `enabled`（整体开关）/ `preprocess_enabled`（分类侧独立授权位）/ `scopes_json` / `last_error` / `last_synced_at` |
| `connector_tool` | 远端工具清单 = **白名单**（PK `(connector_id, tool_name)`） | `crud_type` / `destructive` / `mode`（用户 per-tool 三档覆盖 `auto\|ask\|off`，NULL=跟随默认 auto —— 08-05）/ `enabled`（**退役死列**，08-05 迁移时一次性折入 `mode`：0→off、1→auto、NULL 保持）/ `orphan` / `input_schema_json` / `output_schema_json` |

行投影 = `ConnectorRow` / `ConnectorToolRow`（frozen dataclass）。schema 保持 JSON **字符串**存，
读方自解。

🔴 **refresh 纪律**（`store.sync_connector_tools`，唯一实现点）：只覆盖 manifest 派生字段
（description / 两个 schema / `crud_type` / `destructive` / `last_seen_at` / `orphan`），
**永不覆盖** `mode`（那是用户配置；旧 `enabled` 死列同理不碰）。

### 2.2 凭证（不在双表里）

token 与 DCR client_info 走 `external_credential` 表，`namespace = connector:<id>`
（形状受 `credentials._NAMESPACE_RE` 约束），槽位 `tokens` / `client_info`，
payload 是 **Fernet(JSON)**、master key 在 Keychain。适配层 =
`src/connectors/token_storage.py::CredentialTokenStorage`（实现 MCP SDK 的 `TokenStorage`
protocol 四方法，全部 `run_in_threadpool` 包住 —— 同步 sqlite 不许冻住 serve-api 的 event loop）。

🔴 **明文 `expires_at` 列的语义 = 连接活性，不是 access token 到期**：

- 有 `refresh_token` → 写 **NULL**（refresh token 的绝对寿命服务端不下发，Notion 是 180 天 /
  30 天不活跃，无法可靠预知；「NULL = 不过期/未知」正是该列的既定语义）；
- 无 `refresh_token` → access token 就是连接寿命，写它的绝对 epoch。

access token 自己的到期时间**恒进加密 payload**（`access_token_expires_at`），不占明文列 ——
否则配置台会天天「即将过期」谎报健康度。配置台（§13）与 `_credential_view` 只读明文列 + metadata
（`scope`），**不解密**，master key 不可用时这些查询照样成立。

---

## 3. OAuth 2.1 / PKCE / DCR

装配三层（`src/connectors/client.py::ConnectorClient.session`）：

```
OAuthClientProvider（httpx2.Auth 子类；PKCE + DCR + 刷新全内建）
  → httpx2.AsyncClient(auth=provider, follow_redirects=True, timeout=…)   ← 🔴 超时唯一落点
    → streamable_http_client(url, http_client=…)                          ← 无 auth= 参数
      → Client(transport)
```

- **DCR client_info 必须持久化**（`get_client_info` / `set_client_info`），否则每次连接都重新
  注册一个新 client。`redirect_uris` 是 `list[AnyUrl]` → 落库统一 `model_dump(mode="json")`。
- **redirect_uri = 固定端口 loopback**：`registry.resolve_redirect_uri()` →
  `http://127.0.0.1:{MAILAGENT_API_PORT|8200}/api/connector/oauth/callback`。
  public client（`token_endpoint_auth_method="none"`），靠 PKCE 保护，不请求 client_secret。
- **回调端点无鉴权**（`GET /api/connector/oauth/callback`）：浏览器 302 顶层跳转带不了自定义
  header，挂 CF 门必 401。鉴权 = **`state` 即能力令牌**（SDK `token_urlsafe(32)` 生成，我们从
  授权 URL 里抽出来登记，不自造第二个随机源）：不可猜 + **单次消费** + 600s TTL；
  未知 / 过期 / 已消费一律 **404 不泄因**。交汇表 = `oauth_flow.OAuthRendezvous`（in-process，
  serve-api 单进程）。SDK 侧还有第二道 `compare_digest` 复核。
- **等浏览器回调上限 300s**（`OAUTH_CALLBACK_TIMEOUT_SECONDS`，与请求超时不同量级，独立常量）。
  `POST /oauth/start` 只等「授权 URL 就绪」30s（metadata 发现 + DCR 在这窗口里）。
- 🔴 **anyio cancel scope 单 task 纪律**：`httpx2 client → transport → Client` 的整条
  `async with` 链必须活在**同一个 asyncio task** 里。所以整条授权流是一个后台协程
  （`client.run_connect_flow`，router `_schedule_bg` 形状），callback 端点只做「code 塞
  rendezvous 唤醒」，**绝不跨 task 收尾传输层**。重复 `oauth/start` = cancel 旧 task + 作废旧 state。
- **跨重启懒刷新**（`ConnectorClient._prime`）：SDK 的 `_initialize` 从 storage 读回 token 后
  **不设** `token_expiry_time` → 重启后过期的 access token 会被当有效直接送出 → 401 → 掉进
  交互式全流程重授权。修法 = 会话开始前用 storage 里的绝对 epoch 预置
  `provider.context.token_expiry_time`（提前量 `TOKEN_REFRESH_EARLY_SECONDS=60s`）。
  只碰 `OAuthContext` 的公开 dataclass 字段，有 canary 单测钉 SDK 内部形状漂移。
  **不建后台刷新 worker**（PRD 懒刷新决策）。
- 🔴 **ExceptionGroup 拆包**（`client._sole_leaf`，PR5 新增，**看着多余但绝不能删**）：
  会话内部是 anyio `TaskGroup`（streamable_http），它把**单个**异常也裹成 `ExceptionGroup`
  → `except ConnectorError / httpx / MCPError` 一条都匹配不上，异常以 ExceptionGroup 形态
  原样逃出去。后果不是「日志难看」：invoke / sync 侧靠 `except ConnectorError` + code 判定落
  `needs_reauth`，裹一层就**永不触发** —— 而刷新失败（授权被撤销）这条最主要的失效路径正好在
  TaskGroup 里。故先拆包：只裹一个异常时拆到叶子重抛；真·多子异常（并发多错）拆不动，原样
  抛出不猜（挑哪个当代表都是猜）。

### 错误码表（`ConnectorError.code`，`client.py` 单源）

| code | 含义 | router 映射 |
|---|---|---|
| `E_CONNECTOR_UNKNOWN` | 未知 connector id（不在 registry） | 404 |
| `E_CONNECTOR_NOT_CONNECTED` | 无可用授权且当前会话不允许交互 | 409 |
| `E_CONNECTOR_BUSY` | namespace 闸被占（多半是授权流挂着等浏览器） | 409 |
| `E_CONNECTOR_TIMEOUT` | 请求 / 回调等待超时（message 带**实际耗时 + 生效上限**，issue #69 纪律） | 504 |
| `E_CONNECTOR_OAUTH` | OAuth 流失败（注册被拒 / 刷新失败 / 用户拒绝） | 502 |
| `E_CONNECTOR_NETWORK` | httpx2 传输层错误 | 502 |
| `E_CONNECTOR_PROTOCOL` | MCP 协议层错误 | 502 |

---

## 4. 状态机

值域单源 = `store.CONNECTOR_STATUSES`：
`disconnected` / `authorizing` / `connected` / `needs_reauth` / `error`。
写侧校验，**无 SQL CHECK**（加值不需要迁移）。

| 迁移 | 触发点 |
|---|---|
| → `authorizing` | `run_connect_flow` 起流后立刻写 |
| → `connected` | 工具清单同步成功（同时写 `scopes` / `last_synced_at` / 清 `last_error`） |
| → `needs_reauth` | invoke 或 sync 撞上**授权失效**两码之一 |
| → `error` | 授权流本身炸掉（`run_connect_flow` 的兜底） |
| → `disconnected` | `POST /{id}/disconnect` |

🔴 **`needs_reauth` 与 `error` 的二分**（PR5）：只有 `CONNECTOR_REAUTH_ERROR_CODES` =
`("E_CONNECTOR_OAUTH", "E_CONNECTOR_NOT_CONNECTED")` 落 `needs_reauth` —— 这是**可行动**的一类
（owner 去设置里重连就好）。**timeout / network / protocol 有意不落态**：把「远端抖了一下」
说成「授权没了」会把 owner 支去做一次无用的重新授权。

码表与对外文案（`CONNECTOR_REAUTH_MESSAGE`）单源在 `src/connectors/service.py`，
**两个落态点**（`service.invoke_connector_tool` 与 `routers/connector.py` 的 sync 端点）
共用同一份，绝不各抄一遍。文案面向**人与模型**，不是面向 curl —— client 层的原文里有
「run POST /api/connector/{id}/oauth/start」这类只有开发者能执行的指令，摆进配置台的
`lastError` 与模型看到的工具错误里 = 看得懂但做不了；技术细节留在异常链（`from e`）与日志里。

UI 上 `needs_reauth` 与 `error` 同吃危险色档（对用户是同一级别的「现在用不了」），
区别在**主操作**：「重新连接」vs「重试」。「重新连接」走的就是**同一个** OAuth 流，没有第二套。

---

## 5. 工具生命周期

### 5.1 命名

`mcp__<connector>__<slug>`，前缀是 `classOfTool` / 审批卡 fallback 识别 connector 工具的依据。
规范化规则：`[A-Za-z0-9_]` 之外一律 `_`（Notion 的 `notion-update-page` → `notion_update_page`）。

**两条腿两个上限**（有意不同，方向都是保守的）：

| 腿 | 单源 | 上限 | 理由 |
|---|---|---|---|
| TS gateway | `frontend/src/shared/assistant/tools/mcpToolName.ts`（`mcpGatewayToolName`） | 128 | 只走 AI SDK 的 Anthropic 腿 |
| Python LLM loop | `src/connectors/llm_tools.py`（`llm_tool_name`） | 64 | `run_tool_loop` 有 Anthropic + OpenAI 两条协议腿，OpenAI 侧限 64，取交集 |

不可表示（空段 / 超上限 / 与静态 gateway 工具重名 / 与另一个动态工具重名）→ **跳过 + warning**，
不铸一个坏名字。TS 侧 `mcpToolName.ts` 是**零依赖纯 TS**，gateway 核心与 renderer bundle 共用
（`McpApprovalCard` 反解名字去对 manifest 行），映射永不分叉成两份手抄。

### 5.2 crud 映射（`client.derive_crud_type`）

MCP annotations 的三个 hint 都是三态 `bool | None`（None = 服务器未声明）：

| 判据 | → crud_type |
|---|---|
| `read_only_hint is True` | `read` |
| `idempotent_hint is True` | `update` |
| 其余（含 destructive、完全未注解） | `write` |

🔴 **裁决①（spike 2026-08-03 实测证伪原映射）：`destructive_hint=True` 不映射 `delete`。**
MCP spec 里 `destructiveHint` 的语义是「可能执行破坏性**更新**」（覆盖式写入的超集，不专指删除），
annotations 根本**没有 delete 语义位**。Notion 把最核心的 `notion-update-page` 标了 destructive，
按旧映射会被推成 delete → 结构性不可用，而 Notion 清单里根本没有真删除工具。
destructive 语义位改**单独落列**（`derive_destructive` → `connector_tool.destructive`），
供审批卡显示红色「破坏性操作」警告 —— 位不丢，只是不当档位。

### 5.3 delete 分类已退役（2026-08-03 owner dogfood 改判）

原设计（grill Q3=B + Q16=A）是「delete 类照常入库 + 界面恒灰 + AI 永远拿不到」，由七道结构性
保证撑着。**08-03 owner 拍板推翻**：「不要区分删除，连接工具应该都全部可配置」。

改判的两条实证依据：

1. **结构上不可达** —— MCP annotations 没有 delete 语义位（§5.2 裁决①），裁决①之后
   `derive_crud_type` 只产 `read` / `update` / `write`，**任何 manifest 都推不出 delete**。
   保留一个永不产生的档位，换来的只是「有一档永远恒灰」这个假象。
2. **仅有的 delete 行是 bug 遗留** —— dogfood 现场 live DB 里只有 2 条 `crud_type='delete'`，
   全是 PR1 旧构建按**旧映射**落的陈旧分类（指纹：`destructive=0`），手动 re-sync 一次即被
   治愈成 `write` + `destructive=1`。它们从来不是「真的删除工具」。

⇒ delete **整体退役**（不是「放开」，是删掉一个不可达的死特例）：`CONNECTOR_CRUD_TYPES`
值域收敛为 `('read','write','update')`，`store` 的恒 False 分支 / 写侧 ValueError、
`service` 的闸 3（403 `E_CONNECTOR_TOOL_FORBIDDEN`）、两侧注册期的 `crud === 'delete'`
skip 全部移除；`E_CONNECTOR_TOOL_FORBIDDEN` 错误码随之退役（Python 侧已无生产者）。

**危险性提示由 `connector_tool.destructive` 独立列承担**（审批卡红色「破坏性操作」警告）。
（08-03 时点的「安全地板不变：write/update 默认关、manual 恒弹卡」表述已被 **08-05 三档改判**
取代——见 §5.5/§6.1：默认档 auto、审批性按 per-tool 档；仍然不变的是 headless 的
per-connector grant 天花板与 grant 值域 `read < write < update`（值域外含遗留的
`"delete"` 字面量一律**入库即拒**、`ceiling_allows` 双向 fail-closed）。）

**存量陈旧行的装机自愈** → §5.3.1。

#### 5.3.1 存量 `crud_type='delete'` 行的离线重推导（幂等数据迁移）

`AgentConfigStore._migrate_additive`（backend-owned db，开库即对齐，不进 `DB_VERSION`）多一条：

```sql
UPDATE connector_tool SET crud_type='write', destructive=1, updated_at=? WHERE crud_type='delete'
```

🔴 **可证明等价，不需要网络 re-sync**：旧映射产出 delete 的**唯一**路径是
`destructive_hint is True`，而当前 `derive_crud_type` 对同一输入产出 `write`、
`derive_destructive` 产出 `True` ⇒ 这条 UPDATE 就是把那次误判按新规则重算一遍，与 owner
点一次 sync 的结果逐字段相同。幂等（跑完 `WHERE` 后不再有 delete 行）；用户的 `enabled`
覆盖**一列不碰**（refresh 纪律 2）。owner 本机已手动 sync 治愈，这条保护的是任何旧库 /
回退再升级的路径。测试：`tests/agent_config/test_connector_store.py::
test_stale_delete_rows_migrated_to_write_destructive`（含幂等 + 迁移后可配置可注册的正例）。

### 5.4 orphan（远端工具消失）

`sync_connector_tools` 发现某行不在本轮 manifest 里 → **置 `orphan=1` 保留行**（含用户的
`enabled` 覆盖），不删。生命周期：

```
标记 orphan → 注册期跳过（TS + Python 两侧）→ invoke 撞 409 E_CONNECTOR_TOOL_ORPHAN
  → 配置台显示「已失效」pill 且不可改 → 远端又出现 → 下次 sync 复活且配置还在
  → 攒多了 owner 点「清理已失效工具」→ POST /{id}/tools/purge_orphans
```

🔴 **自动回收永远不做**（服务器抖一下就把用户配置抹掉是病根）；purge 是 owner 的**显式**出口，
只删 `orphan=1`，在册工具与其覆盖一行不碰。删空不是错（`{"purged": 0}`），前端不必先探。

### 5.5 per-tool 三档（08-05 owner 拍板，取代旧「三态启用」）

> 🔴 **08-05 改判留案**（master-plan-0805 WP-10；决策底稿 = 该 task research
> `gap-connector-module-vs-reference.md` §4）：旧模型是「`enabled` 三态**启用性**（read 默认开 /
> write·update 默认关）+ 审批性由 crud class 结构性锁死（write 恒 HITL）不可配」。owner 对照
> 参考产品拍板换成 **per-tool 三档授权**——审批性从此是 owner 的 per-tool 配置，不再由 crud
> 结构性决定。旧折算函数 `connector_tool_effective_enabled` 与 `…/enabled` 端点随之退役。

`mode` ∈ `auto` / `ask` / `off`，`null` = 跟随默认档（值域单源
`store.CONNECTOR_TOOL_MODES`，TS 两处镜像由 `test_connector_contract_parity.py` 锁）：

| 档 | 语义 |
|---|---|
| `auto` | 注册；owner-present 场地（manual / im）**免卡执行**（read 的 auto = 旧 silent 行为；write 的 auto = 08-05 新增的免卡通道，审计 `auto_tool_mode`） |
| `ask` | 注册；owner-present 场地每次调用弹审批卡（manual 桌面卡 / im 飞书按钮卡）。**read 也可设 ask**（owner 显式降档的读工具照样弹卡）。无审批宿主的预处理场地 ask ≙ **不注册**（§6.3） |
| `off` | 任何场地不注册（吸收旧 `enabled=false`） |

🔴 **默认（NULL）折算 = `auto`，含 write/update/destructive**（跟随参考产品；owner 知情拍板，
「工具面变宽」已进升级概览提示与发版说明——存量未配置的 write 行为从「不注册」翻成「注册且
免卡」）。值域外野值 fail-closed 折算 `off`。headless（custom agent / 报告）**不看档位的
auto/ask 之分**（grant 是授权本体、免卡是既有语义），`off` 仍全局生效。

🔴 折算规则**不在前端重算**——`GET /{id}/tools` 与 `POST .../mode` 都直接返回
`effective_mode`，前端照显示。否则那套规则就成了第二处手抄。
写 API 里 `mode` 键**必须在场**（缺键 → 400），不把「没说」当成 null 猜。
组级批量 = `POST /{id}/tools/bulk_mode`（可按 `crud_type` 收窄；`mode=null` = Reset
permissions 批量清覆盖；orphan 行跳过）。destructive 工具在设置面设 auto 的那一下弹
**一次性红色确认**（不阻止、只加摩擦；ask 档的审批卡红警告链原样保留）。

### 5.6 gateway 注入链与 manifest 缓存（0804 dogfood 修复）

`buildTools` 是**同步**的，所以 gateway 侧的工具面永远建自一份 TTL 缓存
（`createConnectorManifestCache`，单源 `frontend/src/ai-gateway/tools/connector.ts`；
`ai_gateway_lifecycle.ts` 只负责注入 `fetchConnectorManifest` 与落日志）。三条纪律：

| 环节 | 语义 |
|---|---|
| 启动预热 | gateway 起来时 fire-and-forget 拉一次，**失败按 1s/3s/6s/10s/20s 退避重试 5 次**（累计 ~40s，有界，不是重试风暴；`CONNECTOR_MANIFEST_PREWARM_RETRIES_MS`）。0805 dogfood：serve-api 冷启实测 4-34s（不是当初以为的 ~1.2s），故把窗口拉到覆盖整段观测范围；重试次数变多但**日志噪音没有跟着变多**——只有首次尝试与最终放弃各打一条，中间重试的 `connector_manifest_warn` 用 `quiet` 静默（fetch 本身照常跑，只是不落盘） |
| 缓存新鲜期 | 成功 **30s**；失败（`value=null`）只 **3s**（`CONNECTOR_MANIFEST_FAILURE_TTL_MS`）—— 失败是关于 serve-api 的瞬时判断，不是关于 manifest 的 |
| run 前预热 | `prepareChatRun` 在 `buildTools` **之前** `await cfg.ensureConnectorManifest()`（owner-present venue：`shouldLoadConnectorTools` 接纳的 `manual_chat` / `im_chat`）；一次性 headless run 由 `agentRun.ts` 按 grant 预热（§6.2）。缓存热时立即返回，单飞 + 契约不抛；⚠️ **3s 是每个 HTTP 请求的上限不是总预算**（list 1 次 + 每个已连接 connector 的 tools 各 1 次，串行），serve-api「接了连接但不回」时该轮首字延迟按 connector 数叠加——现场 2 家 ⇒ 最坏 ~9s。真出现再加总预算 race（不改这里的语义，只封顶等待） |

⚠️ **档位降级的有界 TOCTOU（08-05 三档复核留案）**：owner 把某写工具从 auto 降为 ask 后，manifest TTL（30s）窗口内 + 在途 turn 里按旧 auto 档注册的工具仍会免卡执行——`off` 有服务端闸 5 兜底，`ask` 没有（服务端对 owner-present 场地不判审批，by design）。窗口有界、与旧 enabled 缓存语义同源，接受不修。

🔴 **为什么 run 前必须 await**（0804 owner 反馈「connector 不可用」的真根因）：预热失败把 `null`
写进缓存并**占满 30s**，而 manual/im 的注册点只 `void refresh()` 后**同步**读缓存 —— 重启后第一轮
对话于是零 `mcp__*` 工具、prompt 里零 connector 告知、`discover_skills` 也看不到
`external_connectors`，模型如实回答「不可用」，第二轮才正常。await 一次同时消掉另一个漂移：
`buildTools`（同步）与 `systemPromptProvider`（稍后 await）读缓存的时刻不同，可能出现
「prompt 宣告了 connector、ToolSet 里却没有」。

**可观测**（`~/Library/Logs/MailAgent/ai-gateway.log`，`gatewayLogLine`）：
`connector_manifest_refresh`（每次真拉，`ok` + 条目数 —— **不受 `quiet` 影响，恒落盘**，所以「拉了且失败」
永远有痕）· `connector_manifest_warn`（降级警告的**详情**（message/error）；0805 起预热的**中间重试**用
`quiet` 不落这条，只有第一发与最终放弃留痕 —— 拉长退避后防同一句话刷屏。⚠️ 单飞副作用：run 前 await 若
正好并到一发 quiet 的在途预热上，该轮也不落这条详情；此时同一根因的详情已由第一发（loud）记过，且
`connector_manifest_refresh ok:false` 与 `connector_tools_skipped` 照常留痕）·
`connector_manifest_prewarm_gave_up`（预热重试用尽，新排程下 `attempts:6`）· `connector_tools_registered`（注册成功）·
`connector_tools_skipped`（🔴 被接纳却什么都没注册，`reason` 分
`manifest_unavailable`（缓存为 null）/ `manifest_empty`（拉到了但零条），此前是完全静默的失败）。

---

## 6. 授权矩阵（五个调用方）

| 调用方 | context_mode | 授权来源 | 审批（08-05 起 = per-tool 三档，§5.5） |
|---|---|---|---|
| manual chat | `manual_chat` | 无天花板（owner 本人在环） | 按档：`auto` 免卡（审计 `auto_tool_mode`）/ `ask` 弹卡 / `off` 不注册 —— read/write 同一套档位语义 |
| custom agent（headless） | `untrusted_trigger` / `cron_headless` | `report_agent.tool_policy_json` 的 `grant_connectors` | grant 内**免卡**执行（审计 `auto_whitelist`），grant 外**根本不注册**；per-tool `off` 仍全局生效，ask/auto 对 headless 无意义 |
| 报告 Agent | 同上（该 agent 行的 grant） | 同上（`summarizer.generate_report_agentic(connector_grants=…)`） | 同上 |
| 邮件预处理分类 | 不走 gateway（Python LLM loop） | **独立** `connector.preprocess_enabled` 列 | 08-05 场地放开：**仅 `mode='auto'` 的工具注册（含写类）**，`ask` ≙ 不注册（无审批宿主），无 crud 天花板（§6.3） |
| im chat（飞书） | `im_chat` | 无天花板（owner 本人隔着 IM 在环） | 与 manual 同档：`auto` 免卡 / `ask` 弹卡（卡经飞书按钮投递）/ `off` 不注册 |
| 任何未来新场地 | 新 mode | — | **恒拒**（fail-closed，见 §6.4 的双白名单） |

### 6.1 manual chat / im chat（grill Q5=A 原案；🔴 08-05 owner 拍板改判为 per-tool 三档）

> **改判留案**（学 §5.3 delete 退役的写法）：grill Q5=A 的原论述「读免批、写**恒** HITL——
> connector 写是外部服务上可能不可逆的动作，恒弹卡是安全地板」在 08-01~08-04 一直成立。
> **08-05 owner 对照参考产品拍板推翻「恒」字**：写类的审批性改由 per-tool `mode` 决定
> （auto 免卡 / ask 弹卡），destructive 也可设 auto（设置面一次性红色确认承担摩擦）。
> 原文保留于此，防未来被当成无意漂移；风险留痕见 master-plan-0805 §5 风险 1/6。

- read 类 → 现有 `read` class；默认档 auto = silent（旧行为逐字节）。owner 显式设 `ask` 的
  read 在 owner-present 场地经 audited 写包装注册（弹卡；runtime class 仍是 `read`，矩阵行不动）；
- write / update 类 → tool class `connector_write`（`GATEWAY_TOOL_CLASS_VALUES` /
  `isToolClassAllowedInMode` / `tool_catalog.json` 镜像不变）。edit tier，无 `editableFields`
  （identity pinned，只能批/拒）。**08-05 起审批形态按档**：`ask` = 弹卡（旧恒 HITL 行为）；
  `auto` = 走 `policyEvaluate` auto_allow 缝免卡执行（镜像 headless grantVerdict 的形状，
  needsApproval/guard 内核未动），审计 `approvalStatus='auto_tool_mode'`（与 headless 的
  `auto_whitelist` 可辨——`whitelistRuleId` 同为 null，来源字段不同值）。
  🔴 **不复用 `artifact` 本身** —— `test_report_write_is_the_only_artifact_class_tool`
  那道「只此一个」的闸原样不动。
- 审批卡 = `frontend/src/shared/assistant/tools/generic/McpApprovalCard.tsx`。动态工具名不可能进
  ComponentRegistry 的静态 by_name 表，所以走 registry 的 `tools.Fallback` 槽：`mcp__*` part 的
  审批相位（pending / rejected / expired）渲染这张卡（真按钮，不是无按钮的 `ToolTraceCard` 转圈），
  其余相位与非 connector 工具原样落回 `ToolTraceCard`。
  🔴 destructive 红警告**从 serve-api 实时拉**（`GET /{id}/tools` + 共享的 `mcpToolName` 映射），
  **不从模型 args 投影**（CalendarApprovalCard 先例：模型不能把警告哄没）。拉失败 → 降级成不显示
  警告行，批准面本身不阻塞在这次查询上。
- 🔴 **`im_chat` 与 manual 同档**（阶段 2 PR-1，08-04 拍板「connector 对 im_chat 全开放」；
  **08-05 场地二放开**：写类跟随 per-tool 三档）：`ask` 档走既有**飞书按钮**审批卡链
  （[`im-feishu-chat.md`](./im-feishu-chat.md) §2.5 闭环 + §3 矩阵，destructive 红警告随卡），
  `auto` 档免卡执行（审计 `auto_tool_mode`，`context_mode='im_chat'` 事后可辨）。auto 判据 =
  `OWNER_PRESENT` 两模式（与 §6.4 服务端白名单同源），无 manual-only 分支。风险留痕
  （被盗飞书账号可无卡驱动 auto 档外部写）见 master-plan-0805 §5 风险 4②；残余护栏 = 绑定码
  配对 + per-tool 档位 + exec/capability_change/outbound 在 im 场地仍不注册（结构性地板不动）。
  服务端不叠天花板（`OWNER_PRESENT_CONTEXT_MODES`，§6.4）。工具面判定同源 `shouldLoadConnectorTools`。

### 6.2 headless custom agent（grill Q2）

`tool_policy_json` v1 的第 5 个 grant 键：

```json
{"v": 1, "grant_connectors": {"notion": "read", "atlassian": "update"}}
```

- **有效值域 `read < write < update`**，`delete` 入库即拒；解析结果规范化成按 connector_id
  排序的不可变 pair 元组（`ToolPolicy.grant_connectors`）。
- **whole-map replace 语义**：对话式 CRUD 工具里，**省略** `grant_connectors` = 保持服务端现值
  （agents.ts 的 read-merge-write），显式传 `{}` = 清空全部授权。两者不同。
- **grant 内免卡、grant 外不注册**（镜像 `grant_web` 的 `open` 档）：headless 无人在场，
  「注册但审批」会让每次定时任务挂 `paused_handoff`。免卡的实现是 grant 级
  `auto_allow` verdict，审计记 `auto_whitelist` + `rule_id=null`（与规则来源的非 null id 可区分）。
- **注册期过滤在 TS**（`createConnectorTools`）：connector 不在 grants 里 → 整族跳过；
  工具 crud rank > 该 connector 的天花板 → 跳过。这个 per-connector/per-tool 精度正是粗粒度的
  `connector_write` 矩阵行所依赖的。
- 无 connector grants 的 run **零 connector 请求**（`shouldLoadConnectorTools` 这道接缝先判，
  不是「拉了再拒」）；一次性 headless run 另有**有界预热**（`ensureConnectorManifest`，
  单飞 + 3s 上限），否则冷 TTL 缓存会让 cron run 静默漏掉自己被授权的工具。

第七张「外部服务」能力卡（`CapabilityCards.tsx`）：每个已连接 connector 一行，档位
**关 / 只读 / 可写**，粒度是 **connector 级而非单工具级**（正好绕开「动态工具名 vs 静态集合」
的矛盾）。UI 三档是**展示折叠**而非存储值域：

- **display 向上取整**：`'write'` 与 `'update'`（以及任何防御性未知值）都显示「可写」——
  绝不把已授的写权限显示成更低档（`deriveToolTier` 的同一条教训）；
- **写入 canonical**：点「可写」恒写 `'update'` 天花板；
- 🔴 **同档 no-op 闸**（`setConnectorTier`）：目标档 == 当前显示档就不写 state ——
  否则一个存量的 `'write'` 会被点一下就**无声升成** `'update'`。整份 grant map 必须无损往返。

卡内行集 = 已连接的 connector ∪ **已配 grant 但已断开/registry 已消失**的 id（后者标「未连接」
仍可见可改，免得一个看不见的 grant 悄悄留着）。

### 6.3 邮件预处理分类（坑 3 原案；🔴 08-05 场地放开改判：read 硬天花板拆除）

> **改判留案**（08-05 owner 知情拍板，master-plan-0805 §5 风险 4①）：这条路径同时齐备
> lethal trifecta 三件套——untrusted 输入（任何人都能发邮件）+ 私有数据访问（token 能读整个
> 工作区）+ 外部写能力，且**全自动、无人值守、逐封跑、没有审批链宿主**。08-01 的结构性收紧
> （`PREPROCESS_CONNECTOR_CEILING = "read"` 常量 + 工厂只造 read 工具）正是为此而设。
> **08-05 owner 在被明确告知「任意寄件人的邮件正文可在无人值守路径上驱动外部写」后仍拍板
> 放开**——该路径不再有 lethal trifecta 的结构性缓解，残余控制面见下。原设计理由存档于此，
> 防未来被当成无意漂移。

- 🔴 **独立 grant 键不变**：`connector.preprocess_enabled` 列（`POST /{id}/preprocess`），
  **不复用** custom agent 的 `grant_connectors`，**默认关不变** —— 拆的只是「开了之后只能 read」。
- 🔴 **per-tool 三档在该场地坍缩为两态**（无人可点头 ⇒「需审批」的忠实实现只有不给工具）：
  `auto` → 注册且直接执行（该场地唯一执行形态，**含 write/update**）；`ask` → **不注册**
  （不是「注册但拒执行」——模型会反复调一个恒失败的工具烧迭代；也不是降级 auto——那会把
  owner 的「要问我」静默升成「不问」）；`off` → 不注册。工厂判据 = `preprocess_enabled` ∧
  `status='connected'` ∧ connector `enabled` ∧ per-tool 折算 `auto`
  （`build_connector_llm_tools(grants, only_auto_tools=True)`，grants 的 ceiling=None）。
- **服务端第二道**：handler 闭包带 `deny_ask_mode=True` 调 `invoke_connector_tool` ——
  工具集 stale（工厂建完后 owner 改档）时 `ask`/`off` 都在闸 5 被拒。
- **残余控制面**：`preprocess_enabled` 默认关 · per-tool `off`/`ask` · destructive 标注 ·
  `_PREPROCESS_TOOL_MAX_ITER` 小值。
- 分类是**同步热路径**：走多轮 loop 但 `max_iter` 取小值（`_PREPROCESS_TOOL_MAX_ITER`），
  `classify_email` 仍是终止工具；工具失败/超时由 handler 回灌 `"error: …"` 字符串（不抛），
  **失败即跳过，不阻断分类本身**（write 失败同样只是分类少一个动作）。任何异常都吞成空
  工具集——connector 是增强面。

### 6.4 服务端第二道闸（授权判定与执行同侧）

gateway 注册期过滤是第一道，但那道在 TS 侧、由调用方自证。invoke 端点收 `caller` 信封
（wire 是 snake_case：`{"context_mode": …, "agent_id": …}`），由
`service.resolve_caller_ceiling` 重新判一次：

- `caller` 缺席 → `None`（无天花板；owner 直调 curl / 尚未升级的 gateway，PR2 行为逐字节保留）；
- **owner-present 两模式**（`OWNER_PRESENT_CONTEXT_MODES` = `manual_chat` / `im_chat`）→ `None`：
  owner 本人在环，审批链在 gateway 侧（`im_chat` 自阶段 2 PR-1 / 08-04 拍板起与 manual 同档；
  08-05 起写类审批形态按 per-tool 三档——`ask` 弹卡（manual 桌面卡 / im 经飞书按钮投递）、
  `auto` 免卡执行，§6.1）；
- headless 两模式（`HEADLESS_CONTEXT_MODES`）→ 按 `agent_id` 读该 agent 的 `grant_connectors`；
  无 agent_id / 无行 / 该 connector 不在 grants 里 → **拒**；
- 🔴 **两张显式白名单**：两者互斥、并起来 == `CALLER_CONTEXT_MODES`（parity 闸锁着），落在两张
  白名单之外的 mode（当前值域下不可达，**将来任何新增的**场地都会落这里）一律拒——写成「排除
  owner-present 后就当 headless」会让某天跟着 TS `AGENT_CONTEXT_MODES` 新增的第五种 mode 悄悄
  落进 headless 分支拿到 grant 语义，而新场地该不该有 connector 是一次独立决策，不是继承来的；
- 形状不对 / 未知 context_mode → 400（调用方 bug 早暴露，不静默降级成「无约束」）。

### 6.5 闸序（单源 `src/connectors/service.py::invoke_connector_tool`）

伪造 / 未同步 / orphan / 关档 / 越天花板的名字**到不了远端**：

| # | 判据 | 结果 |
|---|---|---|
| 1 | 未知 connector id（不在 registry） | 404 `E_NOT_FOUND` |
| 2 | 工具不在已同步清单里（伪造 / 未同步） | 404 `E_NOT_FOUND` |
| 3 | `orphan` | 409 `E_CONNECTOR_TOOL_ORPHAN` |
| 4 | 越 crud 天花板 | 403 `E_CONNECTOR_GRANT_DENIED` |
| 5 | `mode` 折算为 `off`（08-05 三档）；`deny_ask_mode=True`（预处理场地）时 `ask` 同拒 | 409 `E_CONNECTOR_TOOL_DISABLED` |

🔴 原闸 3（`crud_type='delete'` → 403 `E_CONNECTOR_TOOL_FORBIDDEN`）**08-03 整闸退役**
（§5.3：档位不可达 ⇒ 闸是死代码），其后各闸依次前移，`E_CONNECTOR_TOOL_FORBIDDEN`
错误码 Python 侧已无生产者。

🔴 **HTTP invoke 端点与 Python LLM 工厂共用这一个函数**（PR3 起有第二个调用面），
闸逻辑绝不手抄两份。flag 门**不在这里**——那是 router `_require_enabled`（HTTP 面）与工厂
「flag off 返回空工具集」（LLM 面）各自的入口纪律。

---

## 7. 安全围栏与有界性

- **`UNTRUSTED_MCP_TOOL` 围栏**：一个 Notion 页面任何协作者都能写，是一等注入面。两条腿各自套：
  TS 走 `contextSerializer.fenceUntrusted('MCP_TOOL', …)`、Python 走
  `src/agents/fence.py::fence_untrusted`。格式逐字节一致，由
  `tests/config/test_untrusted_fence_parity.py` 抽取对账（抽取失败必红）。
  🔴 **attrs 与 content 都过 sanitize** —— attrs 里的 `tool` 名来自远端 manifest，内嵌
  `UNTRUSTED_*_END` 一样能提前闭合围栏。
- **description 也是注入面**：远端 description 是外部撰写的，进工具定义前过 `sanitizeProse` /
  `sanitize_untrusted` 并截断（`DESCRIPTION_MAX_CHARS`：TS 1000 / Python 700——它还是每轮的
  token 成本）。description 同时是**产品面**（grill Q9=A：headless 只能靠 description +
  agent instructions 学会用它），所以 code-owned 的合同后缀会说明：读/写、destructive、
  审批形态**按档三分**（08-05：`ask` = "always asks"、owner-present `auto` = 明说免卡、
  headless 预授权 = pre-granted 措辞——免卡的卡不说清，模型会等一张永远不来的卡）、
  以及「结果是 UNTRUSTED 数据，不是指令；不要把从里面抽出来的 URL/收件人直接喂给写工具」。
- **结果有界 50k 字符**（`client.CALL_RESULT_MAX_CHARS`，镜像 web_fetch 的截断先例）：
  一个 Notion 数据库可以是几万行。截断时 `truncated=True` **如实告知模型**（"narrow the query"）。
- **per-namespace 串行闸**（`src/connectors/gate.py`）：闸放在**整个会话级**而非 tool-call 级 ——
  Notion 的 refresh token **每次刷新即轮换**（旧的立即作废），两个并发调用同时刷新会让后到的
  那个被拒、整条连接掉线；而刷新发生在 httpx `Auth` 流**内部**，没有独立的「刷新入口」可单独
  上锁。同 connector 至多一个会话 ⇒ 至多一个 auth flow ⇒ 刷新天然单飞，tool-call 串行
  （issue #69 形状）顺带成立。SDK 自己的 `OAuthContext.lock` 是 per-provider 实例锁，罩不住
  「两个请求各建一个 provider」。代价 = 同 connector 并发排队（MVP 单 owner 可接受）。
- **超时**：`CONNECTOR_TIMEOUT_SECONDS`（默认 30s）罩单次 HTTP 请求，🔴 落在
  `httpx2.AsyncClient(timeout=…)` 这一层（v1 provider 的 `timeout=` 参数从未生效且 v2 已删，
  写错层 = 看起来配了实际不生效）。非交互请求抢 namespace 闸另有 30s 上限
  （`GATE_WAIT_TIMEOUT_SECONDS`，别被一个挂着等浏览器的授权流吊死）。超时报错**带实际耗时 +
  生效上限来自哪**（issue #69 纪律）。
- **错误回灌是可行动的**：`CONNECTOR_ERROR_HINTS`（TS）对三个 owner-action 码
  （`E_CONNECTOR_NOT_CONNECTED` / `E_CONNECTOR_OAUTH` / `E_CONNECTOR_DISABLED`）追加
  「重试没用，去设置里连接」——否则模型会读到「not connected」然后反复重调烧步数。
- **`list_tools` 分页有上限**（`_LIST_TOOLS_MAX_PAGES=20`，防远端游标永动）。

### 跨语言一致性闸

| 闸 | 锁什么 |
|---|---|
| `tests/config/test_connector_contract_parity.py` | crud 天花板词表 + 序（**七处副本**，🔴 任一侧多出 `delete` = 安全地板破口）· caller `context_mode` 值域（`service.CALLER_CONTEXT_MODES` ↔ `policy.ts::AGENT_CONTEXT_MODES`）· **per-tool 三档词表**（08-05：`store.CONNECTOR_TOOL_MODES` canonical ↔ TS 两处 `ConnectorToolMode` 类型联合 + gateway admission 判据锚点）· **目录 track 词表**（08-06 ③c：`catalog.CONNECTOR_TRACKS` canonical ↔ `types/connector.ts::ConnectorTrack`）+ **Python 内的 track↔source 双射闸**（`TRACK_TO_SOURCE` 的值必须恰好铺满 `CONNECTOR_SOURCES` —— 漏一边 = `row_is_off_track` 把一整轨的行全判成「已被取代」） |
| `tests/config/test_untrusted_fence_parity.py` | `UNTRUSTED_MCP_TOOL` 围栏格式两语言逐字节一致 |
| `tests/config/test_flag_cross_language.py` | `MAILAGENT_MCP_CONNECTORS` 已登记为 `[lifecycle, config]` 双载体，🔴 **双侧默认必须同为 false**，cutover 时两边一起翻 |

七处副本 = `trigger._CONNECTOR_GRANT_VALUES`（保存闸，权威）· `service.CONNECTOR_CRUD_RANK` ·
`policy.ts::ConnectorGrant`（类型联合）· `policy.ts::CONNECTOR_CRUD_RANK` ·
`schemas.ts::customAgentConnectorGrantSchema`（zod）· `types/chat.ts::AgentRunSpec`（spec wire）·
`types/report.ts::CustomAgentToolPolicy`（REST wire）。**消灭不了**：跨语言 + 跨构件种类，
TS 三份里两份是编译期类型（压根没有值可 import）。

---

## 8. 灰度开关与回退

**`MAILAGENT_MCP_CONNECTORS`，默认 `false`**（沿用 island 的 ship off → dogfood → cutover 模式）。

**双载体**（与 island 同形态），翻开关**两侧都要重启**：

| 载体 | 位置 | 管什么 |
|---|---|---|
| Python pydantic `mcp_connectors_enabled` | `src/config.py`（`validation_alias`） | serve-api，翻需重启 serve-api |
| Node `envBool` | `frontend/src/electron/main/ai_gateway_lifecycle.ts` | gateway，main-env-only、**不加 vite define**，翻需重启 app |

🔴 pydantic 而非 `.env` 热读是**刻意**的：热读会让 UI 与端点在同一次会话里劈叉（一半读到新值
一半读到旧值）；且 env-only 直读有 ratchet 闸（`tests/config/test_env_only_reads.py` 禁新增）。
代价 = 翻开关要重启，对灰度开关可接受。

**全部消费点**（off 时逐个字节级 inert）：

| 消费点 | on | off |
|---|---|---|
| `routers/connector.py::_require_enabled` | 端点正常 | 除 `oauth/callback` 外**全 409** `E_CONNECTOR_DISABLED` |
| `GET /api/connector/oauth/callback` | — | **刻意不挂 flag 门**：off 时不存在活 rendezvous → 天然 404；端点自身零副作用 |
| `/api/chat/config.connectorToolsEnabled` | `true` | `false`（字段恒发） |
| `ai_gateway_lifecycle.ts` manifest 拉取 + `ensureConnectorManifest` | 启动预热（1s/3s/6s/10s/20s 退避重试 5 次，累计 ~40s）+ TTL 缓存（成功 30s / 失败 3s）+ 单飞，run 前 await（§5.6） | 不预热、不拉、不接线，零工作 |
| `createConnectorTools` / `shouldLoadConnectorTools` | 注册动态工具 | `buildGatewayTools` 字节级回退 |
| `llm_tools.build_connector_llm_tools` | 造 schema + handler | 返回 `([], {})`，报告/分类逐字节回退 |
| Connectors 配置台 `/connectors` 的「外部连接」段（08-06，§13） | 左栏该段 + 右栏 connector/catalog/Composio 账户 detail 全部渲染 | 整段不渲染（内置工具段照常可用 —— 那份数据与本 flag 无关），且**零** `/api/connector/*` 请求 |
| Settings `ConnectorsSection`（08-06 起只剩一张指向 `/connectors` 的深链卡） | 渲染指路卡 | `return null`（整区不在 DOM，且**零** `/api/connector/*` 请求） |
| 第七张能力卡 | 档位可改 | 档位 disabled + 提示（卡本身仍在） |
| `CustomAgentDrawer` 的 `useConnectorOptions` | 拉 connector 列表 | 不拉（🔴 必须**同时**看 flag：这个 query 与 `ConnectorsSection` 共用 `qk.connectors()` 缓存键，只看抽屉开合会把一个 error 结果写进共享缓存；flags 还在加载时按 off 处理） |

**off 时存量数据惰性无害**：`connector` / `connector_tool` 行照常在库、`grant_connectors` 照常
可存 —— 只是没有任何消费者。

**当前状态 / 待 cutover 裁决**（owner 可否决）：**不加 Settings 开关**——dogfood 之后直接拍
cutover 默认 on（env 显式 false 应急回退），对齐既有 harness flag 惯例（island / openness /
custom agents 全是这么走的）。理由：一个既要 env 又要 UI 的双开关会产生「界面开着但 env 关着」
的第二种失效态，而 connector 的真正 owner 控制面已经有三层（per-connector `enabled` /
per-tool 三态 / per-agent grant）。

---

## 9. 已知限界（有意留，别再调研一遍）

1. **token 死亡无告警接入**。`needs_reauth` 只在配置台与模型的工具错误里可见；`src/notify/`
   一条 connector 告警链都没有。连着的 connector 悄悄失效 → 下一次真用到它才知道。
2. **无半开自动探测**。一次 `needs_reauth` 落态后不会自愈——没有后台 worker，状态只由
   人工重连或下一次成功的 sync/invoke 翻回来。
3. ~~**registry 移除一个 connector 会留僵尸行**~~ —— **08-05 WP-12 已关闭**（§11.2）：
   `registry.CONNECTORS` 常量整体退役，`GET /api/connector` 改为迭代**库里的行**，
   `get_connector_def` 也是行优先解析 ⇒ 库里有的一定看得见；`POST /{id}/disconnect`
   增加 `{"purge": true}` 把行与工具行一并删掉 ⇒ 一定删得掉。connector 行自此是一等实体，
   代码里的目录只是 seed 源之一。
4. **orphan × grant 的 headless run 是静默空工具集**。注册期的 orphan 跳过与 grant 过滤都是
   裸 `continue`，无 warning、无审计痕迹。一个 agent 的 grant 覆盖的工具全 orphan 了 → run
   照常跑、什么都调不动、日志里看不出为什么。
5. **flag off 时 custom agent CRUD 工具的 `grant_connectors` 文案仍暴露给模型**。
   `agents.ts` 的工具 description 由 `MAILAGENT_CUSTOM_AGENTS_ENABLED` 门控，与本 flag 无关；
   off 时模型仍会读到「`grant_connectors` sets a per-connector crud ceiling」。惰性无害
   （存进去也没有消费者），但可能误导模型以为这条路通着。
6. **`llm_tools._make_handler` 的泛化 except 回灌的是 repr 不是结构化码**：
   `f"error: connector call failed: {e!r}"`，与闸拒分支的 `f"error: {e.code}: {e}"` 不同形。
   模型读得懂，但没法按码分支。
7. ~~**delete 类的实际开放**（Out of Scope）~~ —— **08-03 已按「整体退役」实现**（§5.3）：
   不是把保留位解冻，而是删掉一个不可达的死特例。将来若真出现明示删除语义的 manifest，
   那是一次**新增**档位的独立决策（值域 + 天花板 + 审批语义一起议）。
8. **其余明确不做**：stdio transport 的实现（只留表结构）· ~~Composio 等第三方云代管聚合~~
   （**08-05 owner 知情拍板推翻**：预置目录接入 Composio，理由与代价见 §11；原「数据出机
   与本地优先冲突」的判断本身没有被证伪 —— 是 owner 在知道代价后选择了它，故 §11 把三处出站
   告知做成产品的一部分。⚠️ 当时那句「**全**走 Composio、免得搞两套」已于 08-06 被 dogfood
   证伪 —— 见 §12.1：Composio 的 OAuth app 在公司租户上要 IT 管理员同意，owner 拿不到 ⇒
   Notion / Atlassian 回到直连轨，两轨并存）· 远程 web 面发起**直连** OAuth 连接（loopback
   callback 在远程浏览器打不开——远程只能**使用**已连接的直连 connector，配置台里
   `track='direct'` 条目的「连接」按钮在 web 构建下 disabled 并明示去桌面 App；🔴 **限的是
   直连轨、不是「预置目录」整体**（08-06 双轨后这两者不再等价）：`track='composio'` 的条目
   走 Connect Link，授权页与回调都在 Composio 那边，远程网页版照常连得上）· MCP `prompts` /
   `resources` · 自定义 MCP server URL 的 UI 入口（WP-24，`source='custom_mcp'` 的 schema
   已就位，缺的只是表单）。
9. **`disconnect(purge=true)` 只清得掉本地那四处**（08-06 起是「换轨」的必经动作，所以这条
   限界变得更常被踩到）：`external_credential` 的 `connector:<id>` 全部槽位 · `connector` 行
   （含 `composio_session_id`）· 该 connector 的全部 `connector_tool` 行。**Composio 服务端的
   tool-router session 与 connected account 会残留** —— `src/connectors/composio.py` 只实现了
   建 session / 起 Connect Link / 轮询账号，**没有任何 delete**。后果不是安全洞（我们再也拿不到
   那个 session id），但那条 connected account 仍挂在 owner 的 Composio 项目下、仍占配额、
   仍持有对方服务的授权 ⇒ 要真正撤销得去 Composio 控制台手动删。不是本批引入。

---

## 10. 运维速查

### 端点（`/api/connector`，除 callback 外全 `verify_cf_access` + flag 门）

| 方法 + 路径 | 用途 |
|---|---|
| `GET /api/connector` | **已配置的行** ∪ 凭证健康 ∪ 在途流（08-05 WP-12 起不再是 registry 全集；每行带 `source` + `superseded_by_catalog`） |
| `GET /api/connector/catalog` | 预置目录（08-06 起**双轨**：每条带 `track:'direct'\|'composio'` + `server_url`（direct 恒有 / composio 恒 null）+ `tool_count`（direct 恒 **null**）+ `configured` / `superseded`）+ BYOK key 状态 `{composio:{configured,updated_at}, entries:[…]}`。🔴 服务端恒返回**全部**条目——BYOK gate 是 per-entry 的 UI 语义（只罩 composio 轨），强制在连接端点 |
| `POST /api/connector/composio/key` | 写 Composio API key（`{"api_key": "…"}`；落 external_credential，响应**不回显**任何字符） |
| `DELETE /api/connector/composio/key` | 删 key（幂等；connector 行与 session id 不动） |
| `POST /{id}/oauth/start` | 起授权流 → 返回 `authorize_url`（重复调 = 替换在途流）。**按解析出的 `source` 分派**：`custom_mcp` → loopback OAuth/DCR，`composio` → 托管 session + Connect Link（§12.4） |
| `GET /{id}/status` | 单个 connector 的状态 + 凭证视图 + 在途流视图 |
| `POST /{id}/sync` | 用已存授权拉工具清单落库（非交互，无授权 → 409 引导走 oauth/start）。🔴 「连过没有」的判据 08-06 起是**行是否存在**，不再是 `definition.server_url` 是否为空 —— 后者只是 composio 轨下「没连过」的代理判据，直连轨的目录条目**自带**官方 endpoint，照旧判会让一个从没连过的 Notion 走进 upsert、在列表里凭空多出一行假连接 |
| `GET /{id}/tools` | 已同步清单（含 orphan 行；`mode_override` 原样 + `effective_mode` 已折算、`destructive` 原样透出） |
| `POST /{id}/enabled` | connector 整体启停（`{"enabled": bool}`；**保留**凭证与 per-tool 配置） |
| `POST /{id}/tools/{tool}/mode` | per-tool 三档（08-05，取代旧 `…/enabled`）：`{"mode": "auto"\|"ask"\|"off"\|null}`，键必须在场，null=清覆盖回默认档 auto |
| `POST /{id}/tools/bulk_mode` | 组级批量设档 / Reset permissions：`{"mode": …, "crud_type"?: …}`（orphan 行跳过；`updated` 计数） |
| `POST /{id}/tools/purge_orphans` | 清 orphan 行（只删 `orphan=1`） |
| `POST /{id}/preprocess` | 分类侧独立授权（`{"enabled": bool}`；08-05 起开 = 该场地可用 per-tool `auto` 档工具**含写类**） |
| `POST /{id}/tools/{tool}/invoke` | 工具调用（gateway 与 curl 共用；可带 `caller` 信封） |
| `POST /{id}/disconnect` | **逐条删凭证**（tokens + client_info + 将来任何槽位）+ 状态回 `disconnected`；**工具清单行与用户配置保留**。`{"purge": true}`（08-05 WP-12）= 连 connector 行与工具行一起删（差距表 #10 的 Uninstall 语义 + **换轨的唯一出口**，08-06 起两个方向都走它，§12.5）；🔴 清得掉的只有本地四处，Composio 服务端残留见 §9.9 |
| `GET /oauth/callback` | 浏览器回调落点（**无鉴权**，state 即能力令牌） |

无 `mailagent` CLI group；开发期实连脚本 = `scripts/dev/connector_oauth_spike.py`
（`--mode live` 需 serve-api 在跑且 flag on）。

### UI 入口

🔴 **08-06 起唯一的 owner 操作面是独立的 Connectors 配置台 `/connectors`**（Sidebar「AI AGENTS」
段内一行 `nav.connectors`）。布局、深链、默认折叠、迁移前后的对应关系见 **§13**。

设置 → **AI** tab 里原来那两个区（「工具审批档」`ToolApprovalSection` + 「外部连接（MCP）」
`ConnectorsSection`）**降级成指向配置台的深链卡**——同一份数据不在两处都能改。
`ToolApprovalSection.tsx` 已删除；`ConnectorsSection.tsx` 只剩指路卡，flag off 时整区
`return null` + 零请求的门控语义原样保留（§8）。设置-AI 的右侧锚点导航
（`ui/section-anchor-nav.tsx` + `aiTabAnchors.ts`）照旧，两个锚点（`approval` / `connectors`）
现在落在各自的指路卡上。per-agent 授权仍在 Custom Agent 抽屉的第七张「外部服务」能力卡
（§6.2），那是**另一份数据**（grant），不在配置台里。

对话里的快捷入口（08-03 起）= 两个 composer 的「+」菜单 → 「外部连接」（08-04 WP6 把原来平铺
在工具条上的独立 Blocks 圆钮收进「+」，两面同一个 `ComposerPlusMenu`；面板内容
`ConnectorQuickContent` 逐字未变）。**只有开关 + 「管理」深链**（08-06 起深链落
`/connectors?item=external`，不再是设置页锚点），发起 OAuth 连接恒在桌面 App 的配置台
（直连轨回调走本机 loopback，远程点了只会静默超时）。Switch 直接写穿全局
`connector.setEnabled` —— 它是全局位的镜像，不是第二套 per-conversation 状态；显隐判据
（flag 未知按 off、零请求；零行不出该项）单源 `useConnectorQuickRows`。至少一个
connected+enabled 时「+」挂一颗 coral 角标点。

### SQL

🔴 活库是 **userData** 那份，不是仓库 `data/`：

```bash
DB=~/Library/Application\ Support/mailagent-frontend/data/agent_config.db

sqlite3 "$DB" "SELECT connector_id, status, enabled, preprocess_enabled, last_synced_at,
  substr(coalesce(last_error,''),1,60) FROM connector;"

# 工具清单分布（crud × destructive × orphan；🔴 crud_type='delete' 应恒为 0 行 —— 出现
# 说明库没跑过 08-03 的退役迁移，见 §5.3.1）
sqlite3 "$DB" "SELECT connector_id, crud_type, destructive, orphan, COUNT(*)
  FROM connector_tool GROUP BY 1,2,3,4;"

# 某个工具的档位（08-05：mode NULL=跟随默认 auto；enabled 是退役死列，只作迁移取证）
sqlite3 "$DB" "SELECT tool_name, crud_type, mode, enabled, orphan FROM connector_tool
  WHERE connector_id='notion' ORDER BY crud_type, tool_name;"

# 装配路线分布（08-05 WP-12：composio = 经 Composio 云执行 / custom_mcp = 直连）
# 🔴 08-06 双轨后判「这一行对不对」要拿它比目录出厂轨道（§12.2）：notion / atlassian 的
#    出厂轨是 direct ⇒ 这两家 source='composio' 的行会被标 superseded（要 purge 后重连）。
sqlite3 "$DB" "SELECT connector_id, source, substr(coalesce(composio_session_id,''),1,16),
  status FROM connector;"

# 凭证健康（明文列，不解密；🔴 Composio 的 BYOK key 落 namespace='composio:project'）
sqlite3 "$DB" "SELECT namespace, credential_key, expires_at, metadata_json, updated_at
  FROM external_credential WHERE namespace LIKE 'connector:%' OR namespace='composio:project';"

# per-agent grant
sqlite3 ~/Library/Application\ Support/mailagent-frontend/data/sync_store.db \
  "SELECT id, title, tool_policy_json FROM report_agent WHERE tool_policy_json LIKE '%grant_connectors%';"
```

### dogfood 现状

`MAILAGENT_MCP_CONNECTORS` 在 owner 的 userData `.env` 里已开（连同阶段 0.5 的
`MAILAGENT_MEMORY_LAYERS` / `MAILAGENT_SKILL_CATALOG_PROMPT`）；仓库默认与 `.env.example`
仍是 off，cutover 另拍。翻开关后**必须同时重启 serve-api 与 app**（双载体）。

---

## 11. Composio 托管轨：预置目录 + BYOK（08-05 WP-12）

> ⚠️ **本节描述的是两轨中的 `composio` 那一轨**（当前 14 家）。它落地时的前提是「预置目录
> **全**走 Composio」，那个前提已于 08-06 被 dogfood 证伪 —— Notion / Atlassian 回到直连轨，
> 见 **§12**。本节其余内容（装配、五件套、meta 工具过滤、BYOK、出站告知、风险）对 composio
> 轨**逐条仍然成立**，只是不再覆盖全部预置服务。

> owner 三轮拍板收敛的结果（决策链见 task `08-04-dogfood-feedback-0804-connector-chatui-avatar`
> 的 `research/gap-connector-module-vs-reference.md` §7 与 `master-plan-0805.md` WP-12）：
> **预置目录全走 Composio**（「免得搞两套，效果不一致」）+ 保留「自定义 MCP server URL」入口
> 作为高级用法（WP-24，schema 已就位）+ 存量直连行不做迁移、owner 手动重配。
> owner 在被明确告知「工具入参/返回经 Composio 服务器、OAuth token 托管在它那边、它是单点
> 依赖」之后仍拍板使用。§11.5 的三处出站告知就是这条决策的产品化处置。

### 11.1 装配：一个 connector = 一个 tool-router session

- Composio 的 session 暴露一个**托管 MCP endpoint**（`mcp.url`）。我们不引 `composio` SDK
  （只用四个控制面动作，引 SDK 要往 108 包 lock 里塞一整棵依赖树），走**裸 REST**：
  `POST /api/v3/tool_router/session`（建）· `GET …/session/{id}`（复用）·
  `POST …/session/{id}/link {toolkit}`（起 Connect Link）· `GET /api/v3/connected_accounts?user_ids=`
  （轮询状态）。base = `https://backend.composio.dev/api/v3`，实现单源 `src/connectors/composio.py`。
- MCP 侧是 `ConnectorClient` 的**第二种装配模式**：跳过 `OAuthClientProvider`，httpx2 client
  挂静态 header `x-api-key`（spike 实测：纯 URL 不带 header → `401 code 906`）。transport /
  list_tools 分页 / 50k 截断 / ExceptionGroup 拆包 / per-namespace 串行闸 **全部复用**。
- ⇒ 对 gateway 而言 Composio connector 与任何 MCP connector 长得一模一样：manifest 同步、
  per-tool 三档（§5.5）、审批链（§6）、`UNTRUSTED_MCP_TOOL` 围栏、orphan 纪律 **零改动**。

🔴 **session 创建必带五件套**（`composio.session_create_body`，少任何一条都会静默出事）：

| 字段 | 值 | 少了会怎样 |
|---|---|---|
| `toolkits.enable` | 该 connector 的 toolkit（小写） | 工具面为空 |
| `tools.<toolkit>.enable` | curated 白名单 | 65～947 个工具全进来 |
| `preload.tools` | 同白名单（≤20） | 只出 meta 工具，走 Composio 自己的「搜索→执行」语义 |
| `manage_connections.enable` | `false` | 模型拿到「自己去连别的账号」的工具 |
| `workbench.enable` | **`false`** | **白送一个云端代码执行沙箱**（默认是开的！） |

🔴 **meta 工具删不掉**：即使配全五件套，`tools/list` 仍带 `COMPOSIO_SEARCH_TOOLS` /
`COMPOSIO_MULTI_EXECUTE_TOOL` / `COMPOSIO_GET_TOOL_SCHEMAS`。它们的「搜索→执行」发生在
Composio 的语义里，会**绕开**我们的 per-tool 档位、审批卡与围栏 ⇒
`ConnectorClient.list_tools_manifest` 对 `source='composio'` 按前缀 `COMPOSIO_` 恒过滤、不入库
（直连轨不过滤 —— 那边同名工具就是个普通工具）。

### 11.2 数据模型增量

`connector` 表加两列（`_migrate_additive` 幂等补，不进 `DB_VERSION`）：

- `source TEXT NOT NULL DEFAULT 'custom_mcp'`（值域 `CONNECTOR_SOURCES`，写侧校验）。
  🔴 默认 `custom_mcp` 是**有意**的：补列时存量行全是直连的（08-05 之前不存在 composio 行），
  默认写成 composio 会把两条老行当场标错源。跨语言闸 = `tests/config/test_connector_contract_parity.py` ③b。
- `composio_session_id TEXT`（明文非敏感；直连行恒 NULL）。

`registry.CONNECTORS` 常量退役 → `get_connector_def` **行优先、目录兜底**：
库里的行是权威（server_url / transport / display_name / source 全读行）→ 没有行才回退到预置
目录（composio 轨的兜底 `server_url=''` = 还没有 endpoint，任何要发请求的路径显式报
not-connected；**direct 轨的兜底自带官方 endpoint**，这就是「还没连过的直连家」也能点连接的
原因，见 §12.3）。
🔴 顺序不能反：目录里有 `notion`、库里也有一行老的直连 `notion`，**行优先**才不会让老连接
一夜之间改用一把 Composio key 去打 Notion 的直连端点。08-06 双轨后同一条纪律反过来也管用：
owner 活库里那行 composio 的 `atlassian` 不会因为目录换轨就被当成直连行。

### 11.3 目录数据（代码内 curated，加一家 = 一条数据）

单源 `src/connectors/composio_catalog.py`：16 家（Gmail / Google Calendar / Google Drive /
Slack / X / GitHub / Notion / Atlassian[JIRA+CONFLUENCE 双 toolkit 单 connector] / Linear /
Outlook / Figma / Stripe / Asana / Intercom / Sentry / PayPal；Vercel + PostHog 是 `API_KEY`
scheme，本批不做）。🔴 **08-06 起这张表里的 `notion` / `atlassian` 两条不再进目录视图**
（出厂轨改成 direct），但**不是死数据** —— 存量 composio 行重连/续期时仍要靠它拿白名单
（`routers/connector.py::get_composio_entry` 的红标；判「目录里有没有这一家」一律走
`catalog.track_for`，不是这张表的成员关系）。
每条 = toolkit + **curated 白名单** + 描述 i18n key + 字母牌 logo。
`validate_catalog()` 在 import 期跑：白名单非空、≤20、无重复、slug 属于自己的 toolkit、
不含 meta 工具 —— 加错数据当场炸而不是等用户点连接。

- **白名单是必选项不是优化**：实测量级 GitHub 947 / Outlook 314 / Slack 178 / Gmail·Notion 65。
- 🔴 **Outlook 白名单剔除全部 send/draft/message 写类**（`validate_catalog` 有断言）：
  Exchange 邮件读写是本机 davmail 主链路，不给模型第二条写邮件通道；只补日历 + 联系人。
- Gmail 首发只给起草类写入（不给 `GMAIL_SEND_EMAIL`）；Stripe / PayPal 白名单全读。
- **logo 取舍**：不用 `logos.composio.dev` 外链、也不内嵌品牌 SVG，用**代码内品牌色字母牌**。
  理由 = 打包 `.app` 常在离线/受限网络下跑（外链会裂图），且未配 key 时就向第三方 CDN 发请求
  与本节的出站告知调性相反；字母牌零请求、零商标复制、离线恒成立。

### 11.4 BYOK + 连接流

- **key 存 `external_credential`**（namespace `composio:project`，槽位 `api_key`，Fernet +
  Keychain），**不进 .env**（明文落盘 + 第二事实来源 + 要重启，与「填完即生效」矛盾）。
  UI（08-06 起 = 配置台左栏的「Composio 账户」面）只能写不能读回：状态视图只有
  `{configured, updated_at}`（`peek` 不解密）。
- **未配 key 的 gate**：composio 轨的目录卡 disabled + 引导（注册 Composio → 取 key → 粘贴）+
  深链跳「Composio 账户」面。🔴 **08-06 起 gate 是 per-entry 的**（判据 `track === 'composio'`，
  单源 `consoleShared.resolveCatalogTrack`）——直连轨的 Notion / Atlassian 没有 Composio key
  也照样能连；把 gate 做成整区 disabled 会让**不需要 key 的那一轨**卡在「先填 key」的死路上。
  真正的强制仍在连接端点（`POST /{id}/oauth/start` 解析出 `source='composio'` 且没 key →
  409 `E_COMPOSIO_NO_KEY`；direct 轨走不到这条分支）。
- **user_id** = 首次生成的稳定 uuid 存 `owner_settings['composio.user_id']`（官方明说别用
  `'default'`、别用 email）。
- **连接流** `src/connectors/composio_flow.py`（`custom_mcp` 轨 `run_connect_flow` 的对位物，
  共用 `ConnectorFlowState` 交接面，所以 UI 的「等待授权 + deadline」整段复用）：
  建/复用 session → 逐 toolkit 起 Connect Link → 轮询 connected account → 拉 manifest → 落双表
  → `connected`。**端点仍叫 `oauth/start`**：对前端它就是「连接」这一个动作，分派在服务端。
- 🔴 **多 toolkit 顺序授权**：Atlassian 要连 Jira + Confluence 两次。流把第 1 条 URL 交出去、
  等它 ACTIVE，再把第 2 条填进 `flow.auth_url` 并把 `link_seq` +1；前端轮询发现序号涨了就再开
  一次浏览器（同时弹两个授权页是更糟的 UX，而不弹第二个则第二条链接根本没人打开）。

### 11.5 出站告知三处（这条路线的产品化处置，不是装饰）

1. **目录卡上的常驻声明** + 每行「经 Composio」/「直连」小字（已连行判据 = 服务端 `source`
   字段，未连目录条目判据 = `track`，前端两者都不靠 URL 长相猜）。08-06 起直连条目对位地有
   一句 `connectorsConsole.directTrackNote`（「直连官方 MCP 端点…不经任何第三方中转，也不需要
   API Key」）——**两轨都要如实说自己是什么**，否则「没有声明」会被读成「没有出机」。
2. **首次连接任一 Composio 轨服务的一次性 confirm**：数据过境 + token 托管 + 🔴 提醒去
   Composio 后台 Settings → General 把 **Log storage 切「Don't store data」**（默认存 payload
   最长一年，且只对新调用生效）。localStorage 全局一次（说的是**这条路线**的性质，不是某一家
   的性质）；🔴 直连轨**不经这道 confirm** —— 它没有任何第三方中转，弹一句「数据会过境」是假话。
3. **写类审批卡加一行「经 Composio 云执行」**（`McpApprovalCard`）——走与 destructive 红警告
   **同一条 live 通道**（`GET /{id}/tools` 的顶层 `source`），模型无法把这行字说没。

### 11.6 存量行的处置（换轨走同一条路，两个方向）

不自动迁移、不做 slug 映射表（owner 已豁免）。**装配路线与目录出厂轨道不符**的行：

- **保持可用**（行优先解析 ⇒ 装配路线不变，不会被目录换轨影响）；
- 列表行上标 `superseded_by_catalog` → 迁移提示；
- 目录卡上同 id 条目显示「已添加 / 先断开清除」——**同一家不给两个入口**（一个 id 一行是
  connector 表的 PK 事实，不是 UI 选择）；
- 换装 = 「断开」对话框勾选 **「同时清除工具配置」**（`purge=true`，`superseded` 行默认勾上）
  → 行没了 → 目录卡回到可连接。

🔴 **08-06 起这件事是双向的**（原文只写了「老直连行 → Composio 版本」一个方向，因为当时目录
是单轨）：现在也有反方向 —— composio 行遇上 direct 轨条目（owner 活库那行 `atlassian` 正是
这一种），提示文案与预勾选按**行的 `source`** 分方向。判据单源 `catalog.row_is_off_track`，
真值表见 §12.2。

### 11.7 风险与配额（如实列，owner 已知情）

1. **单点依赖**：Composio 宕机 / 账号问题 / 额度用尽 = **该轨全部 connector 一起停**
   （08-06 双轨后不再是「全部预置 connector」—— 直连的 Notion / Atlassian 不受它影响，
   这也是双轨顺带买到的一点韧性）。§9.1「无告警接入」这个洞因此变大一号（仍未做，列入后续）。
2. **数据出机范围扩大**：仍适用于 composio 轨的 14 家。⚠️ 原文那句「原本本地直连的
   Notion / Jira 重配后也经 Composio」**已于 08-06 作废** —— 这两家回到直连轨（§12.1）。
3. **留存默认开**：不切 Log storage 就是「入参/返回存它那 1 年」——接入 checklist 第一项。
4. **配额**：免费档 20K calls/月（个人用量 $0）。🔴 **邮件预处理场地接入前必须按邮件量重算**
   （逐封自动跑 × 每封若干次调用）。
5. **延迟**：多一跳云中转（我们 → Composio → Google/Notion），可感知但非数量级。

---

## 12. 双轨预置目录（08-06）

> 单源 `src/connectors/catalog.py`（纯数据 + 纯函数、零第三方 import，与 `composio_catalog`
> 同款纪律 —— router 才能在模块级薄封装里用它）。task
> `08-05-08-06-connector-dual-track-and-console` Lane A。

### 12.1 为什么直连轨必须留着（别把它当历史包袱清掉）

08-05 WP-12 收敛成「预置目录全走 Composio」时的理由是「免得搞两套、效果不一致」。
**08-06 owner dogfood 当场证伪了那个前提**：试连 Composio 版 Atlassian 失败，活库里落下一行
`atlassian`（`source='composio'`, `status='error'`, `Composio reported a failed connection for
JIRA`），工具清单一条没同步下来。

根因**不是功能故障，是鉴权路线**：Composio 用的是**它自己的** OAuth app，授权请求落到公司
（Omada）的 IdP 上就变成「第三方应用接入本租户」，需要 **IT 管理员同意**——owner 拿不到，
而且这跟我们写多少代码无关。

owner 拍板原话：

> 「不是功能故障，是 composio 的鉴权，会跳转，需要公司的 IT 授权才行，我之前的那个实现不需要，
> 可以直接连接。」
> 「所以 notion/jira 可能得保留原来的设计，composio 来补全剩下的部分。」

自建直连轨走的是 **MCP OAuth 2.1 + PKCE + 动态客户端注册（DCR）**，打的是 Notion / Atlassian
**官方**的 MCP 端点、授权页是服务方自己的、注册的 client 是当场 DCR 出来的 ⇒ **结构上不存在
「第三方应用要租户批准」这一步**。这不是「更快」或「更省」的优化，是**在受管企业租户下唯一
连得上**的路线。

⇒ 两轨并存，不是过渡态：`notion` / `atlassian` 出厂 `direct`，其余 14 家出厂 `composio`。
未来若某家的 Composio 授权也撞上同类租户约束，正确的处置是**把它挪进 `DIRECT_CATALOG`**
（前提是它有官方 remote MCP 端点），而不是让用户去求 IT。

### 12.2 `track` 与 `source` 是两个东西（四格真值表）

| 概念 | 单源 | 语义 | 何时变 |
|---|---|---|---|
| `track` | `catalog.track_for(id)` → `'direct'` / `'composio'` / `None` | **目录侧的出厂轨道** = 「现在从目录点连接会走哪条路」 | 我们改代码里的目录数据时 |
| `source` | `connector.source` 列（`store.CONNECTOR_SOURCES` = `custom_mcp` / `composio`） | **行侧的既成事实** = 「这一行当初是怎么连上的」 | 只在建行（连接成功）时定，之后不会被目录变更改写 |

两套词表**只在 `catalog.TRACK_TO_SOURCE` 一处对接**（`direct → custom_mcp`、
`composio → composio`）；别处再写一次这个映射就是第二处手抄。双射性（值恰好铺满
`CONNECTOR_SOURCES`）由 parity 闸断言。

`row_is_off_track(source, connector_id)` 是**唯一**判据（列表端点的
`superseded_by_catalog`、目录端点的 `superseded`、配置台的迁移提示与「切换轨道」按钮全读它）：

| 行 `source` | 目录 `track` | off-track？ | 什么场景 |
|---|---|---|---|
| `custom_mcp` | `direct` | **否** | 正确的直连行（08-06 后的 Notion / Atlassian）。🔴 旧判据（`source=='custom_mcp' && 目录里有同 id`）会把它误标成「已被目录取代」，把 owner 诱导去断开重连一个本来就对的连接 |
| `composio` | `direct` | **是** | owner 活库那行 error 的 `atlassian` —— 提示文案与预勾 purge 走**反方向**（§11.6） |
| `custom_mcp` | `composio` | **是** | WP-12 的原始场景（老直连行遇上 Composio 轨条目） |
| `composio` | `composio` | **否** | 正常的托管连接 |
| 任意 | `None`（两张表都没有这一家） | **否**（早退不猜） | WP-24 用户自填 URL 的行 —— 它永远不该被提示「已被目录取代」 |

### 12.3 直连轨的目录数据

`catalog.DIRECT_CATALOG`（端点值 = WP-12 退役掉的那张常量表原文，`git show b249bf92^`）：

| id | display_name | 官方 MCP 端点 |
|---|---|---|
| `notion` | Notion | `https://mcp.notion.com/mcp` |
| `atlassian` | Atlassian (Jira / Confluence) | `https://mcp.atlassian.com/v1/mcp/authv2` |

🔴 **直连轨不套用 Composio 的 curated 白名单**：那份白名单是 Composio 自己的 slug 命名
（`NOTION_FETCH_DATA` 等），官方 MCP 端点 `tools/list` 自报的是完全另一套名字，套过去只会
得到一份对不上的假清单。所以统一视图（`CatalogEntryView`）对 direct 条目恒发
`toolkits=[]` + **`tool_count=null`**——不是 `0`。`null` 读作「连上才知道」（UI 显示
「工具清单连接后获取」），`0` 读作「这家一个工具都没有」，后者是撒谎。

`validate_direct_catalog()` 在 import 期跑（镜像 `composio_catalog.validate_catalog` 的纪律：
加错数据当场炸，不等用户点连接）：`TRACK_TO_SOURCE` 的键与 `CONNECTOR_TRACKS` 一致（加轨道
必须同时给出它的 source 归属）· key 与 `connector_id` 一致 · `server_url` 必须是 `https://` ·
展示元数据非空。最后一条的理由 = 空/写错的 server_url 会一路走到 `client.session`，在那里
以 not-connected 的面目出现，症状与「没授权」一模一样、极难查。

`catalog_views()` 合并两轨（按 id 排序、同 id 只出现一次、**direct 优先**）。🔴 轨道归属
**只问 `track_for`**：在这里再写一次 `cid in DIRECT_CATALOG` 就是第二处判据，与
`row_is_off_track` 漂开时的症状正是「目录卡说自己是 direct、`superseded` 却按 composio 判」
—— 一整轨的正确行被标成已取代。

### 12.4 解析 / 连接分派 / 一个安全不变量

- **解析顺序不变**（`registry.get_connector_def`）：① `connector` 行（权威）→ ② 预置目录
  （direct 带官方 endpoint + `source='custom_mcp'`；composio 只有 display_name、`server_url=''`）
  → ③ `KeyError`。所以「还没连过的直连家」也解析得出一个可用的 def，这就是点「连接」能直接
  走 loopback OAuth/DCR 的原因。
- **连接端点按 `source` 分派**（`POST /{id}/oauth/start`）：`custom_mcp` → `client.run_connect_flow`
  （loopback OAuth + DCR）；`composio` → `composio_flow.run_composio_connect_flow`。因为解析是
  行优先，这条分派**同时**覆盖了「按 track 分流」（没行 → 目录轨道）与「已有行按原轨重连」
  （有行 → 行的 source）。两条路径的错误码与状态机（§3 / §4）完全一致。
- **sync 的 guard 改判**：从「`definition.server_url` 为空」改成**直接查行是否存在**。
  空 URL 只是 composio 轨下「没连过」的代理判据；直连轨的目录条目自带 endpoint，照旧判会让
  一个从没连过的 Notion 走进 upsert，在列表里凭空多出一行「未连接」的假象。
- 🔴 **`row_lookup_ok` 不变量（「没有行」≠「读不出行」）**：读 `connector` 行**抛异常**时
  caller 也只能给出 `row=None`，但那是「不知道」而不是「没有」。两者折成同一个值 ⇒ 一次
  DB 读失败就会把一行**健康的** composio 连接临时解析成直连 def，于是真的拿
  `connector:<id>` 下并不存在的直连 token 去打 `mcp.notion.com` / `mcp.atlassian.com`：
  ① 真的出网发了 DCR/授权请求；② 失败码 `E_CONNECTOR_NOT_CONNECTED` ∈
  `CONNECTOR_REAUTH_ERROR_CODES` 会把那条健康连接落成 `needs_reauth`，把用户支去重新授权
  一个本来没坏的东西。
  处置 = `_def_from_catalog(..., row_lookup_ok=)`：**只有在行查询正常返回时 direct 条目才交出
  端点**，异常路径下抹成空 URL。抹空后两轨的兜底同性质——**失败在本地、零出网**，DB 恢复后
  下一次解析自动回正。这条不变量是目录兜底那段安全论证的支点，改 registry 时别顺手抹掉。

### 12.5 换轨：唯一正确路径与它清不掉的东西

- **换轨 = `disconnect(purge=true)` 后从目录重连**。`source` 是行侧既成事实，没有任何「原地
  改轨」的写入口（那会让一行的 token 与它的装配路线对不上）。配置台在 `superseded` 行上直接
  给「切换轨道（断开并清除配置）」按钮：预勾 purge 打开断开对话框，行清掉后页面自动落到同 id
  的目录条目，用户下一步正好是重连。
- 🔴 **已有行按原轨重连不被拦截**：`superseded` 只是提示 + 一个更明确的动作，不是禁止。
  owner 活库那行 composio 的 `atlassian` 点「重新连接」仍走托管流（它的 token 在那边）——
  拦下来会让「我只想让现在这条先能用」变成死路。
- **purge 清得掉的只有本地四处**：`connector:<id>` 凭证全槽位 · `connector` 行（含
  `composio_session_id`）· 该 connector 的全部 `connector_tool` 行。**Composio 服务端的 session
  与 connected account 会残留**（`composio.py` 无 delete 实现）——见 §9.9，要去 Composio 控制台清。

### 12.6 前端契约与容错

- wire：`GET /catalog` 每条带 `track` + `server_url`；TS 类型 `ConnectorTrack`
  （`types/connector.ts`），词表闸见 §7。
- 🔴 **前端不直读 `entry.track`**，走 `consoleShared.resolveCatalogTrack`：字段缺席
  （老服务端 / 半程部署）时**按 `composio` 处理**。方向是有意选的——把 composio 条目误当
  direct 只是少了一句 BYOK 引导，反过来会把 direct 条目卡在「先填 Composio key」的死路上，
  而那一轨恰恰是不需要 key 的那条。
- **BYOK gate 是 per-entry 的**（只罩 `track==='composio'`，§11.4）。
- **远程 web 面只有 composio 轨能发起连接**：direct 轨回调走本机 loopback，web 构建下按钮
  disabled 并明示去桌面 App（§9.8）。

**测试**：`tests/connectors/test_catalog_tracks.py`（轨道归属 / 视图形状 / 双射 / off-track
四格 / 解析优先级 / `row_lookup_ok` 的四条异常路径）· `tests/api/test_connector_api.py`
（`/catalog` 带 track、`superseded` 两个方向、连接端点三种分派、直连条目未建行不能 sync、
失败的 composio 行可被直连替换）· `tests/config/test_connector_contract_parity.py` ③c。

---

## 13. Connectors 独立配置台 `/connectors`（08-06）

> owner 原话：「之前说了 connector 单独一个配置页，参考 lobe hub 的界面呈现设计。」
> 同批 Lane B。**零数据面改动** —— 端点、值域、折算规则一个没动，改的是这些配置**在哪里改**。

### 13.1 迁移前后

| 原位置 | 现位置 | 处置 |
|---|---|---|
| 设置 → AI → 「工具审批档」区（`ToolApprovalSection.tsx`，33 项，以 `BUILTIN_TOOL_POLICIES` 为准） | `/connectors` 左栏「内置工具」段 → 右栏 `BuiltinDetailPane` | 组件**已删除**；设置页该 Section 只剩一张「已迁移」深链卡 |
| 设置 → AI → Custom AI 区 → 「外部连接（MCP）」（`ConnectorsSection.tsx`） | `/connectors` 左栏「外部连接」段 → 右栏 `ConnectorDetailPane` / `CatalogDetailPane` / `ComposioAccountPane` | 组件**保留但降级**成深链卡（flag off 时 `return null` + 零请求的门控语义原样保留） |
| composer「+」菜单 →「外部连接」→「管理」 | 同上 | 深链目标从「设置页 AI tab + 锚点滚动」改成 `/connectors?item=external` |

🔴 **同一份数据只有一个可写面**：设置页两处都不再直接编辑（两处都能改 = 两个事实来源）。
per-agent 的 `grant_connectors` **不在**配置台里 —— 那是另一份数据（§6.2），仍在 Custom Agent
抽屉的第七张能力卡。

### 13.2 布局与路由

- 路由 `/connectors`（`router-instance.tsx` → `ConnectorsLayout`），Sidebar「AI AGENTS」段内
  一行（**不新增 section header**，遵守三段铁律）。
- **左栏（master）**
  - 「内置工具」= 按 `tool_prefs.TOOL_PREF_GROUPS` 的功能域分组（`email_write` / `draft` /
    `web` / `calendar` / `capability` / `supply` / `agents` / `exec` / `outbound`），行 = 域名
    + 工具数；**顺序跟 wire 负载走**，前端不手抄工具名也不手抄分组序。
  - 「外部连接」= 已连行（状态点 + 「直连」/「经 Composio」轨道标识）+ 未连目录条目
    （「连接」）+ 「Composio 账户」（BYOK key）。flag off 时整段不渲染、零请求。
- **右栏（detail）**：标题 + 状态/路线药丸 + 一句话说明 + 右上角操作 —— 外部连接是
  `Reset permissions` / `Refresh`(=同步工具) / `Uninstall`(=断开)，内置工具是「编辑放行预设」
  / 「全部重置」（`preset` / `reset` 两端点，语义原样）。主体是**按类别分组**的工具列表
  （connector 用 `crud_type` 读/写/更新；内置工具用 tool_prefs 分组，一个功能域一组），
  组头 = 名称 + 数量徽标 + 组级批量下拉，每行 = 工具名（等宽）+ 描述 + 三档图标单选。
- **深链** `?item=`：`builtin:<group>` / `connector:<id>` / `catalog:<id>` / `composio` /
  `external`（模糊落点「跳到外部连接段」）。解析宽松（`parseItemParam`），手敲 URL 落到默认
  选中而不崩页；选中项**跟随数据归一** —— `catalog:<id>` 在该家连上之后自动变成
  `connector:<id>`，行被 purge 之后反向落回 `catalog:<id>`（用户下一步正是从目录重连）。

### 13.3 🔴 每个类别默认折叠

owner 明确要求（LobeHub 截图里是展开的，我们要更收敛的默认态）：**组头点击才展开**。
两个 detail pane 都是这样。只有两处**由用户动作触发**的自动展开：sync 发现 orphan → 展开
**含 orphan 的那些组**（说了「有 N 个已失效」就得让证据当场可见）；「工具面变宽」概览里点
「查看并调档」→ 展开**全部**组（那句概览说的是整张工具面，不是某一组）。

折叠态 / 确认态 / 一次性提示 ack / purge 勾选这些临时态的「换选中项归零」由父级
`key={选中项}` 重挂载承担（惰性初始化），**不在 effect 里 setState**。

### 13.4 重排时必须保住的语义（都是既有能力，不是新做的）

- `destructive` 工具设 `auto` → 一次性红色确认；**组级批量设 auto 且组里有 destructive /
  `dangerAuto` 可配行同样先过红确认**（否则「calendar 组批量 auto」恰好只改 `delete` 一行、
  静默绕过单行确认）。
- `configurable=false` 的内置工具（`skill_install` / `skill_install_confirm` /
  `custom_agent_create|update|delete` / `run_command` / `email_prepare_send`）渲染成**禁用
  且解释为什么**（`fixedAsk` 药丸 + tip：send=收件人白名单 / run_command=`policy_rules` /
  供应链与 custom-agent CRUD=恒弹卡），不是消失、也不是只灰掉。
- `deny`（内置）/ `off`（connector）与 `auto`/`ask` **不同轴**：它作用在**注册面**（模型根本
  看不见这个工具），effective 文案单独说，不与审批档混排。
- BYOK gate（未配 Composio key → composio 轨目录卡 disabled + 三步引导）原样，且 08-06 起是
  per-entry 的（§11.4）。
- 「工具面变宽」一次性概览（per-connector localStorage）· Composio 首连一次性出站告知
  （全局 localStorage）· 断开对话框的「同时清除工具配置」勾选 —— 全部原样搬来，标记键不变。
- 与旧 UI 的两点**有意**偏差：① 工具清单不再懒加载（detail 被选中就是「展开」，组头计数也需要
  这份数据；「没选中不打请求」的语义由「只 mount 选中项的 detail」承担）；② **断开对非
  connected 行也可用** —— owner 活库那行 error 的 `atlassian` 要能被干净替换成直连行，旧 UI
  只在 connected 时给断开入口，error 行根本无路可走。

**测试**：`frontend/tests/shared/connectors/ConnectorsConsoleBuiltin.test.tsx` ·
`ConnectorsConsoleExternal.test.tsx` · `ConnectorsSettingsLink.test.tsx`
（覆盖分组默认折叠、组级批量走红确认、三档切换落库、不可配置工具不可改、设置页只剩深链）。
