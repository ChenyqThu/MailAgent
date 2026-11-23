// Reply-draft IPC handler (`email:createDraft` — 正文 Craft 按钮).
//
// 主路径 (MAILAGENT_BACKEND!=='applescript'，即 davmail / outlook_com): 转发本机
// serve-api `POST /email/draft`，传纯回复正文 + quoteOriginal、不传 to/cc → 服务端
// 按原邮件推导 **reply-all** 收件人 + 在正文下方拼引用原文，经 backend 协议
// append_draft 写进 Drafts (davmail=IMAP APPEND / outlook_com=COM CreateItem+Save)。
// 与 chat `email_draft_reply` 工具同契约 (gateway ai-gateway/tools/write.ts)。
//
// Emergency fallback (MAILAGENT_BACKEND==='applescript'): `createDraftViaAppleScript`
// 经 `scripts/create_reply_draft.sh` 在 Mail.app 里开 reply-all 草稿并 clipboard
// 粘贴正文 (NSPasteboard 保富文本 → ⌘S 存 Drafts)。
//
// Why a shell script (fallback) and not pure TS:
//   1. `scripts/html_clipboard.py` already converts markdown → HTML +
//      writes NSPasteboardTypeHTML via PyObjC; rewriting that in JS would
//      duplicate a lot of `AppKit` interop;
//   2. the shell script's System Events `keystroke "v"` retry/verify loop
//      survives Mail.app focus drift better than a one-shot osascript.
//
// Permissions (fallback only): macOS prompts for Automation access on first run
// ("Allow MailAgent to control Mail.app"). The user MUST accept the prompt for
// any subsequent AppleScript createDraft to work — we surface this as
// `E_AUTOMATION_DENIED` so the renderer can guide them through System
// Settings → Privacy → Automation.

import { execa } from 'execa'

import { typedIpcHandle } from '../ipc/typedHandle'
import { existsSync } from 'fs'
import { join } from 'path'

import { getDb } from '../db'
import { resolveBundledResourcesRoot } from '../cli_runner'
import { daemonRequest } from '../daemon_api'

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

/** Backend selector — mirrors the Python `MAILAGENT_BACKEND` switch (default
 *  applescript; 值域三值 applescript | davmail | outlook_com, 单源
 *  @shared/lib/mailBackend)。判据 = 「非 applescript 都走 serve-api 通用 backend
 *  路径」(镜像 Python 侧 `== "davmail"` → `!= "applescript"` 的修正模式):
 *  serve-api `/email/draft` → MailWriteService.compose_draft → 协议 append_draft,
 *  davmail 与 outlook_com 同路; applescript 模式才回退到 Mail.app GUI 注入。
 *  空白值（unset / `MAILAGENT_BACKEND=` 空行）按默认 applescript 处理 —— 与改判据
 *  前 `=== 'davmail'` 时代的空值走向逐字节一致, 不让脏 env 把草稿悄悄改道。 */
function usesServeApiDraftPath(): boolean {
  const backend = (process.env['MAILAGENT_BACKEND'] ?? '').trim().toLowerCase()
  return backend !== '' && backend !== 'applescript'
}

/** POST /email/draft 返回的 DraftResult data 块的相关字段（createDraft 投影为
 *  CreateDraftResult）。其余字段（success/appended_uid/to_count/…）此处不读。 */
interface DraftEndpointData {
  internal_id: number
  drafts_folder?: string | null
  method?: string | null
}

/** 正文 Craft 按钮的草稿创建（`email:createDraft` IPC）。
 *
 *  通用 backend 主路径（davmail / outlook_com）：转发本机 serve-api `POST /email/draft`，
 *  传纯回复正文 + quoteOriginal、不传 to/cc → 服务端按原邮件推导 reply-all 收件人 +
 *  在正文下方拼引用原文（协议 append_draft）。等效于点顶部「回复所有 + 带原文引用」，
 *  与 chat email_draft_reply 工具同契约。
 *
 *  applescript 模式（emergency fallback）：保留旧 `create_reply_draft.sh` GUI 注入路径。 */
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

  // 通用 backend 主路径 (davmail / outlook_com) — 转发 serve-api（不传 to/cc →
  // 服务端推导 reply-all + 拼引用原文）。
  if (usesServeApiDraftPath()) {
    const data = (await daemonRequest('POST', '/email/draft', {
      body: {
        internalId: opts.internalId,
        mode: 'reply-all',
        bodyText: replyText,
        quoteOriginal: true
      }
    })) as DraftEndpointData
    return {
      internalId: data.internal_id,
      mailbox: data.drafts_folder ?? null,
      accountName: null,
      draftId: data.method ?? 'reply_all'
    }
  }

  // applescript fallback — Mail.app GUI 注入（reply-all + clipboard paste + ⌘S）。
  return createDraftViaAppleScript(opts, replyText)
}

/** Emergency fallback：`MAILAGENT_BACKEND==='applescript'` 时经 `create_reply_draft.sh`
 *  在 Mail.app 里开 reply-all 草稿并 clipboard 粘贴正文（保留富文本）。replyText 已由
 *  调用方裁剪/校验非空。 */
async function createDraftViaAppleScript(
  opts: CreateDraftOpts,
  replyText: string
): Promise<CreateDraftResult> {
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
  const scriptPath = join(resolveBundledResourcesRoot(), 'scripts', 'create_reply_draft.sh')
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
  typedIpcHandle(
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
  parseScriptOutput,
  usesServeApiDraftPath
}
