// Tracks which ids in `current` were not in the prior snapshot, and fades
// each "new" flag after `fadeMs`. This is one of the few places where
// effect-body setState is the correct pattern: we're translating a stream
// of polled snapshots into a discrete "newly added" UX event, and the fade
// timer is a side-effect lifecycle. Pulling it into its own hook isolates
// the lint suppression and the prior-snapshot ref to a single file.

/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from 'react'

export function useNewlyAddedIds(
  current: ReadonlyArray<number>,
  fadeMs = 2000
): ReadonlySet<number> {
  const [active, setActive] = useState<ReadonlySet<number>>(new Set())
  // Last snapshot of *all* ids; the diff against this set defines "new".
  // Initial value is null (sentinel: first load — nothing is "new").
  const lastSeenRef = useRef<Set<number> | null>(null)

  useEffect(() => {
    const currentSet = new Set(current)
    const last = lastSeenRef.current
    lastSeenRef.current = currentSet
    if (last === null) return // first load → no "new" markers

    const fresh: number[] = []
    for (const id of currentSet) if (!last.has(id)) fresh.push(id)
    if (fresh.length === 0) return

    setActive((prior) => {
      const merged = new Set(prior)
      for (const id of fresh) merged.add(id)
      return merged
    })

    const timeoutId = window.setTimeout(() => {
      setActive((prior) => {
        const next = new Set(prior)
        for (const id of fresh) next.delete(id)
        return next
      })
    }, fadeMs)
    return () => window.clearTimeout(timeoutId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: `fadeMs` is a constant per-mount; we want the effect to run on every `current` change only.
  }, [current])

  return active
}
