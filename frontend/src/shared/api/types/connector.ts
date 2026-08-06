// MCP connector 数据层类型（08-01 阶段 1 PR4）—— `/api/connector/*` 的 wire 形状。
//
// 🔴 字段名保持服务端 **snake_case 原样**（不转 camelCase）：这些对象整体来自
// `src/api/routers/connector.py` 的 success_envelope，没有任何映射层；改名就等于在
// 前端手抄一份字段字典，服务端加字段时静默漏掉。
//
// 值域联合（`status` / `crud_type`）镜像 Python 侧 `CONNECTOR_STATUSES` /
// `CONNECTOR_CRUD_TYPES`（src/agent_config/store.py）。这两处是**展示用**镜像，与
// PR3 那组「授权天花板词表」不同（后者是安全判定、已由
// tests/config/test_connector_contract_parity.py 建闸）。

/** connector 连接态值域（Python `CONNECTOR_STATUSES`，写侧校验的同一组值）。
 *
 *  🔴 `'needs_reauth'`（PR5）与 `'error'` **不是**同一件事，故是独立的值而不是复用 error：
 *  error = 这次操作失败了（网络/远端 5xx/协议），重试可能就好；needs_reauth = 授权本身
 *  已失效或被撤销，**重试永远不会好**，只有重走一次 OAuth 才行。UI 因此给不同的主操作
 *  （「重新连接」而不是「连接」/「同步」），把用户直接送到唯一有用的那一步。 */
export type ConnectorStatusValue =
  | 'disconnected'
  | 'authorizing'
  | 'connected'
  | 'needs_reauth'
  | 'error'

/** 工具的 crud 归类（Python `CONNECTOR_CRUD_TYPES`）。
 *
 *  🔴 `'delete'` 已退役（08-03 dogfood 批）：它曾是第四档「恒不可启用」的保留位，但那是一条
 *  **分错了的轴** —— 「会不会毁数据」是 `destructive`（manifest 的 destructive_hint）在管的，
 *  crud 轴管的是「读还是写」。一个删除工具就是一个 destructive 的 write，多出来的第四档只
 *  制造了一批用户看得见、却永远配不了的死行。服务端值域已收敛为三档，存量 delete 行迁成
 *  `write` + `destructive=1`；前端因此不再需要 delete 特例分支。 */
export type ConnectorCrudType = 'read' | 'write' | 'update'

/** per-tool 三档（08-05 WP-10，owner 拍板）。镜像 Python canonical
 *  `src/agent_config/store.py::CONNECTOR_TOOL_MODES`——编译期类型联合无运行时值可 import，
 *  由 `tests/config/test_connector_contract_parity.py` 抽取对账（抽取失败必红）。
 *  `auto` = 注册且免卡执行（read 的 auto 就是旧 silent 行为）；`ask` = 注册且每次调用弹
 *  审批卡（manual 桌面卡 / im 飞书按钮卡）；`off` = 任何场地不注册。**默认（覆盖 null）
 *  折算 auto**——含 write/update/destructive（跟随参考产品，升级说明已列工具面变宽）。 */
export type ConnectorToolMode = 'auto' | 'ask' | 'off'

/** 装配路线（Python `CONNECTOR_SOURCES`，08-05 WP-12）。
 *
 *  `composio` = 预置目录条目：授权与工具执行都经 Composio 云（token 托管在它那边，工具的
 *  输入与结果会过它的服务器）——**这就是设置页「经 Composio」小字与审批卡那行告知的判据**。
 *  `custom_mcp` = 直连远端 MCP server（我们自己的 OAuth 2.1/PKCE/DCR + loopback 回调），
 *  也是**存量直连行**（Notion / Atlassian）升级后的归属。
 *  🔴 前端**不推断**这个值（不能靠 URL 长相猜），恒读服务端字段。 */
export type ConnectorSource = 'composio' | 'custom_mcp'

/** 凭证健康视图（只走明文列 peek —— master key 不可用时照样成立，故它不是「解密成功」的证据）。 */
export interface ConnectorCredentialView {
  has_tokens: boolean
  has_client_info: boolean
  /** refresh token 寿命（epoch 秒）；null = 未知 / 不过期。 */
  expires_at: number | null
  scope: string | null
  updated_at: number | null
}

/** 在途授权流的可观测状态（in-process，进程重启即消失 → null）。 */
export interface ConnectorFlowView {
  /** 流生命周期：pending → authorizing → connected | error。
   *  🔴 与 `ConnectorStatusValue` **不是同一个值域**（这里有 'pending'、没有
   *  'disconnected'），故不复用那个联合类型。 */
  status: string
  /** 浏览器要打开的授权 URL；流刚起时可能还没就绪。 */
  authorize_url: string | null
  started_at: number
  error: string | null
  tool_count: number | null
  /** 本流已产出过几条授权 URL（08-05 WP-12）。
   *  🔴 多 toolkit 的 composio connector（Atlassian = Jira + Confluence）要**顺序**授权两次：
   *  服务端连上第一个之后把第二条 URL 填进 `authorize_url` 并把这个序号 +1，前端轮询时发现
   *  序号涨了就再开一次浏览器。不这样第二条链接根本没人会去打开。 */
  link_seq: number
  /** 当前在等哪个 toolkit（composio 轨的可观测位；直连轨恒 null）。 */
  pending_toolkit: string | null
}

