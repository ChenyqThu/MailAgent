// LLM gateway config — keychain for the API key (mirrors keychain.ts pattern
// for the mailagent CLI key), env-var-overridable defaults for the endpoint
// and model.
//
// Why a dedicated module: (1) translate.ts shouldn't reach into keytar
// directly (single responsibility), (2) Sprint 6 SettingsPage will write
// here from a UI form (setLlmApiKey + a future setLlmBaseUrl/setLlmModel),
// (3) REVIEW-LOG C-04 hard requirement that the API key never crosses
// into the renderer bundle is enforced by routing all reads through this
// main-process-only file.

import keytar from 'keytar'

const SERVICE = 'ink.chenge.mailagent'
const ACCOUNT_LLM = 'llm-api-key'

/**
 * Resolve the LLM gateway API key. macOS Keychain entry first, then
 * `LLM_API_KEY` env-var fallback for `pnpm dev` ergonomics. Returns
 * null when neither is set — the translate handler turns this into
 * an E_NO_LLM_KEY user-facing error.
 */
export async function getLlmApiKey(): Promise<string | null> {
  const fromKey = await keytar.getPassword(SERVICE, ACCOUNT_LLM)
  if (fromKey && fromKey.length > 0) return fromKey
  const fromEnv = process.env['LLM_API_KEY']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return null
}

export async function setLlmApiKey(value: string): Promise<void> {
  if (!value) {
    await keytar.deletePassword(SERVICE, ACCOUNT_LLM)
    return
  }
  await keytar.setPassword(SERVICE, ACCOUNT_LLM, value)
}

export async function clearLlmApiKey(): Promise<boolean> {
  return keytar.deletePassword(SERVICE, ACCOUNT_LLM)
}

/**
 * Anthropic-compatible Messages API base URL. CRS (`https://crs.chenge.ink`)
 * is the project default; users can point at native Anthropic or any other
 * Messages-shape endpoint via env override.
 */
export function getLlmBaseUrl(): string {
  const fromEnv = process.env['LLM_BASE_URL']
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  return 'https://crs.chenge.ink'
}

export function getLlmModel(): string {
  const fromEnv = process.env['LLM_MODEL']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return 'claude-sonnet-4-6'
}
