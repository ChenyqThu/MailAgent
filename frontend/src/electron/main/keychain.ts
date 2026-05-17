// macOS Keychain wrapper around `keytar`. Holds MAILAGENT_CLI_API_KEY for
// write commands (BACKEND-INTERFACES.md §1.4). Sprint 0 = thin getter/setter;
// Sprint 6 SettingsPage wires the input + test-ping button.

import keytar from 'keytar'

const SERVICE = 'ink.chenge.mailagent'
const ACCOUNT_CLI = 'cli-api-key'

export async function getCliApiKey(): Promise<string | null> {
  return keytar.getPassword(SERVICE, ACCOUNT_CLI)
}

export async function setCliApiKey(value: string): Promise<void> {
  if (!value) {
    await keytar.deletePassword(SERVICE, ACCOUNT_CLI)
    return
  }
  await keytar.setPassword(SERVICE, ACCOUNT_CLI, value)
}

export async function clearCliApiKey(): Promise<boolean> {
  return keytar.deletePassword(SERVICE, ACCOUNT_CLI)
}
