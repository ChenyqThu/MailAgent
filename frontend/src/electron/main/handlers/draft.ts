// Sprint 5 §2.2 — Mail.app reply-draft IPC handler.
//
// `email:createDraft` opens a Mail.app reply window pre-filled with the
// quoted source message. The user types/edits in Mail.app and clicks send
// there — we don't send through our process (sending mail from the user's
// account requires the same Mail.app credentials that already flow through
// the macOS Mail database, and opening a draft is the only path that
// triggers Mail.app's standard "Reply From" account picker).
//
// The implementation is intentionally minimal for V1:
//   - tell Mail.app to `reply` the source message `with opening window`
//   - if `body` is supplied AND the user opted into prefill, set the
//     content (plaintext). Markdown / HTML clipboard pasting is Sprint 6
//     (Path A in MEMORY.md uses NSPasteboard).
//   - no recipients override — Mail.app populates To / Cc / Subject from
//     the source message; the user can edit them in the compose window.
//
// Why AppleScript and not a CLI: `mailagent` doesn't expose a draft-creation
// command (the backend handles draft creation via Notion webhook → Redis
// → osascript on the same host; the frontend bypasses that round-trip and
// runs the AppleScript directly).
//
// Permissions: macOS prompts for Automation access on first run ("Allow
// MailAgent to control Mail.app"). The user MUST accept the prompt for
// any subsequent createDraft to work — we surface this as
// `E_AUTOMATION_DENIED` so the renderer can guide them through System
// Settings → Privacy → Automation.

import { ipcMain } from 'electron'
import { execa } from 'execa'

import { getDb } from '../db'

// ---- request / response shapes ---------------------------------------------

export interface CreateDraftOpts {
  internalId: number
  /** Optional plaintext body to prepend above the quoted source. */
  body?: string
}

export interface CreateDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  draftId: string
}

export type CreateDraftEnvelope =
  | { ok: true; data: CreateDraftResult }
  | { ok: false; code: string; message: string }

// ---- limits / config -------------------------------------------------------

/** Mail.app's first AppleScript invocation can be slow on a cold launch. */
const APPLESCRIPT_TIMEOUT_MS = 30_000

/** Hard upper bound on body length we'll inject into AppleScript — avoids
 *  pathological osascript -e arg sizes and limits the surface for escaping
 *  edge cases. Real reply drafts top out well below this. */
const MAX_BODY_CHARS = 8000

// ---- AppleScript string escaping ------------------------------------------

/** Escape a JS string for use inside an AppleScript double-quoted literal.
 *  AppleScript's lexer needs `\\` for backslash and `\"` for quote; other
 *  printable chars pass through. Newlines stay literal — AppleScript
 *  string literals accept embedded line breaks. */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---- mailbox lookup --------------------------------------------------------

interface EmailMailboxRow {
  internal_id: number
  mailbox: string | null
}

function lookupMailbox(internalId: number): EmailMailboxRow | null {
  const db = getDb()
  const row = db
    .prepare('SELECT internal_id, mailbox FROM email_metadata WHERE internal_id = ?')
    .get(internalId) as EmailMailboxRow | undefined
  return row ?? null
}

/** The Mail.app account name we look up the message under. Backend's
 *  `MAIL_ACCOUNT_NAME` env (see project CLAUDE.md) is the canonical
 *  setting — frontend re-reads it so we don't duplicate the contract.
 *  Sprint 6 SettingsPage will add a UI override. Returns null if not set;
 *  the AppleScript path then degrades to "any account" lookup. */
function getAccountName(): string | null {
  const fromEnv = process.env['MAIL_ACCOUNT_NAME']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return null
}

// ---- AppleScript composition ----------------------------------------------

interface ScriptOpts {
  internalId: number
  mailbox: string
  account: string | null
  body: string | null
}

/** Build the AppleScript that opens a reply draft. When `account` is null
 *  we walk every account looking for a message whose internal id matches —
 *  slower (Mail.app loops) but still bounded since each account's index is
 *  hashed by message id. The script returns the draft id (or "" on a
 *  permission denial that returned silently). */
