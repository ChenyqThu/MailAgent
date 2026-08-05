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
  eventInternalIds,
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

  test('pin_changed batch wire (线程级联 unpin) gates supplements on data.internal_ids', () => {
    // mail_write.set_pins 恒发批量形状 (internal_id=null + data.internal_ids),
    // 单封写也一样 —— 消费侧只认一种 wire。
    expect(
      planInvalidation('email.pin_changed', null, {
        is_pinned: false,
        internal_ids: [11, 22]
      })
    ).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['pinnedIds'] },
      { kind: 'supplements' },
      { kind: 'thread-members' }
    ])
  })

  test('pin_changed 不发 [email, id] —— 置顶态不在邮件记录上, 由 pinnedIds 镜像承载', () => {
    // 🔴 与 flag 的差异是有意的: flag 状态显示在详情 toolbar (读 ['email', id] 缓存),
    // pin 只活在 ['pinnedIds'] (usePinned zustand 镜像) 里。所以 pin 既不逐 id 失效
    // 详情, 超长批次也不需要退化成 ['email'] 前缀 (那会把所有正文/翻译缓存冲掉)。
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1)
    for (const ids of [[11, 22], tooMany]) {
      const directives = planInvalidation('email.pin_changed', null, {
        is_pinned: false,
        internal_ids: ids
      })
      expect(directives.filter((d) => d.kind === 'key')).toEqual([
        { kind: 'key', key: ['pinnedIds'] }
      ])
    }
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

// ---- issue #58 — batch flag_changed (inbound read reconcile) ----
//
// The reconcile converges many emails per round and emits ONE event for the round
// (internal_id: null, ids in data.internal_ids) instead of one per email. Without
// consuming those ids the list + badges refreshed but an OPEN email detail kept
// its stale unread toolbar — its ['email', id] cache was never invalidated.

describe('planInvalidation — batch internal_ids (issue #58 inbound read reconcile)', () => {
  const batch = (internal_ids: unknown[], ids_truncated = false): Record<string, unknown> => ({
    target: 'local',
    converged: internal_ids.length,
    reason: 'inbound_read_reconcile',
    internal_ids,
    ids_truncated
  })

  test('one detail key per converged id, plus id-gated supplements + thread-members', () => {
    expect(planInvalidation('email.flag_changed', null, batch([11, 22, 33]))).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['mailboxes'] },
      { kind: 'supplements' },
      { kind: 'thread-members' },
      { kind: 'key', key: ['email', 11] },
      { kind: 'key', key: ['email', 22] },
      { kind: 'key', key: ['email', 33] }
    ])
  })

  test('ids_truncated → degrade to the whole ["email"] prefix (no partial fan-out)', () => {
    expect(planInvalidation('email.flag_changed', null, batch([11, 22], true))).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['mailboxes'] },
      { kind: 'key', key: ['email'] }
    ])
  })

  test('an over-cap id list degrades the same way (backend regression cannot unbound us)', () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1)
    expect(planInvalidation('email.flag_changed', null, batch(tooMany))).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['mailboxes'] },
      { kind: 'key', key: ['email'] }
    ])
    // …and exactly at the cap it is still a per-id fan-out.
    const atCap = Array.from({ length: 200 }, (_, i) => i + 1)
    expect(planInvalidation('email.flag_changed', null, batch(atCap))).toHaveLength(4 + 200)
  })

  test('an empty / malformed internal_ids keeps the old no-id behaviour', () => {
    for (const data of [
      batch([]),
      { reason: 'inbound_read_reconcile' },
      { internal_ids: 'nope' },
      { internal_ids: null }
    ]) {
      expect(planInvalidation('email.flag_changed', null, data)).toEqual([
        { kind: 'main-list' },
        { kind: 'key', key: ['mailboxes'] }
      ])
    }
  })

  test('non-numeric entries are dropped, not passed into a query key', () => {
    expect(planInvalidation('email.flag_changed', null, batch([1, '2', null, NaN, 3]))).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['mailboxes'] },
      { kind: 'supplements' },
      { kind: 'thread-members' },
      { kind: 'key', key: ['email', 1] },
      { kind: 'key', key: ['email', 3] }
    ])
  })

  test('a single-id event ignores data entirely (internal_id wins)', () => {
    expect(planInvalidation('email.flag_changed', 42, batch([11, 22]))).toEqual(
      planInvalidation('email.flag_changed', 42)
    )
  })

  test('every OTHER event type is byte-identical with or without data', () => {
    // The new 3rd parameter must be inert everywhere except the batch shape above:
    // passing a batch-looking payload to any other event changes nothing.
    const cases: Array<[string, number | null]> = [
      ['email.synced', 7],
      ['email.failed', 7],
      ['email.dead_letter', 7],
      ['email.flag_changed', 7],
      ['email.pin_changed', 7],
      // ['email.pin_changed', null] 有意不在此列 —— pin 现在也走批量 wire
      // (data.internal_ids)，见下方专门的 pin 批量用例。
      ['outbox.done', 7],
      ['outbox.done', null],
      ['llm.success', 7],
      ['folder.synced', null],
      ['calendar.synced', null],
      ['outbox.enqueued', 7],
      ['nonsense', null]
    ]
    for (const [type, id] of cases) {
      expect(planInvalidation(type, id, batch([11, 22]))).toEqual(planInvalidation(type, id))
      expect(planInvalidation(type, id, batch([11, 22], true))).toEqual(planInvalidation(type, id))
    }
    // The pre-batch signature (2 args) also still behaves exactly as before.
    expect(planInvalidation('email.flag_changed', null)).toEqual([
      { kind: 'main-list' },
      { kind: 'key', key: ['mailboxes'] }
    ])
  })
})

