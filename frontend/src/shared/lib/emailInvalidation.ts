// Email query invalidation routing — pure, testable core for the SSE event
// bridge (see ../hooks/useEventBridge.ts).
//
// Problem: every mailbox-level write event used to invalidate the whole
// ['emails'] prefix, refetching all five active query families at once —
// the primary mailbox list plus four enrichment ("supplement") families:
// cross-mailbox, pinned-supplement, thread-batch, thread-enriched (all defined
// in EmailList.tsx). better-sqlite3 runs those reads synchronously on the main
// process, so one SSE burst serialised five list queries (~300ms+ of
// main-process stall) even when the changed email only lived in the primary
// list.
//
// This module routes each event to the minimal set of families:
//   • the primary mailbox list always refetches (catches new arrivals + state
//     changes to any visible row)
//   • the four supplement families refetch ONLY when their current cache holds
//     a changed internal_id that the main list does NOT already cover. In
//     EmailList the merged view gives main-list rows precedence over every
//     supplement (enrichedById: `all` wins; threadSupplement falls back to
//     thread-enriched only when enrichedById misses), and thread-batch is
//     structure-only — so a main-list-resident email's fresh state comes from
//     the list refetch alone. The common inbox-email case therefore touches
//     zero supplements (5 active families → 1 refetch); only a supplement-only
//     email (an old pinned/thread member beyond the list window) pulls in its
//     one owning supplement (→ 2).
//
// EmailRow.optimisticPatch keeps writing the full ['emails'] prefix via
// setQueriesData (arrays only). That cache-WRITE surface is intentionally
// decoupled from this refetch routing and is NOT touched here: an SSE event
// that follows an optimistic patch still reconciles every cache the patch
// could have reached, because the main list always refetches and any
// supplement holding the id refetches via containment (a supplement that does
// not hold the id was a no-op for the patch anyway).

export const EMAIL_QUERY_ROOT = 'emails'

// The 2nd queryKey element that marks a supplement (enrichment) query. The
// primary mailbox list uses the EmailView string in this slot instead
// (inbox / outbox / drafts / flagged / all), which never collides with these
// tags. Keep these literals in sync with the useQuery callsites in
// EmailList.tsx — the classifier below is the single authority for "is this an
// enrichment query", so a rename there must land here too.
export const EMAIL_SUPPLEMENT_TAG = {
  cross: 'cross',
  pinnedSupplement: 'pinned-supplement',
  threadBatch: 'thread-batch',
  threadEnriched: 'thread-enriched'
} as const

export type EmailSupplementTag = (typeof EMAIL_SUPPLEMENT_TAG)[keyof typeof EMAIL_SUPPLEMENT_TAG]

const SUPPLEMENT_TAGS: ReadonlySet<string> = new Set(Object.values(EMAIL_SUPPLEMENT_TAG))

export type EmailQueryFamily = 'main-list' | EmailSupplementTag

type QueryKeyLike = readonly unknown[]

/**
 * Classify an ['emails', ...] queryKey into its family. Returns null for any
 * key that is not rooted at 'emails'. Any 'emails'-rooted key whose 2nd element
 * is not a reserved supplement tag is treated as the primary mailbox list.
 */
export function classifyEmailQueryKey(key: QueryKeyLike): EmailQueryFamily | null {
  if (key[0] !== EMAIL_QUERY_ROOT) return null
  const tag = key[1]
  if (typeof tag === 'string' && SUPPLEMENT_TAGS.has(tag)) return tag as EmailSupplementTag
  return 'main-list'
}

/** True for the primary mailbox list query (`['emails', view, ...]`). */
export function isMainListKey(key: QueryKeyLike): boolean {
  return classifyEmailQueryKey(key) === 'main-list'
}

/** True for any of the four enrichment families (cross / pinned / thread-*). */
export function isEmailSupplementKey(key: QueryKeyLike): boolean {
  const family = classifyEmailQueryKey(key)
  return family !== null && family !== 'main-list'
}

/**
 * True for a thread-members query (`['email', 'thread', threadId]`) — the list
 * of a thread's emails that ThreadSidebar / ThreadBundle render from their OWN
 * cache, independent of the main mailbox list. Rooted at 'email' (singular), so
 * it is not one of the 'emails' supplement families above and needs its own
 * id-gated routing (see the 'thread-members' directive below).
 */
export function isThreadMembersKey(key: QueryKeyLike): boolean {
  return key[0] === 'email' && key[1] === 'thread'
}

/**
 * Does a query's cached data currently hold any of the given internal_ids?
 * Handles both the array-shaped supplement caches (EnrichedEmailMeta[] — cross,
 * pinned-supplement, thread-enriched) and thread-batch's
 * Record<threadId, EmailMeta[]> shape. Used to gate supplement refetches so a
 * write event only touches a supplement that actually shows the changed email.
 */
