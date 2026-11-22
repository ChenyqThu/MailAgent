// Shared types, DavMail defaults, and config/folder helpers for onboarding wizard.

import type { FolderInfo } from '@shared/api/types'

import type { BackendKind, CompleteConfig, PluginFlags } from '../ipc'

export interface ConfigForm {
  USER_EMAIL?: string
  NOTION_TOKEN?: string
  EMAIL_DATABASE_ID?: string
  CALENDAR_DATABASE_ID?: string
  MAIL_ACCOUNT_NAME?: string
  SYNC_MAILBOXES?: string[]
  // — DavMail 连接配置 (仅 backend==='davmail' 时填; applescript 分支不展示/不收集)。
  DAVMAIL_HOST?: string
  DAVMAIL_IMAP_PORT?: string
  DAVMAIL_SMTP_PORT?: string
  /** PoC 默认密钥开关。true → DAVMAIL_POC_MODE=true (用默认 shared key);
   *  false → 需填 DAVMAIL_POC_CIPHER_KEY。默认 true。 */
  DAVMAIL_POC_MODE?: boolean
  DAVMAIL_POC_CIPHER_KEY?: string
}

export const DAVMAIL_DEFAULT_HOST = '127.0.0.1'
export const DAVMAIL_DEFAULT_IMAP_PORT = '1143'
export const DAVMAIL_DEFAULT_SMTP_PORT = '1025'

export interface SubmitError {
  title: string
  message: string
}

export function collectSystemImapNames(folders: FolderInfo[]): Set<string> {
  const out = new Set<string>()
  for (const f of folders) if (f.is_system) out.add(f.imap_name)
  return out
}

const PLUGIN_KEYS = ['llm', 'calendar'] as const

export function buildCompleteConfig(
  form: ConfigForm,
  backend: BackendKind,
  plugins: Record<string, boolean>
): CompleteConfig {
  const pluginFlags: PluginFlags = {}
  for (const key of PLUGIN_KEYS) {
    pluginFlags[key] = Boolean(plugins[key])
  }
  const cfg: CompleteConfig = {
    NOTION_TOKEN: (form.NOTION_TOKEN ?? '').trim(),
    EMAIL_DATABASE_ID: (form.EMAIL_DATABASE_ID ?? '').trim(),
    USER_EMAIL: (form.USER_EMAIL ?? '').trim(),
    MAILAGENT_BACKEND: backend,
    plugins: pluginFlags
  }
  const cal = (form.CALENDAR_DATABASE_ID ?? '').trim()
  if (cal) cfg.CALENDAR_DATABASE_ID = cal
  const acct = (form.MAIL_ACCOUNT_NAME ?? '').trim()
  if (acct) cfg.MAIL_ACCOUNT_NAME = acct
  const mailboxes = form.SYNC_MAILBOXES ?? []
  if (mailboxes.length > 0) cfg.SYNC_MAILBOXES = mailboxes.join(',')
  // davmail 连接配置 (仅 davmail 后端收集; handler 在 applescript 模式忽略这些 key)。
  if (backend === 'davmail') {
    const host = (form.DAVMAIL_HOST ?? '').trim()
    if (host) cfg.DAVMAIL_HOST = host
    const imapPort = (form.DAVMAIL_IMAP_PORT ?? '').trim()
    if (imapPort) cfg.DAVMAIL_IMAP_PORT = imapPort
    const smtpPort = (form.DAVMAIL_SMTP_PORT ?? '').trim()
    if (smtpPort) cfg.DAVMAIL_SMTP_PORT = smtpPort
    // POC_MODE 默认 true (form 字段 undefined 视为 true)。
    cfg.DAVMAIL_POC_MODE = form.DAVMAIL_POC_MODE === false ? 'false' : 'true'
    const cipher = (form.DAVMAIL_POC_CIPHER_KEY ?? '').trim()
    if (cipher) cfg.DAVMAIL_POC_CIPHER_KEY = cipher
  }
  return cfg
}
