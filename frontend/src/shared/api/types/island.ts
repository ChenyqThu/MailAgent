// ---- Sprint 9 §2.3 — Island bridge surface --------------------------------
//
// Status state machine mirrors `src/electron/main/island/probe.ts`:
//   idle          → fresh boot, no probe attempted yet (first 100ms)
//   connected     → /tmp/island.sock present + last Ping accepted
//   degraded      → socket present but Ping failed (timeout / parse error)
//   disconnected  → socket file missing (ping-island.app not running)
//   dev-disabled  → `is.dev = true`, auto-probe skipped (Settings can still
//                   trigger `testConnection` manually)
//   disabled      → user toggled the integration off via Settings

export type IslandConnectionState =
  | 'idle'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'dev-disabled'
  | 'disabled'

export interface IslandStatus {
  state: IslandConnectionState
  /** Resolved unix socket path (default `/tmp/island.sock`, overridable via
   *  `ISLAND_SOCKET_PATH` env). Read-only on the renderer. */
  socketPath: string
  /** Epoch ms of the last probe attempt, or null if probe loop hasn't run. */
  lastProbeAt: number | null
  /** Free-form last error from a probe / send attempt. */
  lastError: string | null
}

export interface IslandAppearancePayload {
  accent: string
  theme: 'dark' | 'light'
  lang?: string
}

export interface IslandAIDraftStartPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** Plain-text user prompt; clipped server-side to 240 chars. */
  prompt: string
}

export interface IslandAIDraftStreamPayload {
  emailId: number
  /** Running count of streamed characters (cumulative, monotonic). */
  streamedChars: number
}

export interface IslandAIDraftReadyPayload {
  emailId: number
  senderName: string | null
  subject: string | null
  /** First ~240 chars of the final draft for the island preview pill. */
  preview: string
}

export interface IslandApi {
  /** Current island connection snapshot. */
  status(): Promise<IslandStatus>
  /** Trigger an immediate probe (fs.existsSync + Ping envelope). Resolves
   *  with the post-probe status. */
  testConnection(): Promise<IslandStatus>
  /** Toggle the integration on/off from Settings. */
  setEnabled(enabled: boolean): Promise<IslandStatus>
  /** Fire-and-forget: theme/accent change → AppearanceChange envelope. */
  appearance(payload: IslandAppearancePayload): void
  /** Fire-and-forget: AI Chat composer kicked off a draft turn. */
  aiDraftStart(payload: IslandAIDraftStartPayload): void
  /** Fire-and-forget: streaming progress tick. Throttled by caller. */
  aiDraftStream(payload: IslandAIDraftStreamPayload): void
  /** Fire-and-forget: draft turn finished (status.kind=completed). */
  aiDraftReady(payload: IslandAIDraftReadyPayload): void
  /** Subscribe to status broadcasts. Returns an unsubscribe function. */
  onEvent(handler: (status: IslandStatus) => void): () => void
}
