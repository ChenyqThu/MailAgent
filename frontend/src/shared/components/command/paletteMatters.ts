import type {
  Matter,
  MatterResourceLookupResponse,
  MatterSearchField
} from '@shared/api/types/matter'
import type { SearchHit } from '@shared/api/types'

export type PaletteScope = 'all' | 'email' | 'matter' | 'contact' | 'library'

export interface PaletteScopeVisibility {
  showEmail: boolean
  showMatter: boolean
  /** 通讯录 WP4「人」组：scope 'all' 与 'contact' 下可见。 */
  showContact: boolean
  /** 资料库第五 lane（P2-L7）：scope 'all' 与 'library' 下可见。 */
  showLibrary: boolean
  showNonProviderGroups: boolean
}

export interface MatterMatchDetail {
  field: MatterSearchField
  labelKey: string
  snippet: string
}

const MATTER_FIELD_LABEL_KEYS: Record<MatterSearchField, string> = {
  title: 'palette.matters.fields.title',
  description: 'palette.matters.fields.description',
  current_summary: 'palette.matters.fields.currentSummary',
  status: 'palette.matters.fields.status',
  items: 'palette.matters.fields.items',
  stakeholders: 'palette.matters.fields.stakeholders',
  notes: 'palette.matters.fields.notes'
}

export function matterFieldLabelKey(field: MatterSearchField): string {
  return MATTER_FIELD_LABEL_KEYS[field]
}

export function getMatterMatchDetails(
  matter: Pick<Matter, 'matched_fields' | 'snippets'>,
  limit = 2
): { details: MatterMatchDetail[]; overflow: number } {
  const fields = matter.matched_fields ?? []
  const details = fields.slice(0, limit).map((field) => ({
    field,
    labelKey: matterFieldLabelKey(field),
    snippet: matter.snippets?.[field] ?? ''
  }))
  return { details, overflow: Math.max(0, fields.length - details.length) }
}

export function paletteScopeVisibility(scope: PaletteScope): PaletteScopeVisibility {
  // 既有三档（all/email/matter）的可见性逐字不变；'contact' / 'library' 两档 = 只看
  // 自己那一组（镜像 'matter' 档只看事项组的语义：email/jump/actions 全藏）。
  const soloProvider = scope === 'contact' || scope === 'library'
  return {
    showEmail: scope !== 'matter' && !soloProvider,
    showMatter: scope !== 'email' && !soloProvider,
    showContact: scope === 'all' || scope === 'contact',
    showLibrary: scope === 'all' || scope === 'library',
    showNonProviderGroups: scope !== 'matter' && !soloProvider
  }
}

export function buildPaletteMatterLookupKeys(
  hits: readonly Pick<SearchHit, 'internal_id'>[],
  enabled: boolean
): string[] {
  if (!enabled) return []
  const keys: string[] = []
  const seen = new Set<number>()
  for (const hit of hits) {
    if (seen.has(hit.internal_id)) continue
    seen.add(hit.internal_id)
    keys.push(`email:${hit.internal_id}`)
    if (keys.length === 50) break
  }
  return keys
}

export function lookupMattersForEmail(
  response: MatterResourceLookupResponse | undefined,
  internalId: number
): MatterResourceLookupResponse['results'][string] {
  return response?.results[`email:${internalId}`] ?? []
}
