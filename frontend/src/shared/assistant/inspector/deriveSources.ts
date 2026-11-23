import type { prettifyMcpToolName } from '@shared/assistant/tools/toolNarration'
import {
  asRecord,
  basenameOfPath,
  type DeriveSessionWorkspaceInput,
  nonEmptyStr,
  type NormalizedToolCall,
  positiveInt,
  sanitizeExternalUrl,
  toSafeVirtualPath,
  type WorkspaceConnectorUsage,
  type WorkspaceLink,
  type WorkspaceSkill,
  type WorkspaceSource
} from './deriveWorkspaceBase'

type PrettyMcpTool = ReturnType<typeof prettifyMcpToolName>

export interface WorkspaceSourceCollectors {
  readonly explicitMap: Map<string, WorkspaceSource>
  readonly consultedMap: Map<string, WorkspaceSource>
  readonly linkMap: Map<string, WorkspaceLink>
  readonly skillMap: Map<string, WorkspaceSkill>
  readonly connectorMap: Map<string, { displayName: string; callCount: number; actions: string[] }>
  readonly upsertExplicitSource: (src: WorkspaceSource) => void
  readonly recordConsultedSource: (src: Omit<WorkspaceSource, 'origin'>) => void
  readonly recordLink: (
    rawUrl: unknown,
    titleCandidate: unknown,
    source: WorkspaceLink['source']
  ) => void
  readonly recordSkill: (name: string, kind: WorkspaceSkill['kind']) => void
  readonly recordConnectorCall: (toolName: string, mcp: PrettyMcpTool) => void
}

export function createSourceCollectors(): WorkspaceSourceCollectors {
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

  const recordConnectorCall = (toolName: string, mcp: PrettyMcpTool): void => {
    if (!mcp) return
    const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName)
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

  return {
    explicitMap,
    consultedMap,
    linkMap,
    skillMap,
    connectorMap,
    upsertExplicitSource,
    recordConsultedSource,
    recordLink,
    recordSkill,
    recordConnectorCall
  }
}

export function seedExplicitSources(
  input: DeriveSessionWorkspaceInput,
  collectors: WorkspaceSourceCollectors
): void {
  const { upsertExplicitSource } = collectors

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
}

export function serializeConnectorsUsed(
  connectorMap: WorkspaceSourceCollectors['connectorMap']
): WorkspaceConnectorUsage[] {
  return [...connectorMap.entries()].map(([connectorId, val]) => ({
    connectorId,
    displayName: val.displayName,
    callCount: val.callCount,
    actions: val.actions
  }))
}

export function processConsultedToolCall(
  tc: NormalizedToolCall,
  argsObj: Record<string, unknown> | null,
  resObj: Record<string, unknown> | null,
  collectors: WorkspaceSourceCollectors
): void {
  const { recordConsultedSource, recordLink, recordSkill } = collectors

  if (tc.toolName === 'email_get' || tc.toolName === 'email_body' || tc.toolName === 'email_list_thread') {
    const internalId = positiveInt(argsObj?.internal_id) ?? positiveInt(resObj?.internal_id)
    if (internalId) {
      recordConsultedSource({
        key: `email:${internalId}`,
        kind: 'email',
        title: nonEmptyStr(resObj?.subject) ?? `#${internalId}`,
        subtitle: nonEmptyStr(resObj?.sender) ?? undefined,
        internalId
      })
    }
    return
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
    return
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
    return
  }

  if (tc.toolName === 'library_read') {
    const fileId = positiveInt(argsObj?.file_id) ?? positiveInt(resObj?.id)
    const safePath = toSafeVirtualPath(argsObj?.path) ?? toSafeVirtualPath(resObj?.path)
    if (fileId || safePath) {
      recordConsultedSource({
        key: fileId ? `library:${fileId}` : `library-path:${safePath}`,
        kind: 'library',
        title: basenameOfPath(safePath) ?? (fileId ? `#${fileId}` : safePath!),
        fileId: fileId ?? undefined,
        virtualPath: safePath
      })
    }
    return
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
    return
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
    return
  }

  if (tc.toolName === 'contact_get' || tc.toolName === 'contact_search') {
    const contactId =
      positiveInt(argsObj?.id) ?? positiveInt(argsObj?.contact_id) ?? positiveInt(resObj?.id)
    if (contactId) {
      recordConsultedSource({
        key: `contact:${contactId}`,
        kind: 'contact',
        title:
          nonEmptyStr(resObj?.display_name) ?? nonEmptyStr(resObj?.name) ?? `#${contactId}`,
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
    return
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
    return
  }

  if (tc.toolName === 'web_fetch') {
    recordLink(resObj?.url ?? argsObj?.url, resObj?.title ?? argsObj?.url, 'web-tool')
    return
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
    return
  }

  if (tc.toolName === 'skill_read') {
    const skillName =
      nonEmptyStr(resObj?.name) ??
      nonEmptyStr(argsObj?.name) ??
      nonEmptyStr(argsObj?.skill) ??
      nonEmptyStr(argsObj?.slug)
    if (skillName) recordSkill(skillName, 'skill')
  }
}