export function buildDraftScript(opts: ScriptOpts): string {
  const id = opts.internalId
  const mbEsc = escapeAppleScriptString(opts.mailbox)
  const acctEsc = opts.account ? escapeAppleScriptString(opts.account) : null
  const bodyEsc = opts.body ? escapeAppleScriptString(opts.body) : null

  // Branch 1: known account. Targeted lookup via `whose id is <int>`.
  if (acctEsc) {
    const setBody = bodyEsc
      ? `set content of draftMsg to ("${bodyEsc}" & return & return & (content of draftMsg as string))`
      : ''
    return [
      'tell application "Mail"',
      '  activate',
      `  set origMsg to first message of mailbox "${mbEsc}" of account "${acctEsc}" whose id is ${id}`,
      '  set draftMsg to reply origMsg with opening window',
      setBody,
      '  return id of draftMsg as string',
      'end tell'
    ]
      .filter((line) => line.length > 0)
      .join('\n')
  }

  // Branch 2: unknown account. Iterate accounts until we find one that
  // owns this internal id. Stops at the first match.
  const setBody = bodyEsc
    ? `      set content of draftMsg to ("${bodyEsc}" & return & return & (content of draftMsg as string))`
    : ''
  return [
    'tell application "Mail"',
    '  activate',
    '  set draftId to ""',
    '  repeat with acct in every account',
    '    try',
    `      set origMsg to first message of mailbox "${mbEsc}" of acct whose id is ${id}`,
    '      set draftMsg to reply origMsg with opening window',
    setBody,
    '      set draftId to id of draftMsg as string',
    '      exit repeat',
    '    on error',
    '      -- mailbox not in this account, keep looking',
    '    end try',
    '  end repeat',
    '  if draftId is "" then error "internal_id not found in any account" number -2700',
    '  return draftId',
    'end tell'
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// ---- AppleScript invocation -----------------------------------------------

interface ExecaShape {
  stdout: string | unknown
  stderr: string | unknown
  exitCode?: number | null
}

function classifyAppleScriptError(err: unknown): { code: string; message: string } {
  const e = err as Partial<ExecaShape> & { exitCode?: number | null; message?: string }
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  const lower = stderr.toLowerCase()
  if (lower.includes('not allowed assistive access') || lower.includes('not authorized')) {
    return {
      code: 'E_AUTOMATION_DENIED',
      message:
        'macOS blocked AppleScript automation. Allow MailAgent in System Settings → Privacy & Security → Automation → Mail.'
    }
  }
  if (lower.includes('execution error: mail got an error: can')) {
    return { code: 'E_MAIL_NOT_RUNNING', message: 'Mail.app refused — is it open?' }
  }
  if (lower.includes('internal_id not found')) {
    return { code: 'E_NOT_FOUND', message: 'Source message not found in any Mail.app account' }
  }
  // stderr usually has the real Mail.app error context; `e.message` is
  // typically just "Command failed with exit code N" from execa. Prefer
  // stderr when it has anything substantive.
  const trimmed = stderr.trim()
  if (trimmed.length > 0) {
    return { code: 'E_APPLESCRIPT', message: `osascript failed: ${trimmed.slice(0, 200)}` }
  }
  return {
    code: 'E_APPLESCRIPT',
    message: e.message ?? 'osascript failed: unknown error'
  }
}

export async function createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult> {
  if (!Number.isInteger(opts.internalId) || opts.internalId < 0) {
    throw Object.assign(new Error('createDraft: internalId must be non-negative integer'), {
      code: 'E_INVALID_ARG'
    })
  }
  const row = lookupMailbox(opts.internalId)
  if (!row) {
    throw Object.assign(
      new Error(`email_metadata row missing for internal_id=${opts.internalId}`),
      {
        code: 'E_NOT_FOUND'
      }
    )
  }
  if (!row.mailbox) {
    throw Object.assign(
      new Error(`email_metadata row has null mailbox for internal_id=${opts.internalId}`),
      { code: 'E_NO_MAILBOX' }
    )
  }
  const accountName = getAccountName()
  const trimmedBody =
    typeof opts.body === 'string' && opts.body.length > 0
      ? opts.body.slice(0, MAX_BODY_CHARS)
      : null
  const script = buildDraftScript({
    internalId: opts.internalId,
    mailbox: row.mailbox,
    account: accountName,
    body: trimmedBody
  })

  const result = await execa('osascript', ['-e', script], {
    timeout: APPLESCRIPT_TIMEOUT_MS,
    reject: false,
    buffer: true
  })

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const exitCode = result.exitCode ?? -1

  if (result.timedOut) {
    throw Object.assign(
      new Error(`osascript exceeded ${APPLESCRIPT_TIMEOUT_MS}ms creating draft`),
      { code: 'E_TIMEOUT' }
    )
  }
  if (exitCode !== 0) {
    const { code, message } = classifyAppleScriptError({
      stderr,
      message: stderr || `osascript exit ${exitCode}`
    })
    throw Object.assign(new Error(message), { code })
  }

  return {
    internalId: opts.internalId,
    mailbox: row.mailbox,
    accountName,
    draftId: stdout
  }
}

// ---- IPC wiring ------------------------------------------------------------

export function registerDraftHandlers(): void {
  ipcMain.handle(
    'email:createDraft',
    async (_evt, opts: CreateDraftOpts): Promise<CreateDraftEnvelope> => {
      try {
        const data = await createDraft(opts ?? { internalId: -1 })
        return { ok: true, data }
      } catch (err) {
        const code =
          err instanceof Error && typeof (err as Error & { code?: string }).code === 'string'
            ? (err as Error & { code: string }).code
            : 'E_DISPATCH'
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, code, message }
      }
    }
  )
}

export const __testing = {
  buildDraftScript,
  classifyAppleScriptError,
  lookupMailbox
}
