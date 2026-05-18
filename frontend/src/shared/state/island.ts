// Sprint 9 §2.3 — Island connection status zustand store.
//
// One renderer-side shared truth for the ping-island bridge so TitleBar
// (right-cluster indicator) + SettingsPage (Island section) + future
// StatusBar surface all read from the same place. Updates flow through the
// `island:event` IPC broadcast (registered in main/handlers/island.ts);
// the first mount that subscribes also hydrates from `island:status` so
// the store leaves its idle seed even if no event has fired since boot.
//
// Pattern mirrors `state/updater.ts` for the auto-updater bridge: the
// store stays a passive mirror, all side-effects live in main.

import { create } from 'zustand'

import type { IslandStatus } from '@shared/api/types'

interface IslandStore {
  status: IslandStatus
}

const initialStatus: IslandStatus = {
  state: 'idle',
  socketPath: '/tmp/island.sock',
  lastProbeAt: null,
  lastError: null
}

export const useIslandStore = create<IslandStore>(() => ({
  status: initialStatus
}))

/** Bulk-replace the status snapshot. Called by:
 *   - SettingsPage / TitleBar useEffect on mount → hydrate via island.status()
 *   - island.onEvent subscription whenever main broadcasts a new status */
export function setIslandStatus(next: IslandStatus): void {
  useIslandStore.setState({ status: next })
}

/** Convenience helper for components that only care about the coarse state. */
export function useIslandState(): IslandStatus['state'] {
  return useIslandStore((s) => s.status.state)
}

/** Map kebab-case wire states to camelCase i18n key suffixes. react-i18next
 *  treats `.` as the key separator so `dev-disabled` would resolve against
 *  a non-existent path; we centralise the conversion here so TitleBar +
 *  SettingsPage stay in lockstep. */
export function islandStateI18nKey(state: IslandStatus['state']): string {
  switch (state) {
    case 'dev-disabled':
      return 'devDisabled'
    default:
      return state
  }
}
