// 设置 →「MCP 服务」数据层类型 —— serve-api `/api/mcp-service/*` 的 wire 形状。
//
// 🔴 字段名保持服务端 snake_case 原样（同 types/connector.ts）：对象整体来自
// `src/api/routers/mcp_service.py` 的 success_envelope，没有映射层。
// 时间字段一律是 epoch **秒**（`api_auth.db` 的 `_now()` = `int(time.time())`）。

/** 后端 `KEY_PRESETS` 的全部预设名。`writer` 只能经 CLI 建（含 `email:write`），
 *  列表里仍可能出现。 */
export type McpKeyPresetName = 'readonly' | 'handoff' | 'drafter' | 'writer'

/** 设置页可新建的三档（`writer` 不提供：`email_send` 不投 MCP）。 */
export type McpUiKeyPreset = 'readonly' | 'handoff' | 'drafter'

export interface McpServiceStatus {
  /** 本机 MCP 端点完整地址（含 `/mcp`）。 */
  local_url: string
  /** `MAILAGENT_MCP_PUBLIC_URL`；未设为空串或 null。 */
  public_url: string | null
  active_key_count: number
}

/** 密钥列表项。🔴 永不含明文与 hash。 */
export interface McpApiKey {
  id: string
  label: string
  key_prefix: string
  scopes: string[]
  /** scopes 与某个预设逐字相等时为该名，否则 null（显示「自定义」）。 */
  preset: McpKeyPresetName | null
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  revoked_at: number | null
  active: boolean
}

/** 新建 / 轮换的返回：明文只在这一次响应里出现。 */
export interface McpKeyWithPlaintext {
  key: McpApiKey
  plaintext: string
}

export interface McpToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface McpExposedTool {
  /** MCP 工具名（`mailagent_<tool>`）。 */
  name: string
  title: string
  description: string
  annotations: McpToolAnnotations
  auth_scopes: string[]
  /** 能看到这个工具的 UI 预设。 */
  presets: McpUiKeyPreset[]
}

export interface McpAuditEntry {
  id: number
  created_at: number
  key_id: string | null
  key_label: string | null
  route: string
  skill: string | null
  tool: string | null
  /** `'ok'` | `'error'`（src/api/routers/skills.py 的 `_audit`）。 */
  status: string
  error_code: string | null
  duration_ms: number | null
}

export type McpProbeResultValue = 'reachable' | 'access_blocked' | 'unreachable'

export interface McpProbeResult {
  result: McpProbeResultValue
  detail: string
}

export interface McpServiceApi {
  status(): Promise<McpServiceStatus>
  listKeys(): Promise<McpApiKey[]>
  createKey(label: string, preset: McpUiKeyPreset): Promise<McpKeyWithPlaintext>
  rotateKey(id: string): Promise<McpKeyWithPlaintext>
  revokeKey(id: string): Promise<McpApiKey>
  tools(): Promise<McpExposedTool[]>
  audit(limit?: number): Promise<McpAuditEntry[]>
  probe(url: string): Promise<McpProbeResult>
}
