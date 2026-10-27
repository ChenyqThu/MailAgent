// 设置 →「MCP 服务」数据层 —— serve-api `/api/mcp-service/*` 的薄 fetch 面。
//
// 样板 = connector_api.ts：每个方法直接 `request()`，envelope 解包与 `Error & {code}`
// 抛出都在 http_client 一处。🔴 不吞错、不降级返回空 —— 设置页靠 `E_NETWORK` 判断
// serve-api 没在跑，catch 成空数组会把「没在跑」说成「没有密钥」。
//
// baseUrl 与 connector 同源（web = HttpApi baseUrl，electron = loopback serve-api），
// path 不带 `/api` 前缀。
//
// 🔴 不变式：零 Electron import（pnpm build:web 验）。只引 shared/api。

import { request } from './http_client'
import type {
  McpApiKey,
  McpAuditEntry,
  McpExposedTool,
  McpKeyWithPlaintext,
  McpProbeResult,
  McpServiceApi,
  McpServiceStatus,
  McpUiKeyPreset
} from './types/mcpService'

const PREFIX = '/mcp-service'

export function createMcpServiceApi(baseUrl: string): McpServiceApi {
  return {
    status(): Promise<McpServiceStatus> {
      return request<McpServiceStatus>(baseUrl, 'GET', `${PREFIX}/status`)
    },

    listKeys(): Promise<McpApiKey[]> {
      return request<{ keys: McpApiKey[] }>(baseUrl, 'GET', `${PREFIX}/keys`).then((d) => d.keys)
    },

    createKey(label: string, preset: McpUiKeyPreset): Promise<McpKeyWithPlaintext> {
      return request<McpKeyWithPlaintext>(baseUrl, 'POST', `${PREFIX}/keys`, {
        body: { label, preset }
      })
    },

    rotateKey(id: string): Promise<McpKeyWithPlaintext> {
      return request<McpKeyWithPlaintext>(
        baseUrl,
        'POST',
        `${PREFIX}/keys/${encodeURIComponent(id)}/rotate`
      )
    },

    revokeKey(id: string): Promise<McpApiKey> {
      return request<{ key: McpApiKey }>(
        baseUrl,
        'POST',
        `${PREFIX}/keys/${encodeURIComponent(id)}/revoke`
      ).then((d) => d.key)
    },

    tools(): Promise<McpExposedTool[]> {
      return request<{ tools: McpExposedTool[] }>(baseUrl, 'GET', `${PREFIX}/tools`).then(
        (d) => d.tools
      )
    },

    audit(limit = 20): Promise<McpAuditEntry[]> {
      return request<{ entries: McpAuditEntry[] }>(baseUrl, 'GET', `${PREFIX}/audit`, {
        query: { limit }
      }).then((d) => d.entries)
    },

    probe(url: string): Promise<McpProbeResult> {
      return request<McpProbeResult>(baseUrl, 'POST', `${PREFIX}/probe`, { body: { url } })
    }
  }
}
