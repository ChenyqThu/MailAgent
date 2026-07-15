// fe-review P1-2 — invalidate fan-out governance.
//
// Before: every mailbox-level SSE write event invalidated the whole ['emails']
// prefix, refetching all FIVE active query families at once (main list + cross
// + pinned-supplement + thread-batch + thread-enriched). These tests pin the
// routing that replaces that: main list always refetches; supplements refetch
// only for changed ids the main list does not already cover.

import { describe, expect, test } from 'vitest'

import {
  classifyEmailQueryKey,
  isMainListKey,
  isEmailSupplementKey,
  isThreadMembersKey,
  queryDataHoldsAnyId,
  collectMainListIds,
  planInvalidation,
  resolveInvalidatedKeys,
  EMAIL_SUPPLEMENT_TAG,
  type EmailQueryCacheEntry
} from '../../src/shared/lib/emailInvalidation'

// ---- Query keys mirroring EmailList.tsx's five useQuery callsites ----
const KEY = {
  mainList: ['emails', 'inbox', null, '收件箱', 100] as const,
  cross: ['emails', EMAIL_SUPPLEMENT_TAG.cross, '发件箱', 100] as const,
  pinned: ['emails', EMAIL_SUPPLEMENT_TAG.pinnedSupplement, [9]] as const,
  threadBatch: ['emails', EMAIL_SUPPLEMENT_TAG.threadBatch, ['t1']] as const,
  threadEnriched: ['emails', EMAIL_SUPPLEMENT_TAG.threadEnriched, [1, 5]] as const
}

function row(internal_id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { internal_id, is_flagged: false, is_read: true, ...extra }
}

// A realistic snapshot of the five active families:
//   main list holds 1, 2 (+ thread member 1 also visible)
//   cross holds 3; pinned-supplement holds old pinned 9
//   thread-batch (Record shape) + thread-enriched hold thread members 1 and 5
//   (5 is an old member beyond the list window — supplement-only)
function snapshot(): EmailQueryCacheEntry[] {
  return [
    { queryKey: KEY.mainList, data: [row(1), row(2)] },
    { queryKey: KEY.cross, data: [row(3)] },
    { queryKey: KEY.pinned, data: [row(9)] },
    { queryKey: KEY.threadBatch, data: { t1: [row(1), row(5)] } },
    { queryKey: KEY.threadEnriched, data: [row(1), row(5)] }
  ]
}

/** How many of the five ['emails', ...] families the resolved plan refetches. */
function emailFamilyKeys(keys: readonly (readonly unknown[])[]): unknown[][] {
  return keys.filter((k) => k[0] === 'emails') as unknown[][]
}

/** Exact/prefix (non-family) keys in the resolved plan, as JSON signatures. */
function exactKeySigs(keys: readonly (readonly unknown[])[]): string[] {
  return keys.filter((k) => k[0] !== 'emails').map((k) => JSON.stringify(k))
}

describe('classifyEmailQueryKey', () => {
  test('the primary mailbox list is main-list (2nd slot is an EmailView)', () => {
    expect(classifyEmailQueryKey(KEY.mainList)).toBe('main-list')
    expect(isMainListKey(KEY.mainList)).toBe(true)
    expect(isEmailSupplementKey(KEY.mainList)).toBe(false)
    // every EmailView value, never a supplement tag
    for (const view of ['inbox', 'outbox', 'drafts', 'flagged', 'all']) {
      expect(classifyEmailQueryKey(['emails', view, null, null, 50])).toBe('main-list')
    }
  })

  test('each supplement tag classifies to its own family', () => {
    expect(classifyEmailQueryKey(KEY.cross)).toBe('cross')
    expect(classifyEmailQueryKey(KEY.pinned)).toBe('pinned-supplement')
    expect(classifyEmailQueryKey(KEY.threadBatch)).toBe('thread-batch')
    expect(classifyEmailQueryKey(KEY.threadEnriched)).toBe('thread-enriched')
    for (const key of [KEY.cross, KEY.pinned, KEY.threadBatch, KEY.threadEnriched]) {
      expect(isEmailSupplementKey(key)).toBe(true)
      expect(isMainListKey(key)).toBe(false)
    }
  })

  test('non-email keys are unclassified', () => {
    for (const key of [
      ['mailboxes'],
      ['email', 7],
      ['email', 7, 'ai'],
      ['pinnedIds'],
      ['folder']
    ]) {
      expect(classifyEmailQueryKey(key)).toBeNull()
      expect(isMainListKey(key)).toBe(false)
      expect(isEmailSupplementKey(key)).toBe(false)
    }
  })
})

