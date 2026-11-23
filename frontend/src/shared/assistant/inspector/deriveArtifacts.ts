import type { PlanStepStatus, PlanUpdateValue } from '@shared/assistant/plan'
import {
  absoluteImageUrl,
  readImageGenInput,
  readImageGenOutput
} from '@shared/assistant/tools/image/imageGenCard.lib'
import {
  readLibraryWriteInput,
  rendersAsMarkdown
} from '@shared/assistant/tools/library/libraryWriteCard.lib'
import type { prettifyMcpToolName } from '@shared/assistant/tools/toolNarration'
import {
  asRecord,
  basenameOfPath,
  nonEmptyStr,
  type NormalizedToolCall,
  positiveInt,
  sanitizeExternalUrl,
  toSafeVirtualPath,
  type WorkspaceArtifact,
  type WorkspaceArtifactKind,
  type WorkspaceArtifactType,
  type WorkspaceArtifactVersion,
  type WorkspaceLink
} from './deriveWorkspaceBase'

type PrettyMcpTool = ReturnType<typeof prettifyMcpToolName>

export const ARTIFACT_KIND_ORDER: Readonly<Record<WorkspaceArtifactKind, number>> = {
  html: 0,
  library: 1,
  file: 2,
  image: 3,
  report: 4,
  draft: 5,
  matter: 6,
  plan: 7
}

const PLAN_STATUSES = new Set<PlanStepStatus>([
  'pending',
  'in_progress',
  'done',
  'blocked',
  'unavailable'
])

const ARTIFACT_TYPE_SET = new Set<WorkspaceArtifactType>([
  'dashboard',
  'slides',
  'report',
  'diagram',
  'app'
])

function normalizeArtifactType(raw: unknown): WorkspaceArtifactType | undefined {
  return typeof raw === 'string' && ARTIFACT_TYPE_SET.has(raw as WorkspaceArtifactType)
    ? (raw as WorkspaceArtifactType)
    : undefined
}

function parseMcpArtifactPublishPayload(
  resObj: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!resObj || resObj.is_error === true || resObj.ok === false) return null
  const structured = asRecord(resObj.structuredContent)
  if (structured && structured.ok !== false) return structured
  if (
    typeof resObj.review_url === 'string' ||
    typeof resObj.share_url === 'string' ||
    resObj.links
  ) {
    return resObj
  }
  if (typeof resObj.content === 'string' && resObj.content.trim().startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(resObj.content) as unknown)
      if (parsed && parsed.ok !== false) return parsed
    } catch {
      return null
    }
  }
  return null
}

export function artifactWorkspaceId(
  slug: string | null | undefined,
  fallbackId: string
): string {
  const cleaned = typeof slug === 'string' ? slug.trim() : ''
  return cleaned ? `artifact:${cleaned}` : `artifact-call:${fallbackId}`
}

function isHtmlPath(path: string | undefined): boolean {
  return Boolean(path && /\.(?:html?|svg)$/i.test(path))
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

function formatRecipients(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (Array.isArray(raw)) {
    const joined = raw
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .join(', ')
    return joined || undefined
  }
  return undefined
}

export interface ArtifactToolContext {
  readonly tc: NormalizedToolCall
  readonly argsObj: Record<string, unknown> | null
  readonly resObj: Record<string, unknown> | null
  readonly mcp: PrettyMcpTool
  readonly artifactMap: Map<string, WorkspaceArtifact>
  readonly recordLink: (
    rawUrl: unknown,
    titleCandidate: unknown,
    source: WorkspaceLink['source']
  ) => void
}

function recordArtifactWrite(ctx: ArtifactToolContext): void {
  const { tc, argsObj, resObj, artifactMap } = ctx
  if (resObj?.ok === false) return
  const isOmada = tc.toolName === 'artifact_build_omada'
  const slug = nonEmptyStr(resObj?.slug) ?? nonEmptyStr(argsObj?.slug)
  const key = artifactWorkspaceId(slug, tc.toolCallId)
  const existing = artifactMap.get(key)
  const title =
    nonEmptyStr(resObj?.title) ??
    nonEmptyStr(argsObj?.title) ??
    existing?.title ??
    slug ??
    'Artifact'
  const artifactType =
    normalizeArtifactType(resObj?.artifact_type) ??
    normalizeArtifactType(argsObj?.artifact_type) ??
    existing?.artifactType ??
    (isOmada ? 'app' : undefined)
  const fileId = positiveInt(resObj?.file_id) ?? positiveInt(resObj?.id)
  const virtualPath = toSafeVirtualPath(resObj?.path)
  const fileCount = positiveInt(resObj?.file_count) ?? undefined
  const content =
    !isOmada && typeof argsObj?.html === 'string' && argsObj.html.trim().length > 0
      ? argsObj.html
      : existing?.content
  const changeNote =
    nonEmptyStr(resObj?.change_note) ?? nonEmptyStr(argsObj?.change_note) ?? undefined
  const prevVersions = existing?.versions ?? []
  const version =
    positiveInt(resObj?.version) ??
    (prevVersions.length > 0 ? Math.max(...prevVersions.map((v) => v.version)) + 1 : 1)
  const entry: WorkspaceArtifactVersion = {
    version,
    fileId: fileId ?? undefined,
    virtualPath,
    content,
    changeNote,
    ...(fileCount !== undefined ? { fileCount } : {})
  }
  const byVersion = new Map<number, WorkspaceArtifactVersion>()
  for (const v of prevVersions) byVersion.set(v.version, v)
  byVersion.set(version, entry)
  const versions = [...byVersion.values()].sort((a, b) => a.version - b.version)
  const latest = versions[versions.length - 1] ?? entry

  artifactMap.set(key, {
    id: key,
    kind: 'html',
    title,
    subtitle: changeNote ?? existing?.subtitle,
    slug: slug ?? existing?.slug,
    artifactType,
    version: latest.version,
    versions,
    virtualPath: latest.virtualPath ?? existing?.virtualPath,
    fileId: latest.fileId ?? existing?.fileId,
    writeCount: versions.length,
    fileCount: latest.fileCount ?? existing?.fileCount,
    content: latest.content ?? existing?.content,
    isMarkdown: false,
    isHtml: true
  })
}

function recordLibraryWrite(ctx: ArtifactToolContext): void {
  const { tc, argsObj, resObj, artifactMap } = ctx
  const parsed = readLibraryWriteInput(tc.toolName, argsObj, tc.argsText)
  if (parsed.shape === 'delete') return
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
      basenameOfPath(resolvedPath) ?? existing?.title ?? (fileId ? `#${fileId}` : 'Document'),
    virtualPath: resolvedPath,
    fileId: fileId ?? existing?.fileId,
    writeCount: (existing?.writeCount ?? 0) + 1,
    content: mergedContent,
    subtitle: parsed.changeNote ?? existing?.subtitle,
    isMarkdown: !html && rendersAsMarkdown(resolvedPath ?? null),
    isHtml: html
  })
}

