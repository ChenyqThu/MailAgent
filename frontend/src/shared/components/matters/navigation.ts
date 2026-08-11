import { create } from 'zustand'

import type { MatterResourceListItem } from '@shared/api/types/matter'

interface MatterNavigationState {
  targetPublicId: string | null
  open(publicId: string): void
  clear(): void
}

export const useMatterNavigation = create<MatterNavigationState>((set) => ({
  targetPublicId: null,
  open: (targetPublicId) => set({ targetPublicId }),
  clear: () => set({ targetPublicId: null })
}))

export type MatterCitationTarget =
  | { kind: 'email'; emailId: number }
  | { kind: 'resource'; item: MatterResourceListItem }

export function resolveMatterCitationTarget(item: MatterResourceListItem): MatterCitationTarget {
  if (item.resource.kind === 'email' && item.resource.external_key.startsWith('email:')) {
    const emailId = Number(item.resource.external_key.slice('email:'.length))
    if (Number.isInteger(emailId) && emailId > 0) return { kind: 'email', emailId }
  }
  return { kind: 'resource', item }
}