/** `GET /api/connector/{id}/status` 的响应形状。
 *
 *  🔴 比 `ConnectorSummary` **少** `server_url` / `transport` —— status 端点确实不发这两个
 *  字段（它们是 registry 静态定义，只有列表端点带）。故它是 summary 的父接口而不是别名：
 *  拿 status 结果去 merge 一行列表数据时，TS 不会假装那两个字段还在。 */
export interface ConnectorStatusView {
  connector_id: string
  display_name: string
  status: ConnectorStatusValue
  /** connector 整体开关；关掉 = 整族工具不注册给模型（凭证与 per-tool 配置都还在）。 */
  enabled: boolean
  /** 邮件预处理分类侧的**独立**授权位（不复用 custom agent 的 grant_connectors）。 */
  preprocess_enabled: boolean
  scopes: string[] | null
  last_error: string | null
  /** 工具清单最后同步时间（epoch 秒）。 */
  last_synced_at: number | null
  /** 装配路线（08-05 WP-12）——「经 Composio」/「直连」告知的判据。 */
  source: ConnectorSource
  credential: ConnectorCredentialView | null
  flow: ConnectorFlowView | null
}

/** `GET /api/connector` 列表元素 = status 形状 + 行上的两个定义字段。
 *
 *  🔴 08-05 WP-12 语义变更：列表 = **库里的行**（已配置过的），不再是 registry 全集。
 *  「还没连过的服务」由 `catalog()` 的预置目录承担 —— 两处不重复渲染同一家。 */
export interface ConnectorSummary extends ConnectorStatusView {
  server_url: string
  transport: string
  /** 这一行是被预置目录取代的老直连行（同 id，Composio 版本要先断开并清除配置才能装）。 */
  superseded_by_catalog: boolean
}

/** 预置目录一条（`GET /api/connector/catalog`）。全部字段是**代码内 curated 数据**，
 *  不需要 API key 就能看到（gate 是 UI 语义，强制在连接端点）。 */
export interface ConnectorCatalogEntry {
  connector_id: string
  display_name: string
  /** 一句话描述的 i18n key（后端不发译文）。 */
  description_key: string
  category: string
  /** 字母牌 + 品牌色。🔴 有意不用远程 logo：打包 app 离线会裂图，且未配 key 时就向
   *  第三方 CDN 发请求与「数据出机要明示」的调性相反。 */
  logo_text: string
  logo_color: string
  toolkits: string[]
  /** curated 白名单里的工具数（≤20）——目录卡上如实告知「会开多少个工具」。 */
  tool_count: number
  /** 库里已有同 id 行（= 已在上面的列表里）。 */
  configured: boolean
  /** 那一行是**老的直连行** —— 要换成 Composio 版本得先断开并清除配置。 */
  superseded: boolean
}

/** Composio BYOK key 的状态视图。🔴 **永远不含 key 的任何字符**（脱敏纪律）。 */
export interface ComposioKeyStatus {
  configured: boolean
  updated_at: number | null
}

export interface ConnectorCatalogView {
  composio: ComposioKeyStatus
  entries: ConnectorCatalogEntry[]
}

/** `GET /api/connector/{id}/tools` 元素（已同步的工具清单行 = 白名单）。 */
export interface ConnectorToolSummary {
  name: string
  description: string
  /** MCP manifest 的 JSON schema 原文（字符串，读方自解）。 */
  input_schema_json: string | null
  output_schema_json: string | null
  crud_type: ConnectorCrudType
  /** manifest 的 destructive_hint（会不会毁数据）——审批卡红警告 + 设置面「设 auto 前
   *  一次性红色确认」的判据。delete 档退役后它是「破坏性」的**唯一**判据（删除类工具 =
   *  destructive 的 write）。 */
  destructive: boolean
  /** per-tool 三档用户覆盖；null = 未覆盖（跟随默认档 auto）。 */
  mode_override: ConnectorToolMode | null
  /** 折算后的有效档位（null → auto）。
   *  🔴 前端**读这个**，不要自己再折算一遍默认规则（那会成第二处手抄）。 */
  effective_mode: ConnectorToolMode
  /** 远端清单里已消失（配置行保留，但不注册也不可调用）。 */
  orphan: boolean
  first_seen_at: number
  last_seen_at: number
}

/** connector 设置面的数据层。全部方法 **throw** `Error & {code}`（不吞错降级）——
 *  设置面必须能区分「没连接」「flag 关（E_CONNECTOR_DISABLED）」「网络炸了」。 */