describe('queryDataHoldsAnyId', () => {
  test('array-shaped supplement cache', () => {
    expect(queryDataHoldsAnyId([row(3), row(4)], new Set([4]))).toBe(true)
    expect(queryDataHoldsAnyId([row(3), row(4)], new Set([9]))).toBe(false)
  })

  test('thread-batch Record<threadId, EmailMeta[]> shape', () => {
    const data = { t1: [row(1), row(5)], t2: [row(8)] }
    expect(queryDataHoldsAnyId(data, new Set([5]))).toBe(true)
    expect(queryDataHoldsAnyId(data, new Set([8]))).toBe(true)
    expect(queryDataHoldsAnyId(data, new Set([99]))).toBe(false)
  })

  test('empty id set never matches; malformed data is safe', () => {
    expect(queryDataHoldsAnyId([row(1)], new Set())).toBe(false)
    expect(queryDataHoldsAnyId(undefined, new Set([1]))).toBe(false)
    expect(queryDataHoldsAnyId(null, new Set([1]))).toBe(false)
    expect(queryDataHoldsAnyId([{ nope: 1 }, null], new Set([1]))).toBe(false)
  })
})

describe('collectMainListIds', () => {
  test('gathers ids only from main-list caches, ignoring supplements', () => {
    const ids = collectMainListIds(snapshot())
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2])
    // 5 (thread-only) and 9 (pinned-only) live in supplements, not the list
    expect(ids.has(5)).toBe(false)
    expect(ids.has(9)).toBe(false)
  })

  test('ignores inactive (historical) main-list caches', () => {
    // A stale ['emails','all',…] cache from a previously-viewed larger window
    // still holds id 900 but is inactive — it must NOT count toward coverage.
    const ids = collectMainListIds([
      { queryKey: KEY.mainList, data: [row(1)], active: true },
      { queryKey: ['emails', 'all', null, null, 800], data: [row(900)], active: false }
    ])
    expect(ids.has(1)).toBe(true)
    expect(ids.has(900)).toBe(false)
  })
})

describe('planInvalidation', () => {
  test('mailbox write events: main-list + mailboxes + supplements + email detail', () => {
    for (const t of ['email.synced', 'email.flag_changed', 'email.failed', 'email.dead_letter']) {
      expect(planInvalidation(t, 42)).toEqual([
        { kind: 'main-list' },
        { kind: 'key', key: ['mailboxes'] },
        { kind: 'supplements' },
        { kind: 'thread-members' },
        { kind: 'key', key: ['email', 42] }
      ])
    }
  })

  test('mailbox write with no internal_id drops supplements + detail', () => {
    expect(planInvalidation('email.flag_changed', null)).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['mailboxes'] }
    ])
  })

  test('pin_changed routes to main-list + pinnedIds + supplements (M-A1)', () => {
    // With an id, pin_changed also reconciles a cached supplement directly
    // rather than leaning only on the pinnedList reactive chain.
    expect(planInvalidation('email.pin_changed', 7)).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['pinnedIds'] },
      { kind: 'supplements' },
      { kind: 'thread-members' }
    ])
    // No id → no supplements directive to gate on.
    expect(planInvalidation('email.pin_changed', null)).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['pinnedIds'] }
    ])
  })

  test('outbox.done: main-list + supplements', () => {
    expect(planInvalidation('outbox.done', 7)).toEqual([
      { kind: 'main-list' },
      { kind: 'supplements' },
      { kind: 'thread-members' }
    ])
  })

  test('llm.success: main-list + email ai detail + supplements', () => {
    expect(planInvalidation('llm.success', 7)).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['email', 7, 'ai'] },
      { kind: 'supplements' },
      { kind: 'thread-members' }
    ])
  })

  test('folder.synced stays a plain folder invalidation', () => {
    expect(planInvalidation('folder.synced', null)).toEqual([{ kind: 'key', key: ['folder'] }])
  })

  test('calendar.synced invalidates the whole calendar prefix once', () => {
    // One ['calendar'] prefix directive covers events / syncStatus / names /
    // event detail / recurring (every qk.calendar.* key starts with 'calendar').
    expect(planInvalidation('calendar.synced', null)).toEqual([{ kind: 'key', key: ['calendar'] }])
  })

  test('unhandled events are no-ops (matches the old silent branch)', () => {
    for (const t of ['outbox.enqueued', 'outbox.failed', 'llm.failed', 'llm.gave_up', 'nonsense']) {
      expect(planInvalidation(t, 7)).toEqual([])
    }
  })
})

