import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { startModelCatalogUpdates } from '../../shared/modelCatalog/remote'

/** The embedded gateway shares this process, including lookup's live catalog indexes. */
export function startMainModelCatalogUpdates(userData: string): () => void {
  const path = join(userData, 'model-catalog-cache-v1.json')
  const updater = startModelCatalogUpdates({
    storage: {
      getItem: () => {
        try {
          return readFileSync(path, 'utf8')
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
          throw error
        }
      },
      setItem: (_key, value) => {
        writeFileSync(`${path}.tmp`, value, 'utf8')
        renameSync(`${path}.tmp`, path)
      }
    }
  })
  return updater.stop
}
