// Phase 10b — configurable LLM auto-title preferences (renderer-local, localStorage-backed).
//
// The agent view names a brand-new conversation in two modes the user picks in Settings → AI:
//   'off'  (DEFAULT) — the title is the first user message preview (AgentThreadList titleOf fallback);
//                      no model call. Byte-identical behaviour to Phase 10a.
//   'llm'           — after the first turn the renderer POSTs the gateway /api/ai/title, which
//                      generates a short title with the chosen model and persists it (DB) → the
//                      history list refreshes and the title updates live. A manual rename always wins
//                      (the gateway skips an already-titled session).
//
// Persisted as plain localStorage (a renderer preference, like mailagent.chat.customModel) — NOT env,
// so it needs no serve-api round-trip and applies instantly. Best-effort: a blocked localStorage
// falls back to the defaults (off).

export type AutoTitleMode = 'off' | 'llm'

const MODE_KEY = 'mailagent.chat.autoTitle.mode'
const MODEL_KEY = 'mailagent.chat.autoTitle.model'

/** Cheap, fast model is the right default for a 6-word title (mirrors the translate default). */
export const DEFAULT_AUTO_TITLE_MODEL = 'claude-haiku-4-5'

export interface AutoTitleSettings {
  mode: AutoTitleMode
  model: string
}

export function readAutoTitleSettings(): AutoTitleSettings {
  try {
    const mode = localStorage.getItem(MODE_KEY) === 'llm' ? 'llm' : 'off'
    const model = localStorage.getItem(MODEL_KEY) || DEFAULT_AUTO_TITLE_MODEL
    return { mode, model }
  } catch {
    return { mode: 'off', model: DEFAULT_AUTO_TITLE_MODEL }
  }
}

export function writeAutoTitleMode(mode: AutoTitleMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* best-effort — a blocked localStorage just keeps the default */
  }
}

export function writeAutoTitleModel(model: string): void {
  try {
    localStorage.setItem(MODEL_KEY, model)
  } catch {
    /* best-effort */
  }
}