describe('resolveInvalidatedKeys — fan-out vs the old ["emails"] prefix', () => {
  test('the old prefix would have refetched all five families', () => {
    // Baseline the governance is measured against.
    expect(snapshot().filter((c) => c.queryKey[0] === 'emails')).toHaveLength(5)
  })

  test('flag on a main-list-only email → 1 family (5 → 1)', () => {
    const keys = resolveInvalidatedKeys('email.flag_changed', 2, snapshot())
    expect(emailFamilyKeys(keys)).toEqual([KEY.mainList])
    expect(exactKeySigs(keys)).toEqual([
      JSON.stringify(['mailboxes']),
      JSON.stringify(['email', 2])
    ])
  })

  test('flag on a threaded but visible email → still 1 family (main-list precedence)', () => {
    // id 1 is in the main list AND in thread-batch + thread-enriched, but the
    // merged view renders the main-list row, so the supplements are NOT
    // refetched. This is the common threaded-inbox case: 5 → 1, not 5 → 3.
    const keys = resolveInvalidatedKeys('email.flag_changed', 1, snapshot())
    expect(emailFamilyKeys(keys)).toEqual([KEY.mainList])
  })

  test('flag on a supplement-only email → main-list + its owning supplements', () => {
    // id 5 lives only in thread-batch + thread-enriched (beyond the list
    // window). Both must reconcile so the thread child does not show stale
    // state; cross + pinned are untouched. 5 → 3 here, and no update is lost.
    const keys = resolveInvalidatedKeys('email.flag_changed', 5, snapshot())
    const fams = emailFamilyKeys(keys)
    expect(fams).toContainEqual(KEY.mainList)
    expect(fams).toContainEqual(KEY.threadBatch)
    expect(fams).toContainEqual(KEY.threadEnriched)
    expect(fams).not.toContainEqual(KEY.cross)
    expect(fams).not.toContainEqual(KEY.pinned)
  })

  test('flag on an old pinned email → main-list + pinned-supplement (5 → 2)', () => {
    const keys = resolveInvalidatedKeys('email.flag_changed', 9, snapshot())
    const fams = emailFamilyKeys(keys)
    expect(fams).toEqual([KEY.mainList, KEY.pinned])
  })

  test('pin_changed refetches main list + pinnedIds + an uncovered pinned supplement', () => {
    // id 9 is an old pinned email not in the active list window, so the M-A1
    // supplements directive reconciles pinned-supplement directly.
    const keys = resolveInvalidatedKeys('email.pin_changed', 9, snapshot())
    expect(emailFamilyKeys(keys)).toEqual([KEY.mainList, KEY.pinned])
    expect(exactKeySigs(keys)).toEqual([JSON.stringify(['pinnedIds'])])
  })

  test('llm.success on a visible email → main-list + ai detail, no supplements', () => {
    const keys = resolveInvalidatedKeys('llm.success', 1, snapshot())
    expect(emailFamilyKeys(keys)).toEqual([KEY.mainList])
    expect(exactKeySigs(keys)).toEqual([JSON.stringify(['email', 1, 'ai'])])
  })
})

describe('resolveInvalidatedKeys — active-only coverage (High fix)', () => {
  test('an inactive main-list cache does NOT mask coverage for an active supplement', () => {
    // Regression: a historical (inactive) ['emails','all',…] cache still holds
    // id 900 (previously-viewed larger window, not yet GC'd); the active
    // pinned-supplement also holds 900. Coverage must ignore the inactive
    // cache, so flag_changed(900) still refetches the pinned supplement —
    // otherwise its optimistic / stale value would never reconcile.
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(1), row(2)], active: true },
      { queryKey: ['emails', 'all', null, null, 800], data: [row(900)], active: false },
      { queryKey: KEY.pinned, data: [row(900)], active: true }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 900, caches)
    expect(emailFamilyKeys(keys)).toContainEqual(KEY.pinned)
  })

  test('an ACTIVE main-list cache holding the id still covers it (supplement skipped)', () => {
    // Counterpart: when the visible list actually holds 900, its refetch
    // reconciles the row and the supplement is correctly skipped.
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(900)], active: true },
      { queryKey: KEY.pinned, data: [row(900)], active: true }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 900, caches)
    expect(emailFamilyKeys(keys)).toEqual([KEY.mainList])
  })

  test('an inactive supplement is not refetched (refetchType=active)', () => {
    // Off-screen supplement holding an uncovered id stays put — TanStack's
    // active-only refetch leaves it stale until it remounts.
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(1)], active: true },
      { queryKey: KEY.pinned, data: [row(9)], active: false }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 9, caches)
    expect(emailFamilyKeys(keys)).not.toContainEqual(KEY.pinned)
  })
})

