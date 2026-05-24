// Sprint 19 §B eval — register the ESM loader hook via node:module.register.
// Used as the `--import` argument. The register call must happen before the
// entry module loads so chat/* modules see the stubbed electron/keytar.

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
register(pathToFileURL(join(here, 'eval_electron_loader.mjs')).href, {
  parentURL: import.meta.url
})
