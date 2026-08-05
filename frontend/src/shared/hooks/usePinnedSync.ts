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
  /** 乐观翻转的目标集合 —— 单封 = [id]; 线程级联 = 前端已知的成员集
   *  (服务端展开的权威集合经 SSE 回来校正)。 */
  optimisticIds: number[]
  /** 线程级联取消置顶: 服务端按 thread_id 展开线程内其余仍置顶的成员一并取消。 */
  cascadeThread?: boolean
}

/** 线程虚拟头传给 `togglePin` 的级联参数 (省略 = 历史单封 toggle)。 */
export interface TogglePinOpts {
  /** 前端已知的线程成员 id (乐观翻转集)。 */
  memberIds?: number[]
  /** true = 级联取消置顶整条线程。**只能取消** —— 服务端对 pinned=true + cascade 返 400,
   *  故本 hook 在 cascade 时把方向钉死成 false, 不走「读缓存取反」(虚拟头的聚合态
   *  是「任一成员置顶」, 母邮件自己可能根本没置顶, 取反会反向置顶整条线程)。 */
  cascadeThread?: boolean
}

export function useTogglePin(): (internalId: number, opts?: TogglePinOpts) => Promise<void> {
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const setPinnedOptimistic = usePinned((s) => s.setPinnedOptimistic)

  const mutation = useMutation<boolean | null, Error, PinVars, { rollback: () => void }>({
    mutationFn: ({ id, targetPinned, cascadeThread }: PinVars) =>
      mailApi.email.pin(id, targetPinned, cascadeThread ? { cascadeThread: true } : undefined),
    onMutate: async ({ targetPinned, optimisticIds }) => {
      await queryClient.cancelQueries({ queryKey: PINNED_KEY })
      // 缓存缺席时回落到 store 快照, 而不是当成「一个都没置顶」—— 后者写回去的
      // `next` 会把**别的行**的置顶态一起抹掉 (setQueryData → usePinnedSync 的
      // effect → setPinned 整表覆盖), 直到下一次 refetch 才长回来。
      const prev = queryClient.getQueryData<number[]>(PINNED_KEY) ?? [
        ...usePinned.getState().pinned
      ]
      // 逐 id 记下翻转前的真实归属 (读 store 而非 prev —— 别的行可能有在途的
      // 乐观翻转), 回滚时精确还原这些 id, 不整表 setPinned 覆盖别人的在途写。
      const before = new Set(usePinned.getState().pinned)
      const wasPinned = optimisticIds.filter((id) => before.has(id))
      const wasUnpinned = optimisticIds.filter((id) => !before.has(id))
      setPinnedOptimistic(optimisticIds, targetPinned)
      const targets = new Set(optimisticIds)
      const next = targetPinned
        ? [...prev.filter((v) => !targets.has(v)), ...optimisticIds]
        : prev.filter((v) => !targets.has(v))
      queryClient.setQueryData<number[]>(PINNED_KEY, next)
      return {
        rollback: () => {
          setPinnedOptimistic(wasPinned, true)
          setPinnedOptimistic(wasUnpinned, false)
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

  return async (id: number, opts?: TogglePinOpts) => {
    // Decide direction BEFORE mutate(); this read happens before any
    // optimistic write so it sees the real current state.
    //
    // 🔴 判据必须与**用户看到的亮/暗**同源 —— 那是 `usePinned` store
    // (EmailRow / EmailDetail 的 pin 图标都读它)。曾经读 ['pinnedIds'] 查询缓存:
    // 那份缓存离开邮件视图超过 gcTime 就被回收、重新进来到首个 fetch 落地之间也是空,
    // 而 store 是模块级的、活得比它久 —— 于是「图标亮着 + 缓存空」时
    // `!cached.includes(id)` 恒真, 点「取消置顶」发出去的却是 pin=true:
    // 服务端把已置顶的行原地重写一遍, 图标照亮、行照留在已固定桶 = dogfood 报的
    // 「点了没反应」。cascade 方向仍钉死 false (虚拟头聚合态不是母邮件自己的态)。
    const cascadeThread = opts?.cascadeThread === true
    const targetPinned = cascadeThread ? false : !usePinned.getState().pinned.includes(id)
    const optimisticIds =
      cascadeThread && opts?.memberIds && opts.memberIds.length > 0 ? opts.memberIds : [id]
    await mutation.mutateAsync({ id, targetPinned, optimisticIds, cascadeThread })
  }
}
