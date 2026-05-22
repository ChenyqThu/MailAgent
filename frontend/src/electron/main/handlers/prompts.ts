// LLM prompt file IPC — read / write the markdown files that drive the
// Python-side LLM agent (inbox + sent inboxes).
//
// Why a dedicated IPC instead of a generic file handler: each prompt has a
// known role (inbox / sent), a configurable path (LLM_INBOX_PROMPT_PATH /
// LLM_SENT_PROMPT_PATH in repo-root .env), and a default location inside
// the project tree. The renderer addresses prompts by slot — the main
// process resolves the on-disk path and clamps it to the project root so
// a compromised renderer can't read or write arbitrary files via this IPC.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'

import { ipcMain } from 'electron'

import { getProjectRoot } from '../cli_runner'
import { resolveEnvPath } from '../lib/env-path'
import { parseEnv, toRecord } from '../lib/env-parser'

export type PromptSlot = 'inbox' | 'sent'

export interface PromptInfo {
  slot: PromptSlot
  path: string
  exists: boolean
}

export interface PromptContent extends PromptInfo {
  content: string
}

export type PromptWriteResult = { ok: true; info: PromptInfo } | { ok: false; code: string; message: string }

const DEFAULTS: Record<PromptSlot, string> = {
  inbox: 'prompts/email_inbox.md',
  sent: 'prompts/email_sent.md'
}

const ENV_KEY: Record<PromptSlot, string> = {
  inbox: 'LLM_INBOX_PROMPT_PATH',
  sent: 'LLM_SENT_PROMPT_PATH'
}

/**
 * Resolve a prompt's on-disk absolute path. Order:
 *   1. .env override (LLM_*_PROMPT_PATH) — relative paths resolve against
 *      the project root, absolute paths are taken verbatim
 *   2. built-in default (prompts/email_{inbox,sent}.md under project root)
 *
 * Always returns an absolute path. Throws when the resolved path escapes
 * the project root — the IPC layer surfaces that as E_PATH_ESCAPE so a
 * misconfigured .env can't make us read /etc/passwd.
 */
export function resolvePromptPath(slot: PromptSlot): string {
  const root = getProjectRoot()
  const envValues = readEnvSafe()
  const override = envValues[ENV_KEY[slot]]
  const rel = override && override.length > 0 ? override : DEFAULTS[slot]
  const absolute = isAbsolute(rel) ? rel : resolve(root, rel)
  // Clamp: the resolved path must live under the project root. Computing the
  // relative path is the canonical way to detect an escape — a leading `..`
  // or a Windows drive change both make `relative()` produce a non-empty
  // backreference.
  const rel2root = relative(root, absolute)
  if (rel2root.startsWith('..') || isAbsolute(rel2root)) {
    throw new PromptIpcError(
      'E_PATH_ESCAPE',
      `Prompt path "${rel}" escapes project root "${root}"`
    )
  }
  return absolute
}

class PromptIpcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PromptIpcError'
  }
}

function readEnvSafe(): Record<string, string> {
  try {
    const path = resolveEnvPath()
    if (!existsSync(path)) return {}
    return toRecord(parseEnv(readFileSync(path, 'utf8')))
  } catch {
    // .env unreadable (first-run before settings page touches it) → fall
    // back to defaults. The renderer can still write a prompt; we'll just
    // use the built-in default path.
    return {}
  }
}

export function getPromptInfo(slot: PromptSlot): PromptInfo {
  const path = resolvePromptPath(slot)
  return { slot, path, exists: existsSync(path) }
}

export function readPrompt(slot: PromptSlot): PromptContent {
  const info = getPromptInfo(slot)
  if (!info.exists) return { ...info, content: '' }
  const content = readFileSync(info.path, 'utf8')
  return { ...info, content }
}

export function writePrompt(slot: PromptSlot, content: string): PromptInfo {
  const info = getPromptInfo(slot)
  const dir = dirname(info.path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(info.path, content, 'utf8')
  return { ...info, exists: true }
}

export function registerPromptHandlers(): void {
  ipcMain.handle(
    'prompts:list',
    async (): Promise<{ inbox: PromptInfo; sent: PromptInfo }> => {
      return {
        inbox: getPromptInfo('inbox'),
        sent: getPromptInfo('sent')
      }
    }
  )
  ipcMain.handle('prompts:read', async (_evt, slot: PromptSlot): Promise<PromptContent> => {
    if (slot !== 'inbox' && slot !== 'sent') {
      throw new PromptIpcError('E_INVALID_SLOT', `unknown prompt slot "${String(slot)}"`)
    }
    return readPrompt(slot)
  })
  ipcMain.handle(
    'prompts:write',
    async (_evt, payload: { slot: PromptSlot; content: string }): Promise<PromptWriteResult> => {
      if (!payload || (payload.slot !== 'inbox' && payload.slot !== 'sent')) {
        return { ok: false, code: 'E_INVALID_SLOT', message: 'invalid prompt slot' }
      }
      if (typeof payload.content !== 'string') {
        return { ok: false, code: 'E_INVALID_CONTENT', message: 'content must be a string' }
      }
      try {
        const info = writePrompt(payload.slot, payload.content)
        return { ok: true, info }
      } catch (err) {
        const code = err instanceof PromptIpcError ? err.code : 'E_WRITE'
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code, message }
      }
    }
  )
}
