import { MATTER_TAG_DEFAULT_COLOR, MATTER_TAG_DEFAULT_SHAPE } from '@shared/api/types/matter'
import type { MatterTagDefinition, MattersApi } from '@shared/api/types/matter'

export const MATTER_TAGS_QUERY_KEY = ['matters', 'tags'] as const

export function normalizeMatterTagInput(value: string): string {
  return value.trim().replace(/^#/, '')
}

export function fallbackMatterTag(name: string): MatterTagDefinition {
  return {
    name,
    color: MATTER_TAG_DEFAULT_COLOR,
    shape: MATTER_TAG_DEFAULT_SHAPE,
    created_at: null,
    usage_count: 0,
    inferred: true
  }
}

export function mergeMatterTagDefinitions(
  definitions: readonly MatterTagDefinition[],
  names: readonly string[] = []
): MatterTagDefinition[] {
  const merged = new Map<string, MatterTagDefinition>()
  for (const definition of definitions) merged.set(definition.name, definition)
  for (const rawName of names) {
    const name = normalizeMatterTagInput(rawName)
    if (name && !merged.has(name)) merged.set(name, fallbackMatterTag(name))
  }
  return [...merged.values()]
}

export function matterTagMap(
  definitions: readonly MatterTagDefinition[]
): Map<string, MatterTagDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition]))
}

export function resolveMatterTag(
  definitions: ReadonlyMap<string, MatterTagDefinition>,
  name: string
): MatterTagDefinition {
  return definitions.get(name) ?? fallbackMatterTag(name)
}

export async function listMatterTagsSafely(
  api: MattersApi
): Promise<{ items: MatterTagDefinition[] }> {
  const candidate = api as MattersApi & { listTags?: MattersApi['listTags'] }
  if (typeof candidate.listTags !== 'function') return { items: [] }
  return candidate.listTags()
}
