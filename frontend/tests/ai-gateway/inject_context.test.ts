// chat-panel P4 composer-parity C2 — gateway injected-context prepend.
// Pins: only the LAST user message gets the prefix (earlier turns untouched), string content gets a
// string prefix, array content gets a leading text part, empty prefix / no-user → unchanged (the
// rawMessages persisted alongside stay original; only the model-message array is mutated).

import { describe, expect, test } from 'vitest'
import type { ModelMessage } from 'ai'

import { prependInjectedContext } from '../../src/ai-gateway/chatRun'

describe('prependInjectedContext', () => {
  test('empty prefix → returns the same array (byte-identical no-op)', () => {
    const msgs = [{ role: 'user', content: 'hi' }] as ModelMessage[]
    expect(prependInjectedContext(msgs, '')).toBe(msgs)
  })

  test('string content → prefix prepended to the LAST user message; earlier messages untouched', () => {
    const msgs = [
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'hi' }
    ] as ModelMessage[]
    const out = prependInjectedContext(msgs, 'CTX\n')
    expect(out[1]?.content).toBe('CTX\nhi')
    expect(out[0]?.content).toBe('a')
  })

  test('only the LAST user message gets the prefix (multi-user thread)', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'second' }
    ] as ModelMessage[]
    const out = prependInjectedContext(msgs, 'CTX')
    expect(out[0]?.content).toBe('first')
    expect(out[2]?.content).toBe('CTXsecond')
  })

  test('array content → a leading text part is prepended', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as ModelMessage[]
    const out = prependInjectedContext(msgs, 'CTX')
    const content = out[0]?.content as Array<{ type: string; text: string }>
    expect(content[0]).toEqual({ type: 'text', text: 'CTX' })
    expect(content[1]).toEqual({ type: 'text', text: 'hi' })
  })

  test('no user message → unchanged', () => {
    const msgs = [{ role: 'assistant', content: 'a' }] as ModelMessage[]
    expect(prependInjectedContext(msgs, 'CTX')).toBe(msgs)
  })
})
