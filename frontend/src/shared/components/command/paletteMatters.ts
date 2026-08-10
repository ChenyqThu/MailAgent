import type {
  Matter,
  MatterResourceLookupResponse,
  MatterSearchField
} from '@shared/api/types/matter'
import type { SearchHit } from '@shared/api/types'

export type PaletteScope = 'all' | 'email' | 'matter'

export interface PaletteScopeVisibility {
  showEmail: boolean
  showMatter: boolean
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
  return {
    showEmail: scope !== 'matter',
    showMatter: scope !== 'email',
    showNonProviderGroups: scope !== 'matter'
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
