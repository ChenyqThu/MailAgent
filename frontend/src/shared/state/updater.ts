// Sprint 8 §2.2 — renderer-side mirror of the main-process updater state.
//
// Subscribes to `updater:event` broadcast (via `useMailApi().updater.onEvent`)
// at mount, hydrates from `updater:status` synchronously, and exposes the
// store via zustand. UI components consume `useUpdater()` (a selector hook
// over the same store) the same way they consume `useMailbox()`.

import { create } from 'zustand'

import type { UpdaterStatus, UpdaterState } from '@shared/api/types'

interface UpdaterStore {
  status: UpdaterStatus
  setStatus: (next: UpdaterStatus) => void
}

const INITIAL: UpdaterStatus = {
  state: 'idle',
  currentVersion: '0.0.0',
  latestVersion: null,
  downloadPercent: null,
  message: null,
  updatedAt: 0
}

export const useUpdaterStore = create<UpdaterStore>((set) => ({
  status: INITIAL,
  setStatus: (next) => set({ status: next })
}))

export function setUpdaterStatus(next: UpdaterStatus): void {
  useUpdaterStore.getState().setStatus(next)
}

export type { UpdaterState, UpdaterStatus }
