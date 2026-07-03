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
