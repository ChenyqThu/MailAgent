// 设置 →「MCP 服务」数据层类型 —— serve-api `/api/mcp-service/*` 的 wire 形状。
//
// 🔴 字段名保持服务端 snake_case 原样（同 types/connector.ts）：对象整体来自
// `src/api/routers/mcp_service.py` 的 success_envelope，没有映射层。
// 时间字段一律是 epoch **秒**（`api_auth.db` 的 `_now()` = `int(time.time())`）。

/** 后端 `KEY_PRESETS` 的全部预设名。`writer` 只能经 CLI 建（含 `email:write`），
 *  列表里仍可能出现。 */
export type McpKeyPresetName = 'readonly' | 'handoff' | 'drafter' | 'writer'

/** `GET /tools` 里每个工具的 `presets` 取值（后端 `UI_KEY_PRESETS`）。 */
export type McpUiKeyPreset = 'readonly' | 'handoff' | 'drafter'

/** 设置页新建 / 修改权限时的基础档。 */
export type McpKeyBase = 'readonly' | 'handoff'

export type McpScopeRisk = 'low' | 'high'

/** `GET /scope-options`：基础档两项 + 可额外勾选的写权限（顺序即展示顺序）。 */
export interface McpScopeOptions {
  bases: { id: McpKeyBase; scopes: string[] }[]
  extras: { scope: string; risk: McpScopeRisk }[]
}

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
  /** scopes 与某个预设逐字相等时为该名，否则 null。 */
  preset: McpKeyPresetName | null
  /** scopes 拆成「基础档 + 额外写权限」；拆不开时 `custom=true`、`base=null`、`extra=[]`。 */
  base: McpKeyBase | null
  extra: string[]
  /** 由 CLI `--scopes` 等建出、拆不成基础档 + 额外权限的组合：设置页不提供修改权限。 */
  custom: boolean
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
  getScopeOptions(): Promise<McpScopeOptions>
  listKeys(): Promise<McpApiKey[]>
  createKey(label: string, base: McpKeyBase, extra: string[]): Promise<McpKeyWithPlaintext>
  /** 改已有密钥的权限：明文不变，下一次请求即按新权限生效。 */
  updateKeyScopes(id: string, base: McpKeyBase, extra: string[]): Promise<McpApiKey>
  rotateKey(id: string): Promise<McpKeyWithPlaintext>
  revokeKey(id: string): Promise<McpApiKey>
  tools(): Promise<McpExposedTool[]>
  audit(limit?: number): Promise<McpAuditEntry[]>
  probe(url: string): Promise<McpProbeResult>
}
