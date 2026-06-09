// macOS Keychain wrapper around `keytar`. Holds:
//   - cli-api-key       — MAILAGENT_CLI_API_KEY for write commands
//                         (BACKEND-INTERFACES.md §1.4)
//   - llm-api-key       — Sprint 6: LLM API key consumed by translation +
//                         Custom-API chat backend in main process
//   - custom-api-key    — Sprint 6: optional separate key for self-hosted
//                         OpenAI-compatible endpoints (Custom API backend)
//
// Each secret has its own typed getter/setter so SettingsPage can manage
// them independently; the renderer never sees the secret value (read by
// main only, writes go through IPC).

import keytar from 'keytar'

const SERVICE = 'ink.chenge.mailagent'
const ACCOUNT_CLI = 'cli-api-key'
const ACCOUNT_LLM = 'llm-api-key'
const ACCOUNT_LLM_TRANSLATE = 'llm-translate-api-key'
const ACCOUNT_CUSTOM_API = 'custom-api-key'

// ad-hoc 签名的 .app 每次 build 签名都变 → keychain item 的 ACL 绑的是旧签名 → 每次读都
// 弹授权（getSecretsStatus 一次读 4 个 = 一次弹 4 次，极烦）。secret 已经 dual-write 到
// .env（EnvSecretField）+ bootstrapDotenv 启动把 .env 注入 process.env → 读取改 **env 优先**：
// env 有值就直接用、根本不碰 keytar（不弹）；env 无才 fallback keytar（兼容未 dual-write 的旧 key）。
const ENV_BY_ACCOUNT: Record<string, string> = {
  [ACCOUNT_CLI]: 'MAILAGENT_CLI_API_KEY',
  [ACCOUNT_LLM]: 'LLM_API_KEY',
  [ACCOUNT_LLM_TRANSLATE]: 'LLM_TRANSLATE_API_KEY',
  [ACCOUNT_CUSTOM_API]: 'CUSTOM_API_KEY'
}

async function readSecret(account: string): Promise<string | null> {
  const envName = ENV_BY_ACCOUNT[account]
  const fromEnv = envName ? process.env[envName] : undefined
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return keytar.getPassword(SERVICE, account)
}
async function writeSecret(account: string, value: string): Promise<void> {
  if (!value) {
    await keytar.deletePassword(SERVICE, account)
    return
  }
  await keytar.setPassword(SERVICE, account, value)
}

export async function getCliApiKey(): Promise<string | null> {
  return readSecret(ACCOUNT_CLI)
}
export async function setCliApiKey(value: string): Promise<void> {
  return writeSecret(ACCOUNT_CLI, value)
}
export async function clearCliApiKey(): Promise<boolean> {
  return keytar.deletePassword(SERVICE, ACCOUNT_CLI)
}

export async function getLlmApiKey(): Promise<string | null> {
  return readSecret(ACCOUNT_LLM)
}
export async function setLlmApiKey(value: string): Promise<void> {
  return writeSecret(ACCOUNT_LLM, value)
}
export async function clearLlmApiKey(): Promise<boolean> {
  return keytar.deletePassword(SERVICE, ACCOUNT_LLM)
}

export async function getLlmTranslateApiKey(): Promise<string | null> {
  return readSecret(ACCOUNT_LLM_TRANSLATE)
}
export async function setLlmTranslateApiKey(value: string): Promise<void> {
  return writeSecret(ACCOUNT_LLM_TRANSLATE, value)
}
export async function clearLlmTranslateApiKey(): Promise<boolean> {
  return keytar.deletePassword(SERVICE, ACCOUNT_LLM_TRANSLATE)
}

export async function getCustomApiKey(): Promise<string | null> {
  return readSecret(ACCOUNT_CUSTOM_API)
}
export async function setCustomApiKey(value: string): Promise<void> {
  return writeSecret(ACCOUNT_CUSTOM_API, value)
}
export async function clearCustomApiKey(): Promise<boolean> {
  return keytar.deletePassword(SERVICE, ACCOUNT_CUSTOM_API)
}

/** Sprint 6 SettingsPage — used by `settings:secrets:status` so the UI
 *  can render a "set" / "not set" pill without exposing the actual value
 *  (the renderer must never see secrets). */
export interface SecretsStatus {
  cliApiKey: boolean
  llmApiKey: boolean
  llmTranslateApiKey: boolean
  customApiKey: boolean
}

export async function getSecretsStatus(): Promise<SecretsStatus> {
  const [cli, llm, llmTr, custom] = await Promise.all([
    getCliApiKey(),
    getLlmApiKey(),
    getLlmTranslateApiKey(),
    getCustomApiKey()
  ])
  return {
    cliApiKey: cli !== null && cli.length > 0,
    llmApiKey: llm !== null && llm.length > 0,
    llmTranslateApiKey: llmTr !== null && llmTr.length > 0,
    customApiKey: custom !== null && custom.length > 0
  }
}
