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
const ACCOUNT_CUSTOM_API = 'custom-api-key'

async function readSecret(account: string): Promise<string | null> {
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
  customApiKey: boolean
}

export async function getSecretsStatus(): Promise<SecretsStatus> {
  const [cli, llm, custom] = await Promise.all([getCliApiKey(), getLlmApiKey(), getCustomApiKey()])
  return {
    cliApiKey: cli !== null && cli.length > 0,
    llmApiKey: llm !== null && llm.length > 0,
    customApiKey: custom !== null && custom.length > 0
  }
}
