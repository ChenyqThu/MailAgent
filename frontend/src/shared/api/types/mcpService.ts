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

export type McpClientTarget = 'claude_desktop' | 'claude_code' | 'cursor' | 'antigravity'

export type McpClientMode = 'http' | 'streamable_http' | 'sse' | 'stdio'

export interface McpWriteScopeOption {
  scope: string
  risk: McpScopeRisk
  kind?: 'write' | 'run'
}

export interface McpAvailableToolOption {
  name: string
  tool?: string
  title: string
  auth_scopes: string[]
}

/** `GET /scope-options`：基础档两项 + 可额外勾选的写权限 + Phase 5 细粒度只读/工具/TTL 选项。 */
export interface McpScopeOptions {
  bases: { id: McpKeyBase; scopes: string[] }[]
  extras: { scope: string; risk: McpScopeRisk }[]
  read_scopes?: string[]
  write_scopes?: McpWriteScopeOption[]
  available_tools?: McpAvailableToolOption[]
  ttl_presets_days?: (number | null)[]
  client_targets?: McpClientTarget[]
}

export interface McpServiceStatus {
  /** 本机 MCP 端点完整地址（含 `/mcp`）。 */
  local_url: string
  /** 本机 Streamable HTTP 端点（`<base>/mcp`）。 */
  streamable_http_url?: string
  /** 本机 Legacy HTTP+SSE 端点（`<base>/mcp/sse`）。 */
  sse_url?: string
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
  disabled_tools?: string[]
  write_rpm_limit?: number | null
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

export interface McpCreateKeyPolicyInput {
  label: string
  base?: McpKeyBase
  extra?: string[]
  scopes?: string[]
  ttl_days?: number | null
  disabled_tools?: string[]
  write_rpm_limit?: number | null
}

export interface McpUpdateKeyPolicyInput {
  base?: McpKeyBase
  extra?: string[]
  scopes?: string[]
  ttl_days?: number | null
  expires_at?: number | null
  disabled_tools?: string[]
  write_rpm_limit?: number | null
}

export interface McpWriteClientConfigInput {
  target: McpClientTarget
  mode: McpClientMode
  server_name?: string
  api_key?: string
  api_base?: string
  dry_run?: boolean
}

export interface McpWriteClientConfigResult {
  target: McpClientTarget
  mode: McpClientMode
  server_name: string
  path: string
  exists: boolean
  dry_run: boolean
  wrote: boolean
  backup_path: string | null
  snippet: Record<string, unknown>
  preview: string
}

export interface McpServiceApi {
  status(): Promise<McpServiceStatus>
  getScopeOptions(): Promise<McpScopeOptions>
  listKeys(): Promise<McpApiKey[]>
  createKey(label: string, base: McpKeyBase, extra: string[]): Promise<McpKeyWithPlaintext>
  /** 改已有密钥的权限：明文不变，下一次请求即按新权限生效。 */
  updateKeyScopes(id: string, base: McpKeyBase, extra: string[]): Promise<McpApiKey>
  /** Phase 5 (WP-5C) — 细粒度 scope + TTL + per-key 禁用工具 / 写限流 + 客户端一键写入。 */
  createKeyWithPolicy?(input: McpCreateKeyPolicyInput): Promise<McpKeyWithPlaintext>
  updateKeyPolicy?(id: string, patch: McpUpdateKeyPolicyInput): Promise<McpApiKey>
  writeClientConfig?(input: McpWriteClientConfigInput): Promise<McpWriteClientConfigResult>
  rotateKey(id: string): Promise<McpKeyWithPlaintext>
  revokeKey(id: string): Promise<McpApiKey>
  tools(): Promise<McpExposedTool[]>
  audit(limit?: number): Promise<McpAuditEntry[]>
  probe(url: string): Promise<McpProbeResult>
}
