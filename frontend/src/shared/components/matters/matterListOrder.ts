import type { Matter } from '@shared/api/types/matter'
import { compareMatterRank } from '@shared/lib/matterDerive'
import type { MatterAttentionIndex } from '@shared/lib/matterDerive'

export function getOrderedVisibleMatters(
  matters: readonly Matter[],
  search: string,
  attention?: MatterAttentionIndex
): Matter[] {
  const query = search.trim().toLocaleLowerCase()
  return matters
    .filter((matter) => {
      if (!query) return true
      return [
        matter.title,
        matter.public_id,
        matter.description,
        matter.current_summary ?? '',
        ...matter.tags
      ]
        .join('\n')
        .toLocaleLowerCase()
        .includes(query)
    })
    .sort((left, right) => compareMatterRank(left, right, attention))
}
