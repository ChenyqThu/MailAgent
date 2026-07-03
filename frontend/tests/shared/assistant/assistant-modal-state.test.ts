// @vitest-environment happy-dom
//
// assistant-modal P0 / S3 — the useAIChatPanel three-mode state (mode / cached dock mode /
// openChatModal·hideChatModal / pendingAgentSessionId slot). The MAILAGENT_ASSISTANT_MODAL
// surface flag was GA'd and removed in S3 (the modal is the only email-panel shell); the modal
// state stays orthogonal to the `visible`/`toggle` slot. happy-dom gives a real localStorage.

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  useAIChatPanel,
  openChatModal,
  hideChatModal,
  requestOpenAgentSession
} from '../../../src/shared/state/ai-chat-panel'

afterEach(() => {
  vi.unstubAllEnvs()
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
  // Reset the singleton store between tests (zustand persists across the module's lifetime).
  useAIChatPanel.setState({ visible: false, mode: 'floating', pendingAgentSessionId: null })
})

describe('useAIChatPanel — assistant-modal three-mode state', () => {
  test('mode defaults to floating', () => {
    expect(useAIChatPanel.getState().mode).toBe('floating')
  })

  test('setMode persists the dock mode to localStorage', () => {
    useAIChatPanel.getState().setMode('sidebar')
    expect(useAIChatPanel.getState().mode).toBe('sidebar')
    expect(localStorage.getItem('mailagent.chat.dockMode')).toBe('sidebar')
    useAIChatPanel.getState().setMode('floating')
    expect(localStorage.getItem('mailagent.chat.dockMode')).toBe('floating')
  })

  test('openChatModal expands; hideChatModal minimises — mode preserved across both', () => {
    useAIChatPanel.getState().setMode('sidebar')
    openChatModal()
    expect(useAIChatPanel.getState().visible).toBe(true)
    expect(useAIChatPanel.getState().mode).toBe('sidebar') // open keeps the cached mode
    hideChatModal()
    expect(useAIChatPanel.getState().visible).toBe(false)
    expect(useAIChatPanel.getState().mode).toBe('sidebar') // minimise keeps the mode → next open restores it
  })

  test('pendingAgentSessionId slot: request parks the id, consume clears it', () => {
    requestOpenAgentSession(42)
    expect(useAIChatPanel.getState().pendingAgentSessionId).toBe(42)
    useAIChatPanel.getState().consumeOpenAgentSession()
    expect(useAIChatPanel.getState().pendingAgentSessionId).toBeNull()
  })

  test('legacy visible/toggle stays orthogonal to mode (no regression)', () => {
    useAIChatPanel.getState().setVisible(true)
    expect(useAIChatPanel.getState().visible).toBe(true)
    expect(useAIChatPanel.getState().mode).toBe('floating') // mode untouched by the legacy path
    useAIChatPanel.getState().toggle()
    expect(useAIChatPanel.getState().visible).toBe(false)
    expect(useAIChatPanel.getState().mode).toBe('floating')
  })
})
