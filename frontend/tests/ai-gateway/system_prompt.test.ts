// chat-panel P4 Phase 06 (context injection) — gateway system-prompt assembly tests.
//
// buildGatewaySystemPrompt reuses the legacy buildStableSystemPrompt (one standing-context source)
// and appends the typed context block. These tests pin the safety invariants (floor always present
// and prepended, never sourced from standingContext), the unconfigured context-light fallback to
// SOUL_MARKDOWN, memory injection, the appended untrusted context block, and BYTE-PARITY of the
// stable prefix with the legacy custom-api assembly (no drift).

import { describe, expect, test } from 'vitest'

import {
  buildGatewaySystemPrompt,
  type GatewaySystemPromptConfig
} from '../../src/ai-gateway/systemPrompt'
import { buildStableSystemPrompt } from '@shared/chat/backends/custom_api'
import type { ChatModelConfig } from '@shared/chat/platform'
import { PRODUCT_SAFETY_FLOOR } from '@shared/chat/prompts/safety_floor'
import { SOUL_MARKDOWN } from '@shared/chat/prompts/soul'
import {
  buildAgentContextSnapshot,
  type ContextScope,
  type CapabilityContext,
  type UIStateContext
} from '@shared/assistant/context/contextSnapshot'

const SCOPE: ContextScope = {
  surface: 'email-chat',
  anchorType: 'email',
  anchorId: 1,
  sessionId: 1,
  backendKind: 'ai-sdk'
}
const UI: UIStateContext = { locale: 'en', timezone: 'UTC', route: '/', panelMode: 'dock' }
const CAPS: CapabilityContext = {
  thinkingEnabled: false,
  attachmentsEnabled: false,
  toolCallingEnabled: true,
  humanApprovalRequired: true,
  enabledSkills: []
}

function emailSnapshot(body: string) {
  return buildAgentContextSnapshot({
    scope: SCOPE,
    uiState: UI,
    capabilities: CAPS,
    createdAt: '2026-06-25T00:00:00.000Z',
    activeEmail: {
      internalId: 53675,
      subject: 'Q3',
      senderName: 'Alice',
      senderAddr: 'alice@acme.test',
      dateIso: '2026-06-01',
      mailbox: 'INBOX',
      threadId: 't',
      notionPageId: null,
      bodyMarkdown: body,
      bodySource: 'sqlite-body'
    }
  })
}

describe('buildGatewaySystemPrompt', () => {
  test('unconfigured (no provider config) → context-light SOUL fallback', () => {
    const out = buildGatewaySystemPrompt({ promptConfig: null, contextSnapshot: null })
    expect(out).toBe(SOUL_MARKDOWN)
  })

  test('standing context is injected AND the safety floor is present + prepended (not weakened)', () => {
    const pc: GatewaySystemPromptConfig = {
      standingContext: '# AGENT\nYou are a focused email agent.\n# RULES\nBe terse.'
    }
    const out = buildGatewaySystemPrompt({ promptConfig: pc, contextSnapshot: null })
    // floor present, and it leads the prompt — a standingContext edit physically cannot remove it.
    expect(out).toContain(PRODUCT_SAFETY_FLOOR)
    expect(out.indexOf(PRODUCT_SAFETY_FLOOR)).toBe(0)
    expect(out).toContain('You are a focused email agent.')
    // standing replaces the legacy SOUL header (the floor is the only shared safety text).
    expect(out).not.toContain('You are the AI assistant inside MailAgent, a macOS email client.')
  })

  test('memory summary is injected', () => {
    const out = buildGatewaySystemPrompt({
      promptConfig: { memorySummary: 'User prefers concise replies.' },
      contextSnapshot: null
    })
    expect(out).toContain('Saved memory')
    expect(out).toContain('User prefers concise replies.')
  })

  test('appends the typed context block (untrusted fences) after the stable prefix', () => {
    const out = buildGatewaySystemPrompt({
      promptConfig: { standingContext: 'X' },
      contextSnapshot: emailSnapshot('The numbers are in the deck.')
    })
    expect(out).toContain(PRODUCT_SAFETY_FLOOR)
    expect(out).toContain('UNTRUSTED_EMAIL_BODY_START id=53675')
    expect(out).toContain('The numbers are in the deck.')
    // the stable prefix comes before the context block.
    expect(out.indexOf(PRODUCT_SAFETY_FLOOR)).toBeLessThan(
      out.indexOf('UNTRUSTED_EMAIL_BODY_START')
    )
  })

  test('the stable prefix is BYTE-IDENTICAL to the legacy custom-api assembly (no drift)', () => {
    const pc: GatewaySystemPromptConfig = {
      standingContext: '# AGENT\nfocused\n# USER\nAlice',
      userContext: 'role: PM',
      memorySummary: 'prefers concise',
      kosConfigured: false
    }
    const cfg: ChatModelConfig = {
      defaultModel: '',
      kosConsumerEnabled: false,
      kosConfigured: false,
      kosL1HotBlockEnabled: false,
      userContext: 'role: PM',
      memorySummary: 'prefers concise',
      skillFragments: null,
      standingContext: '# AGENT\nfocused\n# USER\nAlice'
    }
    const gateway = buildGatewaySystemPrompt({ promptConfig: pc, contextSnapshot: null })
    const legacy = buildStableSystemPrompt(null, cfg, () => null)
    expect(gateway).toBe(legacy)
  })
})
