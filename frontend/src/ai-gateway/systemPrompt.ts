// chat-panel P4 Phase 06 (context injection) — AI SDK Gateway system-prompt assembly.
//
// The gateway's streamText `system` is built here, reusing the EXACT legacy stable-prefix assembly
// (custom_api.buildStableSystemPrompt) so the AI SDK path and the legacy custom-api path share ONE
// standing-context source — no second "stove" (context-injection.md / goal). The standing-context
// data (SOUL/AGENT/RULES/USER assembled backend-side, the user-context page, the memory summary, the
// KOS-configured flag) arrives via GatewaySystemPromptConfig, which the Electron wrapper fetches from
// the SAME serve-api /chat/config endpoint the legacy runtime uses. The only AI-SDK-specific part is
// the typed AgentContextSnapshot block (buildContextSystemBlock) appended after the stable prefix:
// the legacy path puts the open email in buildEmailContextSection, the gateway puts it in the
// untrusted-fenced context block (§5/§7). That is the one documented difference.
//
// 🔴 Pure-ish: imports only pure shared modules (custom_api prompt assembly + the context
//    serializer). No node:http / electron / ai. Unit-testable in plain Node.
// 🔴 PRODUCT_SAFETY_FLOOR cannot be weakened here: buildStableSystemPrompt prepends it FIRST and it
//    is code-owned (safety_floor.ts), never sourced from standingContext — a parity test asserts the
//    floor bytes are always present, even when standingContext is set.

import { buildStableSystemPrompt } from '@shared/chat/backends/custom_api'
import type { ChatModelConfig } from '@shared/chat/platform'
import { buildContextSystemBlock } from '@shared/assistant/context/contextSerializer'
import type { AgentContextSnapshot } from '@shared/assistant/context/contextSnapshot'

/** The /chat/config projection the gateway needs to assemble the stable system prefix — the SAME
 *  fields the legacy HttpPlatformConfig carries (standing context + user context + memory + KOS
 *  gate). The Electron wrapper fetches these from serve-api /chat/config (TTL-cached). All optional:
 *  a field absent / empty → that section is skipped (graceful degrade to context-light). */
export interface GatewaySystemPromptConfig {
  /** SOUL+AGENT+RULES+USER assembled backend-side. null/"" → fall back to legacy SOUL_MARKDOWN. */
  standingContext?: string | null
  /** user profile / Sender Priority / focus projects page. null/"" → not injected. */
  userContext?: string | null
  /** durable user-scope memory summary (P2 memory kernel). null/"" → not injected. */
  memorySummary?: string | null
  /** KOS configured (enabled AND credentialed) → inject the KOS usage guidance block. */
  kosConfigured?: boolean
  /** M4a — advertised (enabled(override ?? default) && available) skill names from /chat/config,
   *  used by the gateway's skill→tool gating (buildTools), NOT by the prompt assembly here. Carried
   *  on this cached projection only because it shares the same /chat/config fetch + TTL cache as the
   *  prompt fields. null/undefined → unknown → gating fails open (no filtering). */
  advertisedSkills?: string[] | null
}

/** Build the streamText `system` string for an AI SDK gateway run. Always returns a non-empty
 *  string: the stable prefix is never empty (it falls back to SOUL_MARKDOWN when nothing is
 *  configured), and the typed context block (with untrusted fences) is appended when a snapshot
 *  carries usable context. `skillFragments` is intentionally NOT injected here — the gateway conveys
 *  skill capability + honest unavailability through the snapshot's capabilities block instead. */
export function buildGatewaySystemPrompt(args: {
  promptConfig: GatewaySystemPromptConfig | null
  contextSnapshot: AgentContextSnapshot | null
}): string {
  const pc = args.promptConfig
  const cfg: ChatModelConfig = {
    defaultModel: '', // unused by buildStableSystemPrompt
    kosConsumerEnabled: false,
    kosConfigured: pc?.kosConfigured ?? false,
    kosL1HotBlockEnabled: false, // the gateway does no L1 sender-digest prefetch
    userContext: pc?.userContext && pc.userContext.length > 0 ? pc.userContext : null,
    memorySummary: pc?.memorySummary && pc.memorySummary.length > 0 ? pc.memorySummary : null,
    skillFragments: null, // conveyed via the snapshot's capabilities block, not the legacy section
    standingContext:
      pc?.standingContext && pc.standingContext.length > 0 ? pc.standingContext : null
  }
  // ctx=null + no-op digest → the EXACT legacy stable prefix (floor + standing/SOUL + user + memory.md
  // + KOS guidance), byte-identical to the custom-api path's cacheable prefix. 07-01 — the bounded
  // memory.md rides IN the cacheable prefix via cfg.memorySummary (buildStableSystemPrompt renders it
  // as an untrusted MEMORY fence, frozen per session for prefix-cache stability); "" → no fence →
  // byte-identical flag-off. This replaces the retired M2 per-query recall block.
  const stable = buildStableSystemPrompt(null, cfg, () => null)
  const contextBlock = args.contextSnapshot ? buildContextSystemBlock(args.contextSnapshot) : ''
  // Order: stable (cacheable, incl. memory.md) → context (current view). Each segment is joined only
  // when non-empty, so an empty contextBlock reproduces the stable prefix exactly.
  return [stable, contextBlock].filter((s) => s.length > 0).join('\n\n')
}
