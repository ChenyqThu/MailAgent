import { create } from 'zustand'

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
