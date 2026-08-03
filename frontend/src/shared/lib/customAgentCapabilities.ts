export const CUSTOM_AGENT_CAPABILITY_TIERS = {
  email: ['read', 'organize', 'draft'],
  calendar: ['off', 'read', 'write'],
  knowledge: ['off', 'on'],
  reports: ['read', 'produce'],
  web: ['off', 'gated', 'open'],
  files: ['off', 'on']
} as const

export type CustomAgentCapabilityId = keyof typeof CUSTOM_AGENT_CAPABILITY_TIERS
export type CustomAgentCapabilityTier<K extends CustomAgentCapabilityId> =
  (typeof CUSTOM_AGENT_CAPABILITY_TIERS)[K][number]
export type CustomAgentCapabilityProfile = {
  [K in CustomAgentCapabilityId]: CustomAgentCapabilityTier<K>
}
export type CustomAgentCapabilityPatch = Partial<CustomAgentCapabilityProfile>

const EMAIL_READ_TOOLS = [
  'email_list_filter',
  'email_get',
  'email_body',
  'email_list_thread',
  'email_search_fulltext',
  'email_search_attachments',
  'email_attachment_text',
  'email_thread_attachments'
] as const
const EMAIL_ORGANIZE_TOOLS = [
  ...EMAIL_READ_TOOLS,
  'email_flag',
  'email_archive',
  'email_pin',
  'email_resync'
] as const
const EMAIL_DRAFT_TOOLS = [
  ...EMAIL_ORGANIZE_TOOLS,
  'email_draft_reply',
  'email_draft_compose',
  'email_draft_update'
] as const

const CALENDAR_READ_TOOLS = ['calendar_events_list', 'calendar_event_get'] as const
const CALENDAR_WRITE_TOOLS = [
  ...CALENDAR_READ_TOOLS,
  'calendar_event_reschedule',
  'calendar_event_rsvp',
  'calendar_event_delete'
] as const

const KNOWLEDGE_AND_SESSION_TOOLS = [
  'chat_session_list',
  'chat_session_search',
  'chat_session_get',
  'agent_profile_read',
  'agent_profile_history',
  'discover_skills',
  'skill_read',
  'kos_query',
  'kos_search',
  'kos_get_page',
  'kos_find_experts',
  'kos_list_pages',
  'kos_get_backlinks'
] as const

const REPORT_READ_TOOLS = ['report_get', 'report_list'] as const
const REPORT_PRODUCE_TOOLS = [...REPORT_READ_TOOLS, 'report_write'] as const

/**
 * Canonical capability-to-policy mapping. Web and files are grants, so they intentionally have no
 * allowed-tools entries; the gateway matrix remains the authority that admits those tool classes.
 */
export const CUSTOM_AGENT_CAPABILITY_TOOL_SETS = {
  email: {
    read: EMAIL_READ_TOOLS,
    organize: EMAIL_ORGANIZE_TOOLS,
    draft: EMAIL_DRAFT_TOOLS
  },
  calendar: {
    off: [],
    read: CALENDAR_READ_TOOLS,
    write: CALENDAR_WRITE_TOOLS
  },
  knowledge: {
    off: [],
    on: KNOWLEDGE_AND_SESSION_TOOLS
  },
  reports: {
    read: REPORT_READ_TOOLS,
    produce: REPORT_PRODUCE_TOOLS
  }
} as const

type ToolCapabilityId = keyof typeof CUSTOM_AGENT_CAPABILITY_TOOL_SETS

export const CUSTOM_AGENT_MANAGED_ALLOWED_TOOLS = Array.from(
  new Set(
    Object.values(CUSTOM_AGENT_CAPABILITY_TOOL_SETS).flatMap((tiers) =>
      Object.values(tiers).flatMap((tools) => [...tools])
    )
  )
)

const MANAGED_TOOL_SET = new Set(CUSTOM_AGENT_MANAGED_ALLOWED_TOOLS)

export interface CustomAgentCapabilityPolicy {
  allowedTools: string[]
  grantWeb: CustomAgentCapabilityProfile['web']
  grantExec: boolean
}

