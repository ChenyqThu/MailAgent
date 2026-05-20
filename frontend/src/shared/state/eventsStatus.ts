// Sprint 16 — events bridge connection state store.
//
// `useEventBridge` hook 在 App 根 mount 时初始化, 之后通过 mailApi.events.onStatus
// 持续同步 main 进程 SSE 状态. SettingsPage / usePollingFallback / TitleBar 等
// 订阅本 store 决定 UI 显示和 fallback polling 是否启用.
//
// 默认值是 'idle' — App 刚 mount 还没收到任何 status 时,假设 SSE 还在连接中,
// usePollingFallback 在 idle 状态会启用 fallback polling 作为兜底, 避免 UI 完全
// 死寂. SSE connected 后 fallback polling 关.

import { create } from 'zustand'

import type { EventsStatus, EventsConnectionState } from '@shared/api/types'

interface Store {
  status: EventsStatus
  isConnected(): boolean
  setStatus(s: EventsStatus): void
}

const DEFAULT_STATUS: EventsStatus = {
  state: 'idle',
  lastError: null,
  lastEventTs: null,
  url: ''
}

function isConnectedState(s: EventsConnectionState): boolean {
  return s === 'connected'
}

export const useEventsStatusStore = create<Store>((set, get) => ({
  status: DEFAULT_STATUS,
  isConnected: () => isConnectedState(get().status.state),
  setStatus(s) {
    set({ status: s })
  }
}))
