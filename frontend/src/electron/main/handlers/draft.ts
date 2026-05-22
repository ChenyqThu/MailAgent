// Mail.app reply-draft IPC handler.
//
// `email:createDraft` opens a Mail.app **reply-all** draft pre-filled with the
// caller's markdown body, copy-pastes it via NSPasteboard so rich text
// survives, then ⌘S to save into Drafts and ⌘W to close — the same pipeline
// the backend uses for `handle_create_draft` (see `src/events/handlers.py`).
// We do NOT compose AppleScript inline anymore: the previous frontend-only
// path called `set content of draftMsg` which only takes plaintext, losing
// every list / bold / link the LLM produced. Delegating to
// `scripts/create_reply_draft.sh` gives us the same UX as a Notion webhook
// trigger (reply-all + clipboard paste + save).
//
// Why a shell script and not pure TS:
//   1. `scripts/html_clipboard.py` already converts markdown → HTML +
//      writes NSPasteboardTypeHTML via PyObjC; rewriting that in JS would
//      duplicate a lot of `AppKit` interop;
//   2. the shell script's System Events `keystroke "v"` retry/verify loop
//      survives Mail.app focus drift better than a one-shot osascript.
//
// Permissions: macOS prompts for Automation access on first run ("Allow
// MailAgent to control Mail.app"). The user MUST accept the prompt for
// any subsequent createDraft to work — we surface this as
// `E_AUTOMATION_DENIED` so the renderer can guide them through System
// Settings → Privacy → Automation.

import { ipcMain } from 'electron'
import { execa } from 'execa'
import { existsSync } from 'fs'
import { join } from 'path'

import { getDb } from '../db'
import { getProjectRoot } from '../cli_runner'

// ---- request / response shapes ---------------------------------------------

export interface CreateDraftOpts {
  internalId: number
  /** Markdown body the user typed / accepted; converted to HTML by
   *  `scripts/html_clipboard.py` inside the bash pipeline before pasting. */
  body?: string
}

export interface CreateDraftResult {
  internalId: number
  mailbox: string | null
  accountName: string | null
  /** The shell script's `method` field — e.g. `reply_all_internal_id`,
   *  `reply_all_message_id`, `standalone_fallback`. Stored so the renderer
   *  can render the toast with provenance ("via Reply-All by internal id"). */
  draftId: string
}

export type CreateDraftEnvelope =
  | { ok: true; data: CreateDraftResult }
  | { ok: false; code: string; message: string }

// ---- limits / config -------------------------------------------------------

/** Bash script's paste-retry loop can take 5-10s on cold Mail.app launch.
 *  Match the backend `handle_create_draft` 120s budget so we don't pre-empt
 *  a slow but otherwise-healthy draft creation. */
const SCRIPT_TIMEOUT_MS = 120_000

/** Hard upper bound on body length we'll forward to the shell pipeline.
 *  Real reply drafts top out well below this; the script itself doesn't
 *  enforce a limit so we cap here to keep argv reasonable. */
const MAX_BODY_CHARS = 50_000

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

/** The Mail.app account name the script looks up the source message under.
 *  Backend's `MAIL_ACCOUNT_NAME` env (see project CLAUDE.md) is canonical.
 *  Falls back to the script's built-in `Exchange` default when unset. */
function getAccountName(): string | null {
  const fromEnv = process.env['MAIL_ACCOUNT_NAME']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return null
}

// ---- shell-script invocation ----------------------------------------------

export interface DraftCommand {
  cmd: string
  args: string[]
  scriptPath: string
}

/** Build the bash invocation for `scripts/create_reply_draft.sh`. Exported
 *  so a unit test can assert argv shape without touching the live
 *  Mail.app / clipboard. */
export function buildDraftCommand(opts: {
  scriptPath: string
  internalId: number
  mailbox: string
  account: string | null
  replyText: string
}): DraftCommand {
  const args = [
    opts.scriptPath,
    '--mode',
    'reply-all',
    '--reply-text',
    opts.replyText,
    '--mailbox',
    opts.mailbox,
    '--internal-id',
    String(opts.internalId)
  ]
  if (opts.account) {
    args.push('--account', opts.account)
  }
  return { cmd: 'bash', args, scriptPath: opts.scriptPath }
}

interface ScriptOutcome {
  success: boolean
  method?: string
  error?: string
}

/** Best-effort parse of the script's JSON line. The shell writes a single
 *  JSON object on stdout; we tolerate trailing whitespace and embedded
 *  debug lines by scanning for the last `{...}` block. */