describe('resolveInvalidatedKeys — thread-members routing (SSE gap fix)', () => {
  // ThreadSidebar / ThreadBundle render a thread from their OWN
  // ['email','thread',threadId] cache (EmailMeta[]), independent of the main
  // list. Before this fix flag/read write events never invalidated it — it went
  // stale for up to its 30s staleTime.
  const threadKey = ['email', 'thread', 't1'] as const

  test('isThreadMembersKey identifies the family and rejects the others', () => {
    expect(isThreadMembersKey(threadKey)).toBe(true)
    expect(isThreadMembersKey(['email', 7])).toBe(false)
    expect(isThreadMembersKey(['email', 7, 'ai'])).toBe(false)
    expect(isThreadMembersKey(KEY.mainList)).toBe(false)
    expect(isThreadMembersKey(KEY.threadBatch)).toBe(false)
  })

  test('a thread cache holding the changed id refetches on flag_changed', () => {
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(2)], active: true },
      { queryKey: threadKey, data: [row(1), row(5)], active: true }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 5, caches)
    expect(keys).toContainEqual(threadKey)
  })

  test('NO main-list-precedence suppression: thread cache refetches even when the id is visible in the main list', () => {
    // Unlike a supplement, the thread cache is not merged with the main list, so
    // the main-list refetch does not reconcile it — it must refetch even though
    // id 1 is covered by the main list.
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(1), row(2)], active: true },
      { queryKey: threadKey, data: [row(1), row(5)], active: true }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 1, caches)
    expect(keys).toContainEqual(threadKey)
  })

  test('a thread cache not holding the changed id is left alone', () => {
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(2)], active: true },
      { queryKey: threadKey, data: [row(1), row(5)], active: true }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 99, caches)
    expect(keys).not.toContainEqual(threadKey)
  })

  test('an inactive thread cache is not refetched (refetchType=active)', () => {
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(2)], active: true },
      { queryKey: threadKey, data: [row(5)], active: false }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', 5, caches)
    expect(keys).not.toContainEqual(threadKey)
  })

  test('llm.success also refreshes a thread cache holding the id', () => {
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(2)], active: true },
      { queryKey: threadKey, data: [row(5)], active: true }
    ]
    const keys = resolveInvalidatedKeys('llm.success', 5, caches)
    expect(keys).toContainEqual(threadKey)
  })
})

describe('optimisticPatch consistency (death constraint)', () => {
  // EmailRow.optimisticPatch writes the flag onto every ['emails'] array cache
  // via setQueriesData (prefix). These tests confirm a following SSE event
  // reconciles the displayed value on every cache the patch could have reached.
  function applyOptimisticPatch(
    caches: EmailQueryCacheEntry[],
    internalId: number,
    patch: Record<string, unknown>
  ): EmailQueryCacheEntry[] {
    // Mirror EmailRow: setQueries(['emails']) over ARRAY caches only (the
    // thread-batch Record is skipped by `!Array.isArray(old)`).
    return caches.map((c) =>
      Array.isArray(c.data)
        ? {
            ...c,
            data: c.data.map((e) =>
              (e as { internal_id?: number }).internal_id === internalId ? { ...e, ...patch } : e
            )
          }
        : c
    )
  }

  test('a main-list-resident optimistic flag is reconciled by the main-list refetch', () => {
    // User flags id 1 (visible in the list). Patch lands on main-list + thread-
    // enriched arrays. The main list has display precedence, so refetching it
    // is sufficient to reconcile the shown value to server truth.
    const patched = applyOptimisticPatch(snapshot(), 1, { is_flagged: true })
    // sanity: the patch reached both the main list and thread-enriched cache
    const mainRow = (patched[0].data as Array<{ internal_id: number; is_flagged: boolean }>).find(
      (e) => e.internal_id === 1
    )
    expect(mainRow?.is_flagged).toBe(true)

    const keys = resolveInvalidatedKeys('email.flag_changed', 1, patched)
    expect(emailFamilyKeys(keys)).toContainEqual(KEY.mainList)
  })

  test('a supplement-only optimistic flag is reconciled by that supplement', () => {
    // User flags id 9 (an old pinned email not in the list window). The patch
    // lands on pinned-supplement; since the main list does not cover id 9, the
    // event refetches pinned-supplement so its optimistic value returns to
    // server truth — no cache is left holding an unreconciled patch.
    const patched = applyOptimisticPatch(snapshot(), 9, { is_flagged: true })
    const keys = resolveInvalidatedKeys('email.flag_changed', 9, patched)
    expect(emailFamilyKeys(keys)).toContainEqual(KEY.pinned)
  })
})