describe('eventInternalIds — the id source shared by the planner and the bridge', () => {
  test('a single-id event yields just that id', () => {
    expect(eventInternalIds(42, undefined)).toEqual([42])
    // present data is ignored when internal_id is set
    expect(eventInternalIds(42, { internal_ids: [1, 2] })).toEqual([42])
  })

  test('a batch event yields data.internal_ids, non-numbers dropped', () => {
    expect(eventInternalIds(null, { internal_ids: [1, '2', null, NaN, 3] })).toEqual([1, 3])
  })

  test('no id and no batch → empty (nothing to gate containment on)', () => {
    expect(eventInternalIds(null, undefined)).toEqual([])
    expect(eventInternalIds(null, null)).toEqual([])
    expect(eventInternalIds(null, { reason: 'x' })).toEqual([])
  })
})

describe('resolveInvalidatedKeys — batch event fan-out', () => {
  const threadKey = ['email', 'thread', 't1'] as const

  test('every converged id gets its detail key invalidated', () => {
    const keys = resolveInvalidatedKeys('email.flag_changed', null, snapshot(), {
      internal_ids: [1, 2, 9],
      ids_truncated: false
    })
    const sigs = exactKeySigs(keys)
    expect(sigs).toContain(JSON.stringify(['email', 1]))
    expect(sigs).toContain(JSON.stringify(['email', 2]))
    expect(sigs).toContain(JSON.stringify(['email', 9]))
    expect(sigs).toContain(JSON.stringify(['mailboxes']))
  })

  test('supplement containment gates on the WHOLE batch (main-list-covered ids excluded)', () => {
    // 1 and 2 live in the main list (covered → their supplements are suppressed);
    // 9 is pinned-only, so the pinned supplement must refetch off the same batch.
    const keys = resolveInvalidatedKeys('email.flag_changed', null, snapshot(), {
      internal_ids: [1, 2, 9]
    })
    expect(emailFamilyKeys(keys)).toContainEqual(KEY.pinned)
    expect(emailFamilyKeys(keys)).toContainEqual(KEY.mainList)
    // cross holds only id 3, which is not in the batch → untouched.
    expect(emailFamilyKeys(keys)).not.toContainEqual(KEY.cross)
  })

  test('thread-members refetch for a batch id (the open thread sidebar reconciles)', () => {
    const caches: EmailQueryCacheEntry[] = [
      { queryKey: KEY.mainList, data: [row(2)], active: true },
      { queryKey: threadKey, data: [row(1), row(5)], active: true }
    ]
    const keys = resolveInvalidatedKeys('email.flag_changed', null, caches, {
      internal_ids: [5, 77]
    })
    expect(keys).toContainEqual(threadKey)
  })

  test('ids_truncated invalidates the ["email"] prefix — which covers detail AND thread caches', () => {
    const keys = resolveInvalidatedKeys('email.flag_changed', null, snapshot(), {
      internal_ids: [1, 2],
      ids_truncated: true
    })
    const sigs = exactKeySigs(keys)
    expect(sigs).toContain(JSON.stringify(['email']))
    // No partial per-id keys — the prefix already covers them and a partial list
    // would imply the untruncated ids are the whole story.
    expect(sigs).not.toContain(JSON.stringify(['email', 1]))
  })

  test('with no data the fan-out is exactly what it was before batch support', () => {
    expect(resolveInvalidatedKeys('email.flag_changed', 2, snapshot(), undefined)).toEqual(
      resolveInvalidatedKeys('email.flag_changed', 2, snapshot())
    )
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
