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
  ConnectorApi,
  ConnectorDisconnectResult,
  ConnectorOAuthStartResult,
  ConnectorSetEnabledResult,
  ConnectorSetPreprocessResult,
  ConnectorSetToolEnabledResult,
  ConnectorStatusView,
  ConnectorSummary,
  ConnectorSyncResult,
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

    setToolEnabled(
      connectorId: string,
      toolName: string,
      enabled: boolean | null
    ): Promise<ConnectorSetToolEnabledResult> {
      // 🔴 `enabled: null` 是**清除覆盖回默认**，不是「关」——键必须在场（服务端缺键 400，
      // 不把「没说」当 null 猜），故这里恒显式带上它。
      return request<ConnectorSetToolEnabledResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/tools/${seg(toolName)}/enabled`,
        { body: { enabled } }
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

    disconnect(connectorId: string): Promise<ConnectorDisconnectResult> {
      return request<ConnectorDisconnectResult>(
        baseUrl,
        'POST',
        `/connector/${seg(connectorId)}/disconnect`
      )
    }
  }
}
