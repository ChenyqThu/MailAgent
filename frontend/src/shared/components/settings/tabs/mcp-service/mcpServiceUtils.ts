// Pure utilities, constants, types, and non-UI hooks for McpServiceTab.

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import type { McpApiKey, McpProbeResult } from '@shared/api/types'
import { useEnvStore } from '@shared/state/env'

export const PUBLIC_URL_ENV_KEY = 'MAILAGENT_MCP_PUBLIC_URL'
export const AUDIT_LIMIT = 20

export function useEnvValue(key: string): string {
  return useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values[key] ?? '') : ''
  )
}

/** 同 RemoteAccessTab：仅显式 'false' / '0' 算关（默认开）。 */
export function isToggleOn(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v !== 'false' && v !== '0'
}

export function isNetworkError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'E_NETWORK'
}

export function formatEpoch(sec: number | null): string | null {
  if (sec == null) return null
  const d = new Date(sec * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

/** Notion「Custom MCP server」两个输入框照抄即可的文本。 */
export function buildNotionConfigText(url: string, plaintext: string): string {
  return `URL: ${url}\nAuthorization: Bearer ${plaintext}`
}

/** 从本机 `/mcp` 地址派生兼容的 `/mcp/sse` 地址（优先使用服务端下发的 `sse_url`）。 */
export function deriveSseUrl(localUrl: string, explicitSseUrl?: string | null): string {
  const trimmed = explicitSseUrl?.trim()
  if (trimmed) return trimmed
  try {
    const url = new URL(localUrl)
    const cleanPath = url.pathname.replace(/\/+$/, '')
    url.pathname = cleanPath.endsWith('/mcp') ? `${cleanPath}/sse` : `${cleanPath}/mcp/sse`
    return url.toString()
  } catch {
    const clean = localUrl.trim().replace(/\/+$/, '')
    return clean.endsWith('/mcp') ? `${clean}/sse` : `${clean}/mcp/sse`
  }
}

/** Claude Code / Cursor 等通用的 HTTP MCP 客户端配置。 */
export function buildHttpClientConfigText(url: string, plaintext: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mailagent: { type: 'http', url, headers: { Authorization: `Bearer ${plaintext}` } }
      }
    },
    null,
    2
  )
}

/** Legacy HTTP+SSE MCP 客户端配置。 */
export function buildSseClientConfigText(url: string, plaintext: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mailagent: { type: 'sse', url, headers: { Authorization: `Bearer ${plaintext}` } }
      }
    },
    null,
    2
  )
}

export function useCopy(): { copied: string | null; copy: (value: string, which: string) => void } {
  const [copied, setCopied] = React.useState<string | null>(null)
  const copy = React.useCallback((value: string, which: string): void => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(which)
        setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500)
      },
      () => {
        /* clipboard blocked — non-fatal, user can select manually */
      }
    )
  }, [])
  return { copied, copy }
}

/** 检测结果：只记最近一次，连同被检测的那个地址（弹窗的警示只认已保存地址的结果）。 */
export type ProbeState = { url: string; outcome: McpProbeResult | { error: string } }

export function isReachable(probe: ProbeState | null): boolean {
  return probe != null && 'result' in probe.outcome && probe.outcome.result === 'reachable'
}

export const CLOUDFLARE_TUNNEL_DOCS_URL =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/'

export type PublicUrlError = 'invalid' | 'notHttps' | 'loopback' | 'path'

/** 公网地址保存前的格式校验。空串合法（= 清空）。 */
export function validatePublicUrl(raw: string): PublicUrlError | null {
  if (raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (url.protocol !== 'https:') return 'notHttps'
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  ) {
    return 'loopback'
  }
  if (!url.pathname.endsWith('/mcp')) return 'path'
  return null
}

/** 本机地址里的端口（引导与「复制给 Agent」用真实端口，不写死 8200）。 */
export function portOf(localUrl: string): string {
  try {
    const url = new URL(localUrl)
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}

/** 已保存的合法公网地址取主机名；否则 null（调用方换成占位符）。 */
export function hostOf(publicUrl: string): string | null {
  if (publicUrl === '' || validatePublicUrl(publicUrl) !== null) return null
  return new URL(publicUrl).host
}

/** 新建 / 修改权限共用一个弹窗；`target` 在关闭后保留，退场动画期间文案不跳。 */
export type ScopesDialogTarget = { mode: 'create' } | { mode: 'edit'; key: McpApiKey }

/** 本地化连接（zh「A、B」/ en "A, B"）。 */
export function joinLabels(locale: string, labels: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(labels)
  } catch {
    return labels.join(', ')
  }
}

/** scope（如 `email:draft`）→ i18n key 段。`:` 是 i18next 的命名空间分隔符，不能原样进 key。 */
export function scopeI18nKey(scope: string, field: 'label' | 'desc'): string {
  return `settings.mcp.scopes.${scope.replace(/[^a-zA-Z0-9]/g, '_')}.${field}`
}

/** scope 的显示名与说明。没有文案的 scope（后端新加、前端还没翻译）显示原始 scope、不出说明。 */
export function useScopeText(): {
  label: (scope: string) => string
  desc: (scope: string) => string | null
} {
  const { t, i18n } = useTranslation()
  return {
    label: (scope) => {
      const key = scopeI18nKey(scope, 'label')
      return i18n.exists(key) ? t(key) : scope
    },
    desc: (scope) => {
      const key = scopeI18nKey(scope, 'desc')
      return i18n.exists(key) ? t(key) : null
    }
  }
}

export type KeyAction = 'rotate' | 'revoke'
