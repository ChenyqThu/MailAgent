// v8 — bridge between the renderer's optimistic `usePinned` store and
// the SQLite-backed `email:listPinnedIds` IPC query. Mount this once
// near the top of the inbox tree (EmailList does this) and:
//   • `useQuery(['pinnedIds'])` pulls the canonical list every 10s
//   • a `useEffect` syncs the result into `usePinned.setPinned`
//   • `useTogglePin()` exposes a mutation that does an optimistic
//     local flip first, then writes via IPC, then invalidates the
//     query so the server's truth eventually reconciles
//
// Components stay zustand-shaped (`usePinned((s) => s.isPinned(id))`)
// so EmailRow's existing subscriptions still work.

import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { usePinned } from '@shared/state/pinned'
import { toastError } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'

const PINNED_KEY = qk.pinnedIds()

/** Mount once (EmailList does this) — keeps the zustand mirror current. */
export function usePinnedSync(): void {
  const mailApi = useMailApi()
  const setPinned = usePinned((s) => s.setPinned)
  // Sprint 16 — togglePin onSettled 已经 invalidate, 单机单窗口不需 polling.
  // 多窗口 / CLI 改 pin 的同步靠 SSE 断线 fallback (usePollingFallback) 兜底.
  // pins 没有专门的 SSE event 类型, 但 fallback polling 周期能拉到最新值.
  const pollingInterval = usePollingFallback()

  const { data } = useQuery({
    queryKey: PINNED_KEY,
    queryFn: () => mailApi.email.listPinnedIds(),
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false,
    staleTime: 5_000
  })

  useEffect(() => {
    if (data) setPinned(data)
  }, [data, setPinned])
}

/** Toggle pin for a single email with optimistic UI + server reconciliation.
 *  The backend CLI exposes `pin` and `unpin` (not `toggle`), so the caller
 *  side computes `targetPinned` BEFORE invoking the mutation — `onMutate`
 *  has already mutated the cache by the time `mutationFn` runs, so reading
 *  current pin state inside `mutationFn` flips the wrong way and the CLI
 *  ends up calling the opposite of what the user clicked. */
interface PinVars {
  id: number
  targetPinned: boolean
}

export function useTogglePin(): (internalId: number) => Promise<void> {
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const togglePinOptimistic = usePinned((s) => s.togglePinOptimistic)

  const mutation = useMutation<boolean | null, Error, PinVars, { rollback: () => void }>({
    mutationFn: ({ id, targetPinned }: PinVars) => mailApi.email.pin(id, targetPinned),
    onMutate: async ({ id, targetPinned }) => {
      await queryClient.cancelQueries({ queryKey: PINNED_KEY })
      const prev = queryClient.getQueryData<number[]>(PINNED_KEY) ?? []
      togglePinOptimistic(id)
      const next = targetPinned ? [...prev, id] : prev.filter((v) => v !== id)
      queryClient.setQueryData<number[]>(PINNED_KEY, next)
      return {
        rollback: () => {
          togglePinOptimistic(id)
          queryClient.setQueryData<number[]>(PINNED_KEY, prev)
        }
      }
    },
    onError: (err, _vars, ctx) => {
      if (ctx) ctx.rollback()
      toastError('Pin toggle failed', errorMessage(err))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PINNED_KEY })
    }
  })

  return async (id: number) => {
    // Decide direction BEFORE mutate(); this read happens before any
    // optimistic write so it sees the real current state.
    const cached = queryClient.getQueryData<number[]>(PINNED_KEY) ?? []
    const targetPinned = !cached.includes(id)
    await mutation.mutateAsync({ id, targetPinned })
  }
}
