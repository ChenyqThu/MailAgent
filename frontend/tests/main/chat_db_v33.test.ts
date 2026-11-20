// Phase 4 WP-4B (CHAT_DB v33) — 缓存 token 落库 + ai_llm_usage_log 辅助消耗台账迁移测试。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendLlmUsageLog,
  appendMessage,
  closeChatDb,
  createNewSession,
  getChatDb,
  getMessage,
  updateMessage
} from '../../src/electron/main/chat_db'
import { insertGroupTurn } from '../../src/electron/main/chat_db/groups'

const { appMock } = vi.hoisted(() => ({
  appMock: { isPackaged: false, getPath: (_k: string) => '/tmp' } as {
    isPackaged: boolean
    getPath: (key: string) => string
  }
}))
vi.mock('electron', () => ({ app: appMock }))

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-db-v33-'))
  dbPath = join(tmpDir, 'ai_chat.db')
  process.env['AI_CHAT_DB_PATH'] = dbPath
  closeChatDb()
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

const schemaVersion = (): number => {
  const row = getChatDb()
    .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
    .get() as { value: string }
  return Number(row.value)
}

const columnNames = (table: string): string[] =>
  (getChatDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  )

const tableNames = (): string[] =>
  (
    getChatDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((t) => t.name)

describe('CHAT_DB v33 migration & usage persistence', () => {
  test('fresh DB carries v33 cache columns + ai_llm_usage_log at schema_version 33', () => {
    expect(schemaVersion()).toBe(33)
    expect(columnNames('ai_chat_messages')).toEqual(
      expect.arrayContaining(['cache_read_tokens', 'cache_write_tokens'])
    )
    expect(columnNames('ai_chat_group_turn')).toEqual(
      expect.arrayContaining(['cache_read_tokens', 'cache_write_tokens'])
    )
    expect(tableNames()).toContain('ai_llm_usage_log')
  })

  test('crash-before-meta replay (meta=32 on v33 DB) is idempotent', () => {
    expect(schemaVersion()).toBe(33)
    getChatDb()
      .prepare("INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '32')")
      .run()
    closeChatDb()
    expect(() => schemaVersion()).not.toThrow()
    expect(schemaVersion()).toBe(33)
  })

  test('appendMessage / updateMessage / insertGroupTurn / appendLlmUsageLog persist v33 columns', () => {
    const sess = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    const msg = appendMessage({
      sessionId: sess.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete',
      model: 'anthropic:claude-sonnet-4-5',
      tokensInput: 1000,
      tokensOutput: 200,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      costUsd: 0.0042
    })
    expect(msg.cache_read_tokens).toBe(700)
    expect(msg.cache_write_tokens).toBe(100)

    updateMessage(msg.id, { cacheReadTokens: 800, cacheWriteTokens: 50, costUsd: 0.005 })
    const reloaded = getMessage(msg.id)
    expect(reloaded?.cache_read_tokens).toBe(800)
    expect(reloaded?.cache_write_tokens).toBe(50)
    expect(reloaded?.cost_usd).toBe(0.005)

    const turnId = insertGroupTurn({
      sessionId: sess.id,
      runId: 'run-1',
      chainId: 1,
      seq: 1,
      agentId: 'a1',
      triggerKind: 'human',
      outcome: 'spoke',
      tokensInput: 500,
      tokensOutput: 60,
      cacheReadTokens: 300,
      cacheWriteTokens: 25,
      costUsd: 0.002,
      startedAt: Date.now()
    })
    const turnRow = getChatDb()
      .prepare('SELECT cache_read_tokens, cache_write_tokens FROM ai_chat_group_turn WHERE id = ?')
      .get(turnId) as { cache_read_tokens: number; cache_write_tokens: number }
    expect(turnRow).toEqual({ cache_read_tokens: 300, cache_write_tokens: 25 })

    const usageId = appendLlmUsageLog({
      surface: 'auto_title',
      providerId: 'anthropic',
      model: 'anthropic:claude-sonnet-4-5',
      protocol: 'anthropic',
      tokensInput: 120,
      tokensOutput: 15,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      costUsd: 0.0003,
      latencyMs: 210
    })
    const usageRow = getChatDb()
      .prepare('SELECT surface, cache_read_tokens, cost_usd FROM ai_llm_usage_log WHERE id = ?')
      .get(usageId) as { surface: string; cache_read_tokens: number; cost_usd: number }
    expect(usageRow).toEqual({ surface: 'auto_title', cache_read_tokens: 80, cost_usd: 0.0003 })
  })
})
