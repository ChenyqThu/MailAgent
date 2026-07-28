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

// 寻址键单源自 keychain.ts（issue #68 —— 此前这里手抄一份，漂了就是「写在 A 槽、
// 读 B 槽」，用户看到的却是「未配置 API key」）。keychain.ts 不 import 本模块，无环。
// 注意：**只共享寻址键，不共享读取函数** —— 本模块的 getLlmTranslateApiKey 有意在
// translate 槽落空时 fallback 主 LLM key，keychain.ts 的同名函数不 fallback。
import { ACCOUNT_LLM, ACCOUNT_LLM_TRANSLATE, SERVICE } from './keychain'

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
 * Translate-specific model override. Empty/unset → Sonnet 4.6 — 翻译质量优先,
 * 且 64K max output 能承接长文批翻。用户仍可在 Settings 下拉切回更快模型。
 * Model name follows CRS's "no date stamp" convention (matches .env.example's
 * `claude-sonnet-4-6` style); Anthropic's official date-stamped names like
 * `claude-haiku-4-5-20251001` fail CRS account lookup and surface as a
 * Cloudflare 502.
 */
export function getLlmTranslateModel(): string {
  const fromEnv = process.env['LLM_TRANSLATE_MODEL']
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return 'claude-sonnet-4-6'
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
 * 发版终审 HIGH-1 — translate 专用 keytar slot 探测（**不** fallback 主 key）。
 * translate.ts 的 hasExplicitTranslateProfile 用它判「用户配过 translate 专用 profile」：
 * env 缺位但 keytar translate slot 有值（未 dual-write 到 .env 的旧 key）同样算显式
 * profile，registry flag on 时不被 provider registry 顶掉。
 */
export async function hasLlmTranslateKeytarKey(): Promise<boolean> {
  const fromKey = await keytar.getPassword(SERVICE, ACCOUNT_LLM_TRANSLATE)
  return Boolean(fromKey && fromKey.length > 0)
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
