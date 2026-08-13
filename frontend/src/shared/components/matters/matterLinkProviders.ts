// G-14 tab ②「链接粘贴」的 provider 识别 + 连接态判定单源。
//
// 🔴 与设计原型 `pickers.jsx` 的 `PROVIDERS` 表的两处**有意偏离**：
//   ① 原型每家写死 `conn: true/false`（mock 常量）。这里的连接态**只来自** MCP connector
//      真实状态（`useConnectorQuickRows`）；拿不到就说中性话，绝不渲染假的「已连接」。
//   ② 原型给每家画品牌 logo。本仓政策是中性 lucide 图标 —— 自绘品牌 SVG 会引入无授权资产
//      （见 matterResource.ts `DOC_PROVIDER_ICONS` 上方的注释）。
//
// 🔴 落库形状与识别结果**解耦**：不管识别成哪家，粘贴进来的链接一律存成既有的
// `provider='web'` + `kind='url'`（`resource_proposal.py` 的 WEB_PROVIDER 约定）。识别只用于
// 显示「这看起来是一份 Notion 文档」，不是「这条资料归 Notion connector 管」—— 后者需要真实的
// 实体 id（`page:<uuid>` 那种形状），从 URL 猜出来的 id 会造出一条永远验不了的资料。

import { BookOpen, FileText, GitBranch, Globe, Layers, type LucideIcon } from 'lucide-react'

export type MatterLinkProviderKey =
  | 'notion'
  | 'confluence'
  | 'jira'
  | 'feishu'
  | 'googleDocs'
  | 'figma'
  | 'github'
  | 'web'

export interface MatterLinkProvider {
  key: MatterLinkProviderKey
  icon: LucideIcon
  /** 对应的 MCP connector 行 id（`src/connectors/catalog.py` 的键）。
   *  null = 本仓的 connector 目录里没有这家 —— 连接态无从谈起，只说中性话。 */
  connectorId: string | null
  test: RegExp
}

/** 顺序即优先级；最后一条 `web` 是兜底（`test` 恒真）。 */
export const MATTER_LINK_PROVIDERS: readonly MatterLinkProvider[] = [
  { key: 'notion', icon: FileText, connectorId: 'notion', test: /(^|\.)notion\.(so|site)$/i },
  { key: 'confluence', icon: BookOpen, connectorId: 'atlassian', test: /(^|\.)atlassian\.net$/i },
  // Jira 与 Confluence 同域（`*.atlassian.net`），靠路径分。故 Jira 这条必须排在前面判路径，
  // 见 `detectMatterLinkProvider`：它先按 host 找候选，再对 atlassian 家按路径细分。
  { key: 'jira', icon: Layers, connectorId: 'atlassian', test: /(^|\.)atlassian\.net$/i },
  { key: 'feishu', icon: FileText, connectorId: null, test: /(^|\.)(feishu\.cn|larksuite\.com)$/i },
  {
    key: 'googleDocs',
    icon: FileText,
    connectorId: 'googledrive',
    test: /(^|\.)docs\.google\.com$/i
  },
  { key: 'figma', icon: Layers, connectorId: 'figma', test: /(^|\.)figma\.com$/i },
  { key: 'github', icon: GitBranch, connectorId: 'github', test: /(^|\.)github\.com$/i },
  { key: 'web', icon: Globe, connectorId: null, test: /./ }
]

const WEB_PROVIDER = MATTER_LINK_PROVIDERS[MATTER_LINK_PROVIDERS.length - 1]

/** 一行输入是不是一条像样的链接。裸域名（`notion.so/x`）也算 —— 用户粘贴时常常丢了协议。 */
export function isMatterLinkUrlish(value: string): boolean {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(value.trim())
}

function parseUrl(raw: string): URL | null {
  const value = raw.trim()
  if (!value) return null
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
}

export function detectMatterLinkProvider(raw: string): MatterLinkProvider {
  const url = parseUrl(raw)
  if (!url) return WEB_PROVIDER
  const host = url.hostname
  const isAtlassian = /(^|\.)atlassian\.net$/i.test(host)
  if (isAtlassian) {
    // `/wiki/...` = Confluence，其余（`/browse/ABC-1`、`/jira/...`）当 Jira。
    const key: MatterLinkProviderKey = /^\/wiki(\/|$)/i.test(url.pathname) ? 'confluence' : 'jira'
    return MATTER_LINK_PROVIDERS.find((entry) => entry.key === key) ?? WEB_PROVIDER
  }
  return MATTER_LINK_PROVIDERS.find((entry) => entry.test.test(host)) ?? WEB_PROVIDER
}

/** 规范化成落库用的 canonical url（补协议、去 hash）。解析不了就原样交出去。 */
export function normalizeMatterLinkUrl(raw: string): string {
  const url = parseUrl(raw)
  if (!url) return raw.trim()
  url.hash = ''
  return url.toString()
}

/** 从链接推一个可读标题：末段 path → 去掉尾部 hash 串 → 分词。推不出就用主机名。 */
export function deriveMatterLinkTitle(raw: string): string {
  const url = parseUrl(raw)
  if (!url) return raw.trim()
  const segment = url.pathname.split('/').filter(Boolean).pop()
  if (!segment) return url.hostname
  let text = segment
  try {
    text = decodeURIComponent(segment)
  } catch {
    /* 非法百分号转义：用原串，别炸 */
  }
  text = text
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/-[0-9a-f]{8,}$/i, '')
    .replace(/[-_+]+/g, ' ')
    .trim()
  return text.length > 2 ? text : url.hostname
}

/** provider 的连接态。`unknown` 是**默认**：闸关 / 还没取到 / 这家根本没有 connector。 */
export type MatterLinkConnectionState = 'unknown' | 'connected' | 'disconnected'

export interface MatterLinkConnectionInput {
  connectorId: string | null
  /** `MAILAGENT_MCP_CONNECTORS` 投影；`undefined` = 还不知道 ⇒ 按未知处理。 */
  flagEnabled: boolean | undefined
  /** connector 行是否已经取回来了（在途/未发时为 false）。 */
  rowsLoaded: boolean
  rows: ReadonlyArray<{ connector_id: string; enabled: boolean; status: string }>
}

/** 🔴 判定纪律：
 *  · 没有 connectorId（网页 / 飞书）→ 恒 `unknown`，连接与否与它无关。
 *  · flag 未知或 off → `unknown`（此时一个 `/api/connector/*` 请求都没发过，谈不上判断）。
 *  · 行还没回来 → `unknown`（在数据到达前说「未连接」，有一半时间是错的）。
 *  · 行回来了：`enabled && status==='connected'` 才算 `connected`，其余一律 `disconnected`。 */
export function matterLinkConnectionState({
  connectorId,
  flagEnabled,
  rowsLoaded,
  rows
}: MatterLinkConnectionInput): MatterLinkConnectionState {
  if (!connectorId) return 'unknown'
  if (flagEnabled !== true) return 'unknown'
  if (!rowsLoaded) return 'unknown'
  const row = rows.find((entry) => entry.connector_id === connectorId)
  return row && row.enabled && row.status === 'connected' ? 'connected' : 'disconnected'
}
