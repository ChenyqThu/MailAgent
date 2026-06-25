// chat-panel P4 Phase 06a (cutover) — main-side gateway gating (ai_gateway_flags.ts).
//
// shouldStartEmbeddedGateway decides whether the Electron main process starts the embedded AI SDK
// Gateway + injects ?aiGatewayPort=. It MUST agree with the renderer's isAiSdkGatewayEnabled so the
// renderer never resolves to the AI SDK runtime without a gateway actually listening. Resolution:
// explicit MAILAGENT_AI_SDK_GATEWAY wins → CHAT_RUNTIME=ai-sdk opt-in starts → legacy/external-store
// /ag-ui rolls back → else the NEW_SESSION_DEFAULT master. Under vitest there is no Vite `define`, so
// the master build const is undefined and the resolvers read process.env (vi.stubEnv drives them).

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  masterNewSessionDefaultOn,
  shouldStartEmbeddedGateway
} from '../../src/electron/main/ai_gateway_flags'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ai_gateway_flags — masterNewSessionDefaultOn', () => {
  test('unset (vitest baseline) → off', () => {
    expect(masterNewSessionDefaultOn()).toBe(false)
  })

  test('1 / true → on; 0 / "" / other → off', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    expect(masterNewSessionDefaultOn()).toBe(true)
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', 'true')
    expect(masterNewSessionDefaultOn()).toBe(true)
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '0')
    expect(masterNewSessionDefaultOn()).toBe(false)
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '')
    expect(masterNewSessionDefaultOn()).toBe(false)
  })
})

describe('ai_gateway_flags — shouldStartEmbeddedGateway', () => {
  test('nothing stubbed → false (dark, byte-identical)', () => {
    expect(shouldStartEmbeddedGateway()).toBe(false)
  })

  test('explicit MAILAGENT_AI_SDK_GATEWAY wins both ways', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', 'true')
    expect(shouldStartEmbeddedGateway()).toBe(true)
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', 'false')
    expect(shouldStartEmbeddedGateway()).toBe(false)
  })

  test('explicit gateway=false overrides master on; gateway=true overrides master off', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', 'false')
    expect(shouldStartEmbeddedGateway()).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '0')
    vi.stubEnv('MAILAGENT_AI_SDK_GATEWAY', 'true')
    expect(shouldStartEmbeddedGateway()).toBe(true)
  })

  test('master on, nothing else → start', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    expect(shouldStartEmbeddedGateway()).toBe(true)
  })

  test('MAILAGENT_CHAT_RUNTIME=legacy is the one-key rollback (even with master on)', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'legacy')
    expect(shouldStartEmbeddedGateway()).toBe(false)
  })

  test('CHAT_RUNTIME=external-store / ag-ui → no gateway', () => {
    vi.stubEnv('MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT', '1')
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'external-store')
    expect(shouldStartEmbeddedGateway()).toBe(false)
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ag-ui')
    expect(shouldStartEmbeddedGateway()).toBe(false)
  })

  test('CHAT_RUNTIME=ai-sdk alone (master off) → start (mirrors renderer isAiSdkGatewayEnabled)', () => {
    vi.stubEnv('MAILAGENT_CHAT_RUNTIME', 'ai-sdk')
    expect(shouldStartEmbeddedGateway()).toBe(true)
  })
})