function recordFileWrite(ctx: ArtifactToolContext): void {
  const { tc, argsObj, artifactMap } = ctx
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
}

function recordImageGen(ctx: ArtifactToolContext): void {
  const { tc, argsObj, artifactMap } = ctx
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
}

function recordEmailDraft(ctx: ArtifactToolContext): void {
  const { tc, argsObj, resObj, artifactMap } = ctx
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
}

function recordReportWrite(ctx: ArtifactToolContext): void {
  const { argsObj, resObj, artifactMap } = ctx
  const title = nonEmptyStr(argsObj?.title) ?? nonEmptyStr(resObj?.title) ?? 'Report'
  const content =
    nonEmptyStr(argsObj?.content) ?? nonEmptyStr(argsObj?.markdown) ?? nonEmptyStr(argsObj?.body)
  const key = `report:${nonEmptyStr(resObj?.id) ?? title}`
  artifactMap.set(key, {
    id: key,
    kind: 'report',
    title,
    content: content ?? undefined,
    isMarkdown: true
  })
}

function recordMatterArtifact(ctx: ArtifactToolContext): void {
  const { tc, argsObj, resObj, artifactMap } = ctx
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
    content: nonEmptyStr(argsObj?.summary) ?? nonEmptyStr(argsObj?.description) ?? undefined,
    matterPublicId: publicId ?? undefined,
    isMarkdown: true
  })
}

function recordArtifactPublish(ctx: ArtifactToolContext): void {
  const { tc, argsObj, resObj, artifactMap, recordLink } = ctx
  const payload =
    tc.toolName === 'artifact_publish_bundle'
      ? resObj && resObj.ok !== false
        ? resObj
        : null
      : parseMcpArtifactPublishPayload(resObj)
  if (!payload) return
  const slug = nonEmptyStr(payload.slug) ?? nonEmptyStr(argsObj?.slug)
  const linksObj = asRecord(payload.links)
  const reviewUrl = sanitizeExternalUrl(payload.review_url ?? linksObj?.review_url)?.url
  const shareUrl = sanitizeExternalUrl(payload.share_url ?? linksObj?.share_url)?.url
  const remoteVersion = positiveInt(payload.version) ?? undefined
  const remoteUrl = reviewUrl ?? shareUrl
  if (!slug || !remoteUrl) return

  const key = artifactWorkspaceId(slug, tc.toolCallId)
  const existing = artifactMap.get(key)
  if (existing) {
    artifactMap.set(key, {
      ...existing,
      remoteUrl,
      shareUrl: shareUrl ?? existing.shareUrl,
      remoteVersion: remoteVersion ?? existing.remoteVersion
    })
  } else {
    recordLink(
      shareUrl ?? remoteUrl,
      nonEmptyStr(payload.title) ?? nonEmptyStr(argsObj?.title) ?? slug,
      'web-tool'
    )
  }
}

/**
 * Derive plan and write-tool artifacts for a single tool call. Returns true when handled.
 */
export function processArtifactToolCall(ctx: ArtifactToolContext): boolean {
  const { tc, argsObj, artifactMap } = ctx

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
    return true
  }

  if (tc.isError || tc.rejected) return false

  if (tc.toolName === 'artifact_write' || tc.toolName === 'artifact_build_omada') {
    recordArtifactWrite(ctx)
    return true
  }
  if (tc.toolName === 'library_write' || tc.toolName === 'library_append') {
    recordLibraryWrite(ctx)
    return true
  }
  if (tc.toolName === 'file_write') {
    recordFileWrite(ctx)
    return true
  }
  if (tc.toolName === 'generate_image') {
    recordImageGen(ctx)
    return true
  }
  if (
    tc.toolName === 'email_draft_reply' ||
    tc.toolName === 'email_draft_compose' ||
    tc.toolName === 'email_draft_update'
  ) {
    recordEmailDraft(ctx)
    return true
  }
  if (tc.toolName === 'report_write') {
    recordReportWrite(ctx)
    return true
  }
  if (
    tc.toolName === 'matter_create' ||
    tc.toolName === 'matter_update' ||
    tc.toolName === 'matter_item_mutate'
  ) {
    recordMatterArtifact(ctx)
    return true
  }
  if (
    tc.toolName === 'artifact_publish_bundle' ||
    (ctx.mcp && (ctx.mcp.action === 'artifact_publish' || tc.toolName.endsWith('__artifact_publish')))
  ) {
    recordArtifactPublish(ctx)
    return true
  }

  return false
}
