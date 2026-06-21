// P2f — memory tools (memory_list/get/write/delete) against a mock platform.
// Verifies confirmation tiers, value serialization, session provenance, the
// user-edited-input path, and validation. No serve-api — the platform is mocked.

import { describe, expect, test, vi } from 'vitest'

import { createMemoryTools } from '../../../src/shared/chat/tools/builtin/memory'
import type { ChatToolPlatform } from '../../../src/shared/chat/platform'
import type { AgentMemoryEntry } from '../../../src/shared/chat/model'
import type { ToolDef, ToolExecCtx } from '../../../src/shared/chat/tools/registry'

const ctx: ToolExecCtx = { sessionId: 42, emailId: null, signal: new AbortController().signal }

function mockPlatform(over: Partial<ChatToolPlatform> = {}): ChatToolPlatform {
  return { ...over } as unknown as ChatToolPlatform
}

function byName(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

function entry(over: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    scope: 'user',
    key: 'k',
    value_json: '"v"',
    source_wiki_path: null,
    created_at: 1,
    updated_at: 1,
    ...over
  }
}

describe('memory tools — tiers + category', () => {
  test('reads are silent, writes are preview, all meta', () => {
    const tools = createMemoryTools(mockPlatform())
    expect(byName(tools, 'memory_list').confirmationTier).toBe('silent')
    expect(byName(tools, 'memory_get').confirmationTier).toBe('silent')
    expect(byName(tools, 'memory_write').confirmationTier).toBe('preview')
    expect(byName(tools, 'memory_delete').confirmationTier).toBe('preview')
    for (const t of tools) expect(t.category).toBe('meta')
  })
})

describe('memory_list / memory_get', () => {
  test('memory_list forwards scope', async () => {
    const listMemory = vi.fn(async () => [entry()])
    const res = await byName(
      createMemoryTools(mockPlatform({ listMemory })),
      'memory_list'
    ).handler({ scope: 'user' }, ctx)
    expect(listMemory).toHaveBeenCalledWith('user')
    expect(res).toMatchObject({ ok: true, output: { count: 1 } })
  })

  test('memory_get found / not-found + defaults scope=user', async () => {
    const getMemory = vi.fn(async (_s: string, k: string) => (k === 'k' ? entry() : null))
    const tools = createMemoryTools(mockPlatform({ getMemory }))
    const found = await byName(tools, 'memory_get').handler({ key: 'k' }, ctx)
    expect(getMemory).toHaveBeenCalledWith('user', 'k')
    expect(found).toMatchObject({ ok: true, output: { found: true, key: 'k' } })
    const miss = await byName(tools, 'memory_get').handler({ key: 'x' }, ctx)
    expect(miss).toMatchObject({ ok: true, output: { found: false } })
  })

  test('memory_get requires key', async () => {
    const res = await byName(
      createMemoryTools(mockPlatform({ getMemory: vi.fn() })),
      'memory_get'
    ).handler({}, ctx)
    expect(res).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })
})

describe('memory_write', () => {
  test('serializes value + records session provenance', async () => {
    const writeMemory = vi.fn(async (i: { scope: string; key: string; valueJson: string }) =>
      entry({ scope: i.scope, key: i.key, value_json: i.valueJson })
    )
    const res = await byName(
      createMemoryTools(mockPlatform({ writeMemory })),
      'memory_write'
    ).handler({ key: 'reply_language', value: 'English' }, ctx)
    expect(writeMemory).toHaveBeenCalledWith({
      scope: 'user',
      key: 'reply_language',
      valueJson: '"English"',
      sourceWikiPath: 'session:42'
    })
    expect(res).toMatchObject({ ok: true, output: { saved: true, key: 'reply_language' } })
  })

  test('requires key + value', async () => {
    const tools = createMemoryTools(mockPlatform({ writeMemory: vi.fn() }))
    expect(await byName(tools, 'memory_write').handler({ value: 'x' }, ctx)).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
    expect(await byName(tools, 'memory_write').handler({ key: 'k' }, ctx)).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
  })

  test('honors user-edited input from the confirm dialog', async () => {
    const writeMemory = vi.fn(async (i: { scope: string; key: string; valueJson: string }) =>
      entry({ value_json: i.valueJson })
    )
    const res = await byName(
      createMemoryTools(mockPlatform({ writeMemory })),
      'memory_write'
    ).handler(
      { key: 'k', value: 'original' },
      { ...ctx, userEditedInput: { key: 'k', value: 'edited' } }
    )
    expect(writeMemory).toHaveBeenCalledWith(expect.objectContaining({ valueJson: '"edited"' }))
    expect(res).toMatchObject({ ok: true, output: { user_edited: true } })
  })
})

describe('memory_delete', () => {
  test('deletes by scope+key', async () => {
    const deleteMemory = vi.fn(async () => 1)
    const res = await byName(
      createMemoryTools(mockPlatform({ deleteMemory })),
      'memory_delete'
    ).handler({ key: 'k', scope: 'skill:x' }, ctx)
    expect(deleteMemory).toHaveBeenCalledWith('skill:x', 'k')
    expect(res).toMatchObject({ ok: true, output: { deleted: 1 } })
  })
})