export function queryDataHoldsAnyId(data: unknown, ids: ReadonlySet<number>): boolean {
  if (ids.size === 0) return false
  if (Array.isArray(data)) return arrayHoldsAnyId(data, ids)
  if (data !== null && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value) && arrayHoldsAnyId(value, ids)) return true
    }
  }
  return false
}

function arrayHoldsAnyId(rows: readonly unknown[], ids: ReadonlySet<number>): boolean {
  for (const row of rows) {
    if (row !== null && typeof row === 'object') {
      const internalId = (row as { internal_id?: unknown }).internal_id
      if (typeof internalId === 'number' && ids.has(internalId)) return true
    }
  }
  return false
}

// ---- event → invalidation directive planner ----

/**
 * A single invalidation instruction. The event bridge translates each into a
 * (debounced) queryClient.invalidateQueries call:
 *   • 'main-list'     → predicate invalidate of the primary mailbox list family
 *   • 'supplements'   → predicate invalidate of supplement families whose cache
 *                       holds a changed internal_id (batched over the debounce
 *                       window)
 *   • 'thread-members'→ predicate invalidate of thread-members caches
 *                       (['email','thread',id]) holding a changed internal_id,
 *                       id-gated like supplements but WITHOUT main-list-precedence
 *                       suppression (the thread view is independent, not merged)
 *   • 'key'           → prefix invalidate of an exact key (mailboxes / a single
 *                       email detail / pinnedIds / folder)
 */
export type InvalidationDirective =
  | { kind: 'main-list' }
  | { kind: 'supplements' }
  | { kind: 'thread-members' }
  | { kind: 'key'; key: (string | number)[] }

// ---- batch (multi-id) events ----
//
// issue #58's inbound read reconcile converges MANY emails in one pass and emits
// ONE event for the whole round rather than one per email (no burst):
//   internal_id: null
//   data: { target:'local', converged, reason:'inbound_read_reconcile',
//           internal_ids: number[]  (capped server-side at 200),
//           ids_truncated: boolean }
// Without consuming data.internal_ids the list + badges refresh (they ride the
// unconditional main-list / mailboxes directives) but an OPEN email detail keeps
// showing the stale unread toolbar — its ['email', id] cache is never touched.
//
// Batch shape is keyed on the WIRE (internal_id null + data.internal_ids), not on
// data.reason: a second batch producer must get the same routing for free.

/** Mirror of the server-side cap. A backend regression must not be able to make
 *  the planner emit an unbounded directive list (one debounced invalidate each) —
 *  past this we take the same prefix degradation as ids_truncated. */
const MAX_BATCH_IDS = 200

/** The internal_ids an event concerns: the single `internal_id` when present, else
 *  the batch `data.internal_ids` (non-numbers dropped — the field is wire data).
 *  Single source for BOTH the planner and the bridge's supplement/thread id sets. */
export function eventInternalIds(
  internalId: number | null,
  data?: Record<string, unknown> | null
): number[] {
  if (internalId != null) return [internalId]
  const raw = data?.internal_ids
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
}

/** True when the batch is known-incomplete (server truncated the id list, or it
 *  came back longer than the wire contract allows) → the per-id fan-out cannot be
 *  correct and we degrade to a prefix invalidate. */
function isBatchTruncated(
  data: Record<string, unknown> | null | undefined,
  idCount: number
): boolean {
  return data?.ids_truncated === true || idCount > MAX_BATCH_IDS
}

/**
 * Map an SSE event_type (+ internal_id, + optional event `data`) to the
 * invalidation directives the event bridge should run. Unhandled events
 * (outbox.enqueued / job.* / matter.* / …) return [] — same as the previous
 * no-op branch (matter.* / contact.* / *.run.changed route in useEventBridge,
 * job.* in resyncJob.ts).
 *
 * A 'supplements' directive is only emitted when there are internal_ids to gate
 * on; without any there is nothing to scope the containment check to, so the
 * (rare) supplement-only staleness is left to the reactive query-key chain and
 * the polling fallback.
 *
 * `data` is only read for the batch shape above; every other event type ignores
 * it and keeps byte-identical behaviour whether or not it is passed.
 */
