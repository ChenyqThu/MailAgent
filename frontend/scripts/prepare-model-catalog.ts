import { readFileSync, writeFileSync } from 'node:fs'

import { parseRemoteCatalog } from '../src/shared/modelCatalog/remote'

const snapshot: unknown = JSON.parse(readFileSync('src/shared/modelCatalog/catalog.json', 'utf8'))
if (!snapshot || typeof snapshot !== 'object') throw new Error('Missing catalog')
const payload = JSON.stringify({
  ...snapshot,
  schemaVersion: 1,
  publishedAt: new Date().toISOString()
})
parseRemoteCatalog(payload)
writeFileSync('model-catalog-publication.json', payload + '\n', 'utf8')
