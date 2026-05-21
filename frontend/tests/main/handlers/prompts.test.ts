// Prompts IPC tests — path resolution + read + write.
//
// We point MAILAGENT_PROJECT_ROOT at an os.tmpdir() per-test scratch so the
// real prompts/ directory in this repo never gets clobbered. .env reads go
// through resolveEnvPath (handlers/env-path), which we override with
// MAILAGENT_ENV_FILE pointing into the same scratch.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// resolveEnvPath caches its first resolution per-process, so the env-path
// module needs a refresh helper between tests. We import via the same path
// as the handler so vitest's module cache is shared.
import { refreshEnvPath } from '../../../src/electron/main/lib/env-path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { once: vi.fn(), isPackaged: false, getPath: vi.fn(() => tmpdir()) }
}))

const handler = await import('../../../src/electron/main/handlers/prompts')

let root: string
let envFile: string

beforeEach(() => {
  // Unique scratch root per test so resolvePromptPath operations don't
  // collide. timestamp + Math.random keeps it cheap.
  root = join(tmpdir(), `mailagent-prompts-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(root, { recursive: true })
  envFile = join(root, '.env')
  // Empty .env — handler should fall back to defaults.
  writeFileSync(envFile, '', 'utf8')
  process.env['MAILAGENT_PROJECT_ROOT'] = root
  process.env['MAILAGENT_ENV_FILE'] = envFile
  refreshEnvPath()
})

afterEach(() => {
  delete process.env['MAILAGENT_PROJECT_ROOT']
  delete process.env['MAILAGENT_ENV_FILE']
  refreshEnvPath()
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
})

describe('resolvePromptPath', () => {
  test('default → <root>/prompts/email_{inbox,sent}.md', () => {
    expect(handler.resolvePromptPath('inbox')).toBe(join(root, 'prompts', 'email_inbox.md'))
    expect(handler.resolvePromptPath('sent')).toBe(join(root, 'prompts', 'email_sent.md'))
  })

  test('.env override (relative) → joined to root', () => {
    writeFileSync(envFile, 'LLM_INBOX_PROMPT_PATH=my/prompts/inbox.md\n', 'utf8')
    expect(handler.resolvePromptPath('inbox')).toBe(join(root, 'my', 'prompts', 'inbox.md'))
  })

  test('.env override (absolute, inside root) → verbatim', () => {
    const abs = join(root, 'custom.md')
    writeFileSync(envFile, `LLM_SENT_PROMPT_PATH=${abs}\n`, 'utf8')
    expect(handler.resolvePromptPath('sent')).toBe(abs)
  })

  test('.env override that escapes project root → throws E_PATH_ESCAPE', () => {
    writeFileSync(envFile, 'LLM_INBOX_PROMPT_PATH=../../etc/passwd\n', 'utf8')
    expect(() => handler.resolvePromptPath('inbox')).toThrow(/E_PATH_ESCAPE|escapes project root/)
  })

  test('absolute override outside root → throws E_PATH_ESCAPE', () => {
    writeFileSync(envFile, 'LLM_INBOX_PROMPT_PATH=/etc/passwd\n', 'utf8')
    expect(() => handler.resolvePromptPath('inbox')).toThrow(/E_PATH_ESCAPE|escapes project root/)
  })
})

describe('readPrompt', () => {
  test('missing file → {exists:false, content:""}', () => {
    const r = handler.readPrompt('inbox')
    expect(r.exists).toBe(false)
    expect(r.content).toBe('')
    expect(r.slot).toBe('inbox')
  })

  test('existing file → content returned verbatim', () => {
    const p = join(root, 'prompts', 'email_inbox.md')
    mkdirSync(join(root, 'prompts'), { recursive: true })
    writeFileSync(p, '# hello\n\nprompt body', 'utf8')
    const r = handler.readPrompt('inbox')
    expect(r.exists).toBe(true)
    expect(r.content).toBe('# hello\n\nprompt body')
  })
})

describe('writePrompt', () => {
  test('creates parent directory + file on first write', () => {
    expect(existsSync(join(root, 'prompts'))).toBe(false)
    const r = handler.writePrompt('sent', '# sent prompt')
    expect(r.exists).toBe(true)
    expect(existsSync(r.path)).toBe(true)
    expect(readFileSync(r.path, 'utf8')).toBe('# sent prompt')
  })

  test('overwrites existing content', () => {
    handler.writePrompt('inbox', 'v1')
    handler.writePrompt('inbox', 'v2 with more text')
    const r = handler.readPrompt('inbox')
    expect(r.content).toBe('v2 with more text')
  })
})
