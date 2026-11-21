import { create } from 'zustand'

import {
  IDLE_COMPUTER_USE_ACTIVITY,
  type ComputerUseActivityState
} from '@shared/computerUseOverlayContract'
import { selectActiveTab, useTabWorkspace } from './tab-workspace'

const WIDTH_STORAGE_KEY = 'mailagent:managed-browser:width'
export const DEFAULT_BROWSER_SIDEBAR_WIDTH = 520
export const MIN_BROWSER_SIDEBAR_WIDTH = 360
export const MAX_BROWSER_SIDEBAR_WIDTH = 880

export function clampBrowserSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_BROWSER_SIDEBAR_WIDTH
  return Math.min(MAX_BROWSER_SIDEBAR_WIDTH, Math.max(MIN_BROWSER_SIDEBAR_WIDTH, Math.round(width)))
}

function readPersistedWidth(): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return DEFAULT_BROWSER_SIDEBAR_WIDTH
    }
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY)
    if (!raw) return DEFAULT_BROWSER_SIDEBAR_WIDTH
    return clampBrowserSidebarWidth(Number(raw))
  } catch {
    return DEFAULT_BROWSER_SIDEBAR_WIDTH
  }
}

function writePersistedWidth(width: number): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width))
    }
  } catch {
    /* ignore storage failures */
  }
}

export interface ManagedBrowserUiState {
  sidebarOpen: boolean
  sidebarWidth: number
  dismissedRunId: string | null
  activity: ComputerUseActivityState
  openSidebar: () => void
  closeSidebar: () => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setActivity: (next: ComputerUseActivityState) => void
}

export const useManagedBrowserUi = create<ManagedBrowserUiState>((set) => ({
  sidebarOpen: false,
  sidebarWidth: readPersistedWidth(),
  dismissedRunId: null,
  activity: IDLE_COMPUTER_USE_ACTIVITY,

  openSidebar: () =>
    set({
      sidebarOpen: true,
      dismissedRunId: null
    }),

  closeSidebar: () =>
    set((state) => ({
      sidebarOpen: false,
      dismissedRunId: state.activity.active ? state.activity.runId : state.dismissedRunId
    })),

  toggleSidebar: () =>
    set((state) => {
      const nextOpen = !state.sidebarOpen
      return {
        sidebarOpen: nextOpen,
        dismissedRunId: nextOpen
          ? null
          : state.activity.active
            ? state.activity.runId
            : state.dismissedRunId
      }
    }),

  setSidebarWidth: (width: number) => {
    const clamped = clampBrowserSidebarWidth(width)
    writePersistedWidth(clamped)
    set({ sidebarWidth: clamped })
  },

  setActivity: (next: ComputerUseActivityState) =>
    set((state) => {
      if (!next.active) {
        return {
          activity: next,
          dismissedRunId: null
        }
      }
      const isBrowserTabActive = selectActiveTab(useTabWorkspace.getState())?.kind === 'browser'
      const shouldAutoOpen =
        next.surface === 'browser' && !isBrowserTabActive && state.dismissedRunId !== next.runId
      return {
        activity: next,
        sidebarOpen: shouldAutoOpen ? true : state.sidebarOpen
      }
    })
}))
