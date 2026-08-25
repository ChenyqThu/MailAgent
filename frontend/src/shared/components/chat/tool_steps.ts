// task 06-08-chat PR B — pure tool classification + JSON pretty-printer for the
// tool trace UI. S3 W2: the legacy step normalizers (liveSteps / auditSteps /
// ToolStepData) were deleted with the legacy MessageList + ExternalStore
// adapter; what survives is the name→kind classifier + prettyJson consumed by
// the assistant-ui ToolTraceCard (the generic tool-call fallback card).

/** Tool kind classification for the tool trace card. Maps a tool_name to one of
 *  six visual buckets (icon + accent token), per handoff §2.4. */
export type ToolKind = 'search' | 'read' | 'task' | 'write' | 'cmd' | 'link'

/** Name-based heuristic. Order matters: write/link/cmd specific prefixes are
 *  checked before the generic read/task/search fallbacks. */
export function classifyTool(name: string): ToolKind {
  const n = name.toLowerCase()
  // write — mutating mailbox state (flag / archive / move / mark).
  if (
    n.startsWith('email_flag') ||
    n.startsWith('email_archive') ||
    n.includes('_flag') ||
    n.includes('archive') ||
    n.includes('_move') ||
    n.includes('mark_')
  )
    return 'write'
  // link — KOS / Notion association.
  if (n.startsWith('kos_') || n.includes('kos') || n.includes('notion') || n.includes('link'))
    return 'link'
  // cmd — shell / command execution.
  if (n.includes('bash') || n.includes('command') || n.includes('exec') || n.includes('shell'))
    return 'cmd'
  // read — fetch an email body / read-class.
  if (n.includes('body') || n.startsWith('email_get') || n.includes('read') || n.includes('fetch'))
    return 'read'
  // task — extraction / action-item style.
  if (n.startsWith('extract_') || n.includes('extract') || n.includes('task')) return 'task'
  // search — find / search fallthrough.
  if (n.includes('search') || n.includes('find')) return 'search'
  // Default to search (neutral magnifier) for anything unrecognized.
  return 'search'
}

/** Tool names that have a human-readable title in the i18n bundles, under
 *  `chat.toolTitle.<tool_name>` (both zh-CN and en-US).
 *
 *  🔴 This is a hand-copied mirror of the gateway tool universe, so it has a gate:
 *  `tests/shared/toolTitle.test.ts` reads `tests/agent_eval/tool_catalog.json` (the canonical
 *  name list, already kept honest by the eval catalog-completeness gate) and fails when a tool
 *  has no title in EITHER locale. A miss is not fatal at runtime — `toolTitleKey` returns null
 *  and the card falls back to the raw identifier — but it IS the "裸英文标识符" the four-段
 *  tool card exists to remove. The three `legacy_retired` names are included on purpose:
 *  persisted chat history still replays their tool parts. */
export const TITLED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // email — reads
  'email_list_filter',
  'email_get',
  'email_body',
  'email_list_thread',
  'email_search_fulltext',
  'email_search',
  'email_search_attachments',
  'email_thread_attachments',
  'email_attachment_text',
  // email — writes
  'email_flag',
  'email_archive',
  'email_pin',
  'email_resync',
  'email_draft_reply',
  'email_draft_compose',
  'email_draft_update',
  'email_prepare_send',
  // report
  'report_list',
  'report_get',
  'report_write',
  // chat UX (W6) — the in-turn follow-up suggestion no-op. Its tool CARD renders null
  // (registerToolUIs → SuggestFollowupsHiddenPart), but the streaming status line ("正在调用
  // {tool}") can still surface the name for a beat, so it keeps a human title.
  'suggest_followups',
  // kos
  'kos_query',
  'kos_search',
  'kos_get_page',
  'kos_find_experts',
  'kos_list_pages',
  'kos_get_backlinks',
  // profile / memory
  'agent_profile_read',
  'agent_profile_history',
  'agent_profile_restore',
  'agent_memory_update',
  'update_system_md',
  // skill
  'skill_read',
  'discover_skills',
  'set_skill_enabled',
  'skill_install',
  'skill_install_confirm',
  'skill_uninstall',
  'skill_draft_create',
  'skill_draft_write_file',
  'skill_draft_read',
  'skill_draft_validate',
  'skill_draft_publish',
  'skill_draft_discard',
  'skill_list_installed',
  // chat sessions
  'chat_session_list',
  'chat_session_search',
  'chat_session_get',
  // headless custom-agent catalog (knowledge_and_sessions grant only)
  'agent_catalog_list',
  'agent_catalog_get',
  // custom agents
  'custom_agent_list',
  'custom_agent_get',
  'custom_agent_create',
  'custom_agent_update',
  'custom_agent_delete',
  'custom_agent_run_now',
  'custom_agent_call',
  // task 08-14 — 内建 agent 工具面 + 事项跟进的逐条编辑。
  'internal_agent_list',
  'internal_agent_get',
  'internal_agent_update',
  'matter_followup_mutate',
  // web
  'web_fetch',
  'web_search',
  // exec
  'run_command',
  'file_read',
  'file_write',
  // calendar
  'calendar_events_list',
  'calendar_event_get',
  'calendar_event_reschedule',
  'calendar_event_rsvp',
  'calendar_event_delete',
  // matter (Matters MVP P3)
  'matter_find',
  'matter_get',
  'matter_create',
  'matter_update',
  'matter_item_mutate',
  // task 08-25 —— curated 进展 lane 的写面（`matter_suggest_related_resources` 同批退役）。
  'matter_progress_mutate',
  'matter_resource_mutate',
  'matter_stakeholder_mutate',
  'matter_relation_mutate',
  'matter_add_note',
  // matter (Matters MVP P4 — run control / review / headless propose)
  'matter_run_control',
  'matter_review_update',
  'matter_update_propose',
  // matter (0813 轮 3 批 R — attention / run history / tags + the two disposal writes)
  'matter_attention_list',
  'matter_attention_triage',
  'matter_runs_list',
  'matter_tags_list',
  'matter_suggestion_resolve',
  // contact directory (WP7 — 3 reads + 3 proposal channels + 5 direct writes)
  'contact_search',
  'contact_get',
  'contact_list_mails',
  'contact_propose_update',
  'contact_propose_merge',
  'contact_propose_relation',
  'contact_set_kind',
  'contact_mark_former_email',
  'contact_refresh_profile',
  'contact_update_fields',
  'contact_set_manager',
  // notion
  'notion_agent_chat',
  // legacy (deleted engine, still present in persisted history)
  'plan_update'
])

/** The i18n key for a tool's human-readable title, or null when the name is unknown — the caller
 *  then shows the raw identifier (graceful degradation: an unregistered/新 tool must still
 *  render, never a missing-translation placeholder). */
export function toolTitleKey(name: string): string | null {
  return TITLED_TOOL_NAMES.has(name) ? `chat.toolTitle.${name}` : null
}

/** Pretty-print arbitrary JSON-ish input. Accepts a value (live event input) or
 *  a JSON string (audit row); returns a 2-space-indented string. Falls back to
 *  the raw string / String(value) when parsing/serialization fails (tool output
 *  can be anything). */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    // Audit rows store JSON text; re-pretty-print, else show verbatim.
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
