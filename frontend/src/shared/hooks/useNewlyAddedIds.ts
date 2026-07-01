// Tracks which ids in `current` were not in the prior snapshot, and fades
// each "new" flag after `fadeMs`. This is one of the few places where
// effect-body setState is the correct pattern: we're translating a stream
// of polled snapshots into a discrete "newly added" UX event, and the fade
// timer is a side-effect lifecycle. Pulling it into its own hook isolates
// the lint suppression and the prior-snapshot ref to a single file.
//
// `viewKey` scopes the prior-snapshot baseline to a single view. When it
// changes (inbox → outbox → drafts, or switching a custom folder / account)
// the same hook instance would otherwise diff the previous view's ids against
// the new view's first page and flash the ENTIRE screen as "new". On a view
// change we re-baseline to the current set and emit nothing.

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from 'react'

export function useNewlyAddedIds(
  current: ReadonlyArray<number>,
  viewKey: string,
  fadeMs = 2000
): ReadonlySet<number> {
  const [active, setActive] = useState<ReadonlySet<number>>(new Set())
  // Last snapshot of *all* ids in this view; the diff against this set defines
  // "new". Initial value is null (sentinel: first load — nothing is "new").
  const lastSeenRef = useRef<Set<number> | null>(null)
  // The view this hook is currently baselined against; a mismatch means the
  // user switched views and we must re-baseline instead of diffing.
  const viewRef = useRef(viewKey)
  // One fade timer per id. The effect re-runs on every `current` change (React
  // Query polling + SSE churn the array reference constantly), so a single
  // shared timer + cleanup would cancel in-flight fades before they fire —
  // that was the original bug where badges stuck forever. Per-id timers keyed
  // in this map survive effect re-runs; each clears itself on completion.
  const fadeTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    // View switch → re-baseline to the current set, emit nothing. Also clear any
    // still-active badges + pending fade timers from the previous view: otherwise
    // an id badged in view A that is also visible in view B keeps its NEW marker
    // there until A's timer fires (cross-view leak — codex MEDIUM). A view switch
    // must show a clean slate; badges only arise from real additions within a view.
    if (viewRef.current !== viewKey) {
      viewRef.current = viewKey
      lastSeenRef.current = new Set(current)
      for (const tid of fadeTimersRef.current.values()) clearTimeout(tid)
      fadeTimersRef.current.clear()
      setActive((prior) => (prior.size === 0 ? prior : new Set()))
      return
    }

    const currentSet = new Set(current)
    const last = lastSeenRef.current
    lastSeenRef.current = currentSet
    if (last === null) return // first load → no "new" markers

    // Genuinely new ids that are not already fading. The "already fading" guard
    // stops a still-pending id from getting a second timer (and from being
    // re-flagged after its fade completes) when `current` churns from polling.
    const fresh: number[] = []
    for (const id of currentSet) {
      if (!last.has(id) && !fadeTimersRef.current.has(id)) fresh.push(id)
    }
    if (fresh.length === 0) return

    setActive((prior) => {
      const merged = new Set(prior)
      for (const id of fresh) merged.add(id)
      return merged
    })

    for (const id of fresh) {
      const tid = setTimeout(() => {
        setActive((prior) => {
          if (!prior.has(id)) return prior
          const next = new Set(prior)
          next.delete(id)
          return next
        })
        fadeTimersRef.current.delete(id)
      }, fadeMs)
      fadeTimersRef.current.set(id, tid)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: `fadeMs` is a constant per-mount; per-id timers are keyed in a ref and cleaned up on unmount. Run only on `current` / `viewKey` change.
  }, [current, viewKey])

  // Unmount-only: clear any still-pending fade timers to avoid a setState after
  // the component is gone (and to not leak timers across route changes).
  useEffect(() => {
    const timers = fadeTimersRef.current
    return () => {
      for (const tid of timers.values()) clearTimeout(tid)
      timers.clear()
    }
  }, [])

  return active
}
