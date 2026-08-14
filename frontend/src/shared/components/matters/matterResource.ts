import {
  Calendar,
  FileText,
  GitBranch,
  Link,
  Mail,
  MessageSquare,
  Paperclip,
  type LucideIcon
} from 'lucide-react'

import {
  ConfluenceLogo,
  FigmaLogo,
  GoogleDriveLogo,
  NotionLogo,
  type AppLogoIcon
} from '@shared/components/icons/apps/appLogos'
import type {
  MatterResourceKind,
  MatterResourceLinkHit,
  MatterResourceListItem,
  MatterResourceLookupResponse
} from '@shared/api/types/matter'

export type MatterResourceGroupKey = 'mail' | 'meetings' | 'documents' | 'attachments'

export interface MatterResourceGroup {
  key: MatterResourceGroupKey
  kinds: MatterResourceKind[]
  items: MatterResourceListItem[]
}

export interface LinkedMatterSummary {
  publicId: string
  title: string
  status: MatterResourceLinkHit['status']
  health: MatterResourceLinkHit['health']
  priority: MatterResourceLinkHit['priority']
  archivedAt: number | null
  links: MatterResourceLinkHit[]
  subscription: MatterResourceLinkHit | null
}

const GROUP_KINDS: Array<[MatterResourceGroupKey, MatterResourceKind[]]> = [
  ['mail', ['email', 'thread']],
  ['meetings', ['event']],
  ['documents', ['doc']],
  ['attachments', ['file', 'url']]
]

export function groupMatterResources(items: MatterResourceListItem[]): MatterResourceGroup[] {
  return GROUP_KINDS.map(([key, kinds]) => ({
    key,
    kinds,
    items: items.filter((item) => kinds.includes(item.resource.kind))
  }))
}

export function isMatterResourceAvailable(item: MatterResourceListItem): boolean {
  return (
    item.available !== false && item.resource.available !== false && !item.resource.permission_state
  )
}

// 资料图标单源。原本右侧上下文栏里私有一份、抽屉里没有 —— 0811 dogfood 反馈
// 「文档样式不好」时下沉到这里，各展示面（抽屉头 / 上下文 tab 的资料行）共用，
// 避免同一个 kind 在两处长得不一样。（右栏 0812 已删，它那份消费点随之消失。）
// 逐项对照设计原型 helpers.jsx 的 `RES_KIND` 词表（右侧注释是原型写的语义名）。
// 🔴 改动前 6 项里 4 项与它不符，其中 event 用了 Users（干系人图标）表示"会议"是错位。
export const RESOURCE_KIND_ICONS: Record<MatterResourceKind, LucideIcon> = {
  email: Mail, // mail
  thread: MessageSquare, // message
  event: Calendar, // calendar
  doc: FileText, // filetext
  file: Paperclip, // paperclip
  url: Link // link
}

// doc 再按 provider 细分，用真实品牌 logo（批 8 / V3-19，反转此前「有意用 lucide 中性图标」
// 的决定 —— owner 拍板照设计稿做，条件是按 `brandIcons.tsx` 的既有先例落地并补商标声明，
// 见 `icons/apps/appLogos.tsx` + 同目录 NOTICE.md）。
//
// key 是 `resource.provider.toLowerCase()` 的**落库值**，不是展示层的识别 key —— 与
// `matterLinkProviders.ts` 的 8 家（`MATTER_LINK_PROVIDERS`，那是「粘贴链接时按域名识别出
// 哪一家」的展示层 key，如 camelCase 的 `googleDocs`）是两套不同用途的词表，命名风格也不同，
// 不要混用。这里的 key 集合 = 「跟进 Agent 提案会真的用到的 provider 值」（`resource_
// proposal.py::apply_allowed_providers` = builtin + `src/connectors/catalog.py` 的连接器
// 目录全集，即 `notion`/`atlassian`/`googledrive`/`figma`/`github`/… 这些**小写连字符**
// 连接器 id，不是 URL 域名识别出的那套 camelCase key）：
//   · `notion` / `figma` —— 连接器 id 与展示层 key 恰好同名，直接对应设计给的 logo。
//   · `atlassian` —— Atlassian 单个连接器同时覆盖 Confluence 与 Jira，`resource.provider`
//     只会是这一个值，落不到 `confluence`/`jira` 两个更精确的字面量；两者共用 Confluence 标
//     是近似选择（Atlassian 官方也没有一枚代表"两者都是"的通用图形），不是精确判定。
//     `confluence` 这个 key 仍留着（同一枚图）——万一未来某处显式产出这个更精确的字符串，
//     不必再改这张表。
//   · `googledrive` —— 连接器 id；Google 官方没有单独的「Google 文档」logo，落地用 Drive 标
//     （见 `appLogos.tsx` 的 `GoogleDriveLogo` 注释）。
//   · `github` —— 设计交付没有这家的 logo 资产，复用既有 lucide `GitBranch`（零新增成本，
//     与 `matterLinkProviders.ts` 里 github 的展示保持一致）。
export const DOC_PROVIDER_ICONS: Record<string, LucideIcon | AppLogoIcon> = {
  notion: NotionLogo,
  confluence: ConfluenceLogo,
  atlassian: ConfluenceLogo,
  googledrive: GoogleDriveLogo,
  figma: FigmaLogo,
  github: GitBranch
}

// 🔴 有意导出「表」而不是「查表函数」：eslint 的 react-hooks/static-components 不接受
// `const Icon = someFn(...)` —— 调用表达式无法被证明每次 render 返回同一个组件身份，会报
// 「Cannot create components during render」；成员索引（MAP[key]）可以。故调用点写成：
//   const Icon =
//     (kind === 'doc' && DOC_PROVIDER_ICONS[provider.toLowerCase()]) || RESOURCE_KIND_ICONS[kind]

export function buildMatterResourceLookupKeys(
  internalId: number | null,
  threadId: string | null | undefined
): string[] {
  const keys: string[] = []
  if (internalId !== null) keys.push(`email:${internalId}`)
  const normalizedThreadId = threadId?.trim()
  if (normalizedThreadId) keys.push(`thread:${normalizedThreadId}`)
  return keys
}

export function mergeMatterResourceLinkHits(
  response: MatterResourceLookupResponse | undefined,
  keys: readonly string[]
): LinkedMatterSummary[] {
  const byMatter = new Map<string, LinkedMatterSummary>()
  for (const key of keys) {
    for (const hit of response?.results[key] ?? []) {
      const existing = byMatter.get(hit.public_id)
      if (existing) {
        existing.links.push(hit)
        if (hit.sub_state !== 'none') existing.subscription = hit
        continue
      }
      byMatter.set(hit.public_id, {
        publicId: hit.public_id,
        title: hit.title,
        status: hit.status,
        health: hit.health,
        priority: hit.priority,
        archivedAt: hit.archived_at,
        links: [hit],
        subscription: hit.sub_state !== 'none' ? hit : null
      })
    }
  }
  return [...byMatter.values()]
}

export function deriveMatterLinkButtonState(count: number): 'unlinked' | 'single' | 'multiple' {
  if (count <= 0) return 'unlinked'
  if (count === 1) return 'single'
  return 'multiple'
}

export function stripEmailSubjectPrefix(subject: string): string {
  return subject.replace(/^\s*\[[^\]]+\]\s*/, '').trim()
}
