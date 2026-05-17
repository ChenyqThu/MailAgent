// Build-target dispatch. ARCHITECTURE.md §2.2 hard rule: components import
// useMailApi() — never `window.electron.email.list()` direct — so V2 swaps
// the implementation with zero component diffs.

import { ElectronApi } from './ElectronApi'
import { HttpApi } from './HttpApi'
import type { MailApi } from './types'

let _instance: MailApi | null = null

export function makeMailApi(): MailApi {
  if (_instance) return _instance
  const target = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BUILD_TARGET
  if (target === 'web') {
    const baseUrl =
      (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? '/api'
    _instance = new HttpApi(baseUrl)
  } else {
    _instance = new ElectronApi()
  }
  return _instance
}
