import { useCallback, useEffect, useSyncExternalStore } from 'react'

import {
  getModelCatalogInfo,
  getModelCatalogRevision,
  subscribeModelCatalog
} from './lookup'
import { startModelCatalogUpdates } from './remote'

interface CatalogSyncState {
  refreshing: boolean
  lastError: string | null
  forceRefreshFn: (() => Promise<boolean>) | null
}

let syncState: CatalogSyncState = {
  refreshing: false,
  lastError: null,
  forceRefreshFn: null
}
const syncListeners = new Set<() => void>()

function emitSyncState(patch: Partial<CatalogSyncState>): void {
  syncState = { ...syncState, ...patch }
  for (const fn of syncListeners) fn()
}

function subscribeSyncState(listener: () => void): () => void {
  syncListeners.add(listener)
  return () => {
    syncListeners.delete(listener)
  }
}

function getSyncSnapshot(): CatalogSyncState {
  return syncState
}

export function useModelCatalogRevision(): number {
  return useSyncExternalStore(
    subscribeModelCatalog,
    getModelCatalogRevision,
    getModelCatalogRevision
  )
}

export function useModelCatalogUpdates(): void {
  useEffect(() => {
    const updater = startModelCatalogUpdates({
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value)
      },
      onError: (err) => {
        console.warn('[model-catalog] update unavailable', err)
        emitSyncState({ lastError: err instanceof Error ? err.message : String(err) })
      }
    })
    emitSyncState({
      forceRefreshFn: async () => {
        emitSyncState({ refreshing: true, lastError: null })
        try {
          return await updater.forceRefresh()
        } finally {
          emitSyncState({ refreshing: false })
        }
      }
    })
    const refresh = (): void => {
      void updater.refresh()
    }
    window.addEventListener('online', refresh)
    return () => {
      window.removeEventListener('online', refresh)
      updater.stop()
      emitSyncState({ forceRefreshFn: null, refreshing: false })
    }
  }, [])
}

export function useModelCatalogStatus(): {
  source: string
  generatedAt: string
  publishedAt: string | null
  isRemote: boolean
  refreshing: boolean
  lastError: string | null
  forceRefresh: () => Promise<boolean>
} {
  useModelCatalogRevision()
  const sync = useSyncExternalStore(subscribeSyncState, getSyncSnapshot, getSyncSnapshot)
  const info = getModelCatalogInfo()
  const forceRefreshFn = sync.forceRefreshFn

  const forceRefresh = useCallback(async (): Promise<boolean> => {
    if (forceRefreshFn) {
      return forceRefreshFn()
    }
    // 组件测试或尚未挂载全局 updater 时的兜底：发起一次独立刷新后释放 timer。
    emitSyncState({ refreshing: true, lastError: null })
    let transientError: string | null = null
    const temp = startModelCatalogUpdates({
      storage:
        typeof window !== 'undefined' && window.localStorage
          ? {
              getItem: (key) => window.localStorage.getItem(key),
              setItem: (key, value) => window.localStorage.setItem(key, value)
            }
          : undefined,
      onError: (err) => {
        transientError = err instanceof Error ? err.message : String(err)
      }
    })
    try {
      const ok = await temp.forceRefresh()
      emitSyncState({ refreshing: false, lastError: ok ? null : transientError })
      return ok
    } finally {
      temp.stop()
    }
  }, [forceRefreshFn])

  return {
    ...info,
    refreshing: sync.refreshing,
    lastError: sync.lastError,
    forceRefresh
  }
}
