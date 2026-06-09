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
const ACCOUNT_LLM_TRANSLATE = 'llm-translate-api-key'

/**
 * Resolve the LLM gateway API key. macOS Keychain entry first, then
 * `LLM_API_KEY` env-var fallback for `pnpm dev` ergonomics. Returns
 * null when neither is set — the translate handler turns this into
 * an E_NO_LLM_KEY user-facing error.
 */
export async function getLlmApiKey(): Promise<string | null> {
  // env 优先（bootstrapDotenv 把 .env 注入 process.env）：避开 ad-hoc 签名导致 keychain
  // 反复弹授权。env 无才 fallback keytar（兼容未 dual-write 到 .env 的旧 key）。
  const fromEnv = process.env['LLM_API_KEY']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const fromKey = await keytar.getPassword(SERVICE, ACCOUNT_LLM)
  if (fromKey && fromKey.length > 0) return fromKey
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
 * Anthropic-compatible Messages API base URL.
 *
 * Reads `LLM_API_BASE` first (the canonical key the Python LLM agent reads
 * and the one the Settings UI writes through AiTab → "网关 base URL"), then
 * `LLM_BASE_URL` for legacy callers, then defaults to CRS's actual /api
 * path. Curl-verified: the endpoint is `https://crs.chenge.ink/api/v1/messages`;
 * the un-/api path 404s.
 */
export function getLlmBaseUrl(): string {
  const fromApiBase = process.env['LLM_API_BASE']
  if (fromApiBase && fromApiBase.length > 0) return fromApiBase.replace(/\/+$/, '')
  const fromEnv = process.env['LLM_BASE_URL']
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  return 'https://crs.chenge.ink/api'
}

export function getLlmModel(): string {
  const fromEnv = process.env['LLM_MODEL']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return 'claude-sonnet-4-6'
}

/**
 * Translate-specific model override. Empty/unset → Haiku 4.5 — translation
 * needs speed > nuance, and Haiku is ~3-5× faster than Sonnet 4.6 with
 * comparable quality. Model name follows CRS's "no date stamp" convention
 * (matches .env.example's `claude-sonnet-4-6` style); Anthropic's official
 * date-stamped names like `claude-haiku-4-5-20251001` fail CRS account
 * lookup and surface as a Cloudflare 502.
 */
export function getLlmTranslateModel(): string {
  const fromEnv = process.env['LLM_TRANSLATE_MODEL']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return 'claude-haiku-4-5'
}

/**
 * Translate-specific base URL. Empty/unset → fall back to the main LLM
 * gateway. Lets users point translation at a faster regional endpoint or a
 * separate quota bucket without disturbing chat / agent.
 */
export function getLlmTranslateBaseUrl(): string {
  const fromEnv = process.env['LLM_TRANSLATE_BASE_URL']
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  return getLlmBaseUrl()
}

/**
 * Translate-specific API key. Tries keychain (translate slot) first, then
 * `LLM_TRANSLATE_API_KEY` env, then the main LLM key. Lets users use a
 * dedicated key for translation; null only when the main key is also unset.
 */
export async function getLlmTranslateApiKey(): Promise<string | null> {
  // env 优先（见 getLlmApiKey）。env 无才 fallback keytar，再 fallback 主 LLM key。
  const fromEnv = process.env['LLM_TRANSLATE_API_KEY']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const fromKey = await keytar.getPassword(SERVICE, ACCOUNT_LLM_TRANSLATE)
  if (fromKey && fromKey.length > 0) return fromKey
  return getLlmApiKey()
}
