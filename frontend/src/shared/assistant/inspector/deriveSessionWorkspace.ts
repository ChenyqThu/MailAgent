import type { PlanStepStatus, PlanUpdateValue } from '@shared/assistant/plan'
import type { ChatLibraryPartData } from '@shared/assistant/runtime/chatAttachmentAdapter'
import {
  absoluteImageUrl,
  readImageGenInput,
  readImageGenOutput
} from '@shared/assistant/tools/image/imageGenCard.lib'
import {
  readLibraryWriteInput,
  rendersAsMarkdown
} from '@shared/assistant/tools/library/libraryWriteCard.lib'
import { prettifyMcpToolName } from '@shared/assistant/tools/toolNarration'

export type WorkspaceArtifactKind =
  | 'library'
  | 'html'
  | 'file'
  | 'image'
  | 'draft'
  | 'report'
  | 'matter'
  | 'plan'

export interface WorkspaceArtifact {
  readonly id: string
  readonly kind: WorkspaceArtifactKind
  readonly title: string
  readonly subtitle?: string | undefined
  readonly virtualPath?: string | undefined
  readonly fileId?: number | undefined
  readonly writeCount?: number | undefined
  readonly content?: string | undefined
  readonly imageUrl?: string | undefined
  readonly subject?: string | undefined
  readonly to?: string | undefined
  readonly plan?: PlanUpdateValue | undefined
  readonly matterPublicId?: string | undefined
  readonly isMarkdown?: boolean | undefined
  readonly isHtml?: boolean | undefined
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

export const EMPTY_WORKSPACE_SNAPSHOT: SessionWorkspaceSnapshot = Object.freeze({
  artifacts: Object.freeze([]),
  sources: Object.freeze({
    explicit: Object.freeze([]),
    consulted: Object.freeze([])
  }),
  links: Object.freeze([]),
  skills: Object.freeze([]),
  connectorsUsed: Object.freeze([]),
  totalItems: 0
})

const PLAN_STATUSES = new Set<PlanStepStatus>([
  'pending',
  'in_progress',
  'done',
  'blocked',
  'unavailable'
])

const HOST_ABS_PATH_RE = /^(?:\/(?:Users|home|private|var|tmp|etc|opt|Volumes)\/|[A-Za-z]:[\\/])/i
const MD_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/g
const TRAILING_URL_PUNCT_RE = /[.,;:!?)\]}]+$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function parseArgsObject(args: unknown, argsText: unknown): Record<string, unknown> | null {
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

function basenameOfPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) || path
}

function isHtmlPath(path: string | undefined): boolean {
  return Boolean(path && /\.(?:html?|svg)$/i.test(path))
}

