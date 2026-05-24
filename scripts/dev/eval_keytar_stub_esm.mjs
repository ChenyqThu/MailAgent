// Sprint 19 §B eval — ESM stub for keytar. Keytar is only used by
// llm_settings.ts to read the LLM API key when env var is absent; the
// env var is present during eval, so getPassword can safely return null.

export async function getPassword() { return null }
export async function setPassword() {}
export async function deletePassword() { return false }
export async function findCredentials() { return [] }

export default { getPassword, setPassword, deletePassword, findCredentials }