export function parseScriptOutput(stdout: string): ScriptOutcome | null {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return null
  // The script logs progress to stderr but `success:` JSON sits alone on
  // stdout. If somehow extra lines slipped in, pick the last `{ ... }`.
  const last = trimmed.lastIndexOf('{')
  if (last < 0) return null
  const tail = trimmed.slice(last)
  try {
    const parsed = JSON.parse(tail) as ScriptOutcome
    return parsed
  } catch {
    return null
  }
}

/** Map a script-side error message to one of the error codes the renderer's
 *  toast-key switch already understands (see `MessageList.tsx` /
 *  `AIFieldsBlock.tsx`). Pure function — exported for tests. */
export function classifyScriptError(payload: { stderr: string; scriptError: string | null }): {
  code: string
  message: string
} {
  const haystack = [payload.stderr, payload.scriptError ?? ''].join('\n').toLowerCase()
  if (
    haystack.includes('not allowed assistive access') ||
    haystack.includes('not authorized') ||
    haystack.includes('automation')
  ) {
    return {
      code: 'E_AUTOMATION_DENIED',
      message:
        'macOS blocked AppleScript automation. Allow MailAgent in System Settings → Privacy & Security → Automation → Mail.'
    }
  }
  if (
    haystack.includes('mail got an error: can') ||
    haystack.includes('mail.app refused') ||
    haystack.includes('is it open')
  ) {
    return { code: 'E_MAIL_NOT_RUNNING', message: 'Mail.app refused — is it open?' }
  }
  if (
    haystack.includes('not found in any account') ||
    haystack.includes('paste verification failed')
  ) {
    return {
      code: 'E_NOT_FOUND',
      message: payload.scriptError ?? 'Source message not found / paste verification failed'
    }
  }
  const detail = payload.scriptError ?? payload.stderr.trim()
  if (detail.length > 0) {
    return {
      code: 'E_APPLESCRIPT',
      message: `create_reply_draft.sh failed: ${detail.slice(0, 200)}`
    }
  }
  return { code: 'E_APPLESCRIPT', message: 'create_reply_draft.sh failed: unknown error' }
}

export async function createDraft(opts: CreateDraftOpts): Promise<CreateDraftResult> {
  if (!Number.isInteger(opts.internalId) || opts.internalId < 0) {
    throw Object.assign(new Error('createDraft: internalId must be non-negative integer'), {
      code: 'E_INVALID_ARG'
    })
  }
  const replyText =
    typeof opts.body === 'string' && opts.body.trim().length > 0
      ? opts.body.slice(0, MAX_BODY_CHARS)
      : ''
  if (replyText.length === 0) {
    throw Object.assign(new Error('createDraft: body (reply markdown) is required'), {
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
  const scriptPath = join(getProjectRoot(), 'scripts', 'create_reply_draft.sh')
  if (!existsSync(scriptPath)) {
    throw Object.assign(new Error(`create_reply_draft.sh not found at ${scriptPath}`), {
      code: 'E_NOT_FOUND'
    })
  }

  const accountName = getAccountName()
  const { cmd, args } = buildDraftCommand({
    scriptPath,
    internalId: opts.internalId,
    mailbox: row.mailbox,
    account: accountName,
    replyText
  })

  const result = await execa(cmd, args, {
    timeout: SCRIPT_TIMEOUT_MS,
    reject: false,
    buffer: true,
    // Homebrew / PyObjC python3 typically lives outside Electron's default
    // PATH. Augmenting the env keeps the script's `python3` shebang lookup
    // working in packaged builds without forcing the user to add to PATH.
    env: {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/opt/homebrew/bin:/usr/bin`
    }
  })

  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const exitCode = result.exitCode ?? -1

  if (result.timedOut) {
    throw Object.assign(new Error(`create_reply_draft.sh exceeded ${SCRIPT_TIMEOUT_MS}ms`), {
      code: 'E_TIMEOUT'
    })
  }

  const outcome = parseScriptOutput(stdout)
  if (exitCode === 0 && outcome?.success === true) {
    return {
      internalId: opts.internalId,
      mailbox: row.mailbox,
      accountName,
      draftId: outcome.method ?? 'reply_all'
    }
  }

  const { code, message } = classifyScriptError({
    stderr,
    scriptError: outcome?.error ?? null
  })
  throw Object.assign(new Error(message), { code })
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
  buildDraftCommand,
  classifyScriptError,
  lookupMailbox,
  parseScriptOutput
}
