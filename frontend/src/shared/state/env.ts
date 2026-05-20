// Sprint 18 §PR D — repo-root .env zustand store.
//
// SettingsShell mount 时调 `useEnvStore.getState().refresh()` 拉一次
// IPC env:get 缓存 values + secretKeys 到 store; 每个 EnvField mount
// 读 store 拿 value, blur 时调 env:set 落盘 + setLocal 更新 store
// 乐观值. 跨 Tab 切换 (Radix Tabs unmount) 不丢值, refresh 仅在 first
// mount 与显式 refresh action 时触发.
//
// SECRET keys 在 store 里 value 始终是 '***' (set) 或 '' (unset);
// EnvSecretField 的 reveal toggle 不会从 store 读明文 — 明文从未
// crosses IPC.

import { create } from 'zustand'

import type { EnvSnapshot, EnvSetResult } from '@shared/api/types'
// `makeMailApi` is the factory singleton; `useMailApi` (the hook) wraps it
// for component-side consumption. Store-internal actions like `refresh()`
// and the module-level `applyEnvPatch` are NOT React Hooks — calling the
// hook from here trips react-hooks/rules-of-hooks. Reach for the factory
// directly so the linter understands the call site is a plain function.
import { makeMailApi } from '@shared/api/factory'

export type EnvStoreState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; snapshot: EnvSnapshot }
  | { status: 'error'; error: string }

interface EnvStore {
  state: EnvStoreState
  /** Force refresh from IPC. Safe to call repeatedly — concurrent refreshes
   *  share the same in-flight promise via the `_pending` guard. */
  refresh(): Promise<void>
  /** Optimistic local update — used after a successful env:set so the next
   *  render shows the new value without waiting for a fresh env:get round-
   *  trip. SECRET keys are renormalised to '***' so the renderer never sees
   *  plaintext via the store. */
  setLocal(key: string, value: string): void
  /** Remove a key from the in-store values map (used after env:set null
   *  comments-out the line). */
  unsetLocal(key: string): void
  /** Convenience read — null when store hasn't loaded or the key is absent. */
  getValue(key: string): string | null
  /** Whether `key` is in SECRET_ENV_KEYS as reported by the snapshot. Used
   *  by EnvField to decide reveal-toggle visibility + the `***` placeholder. */
  isSecret(key: string): boolean
  /** Whether the key has any value stored (active in .env). For secrets,
   *  this means "set in keytar / env" without revealing the plaintext. */
  hasValue(key: string): boolean
}

let _pending: Promise<void> | null = null

export const useEnvStore = create<EnvStore>((set, get) => ({
  state: { status: 'idle' },

  async refresh() {
    if (_pending) return _pending
    set({ state: { status: 'loading' } })
    const api = makeMailApi()
    _pending = (async () => {
      try {
        const snap = await api.env.get()
        set({ state: { status: 'ready', snapshot: snap } })
      } catch (err) {
        const message = (err as Error).message
        set({ state: { status: 'error', error: message } })
      } finally {
        _pending = null
      }
    })()
    return _pending
  },

  setLocal(key, value) {
    const cur = get().state
    if (cur.status !== 'ready') return
    const isSecret = cur.snapshot.secretKeys.includes(key)
    const stored = isSecret ? (value.length > 0 ? '***' : '') : value
    set({
      state: {
        status: 'ready',
        snapshot: {
          ...cur.snapshot,
          values: { ...cur.snapshot.values, [key]: stored }
        }
      }
    })
  },

  unsetLocal(key) {
    const cur = get().state
    if (cur.status !== 'ready') return
    const nextValues = { ...cur.snapshot.values }
    delete nextValues[key]
    set({
      state: {
        status: 'ready',
        snapshot: { ...cur.snapshot, values: nextValues }
      }
    })
  },

  getValue(key) {
    const cur = get().state
    if (cur.status !== 'ready') return null
    return cur.snapshot.values[key] ?? null
  },

  isSecret(key) {
    const cur = get().state
    if (cur.status !== 'ready') return false
    return cur.snapshot.secretKeys.includes(key)
  },

  hasValue(key) {
    const cur = get().state
    if (cur.status !== 'ready') return false
    const v = cur.snapshot.values[key]
    return v !== undefined && v.length > 0
  }
}))

/** Helper to chain env:set → setLocal optimistic update. Returns the IPC
 *  envelope so the caller can branch on `restartRequired` etc. */
export async function applyEnvPatch(patch: Record<string, string | null>): Promise<EnvSetResult> {
  const api = makeMailApi()
  const result = await api.env.set(patch)
  if (result.ok) {
    const store = useEnvStore.getState()
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) store.unsetLocal(key)
      else store.setLocal(key, value)
    }
  }
  return result
}