export interface ConnectorApi {
  /** 已配置的 connector 行 ∪ 凭证健康 ∪ 在途流。 */
  list(): Promise<ConnectorSummary[]>
  /** 预置目录（Composio 单轨）+ BYOK key 状态。 */
  catalog(): Promise<ConnectorCatalogView>
  /** 写 Composio API key（BYOK）。响应只回状态，不回显任何字符。 */
  setComposioKey(apiKey: string): Promise<ComposioKeyStatus>
  /** 删掉 Composio API key（幂等）；connector 行与 session 不动。 */
  clearComposioKey(): Promise<ComposioKeyStatus>
  status(connectorId: string): Promise<ConnectorStatusView>
  /** 发起授权：返回要在浏览器打开的 URL（后台流已起，等回调）。 */
  oauthStart(connectorId: string): Promise<ConnectorOAuthStartResult>
  /** 用已存授权拉工具清单落库（非交互；无授权 → 409 E_CONNECTOR_NOT_CONNECTED）。 */
  sync(connectorId: string): Promise<ConnectorSyncResult>
  tools(connectorId: string): Promise<ConnectorToolSummary[]>
  /** connector 整体启停（凭证保留）。行不存在 → 404（先连接）。 */
  setEnabled(connectorId: string, enabled: boolean): Promise<ConnectorSetEnabledResult>
  /** per-tool 三档（08-05）：'auto' / 'ask' / 'off' / **null = 清除覆盖回默认档（auto）**。 */
  setToolMode(
    connectorId: string,
    toolName: string,
    mode: ConnectorToolMode | null
  ): Promise<ConnectorSetToolModeResult>
  /** 组级批量设档 + Reset permissions（mode=null 批量清覆盖）。crudType 缺席 = 全部在册
   *  工具；orphan 行恒跳过（服务端纪律）。 */
  bulkSetToolMode(
    connectorId: string,
    mode: ConnectorToolMode | null,
    crudType?: ConnectorCrudType
  ): Promise<ConnectorBulkToolModeResult>
  /** 分类侧独立授权位（08-05 起：开了之后该场地可用 = per-tool mode 为 auto 的工具，
   *  含写类；ask 在该无人值守场地等同禁用）。 */
  setPreprocessEnabled(connectorId: string, enabled: boolean): Promise<ConnectorSetPreprocessResult>
  /** 断开：逐条删凭证 + 状态回 disconnected；**工具清单与 per-tool 配置保留**。
   *  `purge=true`（08-05 WP-12）= 连行一起清（工具行也删），等于「当它没存在过」——
   *  把老直连行换成预置目录 Composio 版本的唯一出口。 */
  disconnect(connectorId: string, purge?: boolean): Promise<ConnectorDisconnectResult>
  /** PR5 — 删掉 orphan 工具行（远端已不再提供的那些）。只删已失效行，非破坏性：
   *  它们本来就恒不注册、恒不可调用，删的是一份过期台账。 */
  purgeOrphans(connectorId: string): Promise<ConnectorPurgeOrphansResult>
}

export interface ConnectorOAuthStartResult {
  connector_id: string
  /** 要在浏览器打开的授权 URL。🔴 **可能是 null**（08-05 WP-12）：composio 轨遇到「全部
   *  toolkit 在 Composio 侧之前就授权过」时一条链接都不起 —— 此时不该开浏览器，行已建出来，
   *  交给轮询看到 connected 即可。 */
  authorize_url: string | null
  status: string
  /** 服务端等浏览器回调的上限（秒）—— UI 的「等待授权」倒计时用。 */
  callback_timeout_seconds: number
}

/** sync 落库统计（`{connector_id} + sync_connector_tools()` 的计数：
 *  当前为 total / inserted / updated / orphaned，均为 number）。统计键不在契约里钉死 →
 *  `unknown`，取用处显式收窄。 */
export type ConnectorSyncResult = { connector_id: string } & Record<string, unknown>

export interface ConnectorSetEnabledResult {
  connector_id: string
  enabled: boolean
}

export interface ConnectorSetToolModeResult {
  connector_id: string
  tool_name: string
  mode_override: ConnectorToolMode | null
  effective_mode: ConnectorToolMode
}

/** `POST /{id}/tools/bulk_mode` 的响应（`updated` = 实际改动行数；0 不是错）。 */
export interface ConnectorBulkToolModeResult {
  connector_id: string
  mode: ConnectorToolMode | null
  crud_type: ConnectorCrudType | null
  updated: number
}

export interface ConnectorSetPreprocessResult {
  connector_id: string
  preprocess_enabled: boolean
}

export interface ConnectorDisconnectResult {
  connector_id: string
  deleted_credentials: number
  /** 行是否一并删掉了（`purge=true` 时；默认 false = 只删凭证）。 */
  purged: boolean
}

/** PR5 — `POST /{id}/tools/purge_orphans` 的响应（`purged` = 实际删掉的行数）。 */
export interface ConnectorPurgeOrphansResult {
  connector_id: string
  purged: number
}
