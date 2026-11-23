import type { ChatLibraryPartData } from '@shared/assistant/runtime/chatAttachmentAdapter'
import { prettifyMcpToolName } from '@shared/assistant/tools/toolNarration'
import { ARTIFACT_KIND_ORDER, processArtifactToolCall } from './deriveArtifacts'
import {
  createSourceCollectors,
  processConsultedToolCall,
  seedExplicitSources,
  serializeConnectorsUsed
} from './deriveSources'
import {
  asRecord,
  type DeriveSessionWorkspaceInput,
  extractToolCall,
  nonEmptyStr,
  parseArgsObject,
  positiveInt,
  type SessionWorkspaceSnapshot,
  toSafeVirtualPath,
  type WorkspaceArtifact
} from './deriveWorkspaceBase'

export type {
  DeriveSessionWorkspaceInput,
  SessionWorkspaceSnapshot,
  WorkspaceArtifact,
  WorkspaceArtifactKind,
  WorkspaceArtifactType,
  WorkspaceArtifactVersion,
  WorkspaceConnectorUsage,
  WorkspaceLink,
  WorkspaceSkill,
  WorkspaceSource,
  WorkspaceSourceKind
} from './deriveWorkspaceBase'
export { sanitizeExternalUrl, toSafeVirtualPath } from './deriveWorkspaceBase'
export { artifactWorkspaceId } from './deriveArtifacts'

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

const MD_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/g

/**
 * Pure real-time derivation of the 5 Session Workspace Inspector panels from live or persisted
 * chat messages plus active anchors/mentions. Requires zero SQLite migrations.
 */
export function deriveSessionWorkspace(
  input: DeriveSessionWorkspaceInput
): SessionWorkspaceSnapshot {
  const artifactMap = new Map<string, WorkspaceArtifact>()
  const collectors = createSourceCollectors()

  // 1. Seed explicit anchors & composer mentions first so canonical dedup favors explicit sources.
  seedExplicitSources(input, collectors)

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

    if (role === 'user' && Array.isArray(msg.attachments)) {
      for (const rawAtt of msg.attachments) {
        const name = nonEmptyStr(asRecord(rawAtt)?.name)
        if (!name) continue
        collectors.upsertExplicitSource({
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

      const isLibraryDataPart =
        part.type === 'data-library' || (part.type === 'data' && part.name === 'library')
      if (isLibraryDataPart) {
        const data = asRecord(part.data) as ChatLibraryPartData | null
        const name = nonEmptyStr(data?.name)
        if (name) {
          const fileId = positiveInt(data?.fileId)
          const virtualPath = toSafeVirtualPath(data?.path)
          collectors.upsertExplicitSource({
            key: fileId ? `library:${fileId}` : `library-name:${name}`,
            kind: 'library',
            origin: 'explicit',
            title: name,
            fileId: fileId ?? undefined,
            virtualPath
          })
          // Drop duplicate raw attachment name if already archived as library file
          collectors.explicitMap.delete(`attachment-local:${name}`)
        }
        continue
      }

      if (part.type === 'source-url' || part.type === 'source') {
        collectors.recordLink(part.url, part.title, 'source-part')
        continue
      }

      if (part.type === 'text' && role === 'assistant' && typeof part.text === 'string') {
        for (const match of part.text.matchAll(MD_LINK_RE)) {
          collectors.recordLink(match[2], match[1], 'markdown')
        }
        for (const match of part.text.matchAll(BARE_URL_RE)) {
          collectors.recordLink(match[0], undefined, 'markdown')
        }
        continue
      }

      const tc = extractToolCall(rawPart, `m${msgIdx}-p${partIdx}`)
      if (!tc) continue
      const argsObj = parseArgsObject(tc.args, tc.argsText)
      const resObj = asRecord(tc.result)
      const mcp = prettifyMcpToolName(tc.toolName)
      collectors.recordConnectorCall(tc.toolName, mcp)

      if (
        processArtifactToolCall({
          tc,
          argsObj,
          resObj,
          mcp,
          artifactMap,
          recordLink: collectors.recordLink
        })
      ) {
        continue
      }

      processConsultedToolCall(tc, argsObj, resObj, collectors)
    }
  }

  const artifacts = [...artifactMap.values()].sort(
    (a, b) => ARTIFACT_KIND_ORDER[a.kind] - ARTIFACT_KIND_ORDER[b.kind]
  )
  const explicit = [...collectors.explicitMap.values()]
  const consulted = [...collectors.consultedMap.values()]
  const links = [...collectors.linkMap.values()]
  const skills = [...collectors.skillMap.values()]
  const connectorsUsed = serializeConnectorsUsed(collectors.connectorMap)

  return {
    artifacts,
    sources: { explicit, consulted },
    links,
    skills,
    connectorsUsed,
    totalItems:
      artifacts.length +
      explicit.length +
      consulted.length +
      links.length +
      skills.length +
      connectorsUsed.length
  }
}
