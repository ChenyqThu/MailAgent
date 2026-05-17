// Build-target dispatch. ARCHITECTURE.md §2.2 hard rule: components import
// useMailApi() — never `window.electron.email.list()` direct — so V2 swaps
// the implementation with zero component diffs.

import { ElectronApi } from './ElectronApi'
import { HttpApi } from './HttpApi'
import type { MailApi } from './types'

let _instance: MailApi | null = null

export function makeMailApi(): MailApi {
  if (_instance) return _instance
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
  // Hold the freshly constructed instance in a local — TS narrowing can't
  // track that the module-level `_instance` is non-null after assignment.
  const created: MailApi =
    env.VITE_BUILD_TARGET === 'web'
      ? new HttpApi(env.VITE_API_BASE_URL ?? '/api')
      : new ElectronApi()
  _instance = created
  return created
}
