// Typed TanStack Query key factory — the single source for query-key literals
// (P2-8). Before this, ~150 keys were hand-typed string arrays scattered across
// ~50 files; the only latent-drift case (`['chat','allSessions']` typed
// identically in three files) had no compile-time guard.
//
// Every builder returns an `as const` tuple BYTE-IDENTICAL to the literal it
// replaces — element order / case / singular-vs-plural are load-bearing for
// TanStack's prefix matching, so this file changes nothing at runtime; it only
// gives the keys one authoritative, typed home.
//
// Coordination with the two pre-existing single sources:
//   • emailInvalidation.ts owns EMAIL_QUERY_ROOT + EMAIL_SUPPLEMENT_TAG (it is
//     the SSE-routing classifier authority with its own test suite). The
//     `emails.*` builders here CONSUME those constants — one definition, no
//     import cycle. emailInvalidation's own directive literals (mailboxes /
//     pinnedIds / folder / email-detail) stay there, covered by its tests.
//   • useCalendarEvents.ts's CALENDAR_*_KEY consts now re-export the calendar
//     builders below instead of defining their own literals.

import { EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG } from './emailInvalidation'

export const qk = {
  // 'emails' — primary mailbox list + 4 enrichment supplements. Tag literals
  // ('cross' / 'pinned-supplement' / 'thread-batch' / 'thread-enriched') come
  // from EMAIL_SUPPLEMENT_TAG so the classifier and the builders can never drift.
  emails: {
    all: () => [EMAIL_QUERY_ROOT] as const,
    list: (view: string, customMailbox: string | null, activeMailbox: string, fetchLimit: number) =>
      [EMAIL_QUERY_ROOT, view, customMailbox, activeMailbox, fetchLimit] as const,
    cross: (crossMailbox: string | null, fetchLimit: number) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.cross, crossMailbox, fetchLimit] as const,
    pinnedSupplement: (pinnedList: readonly number[]) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.pinnedSupplement, pinnedList] as const,
    threadBatch: (threadKey: readonly string[]) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.threadBatch, threadKey] as const,
    threadEnriched: (threadMemberIds: readonly number[]) =>
      [EMAIL_QUERY_ROOT, EMAIL_SUPPLEMENT_TAG.threadEnriched, threadMemberIds] as const
  },

  // 'email' — single-email families. `detail` is a prefix that also invalidates
  // ai / body / translation for that id.
  email: {
    detail: (id: number | null) => ['email', id] as const,
    ai: (id: number | null) => ['email', id, 'ai'] as const,
    translation: (id: number | null, lang: string) => ['email', id, 'translation', lang] as const,
    body: (id: number | null, format: string) => ['email', id, 'body', format] as const,
    threadCount: (threadId: string | null) => ['email', threadId, 'thread-count'] as const,
    thread: (threadId: string | null) => ['email', 'thread', threadId] as const
  },

  mailboxes: () => ['mailboxes'] as const,
  pinnedIds: () => ['pinnedIds'] as const,

  // 'chat' — session list + per-session messages + /chat/config flag probes.
  chat: {
    allSessions: () => ['chat', 'allSessions'] as const,
    messages: (sessionId: string | number) => ['chat', 'messages', sessionId] as const,
    kosAvailable: () => ['chat', 'kosAvailable'] as const,
    config: (flag: string) => ['chat', 'config', flag] as const
  },

  folder: {
    all: () => ['folder'] as const,
    discover: () => ['folder', 'discover'] as const,
    whitelist: () => ['folder', 'whitelist'] as const
  },

  calendar: {
    events: () => ['calendar', 'events'] as const,
    syncStatus: () => ['calendar', 'syncStatus'] as const,
    names: () => ['calendar', 'names'] as const,
    event: () => ['calendar', 'event'] as const,
    eventDetail: (icalUid?: string, recurrenceId?: string | null, source?: string) =>
      ['calendar', 'event', icalUid, recurrenceId, source] as const,
    recurring: () => ['calendar', 'recurring'] as const,
    recurringSince: (since: string) => ['calendar', 'recurring', since] as const,
    recurringStatus90d: (recurringSince: string) =>
      ['calendar', 'recurring', 'status-90d', recurringSince] as const
  },

  settings: {
    all: () => ['settings'] as const,
    secretsStatus: () => ['settings', 'secrets-status'] as const
  },

  skills: () => ['skills'] as const,
  skillSecrets: (skillName: string) => ['skillSecrets', skillName] as const,
  skillConfig: (skillName: string) => ['skillConfig', skillName] as const,

  notionAgent: {
    config: () => ['notionAgent', 'config'] as const,
    models: () => ['notionAgent', 'models'] as const,
    agents: () => ['notionAgent', 'agents'] as const
  },

  standingDocs: {
    list: () => ['standingDocs', 'list'] as const
  },

  policy: {
    rules: (agentId: string) => ['policy', 'rules', agentId] as const,
    skillEntrypoints: () => ['policy', 'skill-entrypoints'] as const
  },

  execPolicy: {
    rules: () => ['execPolicy', 'rules'] as const
  },

  llm: {
    upstreamModels: (provider: string) => ['llm', 'upstream-models', provider] as const,
    stats: () => ['llm', 'stats'] as const,
    statsDays: (days: number) => ['llm', 'stats', days] as const
  },

  admin: {
    stats: () => ['admin', 'stats'] as const,
    deadLetter: () => ['admin', 'deadLetter'] as const,
    systemAlerts: () => ['admin', 'systemAlerts'] as const,
    health: () => ['admin', 'health'] as const,
    davmailHealth: () => ['admin', 'davmailHealth'] as const
  },

  agentRuns: {
    all: () => ['agent-runs'] as const,
    list: (agentId: string | null, limit: number) =>
      ['agent-runs', agentId ?? 'all', limit] as const,
    toolOptions: () => ['agent-runs', 'tool-options'] as const,
    pendingCount: () => ['agent-runs', 'pending-count'] as const,
    pausedPending: () => ['agent-runs', 'list', 'paused_pending'] as const
  },

  agent: {
    skillsRegistry: () => ['agent', 'skills', 'registry'] as const
  },

  aiGateway: {
    health: (gatewayBaseUrl: string | null) => ['ai-gateway', 'health', gatewayBaseUrl] as const,
    approvalPending: (
      gatewayBaseUrl: string | null,
      sessionId: string | number | null,
      islandRefreshNonce: number
    ) => ['ai-gateway', 'approval-pending', gatewayBaseUrl, sessionId, islandRefreshNonce] as const
  },

  agentApprovalPending: (sessionId: string | number | null) =>
    ['agent-approval-pending', sessionId] as const,

  compose: {
    plan: (id: number) => ['compose', 'plan', id] as const,
    planMode: (id: number, mode: string) => ['compose', 'plan', id, mode] as const,
    draftEdit: (id: number) => ['compose', 'draft-edit', id] as const
  },

  report: {
    list: () => ['report', 'list'] as const,
    listCadence: (cadence: string) => ['report', 'list', cadence] as const,
    config: () => ['report', 'config'] as const,
    get: (reportId: string | null) => ['report', 'get', reportId] as const
  },

  projectProgressRuns: (limit: number) => ['project-progress-runs', limit] as const,

  palette: {
    search: (normalised: string) => ['palette', 'search', normalised] as const
  },

  mention: {
    search: (normalised: string) => ['mention', 'search', normalised] as const
  },

  contactSuggest: (debounced: string, exclude: readonly string[]) =>
    ['contactSuggest', debounced, exclude] as const,

  attachment: {
    dataUrl: (id: string | number) => ['attachment', id, 'dataUrl'] as const
  }
} as const
