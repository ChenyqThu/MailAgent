// chat-panel P4 Phase 06 (context injection) — session-reload mapper accepts a renderer-shaped row.
//
// The panel reloads prior history from useEmailChat's `chat.messages` (api/types ChatMessage), which
// has NO ui_message_json column on the read projection. chatMessageToUIMessage's param was decoupled
// to a structural type with ui_message_json OPTIONAL, so a row that omits it falls back to a text
// UIMessage synthesized from `content` (+ a reasoning part from `thinking`).

import { describe, expect, test } from 'vitest'

import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'

describe('chatMessageToUIMessage — renderer reload row (no ui_message_json field)', () => {
  test('synthesizes a text UIMessage from content when ui_message_json is omitted', () => {
    const ui = chatMessageToUIMessage({
      id: 42,
      role: 'assistant',
      content: 'Here is the summary.',
      thinking: null,
      model: 'claude-sonnet-4-6',
      tokens_input: 10,
      tokens_output: 20
    })
    expect(ui.id).toBe('42')
    expect(ui.role).toBe('assistant')
    expect(ui.parts).toEqual([{ type: 'text', text: 'Here is the summary.' }])
  })

  test('prepends a reasoning part from thinking on an assistant row', () => {
    const ui = chatMessageToUIMessage({
      id: 7,
      role: 'assistant',
      content: 'Answer.',
      thinking: 'considered the options',
      model: null,
      tokens_input: null,
      tokens_output: null
    })
    expect(ui.parts[0]).toEqual({ type: 'reasoning', text: 'considered the options' })
    expect(ui.parts[1]).toEqual({ type: 'text', text: 'Answer.' })
  })

  test('a user row maps to a user text message', () => {
    const ui = chatMessageToUIMessage({
      id: 1,
      role: 'user',
      content: 'what changed?',
      thinking: null,
      model: null,
      tokens_input: null,
      tokens_output: null
    })
    expect(ui.role).toBe('user')
    expect(ui.parts).toEqual([{ type: 'text', text: 'what changed?' }])
  })
})
