import { BookOpen, File, FileText, Link2, Mail, Users, type LucideIcon } from 'lucide-react'

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

// 资料图标单源。原本 MatterContextRail 里私有一份、抽屉里没有 —— 0811 dogfood 反馈
// 「文档样式不好」时下沉到这里，三处展示面（抽屉头 / 上下文标签列表 / rail 紧凑行）共用，
// 避免同一个 kind 在两处长得不一样。
export const RESOURCE_KIND_ICONS: Record<MatterResourceKind, LucideIcon> = {
  email: Mail,
  thread: Mail,
  event: Users,
  doc: FileText,
  file: File,
  url: Link2
}

// doc 再按 provider 细分，Notion 与 Confluence 一眼可辨。
// 🔴 有意用 lucide 中性图标而非品牌 logo —— 仓库的 brandIcons 只收了 LLM 厂商（逐字取自
// @lobehub/icons-static-svg，见 providers/NOTICE.md），自绘品牌 SVG 会引入无授权来源的资产。
export const DOC_PROVIDER_ICONS: Record<string, LucideIcon> = {
  confluence: BookOpen,
  atlassian: BookOpen
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
