import { useEffect, useSyncExternalStore } from 'react'

import { getModelCatalogRevision, subscribeModelCatalog } from './lookup'
import { startModelCatalogUpdates } from './remote'

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
      }
    })
    const refresh = (): void => {
      void updater.refresh()
    }
    window.addEventListener('online', refresh)
    return () => {
      window.removeEventListener('online', refresh)
      updater.stop()
    }
  }, [])
}
