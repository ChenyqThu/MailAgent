// MCP connector 数据层（08-01 阶段 1 PR4）—— serve-api `/api/connector/*` 的薄 fetch 面。
//
// 样板 = chat_api.ts：每个方法直接 `request()`，envelope 解包与 `Error & {code}` 抛出都在
// http_client 一处。🔴 **不吞错、不降级返回空** —— 设置面要能把 flag 关
// （E_CONNECTOR_DISABLED / 409）、未连接（E_CONNECTOR_NOT_CONNECTED）、网络炸
// （E_NETWORK）分别渲染成不同的话；一律 catch 成 `[]` 会把「关着」说成「没有连接器」。
//
// baseUrl 与 chat 同源（web = HttpApi baseUrl，electron = loopback serve-api），故这里的
// path 不带 `/api` 前缀。
//
// 🔴 不变式：零 Electron import（pnpm build:web 验）。只引 shared/api。

import { request } from './http_client'
import type {
  ComposioKeyStatus,
  ConnectorApi,
  ConnectorBulkToolModeResult,
  ConnectorCatalogView,
  ConnectorCrudType,
  ConnectorDisconnectResult,
  ConnectorOAuthStartResult,
  ConnectorSetEnabledResult,
  ConnectorSetPreprocessResult,
  ConnectorPurgeOrphansResult,
  ConnectorSetToolModeResult,
  ConnectorStatusView,
  ConnectorSummary,
  ConnectorSyncResult,
  ConnectorToolMode,
  ConnectorToolSummary
} from './types/connector'

/** connector id 与工具名进 URL 路径 —— 工具名来自远端 manifest（可能带 `/` 或空格），
 *  必须 encode；connector id 同样 encode（值虽来自 registry 白名单，但拼 URL 的地方
 *  不该依赖调用方自觉）。 */
function seg(value: string): string {
  return encodeURIComponent(value)
}

export function createConnectorApi(baseUrl: string): ConnectorApi {
  return {
    list(): Promise<ConnectorSummary[]> {
      // 信封内还套一层 {connectors}（服务端留了加 meta 的余地）→ 这里解到数组。
      return request<{ connectors: ConnectorSummary[] }>(baseUrl, 'GET', '/connector').then(
        (d) => d.connectors
      )
    },

    catalog(): Promise<ConnectorCatalogView> {
      // 固定路径段 `catalog` 与 `/{connector_id}/…` 不同形（少一段），不会撞 connector id。
      return request<ConnectorCatalogView>(baseUrl, 'GET', '/connector/catalog')
    },

    setComposioKey(apiKey: string): Promise<ComposioKeyStatus> {
      // 🔴 key 只在这一次请求体里出现；响应恒是脱敏状态（configured + updated_at）。
      return request<ComposioKeyStatus>(baseUrl, 'POST', '/connector/composio/key', {
        body: { api_key: apiKey }
      })
    },

    clearComposioKey(): Promise<ComposioKeyStatus> {
      return request<ComposioKeyStatus>(baseUrl, 'DELETE', '/connector/composio/key')
    },

    status(connectorId: string): Promise<ConnectorStatusView> {
      return request<ConnectorStatusView>(baseUrl, 'GET', `/connector/${seg(connectorId)}/status`)
    },

    oauthStart(connectorId: string): Promise<ConnectorOAuthStartResult> {
      // 服务端等「授权 URL 就绪」最多 30s（metadata 发现 + DCR），超时 → E_CONNECTOR_TIMEOUT。
      return request<ConnectorOAuthStartResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/oauth/start`
      )
    },

    sync(connectorId: string): Promise<ConnectorSyncResult> {
      return request<ConnectorSyncResult>(baseUrl, 'POST', `/connector/${seg(connectorId)}/sync`)
    },

    tools(connectorId: string): Promise<ConnectorToolSummary[]> {
      return request<{ tools: ConnectorToolSummary[] }>(
        baseUrl,
        'GET',
        `/connector/${seg(connectorId)}/tools`
      ).then((d) => d.tools)
    },

    setEnabled(connectorId: string, enabled: boolean): Promise<ConnectorSetEnabledResult> {
      return request<ConnectorSetEnabledResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/enabled`,
        { body: { enabled } }
      )
    },

    setToolMode(
      connectorId: string,
      toolName: string,
      mode: ConnectorToolMode | null
    ): Promise<ConnectorSetToolModeResult> {
      // 🔴 `mode: null` 是**清除覆盖回默认档（auto）**，不是「off」——键必须在场（服务端
      // 缺键 400，不把「没说」当 null 猜），故这里恒显式带上它。
      return request<ConnectorSetToolModeResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/tools/${seg(toolName)}/mode`,
        { body: { mode } }
      )
    },

    bulkSetToolMode(
      connectorId: string,
      mode: ConnectorToolMode | null,
      crudType?: ConnectorCrudType
    ): Promise<ConnectorBulkToolModeResult> {
      // 固定路径段 `bulk_mode` 与 `/tools/{name}/mode` 不同形（少一段），不会撞工具名位。
      return request<ConnectorBulkToolModeResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/tools/bulk_mode`,
        { body: { mode, ...(crudType !== undefined ? { crud_type: crudType } : {}) } }
      )
    },

    setPreprocessEnabled(
      connectorId: string,
      enabled: boolean
    ): Promise<ConnectorSetPreprocessResult> {
      return request<ConnectorSetPreprocessResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/preprocess`,
        { body: { enabled } }
      )
    },

    disconnect(connectorId: string, purge = false): Promise<ConnectorDisconnectResult> {
      // 🔴 `purge` 恒显式发（缺省 false）：删配置这件事不能靠「没说 = 不删」的默认约定，
      // 请求体里看得见才好排查。
      return request<ConnectorDisconnectResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/disconnect`,
        { body: { purge } }
      )
    },

    purgeOrphans(connectorId: string): Promise<ConnectorPurgeOrphansResult> {
      // 🔴 固定路径段 `purge_orphans` 排在 `/tools/{name}/enabled` 之后 —— 它不是工具名位，
      // 故不走 seg()（一个真叫 "purge_orphans" 的远端工具也不会撞：那条路径多一段）。
      return request<ConnectorPurgeOrphansResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/tools/purge_orphans`
      )
    }
  }
}
