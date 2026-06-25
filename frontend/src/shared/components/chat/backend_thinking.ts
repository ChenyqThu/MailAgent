// task 06-08-chat 需求 5 (codex MEDIUM-1) — pure predicate for "may this backend
// use Claude extended thinking".
//
// Split out of AIChatPanel.tsx so it can be unit-tested in isolation (the full
// panel render pulls in router / GSAP / IPC) and so AIChatPanel keeps exporting
// only its component (react-refresh/only-export-components).

import type { BackendChoice } from './BackendSelector'

/** Extended thinking is a Claude-only capability. The custom-api model picker
 *  also lists OpenAI-protocol models (e.g. gpt-5.5) routed through CRS; those go
 *  through custom_api.ts's openaiStream, which doesn't honor `thinking` at all
 *  (no tools gating, no thinking block). So the toggle must additionally require
 *  a `claude-` model — otherwise a user on gpt-5.5 could flip it on and silently
 *  send thinking:true for no effect. notion-agent has no model (b.model is null)
 *  → never supported. Drives both the Composer toggle's `thinkingDisabled` AND
 *  the per-turn send/edit `thinking` flag so a stale-ON toggle (after a model
 *  switch) never sends thinking:true to a backend that ignores it. */
export function backendSupportsThinking(b: BackendChoice): boolean {
  // chat-panel P4 composer-parity — the ai-sdk runtime (cutover default) also routes Claude models
  // through extended thinking (gateway thinkingProviderOptions); custom-api is the legacy path. Both
  // still require a claude- model — OpenAI-protocol gpt models ignore thinking, notion-agent has none.
  return (b.kind === 'custom-api' || b.kind === 'ai-sdk') && (b.model ?? '').startsWith('claude-')
}
