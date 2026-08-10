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
  return item.available !== false && item.resource.available !== false && !item.resource.permission_state
}

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
