// chat-panel P4 Phase 06a (cutover) — the NEW_SESSION_DEFAULT master flag resolver truth table.
//
// flags.ts resolves five renderer gates. Each sub-flag is EXPLICIT-WINS: a stubbed env (even '')
// counts as set and its truthy() decides; when a sub-flag is UNSET the resolver falls back to the
// master (MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT), with MAILAGENT_CHAT_RUNTIME=legacy as the one-key
// rollback. Under vitest there is no Vite `define`, so the build constants are undefined and the
// resolvers read process.env — vi.stubEnv drives them. The two non-negotiables this pins:
//   (1) nothing stubbed (the vitest baseline) → every gate OFF/legacy → byte-identical flag-off.
//   (2) master on + nothing else → the full AI SDK cutover; CHAT_RUNTIME=legacy rolls it all back.

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  getChatRuntimeMode,
  isA2uiToolCardsEnabled,
  isAgentViewEnabled,
  isAiSdkContextInjectionEnabled,
  isAiSdkGatewayEnabled,
  isAssistantUiPanelEnabled
} from '../../../src/shared/assistant/runtime/flags'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Snapshot all five gates in one shot for table-style assertions. */
function gates(): {
  runtime: string
  panel: boolean
  gateway: boolean
  injection: boolean
  a2ui: boolean
} {
  return {
    runtime: getChatRuntimeMode(),
    panel: isAssistantUiPanelEnabled(),
    gateway: isAiSdkGatewayEnabled(),
    injection: isAiSdkContextInjectionEnabled(),
    a2ui: isA2uiToolCardsEnabled()
  }
}

describe('flags — Phase 06a master fallback (non-negotiables)', () => {
  test('(1) nothing stubbed → every gate OFF/legacy (flag-off byte-identical)', () => {
    expect(gates()).toEqual({
      runtime: 'legacy',
      panel: false,
      gateway: false,
      injection: false,
      a2ui: false
    })
  })

  test('(2) master on, nothing else → full AI SDK cutover', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    expect(gates()).toEqual({
      runtime: 'ai-sdk',
      panel: true,
      gateway: true,
      injection: true,
      a2ui: true
    })
  })

  test('master on + MAILAGENT_CHAT_RUNTIME=legacy → one-key rollback, all legacy/off', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'legacy')
    expect(gates()).toEqual({
      runtime: 'legacy',
      panel: false,
      gateway: false,
      injection: false,
      a2ui: false
    })
  })
})

describe('flags — explicit sub-flag overrides win over the master', () => {
  test('master on + ASSISTANT_UI_PANEL=0 → panel off, runtime still ai-sdk (staged)', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_ASSISTANT_UI_PANEL', '0')
    const g = gates()
    expect(g.panel).toBe(false)
    expect(g.runtime).toBe('ai-sdk')
    expect(g.gateway).toBe(true)
  })

  test('master on + AI_SDK_GATEWAY=0 → gateway off, runtime still ai-sdk', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', '0')
    const g = gates()
    expect(g.gateway).toBe(false)
    expect(g.runtime).toBe('ai-sdk')
    expect(g.panel).toBe(true)
  })

  test('master on + CONTEXT_INJECTION=0 → injection off, the rest on', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_AI_SDK_CONTEXT_INJECTION', '0')
    const g = gates()
    expect(g.injection).toBe(false)
    expect(g.runtime).toBe('ai-sdk')
    expect(g.a2ui).toBe(true)
  })

  test('master on + A2UI_TOOL_CARDS=0 → a2ui off (independent partial rollback, phase-06 §7)', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_A2UI_TOOL_CARDS', '0')
    const g = gates()
    expect(g.a2ui).toBe(false)
    expect(g.runtime).toBe('ai-sdk')
    expect(g.injection).toBe(true)
  })
})

describe('flags — manual opt-in without the master (the existing dogfood path)', () => {
  test('master off + MAILAGENT_CHAT_RUNTIME=ai-sdk → ai-sdk, panel + gateway + injection derive on', () => {
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    expect(gates()).toEqual({
      runtime: 'ai-sdk',
      panel: true,
      gateway: true,
      injection: true,
      a2ui: true
    })
  })

  test('master off + ASSISTANT_UI_PANEL=1 alone → panel on but runtime stays legacy (Phase-01 shell)', () => {
    vi.stubEnv('MAILAGENT_ASSISTANT_UI_PANEL', '1')
    const g = gates()
    expect(g.panel).toBe(true)
    expect(g.runtime).toBe('legacy')
    expect(g.gateway).toBe(false)
  })

  test('master truthy variants (true/on-style) — only 1/true count', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', 'true')
    expect(getChatRuntimeMode()).toBe('ai-sdk')
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '0')
    expect(getChatRuntimeMode()).toBe('legacy')
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '')
    expect(getChatRuntimeMode()).toBe('legacy')
  })
})

describe('flags — isAgentViewEnabled (independent surface flag, NOT folded into the master)', () => {
  test('nothing stubbed → false (flag-off: /sessions = ChatsTab, Cmd+O = dialog)', () => {
    expect(isAgentViewEnabled()).toBe(false)
  })

  test('MAILAGENT_AGENT_VIEW=1 → true (/sessions = MailAgent view)', () => {
    vi.stubEnv('MAILAGENT_AGENT_VIEW', '1')
    expect(isAgentViewEnabled()).toBe(true)
  })

  test('MAILAGENT_AGENT_VIEW=0 → false (explicit off)', () => {
    vi.stubEnv('MAILAGENT_AGENT_VIEW', '0')
    expect(isAgentViewEnabled()).toBe(false)
  })

  test('master on but AGENT_VIEW unset → STILL false (independent of NEW_SESSION_DEFAULT)', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    expect(isAgentViewEnabled()).toBe(false)
  })
})
