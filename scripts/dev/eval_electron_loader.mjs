// Sprint 19 §B eval — ESM loader hooks for electron + keytar.
// Used via `node --import` so the hook installs before chat/* modules load.

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const electronStubPath = pathToFileURL(join(here, 'eval_electron_stub_esm.mjs')).href
const keytarStubPath = pathToFileURL(join(here, 'eval_keytar_stub_esm.mjs')).href

export function resolve(specifier, ctx, next) {
  if (specifier === 'electron') return next(electronStubPath, ctx)
  if (specifier === 'keytar') return next(keytarStubPath, ctx)
  return next(specifier, ctx)
}
