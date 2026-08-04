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

/** connector 连接态值域（Python `CONNECTOR_STATUSES`，写侧校验的同一组值）。 */
export type ConnectorStatusValue = 'disconnected' | 'authorizing' | 'connected' | 'error'

/** 工具的 crud 归类（Python `CONNECTOR_CRUD_TYPES`）。`'delete'` 是保留位：照常在清单里，
 *  但恒不可启用、恒不可调用（MVP 安全地板）。 */
export type ConnectorCrudType = 'read' | 'write' | 'update' | 'delete'

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
  credential: ConnectorCredentialView | null
  flow: ConnectorFlowView | null
}

/** `GET /api/connector` 列表元素 = status 形状 + registry 静态定义两字段。
 *  registry 全集都在列表里（**没连过的也在**，供设置页起步）。 */
export interface ConnectorSummary extends ConnectorStatusView {
  server_url: string
  transport: string
}

/** `GET /api/connector/{id}/tools` 元素（已同步的工具清单行 = 白名单）。 */
export interface ConnectorToolSummary {
  name: string
  description: string
  /** MCP manifest 的 JSON schema 原文（字符串，读方自解）。 */
  input_schema_json: string | null
  output_schema_json: string | null
  crud_type: ConnectorCrudType
  /** manifest 的 destructive_hint（破坏性**更新**语义位，不是 delete 档位）——审批卡红警告。 */
  destructive: boolean
  /** 用户覆盖；null = 未覆盖（跟随 crud 默认）。三态的第三态。 */
  enabled_override: boolean | null
  /** 折算后的有效启用态（read 默认开 / write·update 默认关 / delete 恒 False）。
   *  🔴 前端**读这个**，不要自己再折算一遍默认规则（那会成第二处手抄）。 */
  effective_enabled: boolean
  /** 远端清单里已消失（配置行保留，但不注册也不可调用）。 */
  orphan: boolean
  first_seen_at: number
  last_seen_at: number
}

/** connector 设置面的数据层。全部方法 **throw** `Error & {code}`（不吞错降级）——
 *  设置面必须能区分「没连接」「flag 关（E_CONNECTOR_DISABLED）」「网络炸了」。 */
export interface ConnectorApi {
  /** registry 全集 ∪ DB 运行态 ∪ 凭证健康。 */
  list(): Promise<ConnectorSummary[]>
  status(connectorId: string): Promise<ConnectorStatusView>
  /** 发起授权：返回要在浏览器打开的 URL（后台流已起，等回调）。 */
  oauthStart(connectorId: string): Promise<ConnectorOAuthStartResult>
  /** 用已存授权拉工具清单落库（非交互；无授权 → 409 E_CONNECTOR_NOT_CONNECTED）。 */
  sync(connectorId: string): Promise<ConnectorSyncResult>
  tools(connectorId: string): Promise<ConnectorToolSummary[]>
  /** connector 整体启停（凭证保留）。行不存在 → 404（先连接）。 */
  setEnabled(connectorId: string, enabled: boolean): Promise<ConnectorSetEnabledResult>
  /** per-tool 三态：true / false / **null = 清除覆盖回默认**。
   *  delete 类置 true → 403 E_CONNECTOR_TOOL_FORBIDDEN。 */
  setToolEnabled(
    connectorId: string,
    toolName: string,
    enabled: boolean | null
  ): Promise<ConnectorSetToolEnabledResult>
  /** 分类侧独立授权位（天花板恒 read，不可配 write）。 */
  setPreprocessEnabled(connectorId: string, enabled: boolean): Promise<ConnectorSetPreprocessResult>
  /** 断开：逐条删凭证 + 状态回 disconnected；**工具清单与 per-tool 配置保留**。 */
  disconnect(connectorId: string): Promise<ConnectorDisconnectResult>
}

export interface ConnectorOAuthStartResult {
  connector_id: string
  authorize_url: string
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

export interface ConnectorSetToolEnabledResult {
  connector_id: string
  tool_name: string
  enabled_override: boolean | null
  effective_enabled: boolean
}

export interface ConnectorSetPreprocessResult {
  connector_id: string
  preprocess_enabled: boolean
}

export interface ConnectorDisconnectResult {
  connector_id: string
  deleted_credentials: number
}