export function planInvalidation(
  eventType: string,
  internalId: number | null,
  data?: Record<string, unknown> | null
): InvalidationDirective[] {
  switch (eventType) {
    // Any mailbox-level write: list ordering / row state / mailbox counts can
    // all move. Main list + counts always; the changed email's detail + any
    // supplement holding it, id-gated.
    //
    // email.new (perf-sse-realtime R1-1) rides the same group: a freshly saved
    // row must appear in the list + bump mailbox counts immediately instead of
    // waiting for the pipeline-end email.synced (tens of seconds to minutes).
    // Its batch wire (internal_id null + data.internal_ids, poll-round
    // aggregated server-side) reuses the issue #58 batch routing below as-is.
    case 'email.new':
    case 'email.synced':
    case 'email.failed':
    case 'email.dead_letter':
    case 'email.flag_changed': {
      const out: InvalidationDirective[] = [
        { kind: 'main-list' },
        { kind: 'key', key: ['mailboxes'] }
      ]
      const ids = eventInternalIds(internalId, data)
      if (internalId == null && isBatchTruncated(data, ids.length)) {
        // Known-incomplete batch: the ids we got cannot address every changed
        // email, so invalidate the whole ['email', …] family (detail + ai + body
        // + translation + thread-members) instead of a partial per-id fan-out.
        // The four ['emails', …] supplements stay id-gated — with no trustworthy
        // id set there is nothing to gate on, same as the no-id case above.
        out.push({ kind: 'key', key: ['email'] })
        return out
      }
      if (ids.length > 0) {
        out.push({ kind: 'supplements' })
        out.push({ kind: 'thread-members' })
        // Prefix invalidate — covers ['email', id] AND ['email', id, 'ai'] (and
        // translation / body / thread-count for that id), matching the previous
        // ['email', id] prefix call exactly. One per changed email.
        for (const id of ids) out.push({ kind: 'key', key: ['email', id] })
      }
      return out
    }
    // pin / unpin: refresh ['pinnedIds'] → usePinnedSync updates the zustand
    // mirror → pinnedList changes → the pinned-supplement queryKey changes and
    // refetches on its own. Main list carries the pinned-bucket routing. The
    // supplements directive reconciles an already-cached (e.g. just-unpinned)
    // row directly instead of leaning solely on that reactive chain.
    //
    // Batch wire (internal_id null + data.internal_ids) — mail_write.set_pins
    // emits ONE event per write, including the single-row case and the thread
    // cascade (unpin a whole thread). The id set only gates supplements /
    // thread-members containment; unlike flag there is NO ['email', id] leg,
    // because pin state does not live on the email record the detail pane reads
    // (it comes from the ['pinnedIds'] mirror, invalidated unconditionally
    // above) — so a truncated batch needs no prefix degradation either.
    case 'email.pin_changed': {
      const out: InvalidationDirective[] = [
        { kind: 'main-list' },
        { kind: 'key', key: ['pinnedIds'] }
      ]
      if (eventInternalIds(internalId, data).length > 0) {
        out.push({ kind: 'supplements' })
        out.push({ kind: 'thread-members' })
      }
      return out
    }
    // outbox fanout completed: derived Notion / Mail.app state on the email may
    // have moved. Main list + any supplement holding the id.
    case 'outbox.done': {
      const out: InvalidationDirective[] = [{ kind: 'main-list' }]
      if (internalId != null) {
        out.push({ kind: 'supplements' })
        out.push({ kind: 'thread-members' })
      }
      return out
    }
    // LLM done: ai_priority / ai_action land on the single email (detail) and
    // show in the list + thread-enriched rows.
    case 'llm.success': {
      const out: InvalidationDirective[] = [{ kind: 'main-list' }]
      if (internalId != null) {
        out.push({ kind: 'key', key: ['email', internalId, 'ai'] })
        out.push({ kind: 'supplements' })
        out.push({ kind: 'thread-members' })
      }
      return out
    }
    // folder writes (perf-sse-realtime R1-2) — CRUD/cleanup in mail_write.py +
    // folder_pref upsert/rename/delete in sync_store.py. Replaces the dead
    // 'folder.synced' subscription (its src/folder_sync/ publisher was retired,
    // leaving SidebarFolderTree's SSE-gated poll with no event to lean on).
    // ['folder'] prefix covers discover / whitelist / prefs.
    case 'folder.changed':
      return [{ kind: 'key', key: ['folder'] }]
    // outbox delivery failures (R2) — the admin dead-letter list + the admin
    // board's system-alert row read these; both were pure polls before.
    case 'outbox.failed':
    case 'outbox.dead_letter':
      return [
        { kind: 'key', key: ['admin', 'deadLetter'] },
        { kind: 'key', key: ['admin', 'systemAlerts'] }
      ]
    // LLM pipeline failures (R2) — system alerts + the LLM dashboard stats.
    case 'llm.failed':
    case 'llm.gave_up':
      return [
        { kind: 'key', key: ['admin', 'systemAlerts'] },
        { kind: 'key', key: ['llm', 'stats'] }
      ]
    // calendar sync tick landed changes (CalendarSyncWorker) — prefix
    // invalidate every ['calendar', …] family (events / syncStatus / names /
    // event detail / recurring). While the calendar pane is closed this only
    // marks inactive queries stale (refetchType 'active'), so it is free.
    case 'calendar.synced':
      return [{ kind: 'key', key: ['calendar'] }]
    default:
      return []
  }
}

