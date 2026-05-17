// MailApi data-layer abstraction. All React components consume this through
// useMailApi(); the Electron build resolves to ElectronApi (IPC + better-sqlite3),
// the Web build (V2) to HttpApi (fetch + Cloudflare Access). See ARCHITECTURE.md §2.2.
//
// Sprint 1 fills the concrete shape from docs/cli-schema/*.schema.json via
// `pnpm gen:types` (REVIEW-LOG C-03) — at that point EmailMeta / AttachmentMeta /
// SearchHit will replace the placeholder `unknown` here.

export interface ListOpts {
  mailbox?: string
  status?: string
  sinceDate?: string
  untilDate?: string
  fromAddr?: string
  subject?: string
  isRead?: boolean
  isFlagged?: boolean
  hasNotion?: boolean
  limit?: number
  offset?: number
}

export interface BodyOpts {
  format?: 'markdown' | 'html' | 'raw'
}

export interface SearchOpts {
  query: string
  mailbox?: string
  since?: string
  until?: string
  limit?: number
}

export interface ResyncOpts {
  replaceExisting?: boolean
  skipParentLookup?: boolean
  dryRun?: boolean
}

// Placeholders — replaced by codegen output in Sprint 1.
export type EmailMeta = unknown
export type EmailDetail = unknown
export type EmailBody = unknown
export type AttachmentMeta = unknown
export type SearchHit = unknown
export type ResyncResult = unknown

export interface EmailApi {
  list(opts: ListOpts): Promise<EmailMeta[]>
  get(internalId: number): Promise<EmailDetail>
  body(internalId: number, opts?: BodyOpts): Promise<EmailBody>
  search(opts: SearchOpts): Promise<SearchHit[]>
  resync(internalId: number, opts?: ResyncOpts): Promise<ResyncResult>
}

export interface AttachmentApi {
  list(internalId: number): Promise<AttachmentMeta[]>
  download(attachmentId: number, dest?: string): Promise<string | Uint8Array>
}

export interface MailApi {
  email: EmailApi
  attachment: AttachmentApi
}