export interface DerivedCustomAgentCapabilities {
  profile: CustomAgentCapabilityProfile
  /** A tool capability is customized when its exact atomic selection is not one canonical tier. */
  customized: ToolCapabilityId[]
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function toolsForCapabilityTier<K extends ToolCapabilityId>(
  capability: K,
  tier: CustomAgentCapabilityTier<K>
): readonly string[] {
  const tiers = CUSTOM_AGENT_CAPABILITY_TOOL_SETS[capability] as Record<string, readonly string[]>
  return tiers[tier] ?? []
}

function managedToolsForCapability(capability: ToolCapabilityId): Set<string> {
  return new Set(
    Object.values(CUSTOM_AGENT_CAPABILITY_TOOL_SETS[capability]).flatMap((tools) => [...tools])
  )
}

function replaceToolCapability<K extends ToolCapabilityId>(
  allowedTools: readonly string[],
  capability: K,
  tier: CustomAgentCapabilityTier<K>
): string[] {
  const managed = managedToolsForCapability(capability)
  return orderedUnique([
    ...allowedTools.filter((tool) => !managed.has(tool)),
    ...toolsForCapabilityTier(capability, tier)
  ])
}

/** Apply one or more capability tiers without disturbing other capabilities or future tools. */
export function applyCustomAgentCapabilityPatch(
  current: CustomAgentCapabilityPolicy,
  patch: CustomAgentCapabilityPatch
): CustomAgentCapabilityPolicy {
  let allowedTools = [...current.allowedTools]
  if (patch.email !== undefined) {
    allowedTools = replaceToolCapability(allowedTools, 'email', patch.email)
  }
  if (patch.calendar !== undefined) {
    allowedTools = replaceToolCapability(allowedTools, 'calendar', patch.calendar)
  }
  if (patch.knowledge !== undefined) {
    allowedTools = replaceToolCapability(allowedTools, 'knowledge', patch.knowledge)
  }
  if (patch.reports !== undefined) {
    allowedTools = replaceToolCapability(allowedTools, 'reports', patch.reports)
  }
  return {
    allowedTools,
    grantWeb: patch.web ?? current.grantWeb,
    grantExec: patch.files === undefined ? current.grantExec : patch.files === 'on'
  }
}

/** Convert a complete six-card profile into the existing allowed_tools + grants contract. */
export function customAgentPolicyFromCapabilities(
  profile: CustomAgentCapabilityProfile
): CustomAgentCapabilityPolicy {
  return applyCustomAgentCapabilityPatch(
    { allowedTools: [], grantWeb: 'off', grantExec: false },
    profile
  )
}

function deriveToolTier<K extends ToolCapabilityId>(
  capability: K,
  allowedTools: readonly string[]
): { tier: CustomAgentCapabilityTier<K>; customized: boolean } {
  const tiers = CUSTOM_AGENT_CAPABILITY_TIERS[capability] as readonly CustomAgentCapabilityTier<K>[]
  const managed = managedToolsForCapability(capability)
  const selected = orderedUnique(allowedTools.filter((tool) => managed.has(tool)))
  for (const tier of tiers) {
    if (sameSet(selected, toolsForCapabilityTier(capability, tier))) {
      return { tier, customized: false }
    }
  }

  // 🔴 No canonical tier matches exactly → round UP: the smallest tier that CONTAINS the selection.
  // The displayed tier must never be weaker than what is actually granted (PRODUCT.md「Make trust
  // observable」). The previous version rounded DOWN — it returned the strongest tier fully
  // contained BY the selection and, failing that, `tiers[0]`. On the backend default set
  // (DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS, which carries email_flag/archive/pin/resync/draft_reply)
  // no tier is fully contained, so every freshly created agent rendered as email='read' while
  // holding five domain_write tools — the card claimed less power than the agent had.
  // Tiers are ordered weakest→strongest AND each is a superset of the previous one (see
  // EMAIL_READ/ORGANIZE/DRAFT_TOOLS), so the first container found IS the smallest one.
  for (const tier of tiers) {
    const tierTools = toolsForCapabilityTier(capability, tier)
    if (selected.every((tool) => tierTools.includes(tool))) {
      return { tier, customized: true }
    }
  }
  // Nothing contains the selection (an Advanced edit mixed in tools no single tier covers). The
  // strongest tier is the closest honest upper bound — still never understating the granted power.
  return { tier: tiers[tiers.length - 1], customized: true }
}

/** Reverse-map the persisted policy for card rendering; arbitrary Advanced edits are flagged. */
export function deriveCustomAgentCapabilities(
  policy: CustomAgentCapabilityPolicy
): DerivedCustomAgentCapabilities {
  const email = deriveToolTier('email', policy.allowedTools)
  const calendar = deriveToolTier('calendar', policy.allowedTools)
  const knowledge = deriveToolTier('knowledge', policy.allowedTools)
  const reports = deriveToolTier('reports', policy.allowedTools)
  return {
    profile: {
      email: email.tier,
      calendar: calendar.tier,
      knowledge: knowledge.tier,
      reports: reports.tier,
      web: policy.grantWeb,
      files: policy.grantExec ? 'on' : 'off'
    },
    customized: [
      ...(email.customized ? (['email'] as const) : []),
      ...(calendar.customized ? (['calendar'] as const) : []),
      ...(knowledge.customized ? (['knowledge'] as const) : []),
      ...(reports.customized ? (['reports'] as const) : [])
    ]
  }
}

/** Future/unknown atomic tools are never deleted by capability edits. */
export function isCustomAgentManagedTool(name: string): boolean {
  return MANAGED_TOOL_SET.has(name)
}
