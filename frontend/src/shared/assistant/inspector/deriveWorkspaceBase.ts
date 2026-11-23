import type { PlanUpdateValue } from '@shared/assistant/plan'

export type WorkspaceArtifactKind =
  | 'library'
  | 'html'
  | 'file'
  | 'image'
  | 'draft'
  | 'report'
  | 'matter'
  | 'plan'

export type WorkspaceArtifactType = 'dashboard' | 'slides' | 'report' | 'diagram' | 'app'

export interface WorkspaceArtifactVersion {
  readonly version: number
  readonly fileId?: number | undefined
  readonly virtualPath?: string | undefined
  readonly content?: string | undefined
  readonly changeNote?: string | undefined
  readonly fileCount?: number | undefined
}

export interface WorkspaceArtifact {
  readonly id: string
  readonly kind: WorkspaceArtifactKind
  readonly title: string
  readonly subtitle?: string | undefined
  readonly virtualPath?: string | undefined
  readonly fileId?: number | undefined
  readonly writeCount?: number | undefined
  readonly fileCount?: number | undefined
  readonly content?: string | undefined
  readonly imageUrl?: string | undefined
  readonly subject?: string | undefined
  readonly to?: string | undefined
  readonly plan?: PlanUpdateValue | undefined
  readonly matterPublicId?: string | undefined
  readonly isMarkdown?: boolean | undefined
  readonly isHtml?: boolean | undefined
  readonly slug?: string | undefined
  readonly artifactType?: WorkspaceArtifactType | undefined
  readonly version?: number | undefined
  readonly versions?: readonly WorkspaceArtifactVersion[] | undefined
  readonly remoteUrl?: string | undefined
  readonly shareUrl?: string | undefined
  readonly remoteVersion?: number | undefined
}

export type WorkspaceSourceKind =
  | 'email'
  | 'library'
  | 'matter'
  | 'contact'
  | 'attachment'
  | 'kos'

export interface WorkspaceSource {
  readonly key: string
  readonly kind: WorkspaceSourceKind
  readonly origin: 'explicit' | 'consulted'
  readonly title: string
  readonly subtitle?: string | undefined
  readonly internalId?: number | undefined
  readonly fileId?: number | undefined
  readonly virtualPath?: string | undefined
  readonly matterPublicId?: string | undefined
  readonly contactId?: number | undefined
  readonly attachmentId?: number | undefined
}

export interface WorkspaceLink {
  readonly url: string
  readonly title: string
  readonly hostname: string
  readonly source: 'source-part' | 'web-tool' | 'markdown'
}

export interface WorkspaceSkill {
  readonly key: string
  readonly name: string
  readonly kind: 'skill' | 'tool-activated'
}

export interface WorkspaceConnectorUsage {
  readonly connectorId: string
  readonly displayName: string
  readonly callCount: number
  readonly actions: readonly string[]
}

export interface SessionWorkspaceSnapshot {
  readonly artifacts: readonly WorkspaceArtifact[]
  readonly sources: {
    readonly explicit: readonly WorkspaceSource[]
    readonly consulted: readonly WorkspaceSource[]
  }
  readonly links: readonly WorkspaceLink[]
  readonly skills: readonly WorkspaceSkill[]
  readonly connectorsUsed: readonly WorkspaceConnectorUsage[]
  readonly totalItems: number
}

export interface DeriveSessionWorkspaceInput {
  readonly messages: readonly unknown[]
  readonly anchors?: {
    readonly email?: { readonly internalId: number; readonly subject?: string | null }
    readonly matter?: { readonly publicId: string; readonly title?: string | null }
  }
  readonly mentions?: {
    readonly emails?: ReadonlyArray<{
      readonly internal_id: number
      readonly subject?: string | null
    }>
    readonly matters?: ReadonlyArray<{
      readonly public_id: string
      readonly title?: string | null
    }>
    readonly libraryFiles?: ReadonlyArray<{
      readonly file_id: number
      readonly path: string
      readonly name: string
    }>
    readonly attachments?: ReadonlyArray<{ readonly id: string; readonly name: string }>
  }
}

export interface NormalizedToolCall {
  readonly toolName: string
  readonly toolCallId: string
  readonly args: unknown
  readonly argsText?: string
  readonly result: unknown
  readonly isError: boolean
  readonly rejected: boolean
}

const HOST_ABS_PATH_RE = /^(?:\/(?:Users|home|private|var|tmp|etc|opt|Volumes)\/|[A-Za-z]:[\\/])/i
const TRAILING_URL_PUNCT_RE = /[.,;:!?)\]}]+$/

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function nonEmptyStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

export function parseArgsObject(args: unknown, argsText: unknown): Record<string, unknown> | null {
  const obj = asRecord(args)
  if (obj) return obj
  if (typeof argsText === 'string' && argsText.trim().length > 0) {
    try {
      return asRecord(JSON.parse(argsText) as unknown)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Normalize a repository/virtual path without exposing any host absolute filesystem path.
 */
export function toSafeVirtualPath(raw: unknown): string | undefined {
  const s = nonEmptyStr(raw)
  if (!s) return undefined
  if (HOST_ABS_PATH_RE.test(s)) {
    const parts = s.split(/[\\/]/).filter(Boolean)
    return parts.at(-1) || undefined
  }
  const normalized = s.replace(/^\.?\//, '').replace(/^\/+/, '')
  return normalized || undefined
}

export function basenameOfPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) || path
}

/**
 * Validate external URLs for inspector display & clickable launch (`http:`/`https:` only).
 */
export function sanitizeExternalUrl(
  raw: unknown
): { readonly url: string; readonly hostname: string } | null {
  const s = nonEmptyStr(raw)
  if (!s) return null
  const stripped = s.replace(TRAILING_URL_PUNCT_RE, '')
  try {
    const parsed = new URL(stripped)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return { url: parsed.toString(), hostname: parsed.hostname }
  } catch {
    return null
  }
}

export function extractToolCall(rawPart: unknown, fallbackId: string): NormalizedToolCall | null {
  const part = asRecord(rawPart)
  if (!part || typeof part.type !== 'string') return null

  const approval = asRecord(part.approval)
  const rejected =
    approval?.approved === false ||
    approval?.resolution === 'cancelled' ||
    approval?.resolution === 'expired'

  if (part.type === 'tool-call' && typeof part.toolName === 'string') {
    return {
      toolName: part.toolName,
      toolCallId: nonEmptyStr(part.toolCallId) ?? fallbackId,
      args: part.args,
      argsText: typeof part.argsText === 'string' ? part.argsText : undefined,
      result: part.result,
      isError: part.isError === true || part.status === 'error',
      rejected
    }
  }

  // Raw AI SDK v5/v7 UIMessage part shape: `type: 'tool-<name>'` or `'dynamic-tool'`
  if (
    part.type === 'dynamic-tool' ||
    (part.type.startsWith('tool-') && part.type !== 'tool-call')
  ) {
    const toolName =
      part.type === 'dynamic-tool'
        ? nonEmptyStr(part.toolName)
        : part.type.slice('tool-'.length)
    if (!toolName) return null
    const state = nonEmptyStr(part.state)
    return {
      toolName,
      toolCallId: nonEmptyStr(part.toolCallId) ?? fallbackId,
      args: part.input ?? part.args,
      argsText: typeof part.argsText === 'string' ? part.argsText : undefined,
      result: part.output ?? part.result,
      isError: part.isError === true || state === 'output-error',
      rejected: rejected || state === 'output-denied'
    }
  }

  return null
}