const ARTIFACT_KIND_ORDER: Readonly<Record<WorkspaceArtifactKind, number>> = {
  html: 0,
  library: 1,
  file: 2,
  image: 3,
  report: 4,
  draft: 5,
  matter: 6,
  plan: 7
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

function parsePlanValue(value: unknown): PlanUpdateValue | null {
  const record = asRecord(value)
  if (!record || typeof record.goal !== 'string' || !Array.isArray(record.steps)) return null
  const steps: PlanUpdateValue['steps'] = []
  for (const candidate of record.steps) {
    const step = asRecord(candidate)
    if (
      !step ||
      typeof step.id !== 'string' ||
      typeof step.title !== 'string' ||
      typeof step.status !== 'string' ||
      !PLAN_STATUSES.has(step.status as PlanStepStatus)
    ) {
      return null
    }
    steps.push({
      id: step.id,
      title: step.title,
      status: step.status as PlanStepStatus,
      ...(typeof step.note === 'string' && step.note ? { note: step.note } : {})
    })
  }
  return { goal: record.goal, steps }
}

interface NormalizedToolCall {
  readonly toolName: string
  readonly toolCallId: string
  readonly args: unknown
  readonly argsText?: string
  readonly result: unknown
  readonly isError: boolean
  readonly rejected: boolean
}

function extractToolCall(rawPart: unknown, fallbackId: string): NormalizedToolCall | null {
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

function formatRecipients(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (Array.isArray(raw)) {
    const joined = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join(', ')
    return joined || undefined
  }
  return undefined
}

/**
 * Pure real-time derivation of the 5 Session Workspace Inspector panels from live or persisted
 * chat messages plus active anchors/mentions. Requires zero SQLite migrations.
 */
export function deriveSessionWorkspace(
  input: DeriveSessionWorkspaceInput
): SessionWorkspaceSnapshot {
  const artifactMap = new Map<string, WorkspaceArtifact>()
  const explicitMap = new Map<string, WorkspaceSource>()
  const consultedMap = new Map<string, WorkspaceSource>()
  const linkMap = new Map<string, WorkspaceLink>()
  const skillMap = new Map<string, WorkspaceSkill>()
  const connectorMap = new Map<
    string,
    { displayName: string; callCount: number; actions: string[] }
  >()

  const upsertExplicitSource = (src: WorkspaceSource): void => {
    const prev = explicitMap.get(src.key)
    if (!prev) {
      explicitMap.set(src.key, src)
      consultedMap.delete(src.key)
      return
    }
    const prevGeneric = prev.title.startsWith('#')
    if (prevGeneric && !src.title.startsWith('#')) {
      explicitMap.set(src.key, { ...prev, ...src })
    }
  }

  const recordConsultedSource = (src: Omit<WorkspaceSource, 'origin'>): void => {
    const explicit = explicitMap.get(src.key)
    if (explicit) {
      if (explicit.title.startsWith('#') && !src.title.startsWith('#')) {
        explicitMap.set(src.key, {
          ...explicit,
          title: src.title,
          ...(src.virtualPath ? { virtualPath: src.virtualPath } : {}),
          ...(src.subtitle ? { subtitle: src.subtitle } : {})
        })
      }
      return
    }
    const prev = consultedMap.get(src.key)
    if (!prev || (prev.title.startsWith('#') && !src.title.startsWith('#'))) {
      consultedMap.set(src.key, { ...src, origin: 'consulted' })
    }
  }

  const recordLink = (
    rawUrl: unknown,
    titleCandidate: unknown,
    source: WorkspaceLink['source']
  ): void => {
    const sanitized = sanitizeExternalUrl(rawUrl)
    if (!sanitized) return
    const existing = linkMap.get(sanitized.url)
    const nextTitle = nonEmptyStr(titleCandidate)
    if (!existing) {
      linkMap.set(sanitized.url, {
        url: sanitized.url,
        title: nextTitle ?? sanitized.hostname,
        hostname: sanitized.hostname,
        source
      })
    } else if (existing.title === existing.hostname && nextTitle && nextTitle !== sanitized.url) {
      linkMap.set(sanitized.url, { ...existing, title: nextTitle })
    }
  }

  const recordSkill = (name: string, kind: WorkspaceSkill['kind']): void => {
    const cleaned = name.trim()
    if (!cleaned) return
    const key = `${kind}:${cleaned}`
    if (!skillMap.has(key)) {
      skillMap.set(key, { key, name: cleaned, kind })
    }
  }

  // 1. Seed explicit anchors & composer mentions first so canonical dedup favors explicit sources.
  if (input.anchors?.email) {
    const { internalId, subject } = input.anchors.email
    upsertExplicitSource({
      key: `email:${internalId}`,
      kind: 'email',
      origin: 'explicit',
      title: nonEmptyStr(subject) ?? `#${internalId}`,
      internalId
    })
  }
  if (input.anchors?.matter) {
    const { publicId, title } = input.anchors.matter
    upsertExplicitSource({
      key: `matter:${publicId}`,
      kind: 'matter',
      origin: 'explicit',
      title: nonEmptyStr(title) ?? publicId,
      matterPublicId: publicId
    })
  }
  for (const email of input.mentions?.emails ?? []) {
    upsertExplicitSource({
      key: `email:${email.internal_id}`,
      kind: 'email',
      origin: 'explicit',
      title: nonEmptyStr(email.subject) ?? `#${email.internal_id}`,
      internalId: email.internal_id
    })
  }
  for (const matter of input.mentions?.matters ?? []) {
    upsertExplicitSource({
      key: `matter:${matter.public_id}`,
      kind: 'matter',
      origin: 'explicit',
      title: nonEmptyStr(matter.title) ?? matter.public_id,
      matterPublicId: matter.public_id
    })
  }
  for (const file of input.mentions?.libraryFiles ?? []) {
    const virtualPath = toSafeVirtualPath(file.path)
    upsertExplicitSource({
      key: `library:${file.file_id}`,
      kind: 'library',
      origin: 'explicit',
      title: nonEmptyStr(file.name) ?? basenameOfPath(virtualPath) ?? `#${file.file_id}`,
      fileId: file.file_id,
      virtualPath
    })
  }
  for (const att of input.mentions?.attachments ?? []) {
    const label = nonEmptyStr(att.name)
    if (!label) continue
    upsertExplicitSource({
      key: `attachment-local:${label}`,
      kind: 'attachment',
      origin: 'explicit',
      title: label
    })
  }

  // 2. Scan ordered conversation messages.
  for (let msgIdx = 0; msgIdx < input.messages.length; msgIdx += 1) {
    const msg = asRecord(input.messages[msgIdx])
    if (!msg) continue
    const role = nonEmptyStr(msg.role)
    const msgParts = Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(msg.content)
        ? msg.content
        : []

    // User attachments on ThreadMessage shape
    if (role === 'user' && Array.isArray(msg.attachments)) {
      for (const rawAtt of msg.attachments) {
        const att = asRecord(rawAtt)
        const name = nonEmptyStr(att?.name)
        if (!name) continue
        upsertExplicitSource({
          key: `attachment-local:${name}`,
          kind: 'attachment',
          origin: 'explicit',
          title: name
        })
      }
    }

    for (let partIdx = 0; partIdx < msgParts.length; partIdx += 1) {
      const rawPart = msgParts[partIdx]
      const part = asRecord(rawPart)
      if (!part || typeof part.type !== 'string') continue

      // data-library explicit attachments from user turns
      const isLibraryDataPart =
        part.type === 'data-library' || (part.type === 'data' && part.name === 'library')
      if (isLibraryDataPart) {
        const data = asRecord(part.data) as ChatLibraryPartData | null
        const name = nonEmptyStr(data?.name)
        if (name) {
          const fileId = positiveInt(data?.fileId)
          const virtualPath = toSafeVirtualPath(data?.path)
          const key = fileId ? `library:${fileId}` : `library-name:${name}`
          upsertExplicitSource({
            key,
            kind: 'library',
            origin: 'explicit',
            title: name,
            fileId: fileId ?? undefined,
            virtualPath
          })
          // Drop duplicate raw attachment name if already archived as library file
          explicitMap.delete(`attachment-local:${name}`)
        }
        continue
      }

      // Source parts
      if (part.type === 'source-url' || part.type === 'source') {
        recordLink(part.url, part.title, 'source-part')
        continue
      }

      // Assistant markdown / bare external links
      if (part.type === 'text' && role === 'assistant' && typeof part.text === 'string') {
        const text = part.text
        for (const match of text.matchAll(MD_LINK_RE)) {
          recordLink(match[2], match[1], 'markdown')
        }
        for (const match of text.matchAll(BARE_URL_RE)) {
          recordLink(match[0], undefined, 'markdown')
        }
        continue
      }

      const tc = extractToolCall(rawPart, `m${msgIdx}-p${partIdx}`)
      if (!tc) continue
      const argsObj = parseArgsObject(tc.args, tc.argsText)
      const resObj = asRecord(tc.result)

      // Connectors usage (all MCP tool calls, including read or write)
      const mcp = prettifyMcpToolName(tc.toolName)
      if (mcp) {
        const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(tc.toolName)
        const connectorId = (match?.[1] ?? mcp.server).toLowerCase()
        const prev = connectorMap.get(connectorId)
        if (!prev) {
          connectorMap.set(connectorId, {
            displayName: mcp.server,
            callCount: 1,
            actions: [mcp.action]
          })
        } else {
          prev.callCount += 1
          if (!prev.actions.includes(mcp.action)) prev.actions.push(mcp.action)
        }
      }

      // Artifacts (only extract non-rejected / non-errored writes & plans)
      if (tc.toolName === 'plan_update') {
        const plan = parsePlanValue(tc.result) ?? parsePlanValue(argsObj)
        if (plan) {
          artifactMap.set('plan:latest', {
            id: 'plan:latest',
            kind: 'plan',
            title: plan.goal,
            plan
          })
        }
        continue
      }

      if (!tc.isError && !tc.rejected) {
        if (tc.toolName === 'library_write' || tc.toolName === 'library_append') {
          const parsed = readLibraryWriteInput(tc.toolName, argsObj, tc.argsText)
          if (parsed.shape !== 'delete') {
            const fileId = positiveInt(resObj?.file_id) ?? positiveInt(resObj?.id) ?? parsed.fileId
            const safePath = toSafeVirtualPath(resObj?.path) ?? toSafeVirtualPath(parsed.path)
            const key = fileId
              ? `library:${fileId}`
              : safePath
                ? `library-path:${safePath}`
                : `library-call:${tc.toolCallId}`
            const existing = artifactMap.get(key)
            const mergedContent = parsed.content ?? nonEmptyStr(resObj?.content) ?? existing?.content
            const resolvedPath = safePath ?? existing?.virtualPath
            const html = isHtmlPath(resolvedPath)
            artifactMap.set(key, {
              id: key,
              kind: html ? 'html' : 'library',
              title:
                basenameOfPath(resolvedPath) ??
                existing?.title ??
                (fileId ? `#${fileId}` : 'Document'),
              virtualPath: resolvedPath,
              fileId: fileId ?? existing?.fileId,
              writeCount: (existing?.writeCount ?? 0) + 1,
              content: mergedContent,
              subtitle: parsed.changeNote ?? existing?.subtitle,
              isMarkdown: !html && rendersAsMarkdown(resolvedPath ?? null),
              isHtml: html
            })
          }
          continue
        }

        if (tc.toolName === 'file_write') {
          const safePath = toSafeVirtualPath(argsObj?.path)
          const key = safePath ? `file-path:${safePath}` : `file-call:${tc.toolCallId}`
          const existing = artifactMap.get(key)
          const mergedContent = nonEmptyStr(argsObj?.content) ?? existing?.content
          const resolvedPath = safePath ?? existing?.virtualPath
          const html = isHtmlPath(resolvedPath)
          artifactMap.set(key, {
            id: key,
            kind: html ? 'html' : 'file',
            title: basenameOfPath(resolvedPath) ?? existing?.title ?? 'File',
            virtualPath: resolvedPath,
            writeCount: (existing?.writeCount ?? 0) + 1,
            content: mergedContent,
            isMarkdown: !html && rendersAsMarkdown(resolvedPath ?? null),
            isHtml: html
          })
          continue
        }

        if (tc.toolName === 'generate_image') {
          const imgInput = readImageGenInput(argsObj, tc.argsText)
          const images = readImageGenOutput(tc.result)
          for (const img of images) {
            const key = `image:${img.fileId}`
            artifactMap.set(key, {
              id: key,
              kind: 'image',
              title: imgInput.prompt.slice(0, 48) || img.fileId,
              subtitle: imgInput.size ?? undefined,
              content: imgInput.prompt || undefined,
              imageUrl: absoluteImageUrl(img.url)
            })
          }
          continue
        }

        if (
          tc.toolName === 'email_draft_reply' ||
          tc.toolName === 'email_draft_compose' ||
          tc.toolName === 'email_draft_update'
        ) {
          const subject = nonEmptyStr(argsObj?.subject) ?? nonEmptyStr(resObj?.subject)
          const to = formatRecipients(argsObj?.to ?? argsObj?.to_addrs ?? resObj?.to)
          const content =
            nonEmptyStr(argsObj?.body_markdown) ??
            nonEmptyStr(argsObj?.body) ??
            nonEmptyStr(argsObj?.content)
          const key = `draft:${subject ?? tc.toolCallId}`
          artifactMap.set(key, {
            id: key,
            kind: 'draft',
            title: subject ?? to ?? tc.toolName,
            subtitle: to,
            subject: subject ?? undefined,
            to,
            content: content ?? undefined,
            isMarkdown: true
          })
          continue
        }

        if (tc.toolName === 'report_write') {
          const title = nonEmptyStr(argsObj?.title) ?? nonEmptyStr(resObj?.title) ?? 'Report'
          const content =
            nonEmptyStr(argsObj?.content) ??
            nonEmptyStr(argsObj?.markdown) ??
            nonEmptyStr(argsObj?.body)
          const key = `report:${nonEmptyStr(resObj?.id) ?? title}`
          artifactMap.set(key, {
            id: key,
            kind: 'report',
            title,
            content: content ?? undefined,
            isMarkdown: true
          })
          continue
        }

        if (
          tc.toolName === 'matter_create' ||
          tc.toolName === 'matter_update' ||
          tc.toolName === 'matter_item_mutate'
        ) {
          const publicId = nonEmptyStr(resObj?.public_id) ?? nonEmptyStr(argsObj?.public_id)
          const title =
            nonEmptyStr(argsObj?.title) ??
            nonEmptyStr(resObj?.title) ??
            nonEmptyStr(argsObj?.name) ??
            publicId ??
            tc.toolName
          const key = publicId ? `matter:${publicId}` : `matter-call:${tc.toolCallId}`
          artifactMap.set(key, {
            id: key,
            kind: 'matter',
            title,
            subtitle: nonEmptyStr(argsObj?.status) ?? nonEmptyStr(resObj?.status) ?? undefined,
            content:
              nonEmptyStr(argsObj?.summary) ?? nonEmptyStr(argsObj?.description) ?? undefined,
            matterPublicId: publicId ?? undefined,
            isMarkdown: true
          })
        }
      }

      // Consulted sources & web links & skills
      if (tc.toolName === 'email_get' || tc.toolName === 'email_body' || tc.toolName === 'email_list_thread') {
        const internalId = positiveInt(argsObj?.internal_id) ?? positiveInt(resObj?.internal_id)
        if (internalId) {
          const subject = nonEmptyStr(resObj?.subject) ?? `#${internalId}`
          recordConsultedSource({
            key: `email:${internalId}`,
            kind: 'email',
            title: subject,
            subtitle: nonEmptyStr(resObj?.sender) ?? undefined,
            internalId
          })
        }
        continue
      }

      if (tc.toolName === 'email_search_fulltext' || tc.toolName === 'email_search') {
        const items = Array.isArray(resObj?.items) ? resObj.items.slice(0, 3) : []
        for (const item of items) {
          const row = asRecord(item)
          const internalId = positiveInt(row?.internal_id)
          if (!internalId) continue
          recordConsultedSource({
            key: `email:${internalId}`,
            kind: 'email',
            title: nonEmptyStr(row?.subject) ?? `#${internalId}`,
            subtitle: nonEmptyStr(row?.sender) ?? undefined,
            internalId
          })
        }
        continue
      }

      if (tc.toolName === 'email_attachment_text' || tc.toolName === 'email_search_attachments') {
        const attachmentId =
          positiveInt(argsObj?.attachment_id) ?? positiveInt(resObj?.attachment_id)
        if (attachmentId) {
          const fname =
            nonEmptyStr(resObj?.filename) ?? nonEmptyStr(argsObj?.filename) ?? `#${attachmentId}`
          recordConsultedSource({
            key: `attachment:${attachmentId}`,
            kind: 'attachment',
            title: fname,
            attachmentId
          })
        } else if (Array.isArray(resObj?.items)) {
          for (const item of resObj.items.slice(0, 3)) {
            const row = asRecord(item)
            const attId = positiveInt(row?.attachment_id)
            if (!attId) continue
            recordConsultedSource({
              key: `attachment:${attId}`,
              kind: 'attachment',
              title: nonEmptyStr(row?.filename) ?? `#${attId}`,
              attachmentId: attId
            })
          }
        }
        continue
      }

      if (tc.toolName === 'library_read') {
        const fileId = positiveInt(argsObj?.file_id) ?? positiveInt(resObj?.id)
        const safePath = toSafeVirtualPath(argsObj?.path) ?? toSafeVirtualPath(resObj?.path)
        if (fileId || safePath) {
          const key = fileId ? `library:${fileId}` : `library-path:${safePath}`
          recordConsultedSource({
            key,
            kind: 'library',
            title: basenameOfPath(safePath) ?? (fileId ? `#${fileId}` : safePath!),
            fileId: fileId ?? undefined,
            virtualPath: safePath
          })
        }
        continue
      }

      if (tc.toolName === 'library_search') {
        const hits = Array.isArray(resObj?.hits)
          ? resObj.hits
          : Array.isArray(resObj?.items)
            ? resObj.items
            : []
        for (const raw of hits.slice(0, 3)) {
          const hit = asRecord(raw)
          const fileId = positiveInt(hit?.id) ?? positiveInt(hit?.file_id)
          const safePath = toSafeVirtualPath(hit?.path) ?? toSafeVirtualPath(hit?.name)
          if (!fileId && !safePath) continue
          recordConsultedSource({
            key: fileId ? `library:${fileId}` : `library-path:${safePath}`,
            kind: 'library',
            title: nonEmptyStr(hit?.name) ?? basenameOfPath(safePath) ?? `#${fileId}`,
            fileId: fileId ?? undefined,
            virtualPath: safePath
          })
        }
        continue
      }

      if (tc.toolName === 'matter_get' || tc.toolName === 'matter_find') {
        const publicId = nonEmptyStr(argsObj?.public_id) ?? nonEmptyStr(resObj?.public_id)
        if (publicId) {
          recordConsultedSource({
            key: `matter:${publicId}`,
            kind: 'matter',
            title: nonEmptyStr(resObj?.title) ?? publicId,
            matterPublicId: publicId
          })
        }
        continue
      }

      if (tc.toolName === 'contact_get' || tc.toolName === 'contact_search') {
        const contactId = positiveInt(argsObj?.id) ?? positiveInt(argsObj?.contact_id) ?? positiveInt(resObj?.id)
        if (contactId) {
          recordConsultedSource({
            key: `contact:${contactId}`,
            kind: 'contact',
            title:
              nonEmptyStr(resObj?.display_name) ??
              nonEmptyStr(resObj?.name) ??
              `#${contactId}`,
            subtitle: nonEmptyStr(resObj?.email) ?? undefined,
            contactId
          })
        } else if (Array.isArray(resObj?.items)) {
          for (const raw of resObj.items.slice(0, 3)) {
            const row = asRecord(raw)
            const id = positiveInt(row?.id)
            if (!id) continue
            recordConsultedSource({
              key: `contact:${id}`,
              kind: 'contact',
              title: nonEmptyStr(row?.display_name) ?? nonEmptyStr(row?.name) ?? `#${id}`,
              subtitle: nonEmptyStr(row?.email) ?? undefined,
              contactId: id
            })
          }
        }
        continue
      }

      if (
        tc.toolName === 'kos_get_page' ||
        tc.toolName === 'kos_query' ||
        tc.toolName === 'kos_search'
      ) {
        const slug = nonEmptyStr(argsObj?.slug) ?? nonEmptyStr(argsObj?.page_id)
        const query = nonEmptyStr(argsObj?.query) ?? nonEmptyStr(argsObj?.q)
        const title = nonEmptyStr(resObj?.title) ?? slug ?? query
        if (title) {
          recordConsultedSource({
            key: `kos:${slug ?? title}`,
            kind: 'kos',
            title
          })
        }
        continue
      }

      if (tc.toolName === 'web_fetch') {
        recordLink(
          resObj?.url ?? argsObj?.url,
          resObj?.title ?? argsObj?.url,
          'web-tool'
        )
        continue
      }

      if (tc.toolName === 'web_search') {
        const items = Array.isArray(resObj?.results)
          ? resObj.results
          : Array.isArray(resObj?.items)
            ? resObj.items
            : []
        for (const item of items) {
          const row = asRecord(item)
          if (row) recordLink(row.url, row.title, 'web-tool')
        }
        continue
      }

      if (tc.toolName === 'skill_read') {
        const skillName =
          nonEmptyStr(resObj?.name) ??
          nonEmptyStr(argsObj?.name) ??
          nonEmptyStr(argsObj?.skill) ??
          nonEmptyStr(argsObj?.slug)
        if (skillName) recordSkill(skillName, 'skill')
        continue
      }
    }
  }

  const artifacts = [...artifactMap.values()].sort(
    (a, b) => ARTIFACT_KIND_ORDER[a.kind] - ARTIFACT_KIND_ORDER[b.kind]
  )
  const explicit = [...explicitMap.values()]
  const consulted = [...consultedMap.values()]
  const links = [...linkMap.values()]
  const skills = [...skillMap.values()]
  const connectorsUsed: WorkspaceConnectorUsage[] = [...connectorMap.entries()].map(
    ([connectorId, val]) => ({
      connectorId,
      displayName: val.displayName,
      callCount: val.callCount,
      actions: val.actions
    })
  )

  const totalItems =
    artifacts.length +
    explicit.length +
    consulted.length +
    links.length +
    skills.length +
    connectorsUsed.length

  return {
    artifacts,
    sources: { explicit, consulted },
    links,
    skills,
    connectorsUsed,
    totalItems
  }
}
