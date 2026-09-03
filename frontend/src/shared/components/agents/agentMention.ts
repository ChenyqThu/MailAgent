import { unstable_defaultDirectiveFormatter, type Unstable_TriggerItem } from '@assistant-ui/react'

import type { ReportAgentConfig } from '@shared/api/types'

export const AGENT_MENTION_CATEGORY_ID = 'agent'
export const MATTER_MENTION_CATEGORY_ID = 'matter'
export const LIBRARY_MENTION_CATEGORY_ID = 'library'

/** Directive identity for an @ 事项 chip. Paired with the `^matter-` branch in
 *  parseComposerMentionIds below — they are the two halves of one convention, kept adjacent so a
 *  change to the prefix can't land on only one side. */
export function matterMentionItemId(publicId: string): string {
  return `matter-${publicId}`
}

/** Directive identity for an @ 资料库 chip (P2-L8). Same two-halves convention as the matter one
 *  above; the id is the library file's numeric `library_file.id`（投影行没有 id，故进不了这里）。 */
export function libraryMentionItemId(fileId: number): string {
  return `library-${fileId}`
}

export function buildAgentMentionItems(
  agents: ReadonlyArray<ReportAgentConfig>
): readonly Unstable_TriggerItem[] {
  return agents
    .filter((agent) => agent.type === 'custom' && agent.enabled)
    .map((agent) => ({
      id: `agent-${agent.id}`,
      type: 'agent',
      label: agent.title,
      description: agent.description ?? undefined,
      metadata: { icon: 'agent', agentId: agent.id }
    }))
}

export function parseComposerMentionIds(composerText: string): {
  emailIds: ReadonlySet<number>
  agentIds: ReadonlySet<string>
  matterIds: ReadonlySet<string>
  libraryIds: ReadonlySet<number>
} {
  const emailIds = new Set<number>()
  const agentIds = new Set<string>()
  const matterIds = new Set<string>()
  const libraryIds = new Set<number>()
  for (const segment of unstable_defaultDirectiveFormatter.parse(composerText)) {
    if (segment.kind !== 'mention') continue
    const emailMatch = /^email-(\d+)$/.exec(segment.id)
    if (emailMatch) emailIds.add(Number(emailMatch[1]))
    const agentMatch = /^agent-(.+)$/.exec(segment.id)
    if (agentMatch) agentIds.add(agentMatch[1]!)
    const matterMatch = /^matter-(.+)$/.exec(segment.id)
    if (matterMatch) matterIds.add(matterMatch[1]!)
    const libraryMatch = /^library-(\d+)$/.exec(segment.id)
    if (libraryMatch) libraryIds.add(Number(libraryMatch[1]))
  }
  return { emailIds, agentIds, matterIds, libraryIds }
}
