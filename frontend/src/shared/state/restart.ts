// Sprint 18 §PR D / §PR E — pm2 restart-required banner state.
//
// 任何 env:set 返回 restartRequired=true → EnvField 调用 markRestartRequired
// 把 changedKeys merge 到 store; RestartBanner (PR E) 订阅 required 字段决定
// banner visible. 用户点 "立即重启" 触发 services:restart, restarting=true 期间
// 显示 spinner, 成功后 clearRestart() 隐 banner.
//
// changedKeys 用 Set 去重 — 用户连续改 3 个字段, banner 显示 "需要重启
// 才生效: MAIL_INBOX_NAME, RADAR_POLL_INTERVAL, FEISHU_NOTIFY_ENABLED" 而不
// 是 "MAIL_INBOX_NAME, MAIL_INBOX_NAME, RADAR_POLL_INTERVAL".

import { create } from 'zustand'

interface RestartStore {
  required: boolean
  changedKeys: string[]
  restarting: boolean
  lastRestartAt: number | null
  lastError: string | null

  markRestartRequired(keys: string[]): void
  clearRestart(): void
  setRestarting(b: boolean): void
  setRestartError(message: string | null): void
  setLastRestartAt(ts: number): void
}

export const useRestartStore = create<RestartStore>((set, get) => ({
  required: false,
  changedKeys: [],
  restarting: false,
  lastRestartAt: null,
  lastError: null,

  markRestartRequired(keys) {
    if (keys.length === 0) return
    const merged = new Set<string>(get().changedKeys)
    for (const k of keys) merged.add(k)
    set({ required: true, changedKeys: Array.from(merged) })
  },

  clearRestart() {
    set({ required: false, changedKeys: [], lastError: null })
  },

  setRestarting(b) {
    set({ restarting: b })
  },

  setRestartError(message) {
    set({ lastError: message })
  },

  setLastRestartAt(ts) {
    set({ lastRestartAt: ts })
  }
}))