// ---- test / documentation resolver ----

export interface EmailQueryCacheEntry {
  queryKey: QueryKeyLike
  data: unknown
  /**
   * Whether the query currently has active observers (is rendered). Coverage
   * and refetch only consider active caches: TanStack's default
   * refetchType='active' only refetches active queries, and an inactive
   * historical view cache — e.g. a previously-viewed larger window still
   * inside its gcTime — does NOT represent what is on screen. Counting such a
   * cache toward main-list coverage would wrongly suppress an active
   * supplement's refetch (it holds an id the visible list does not), leaving
   * an optimistic patch unreconciled. Defaults to true when unspecified.
   */
  active?: boolean
}

function isActiveEntry(entry: EmailQueryCacheEntry): boolean {
  return entry.active !== false
}

/**
 * Gather every internal_id held by the ACTIVE main-list caches. A supplement
 * refetch is unnecessary for any of these ids because the merged view renders
 * the main-list row in preference to the supplement copy.
 *
 * Only active main-list entries count — inactive historical view caches do not
 * represent the current display, so they must not participate in coverage
 * (this is the fix for the inactive-cache-masks-coverage bug). The live
 * useEventBridge path additionally pre-filters with `type: 'active'` on
 * getQueriesData, since those tuples carry no active flag.
 */
export function collectMainListIds(caches: readonly EmailQueryCacheEntry[]): Set<number> {
  const ids = new Set<number>()
  for (const entry of caches) {
    if (!isActiveEntry(entry) || !isMainListKey(entry.queryKey) || !Array.isArray(entry.data)) {
      continue
    }
    for (const row of entry.data) {
      if (row !== null && typeof row === 'object') {
        const internalId = (row as { internal_id?: unknown }).internal_id
        if (typeof internalId === 'number') ids.add(internalId)
      }
    }
  }
  return ids
}

/**
 * Resolve one event against a snapshot of the ['emails'] query caches into the
 * exact set of queryKeys that would be invalidated. Mirrors what
 * useEventBridge does at flush time (main-list predicate + main-list-precedence
 * supplement containment + exact keys) so tests can assert the real fan-out
 * without a live QueryClient. 'key' directives contribute their (prefix) target
 * key; family directives contribute the concrete matched cache keys.
 */
export function resolveInvalidatedKeys(
  eventType: string,
  internalId: number | null,
  caches: readonly EmailQueryCacheEntry[],
  data?: Record<string, unknown> | null
): QueryKeyLike[] {
  const directives = planInvalidation(eventType, internalId, data)
  // Same id source the bridge feeds its supplement / thread-member sets from, so a
  // batch event gates containment on ALL its ids, not just a (missing) single one.
  const ids = new Set(eventInternalIds(internalId, data))
  const out: QueryKeyLike[] = []
  const seen = new Set<string>()
  const push = (key: QueryKeyLike): void => {
    const sig = JSON.stringify(key)
    if (seen.has(sig)) return
    seen.add(sig)
    out.push(key)
  }
  for (const directive of directives) {
    switch (directive.kind) {
      case 'main-list':
        // refetchType='active' — only active main-list queries refetch.
        for (const entry of caches) {
          if (isActiveEntry(entry) && isMainListKey(entry.queryKey)) push(entry.queryKey)
        }
        break
      case 'supplements': {
        // Coverage from active main lists only (collectMainListIds filters);
        // refetch active supplements holding an uncovered id.
        const mainListIds = collectMainListIds(caches)
        const uncovered = new Set([...ids].filter((id) => !mainListIds.has(id)))
        if (uncovered.size === 0) break
        for (const entry of caches) {
          if (
            isActiveEntry(entry) &&
            isEmailSupplementKey(entry.queryKey) &&
            queryDataHoldsAnyId(entry.data, uncovered)
          ) {
            push(entry.queryKey)
          }
        }
        break
      }
      case 'thread-members': {
        // Thread sidebar / bundle render their members from an independent
        // ['email','thread',id] cache — NOT merged with the main list, so unlike
        // supplements there is NO main-list-precedence suppression: any active
        // thread cache holding the changed id must refetch (its copy of that
        // email's read/flag/ai state is otherwise left stale for up to 30s).
        if (ids.size === 0) break
        for (const entry of caches) {
          if (
            isActiveEntry(entry) &&
            isThreadMembersKey(entry.queryKey) &&
            queryDataHoldsAnyId(entry.data, ids)
          ) {
            push(entry.queryKey)
          }
        }
        break
      }
      case 'key':
        push(directive.key)
        break
    }
  }
  return out
}
