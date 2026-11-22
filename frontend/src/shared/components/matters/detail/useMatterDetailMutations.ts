import { useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type {
  Matter,
  MatterItem,
  MatterItemCreateInput,
  MatterItemExecProfile,
  MatterPatchInput,
  MatterResourceListItem,
  MatterUpdateSummary
} from '@shared/api/types/matter'
import { asWriteError, errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from '../hooks'
import type { ReviewAcceptPayload } from '../MatterUpdateReview'
import { refreshMatter, isMatterStaleError, useMatterMutation } from '../matterMutation'
import type { useMatterUndoToast } from '../useMatterUndoToast'

type MattersApi = ReturnType<typeof useMattersApi>

export interface UseMatterDetailMutationsArgs {
  matterId: string
  matter: Matter | undefined
  updates: readonly MatterUpdateSummary[]
  reviewId: number | null
  deleteConfirmation: string
  setAddOpen(open: boolean): void
  setDeleteOpen(open: boolean): void
  setReviewId(id: number | null): void
  setReviewError(error: string | null): void
  onRemoved(): void
  pushUndoToast: ReturnType<typeof useMatterUndoToast>
}

export interface MatterDetailMutations {
  refresh(): Promise<void>
  patch: UseMutationResult<Awaited<ReturnType<MattersApi['patch']>>, Error, MatterPatchInput>
  patchAgentConfig: UseMutationResult<
    Awaited<ReturnType<MattersApi['patch']>>,
    Error,
    { input: MatterPatchInput; expectedVersion: number }
  >
  transition: UseMutationResult<
    Awaited<ReturnType<MattersApi['archive']>>,
    Error,
    'archive' | 'reopen' | 'trash' | 'restore'
  >
  addItem: UseMutationResult<
    Awaited<ReturnType<MattersApi['createItem']>>,
    Error,
    MatterItemCreateInput
  >
  updateItem: UseMutationResult<
    Awaited<ReturnType<MattersApi['patchItem']>>,
    Error,
    { item: MatterItem; status: 'done' | 'open' }
  >
  setItemProfile: UseMutationResult<
    Awaited<ReturnType<MattersApi['patchItem']>>,
    Error,
    { item: MatterItem; profile: MatterItemExecProfile }
  >
  renameItem: UseMutationResult<
    Awaited<ReturnType<MattersApi['patchItem']>>,
    Error,
    { item: MatterItem; title: string }
  >
  removeItem: UseMutationResult<Awaited<ReturnType<MattersApi['deleteItem']>>, Error, MatterItem>
  permanentDelete: UseMutationResult<
    Awaited<ReturnType<MattersApi['permanentDelete']>>,
    Error,
    void
  >
  toggleResourcePin: UseMutationResult<
    Awaited<ReturnType<MattersApi['patchResource']>>,
    Error,
    MatterResourceListItem
  >
  cancelRun: UseMutationResult<Awaited<ReturnType<MattersApi['cancelRun']>>, Error, number>
  reviewMutation: UseMutationResult<
    Awaited<ReturnType<MattersApi['acceptUpdate']>> | Awaited<ReturnType<MattersApi['rejectUpdate']>>,
    Error,
    { kind: 'accept'; payload: ReviewAcceptPayload } | { kind: 'reject'; payload: string }
  >
}

export function useMatterDetailMutations({
  matterId,
  matter,
  updates,
  reviewId,
  deleteConfirmation,
  setAddOpen,
  setDeleteOpen,
  setReviewId,
  setReviewError,
  onRemoved,
  pushUndoToast
}: UseMatterDetailMutationsArgs): MatterDetailMutations {
  const { t } = useTranslation()
  const api = useMattersApi()
  const queryClient = useQueryClient()

  // 🔴 清单单源在 `matterMutation.refreshMatter` —— 这里曾经手抄过一份七行的失效清单，
  // 漏了焦点页跨事项的 `pending-updates` 聚合键（0818「接受的提案还留在待审阅里」的病根）。
  // resources / stakeholders / runs / updates 都挂在 `detail(id)` 前缀下，前缀一失效就连带刷新。
  const refresh = (): Promise<void> => refreshMatter(queryClient, matterId)

  const patch = useMatterMutation({
    matterId,
    mutationFn: (input: MatterPatchInput) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patch(matterId, input, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  /**
   * 跟进规则模态专用：`expectedVersion` 由模态给（它打开时冻结的那一版），不取这里的
   * 「当前最新」。🔴 上面那个 `patch` 在**发起时**读 `matter.version`，对于「挂载时初始化
   * 草稿、之后才提交」的模态等于把乐观锁架空：期间别处改了排程，保存会带着新版本号把它
   * 静默覆盖。失败也不弹 toast —— 错误要留在模态里，草稿才不会丢。
   */
  const patchAgentConfig = useMatterMutation({
    matterId,
    mutationFn: ({
      input,
      expectedVersion
    }: {
      input: MatterPatchInput
      expectedVersion: number
    }) => api.patch(matterId, input, { expectedVersion }),
    onSuccess: () => void refresh()
  })

  const transition = useMatterMutation({
    matterId,
    mutationFn: async (operation: 'archive' | 'reopen' | 'trash' | 'restore') => {
      if (!matter) throw new Error('Matter is not loaded')
      return api[operation](matterId, { expectedVersion: matter.version })
    },
    // G-33 —— 四个生命周期动作各自报自己的后果（设计 §2.23），不再统一「事项已更新」。
    // 四者在服务端都有反向操作（`_timestamp_transition` 恒返回 undo descriptor），故都带撤销。
    onSuccess: async (result, operation) => {
      await refresh()
      pushUndoToast(t(`matters.toast.transition.${operation}`), result, matterId)
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const addItem = useMatterMutation({
    matterId,
    mutationFn: (input: MatterItemCreateInput) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.createItem(matterId, input, { expectedVersion: matter.version })
    },
    onSuccess: async () => {
      setAddOpen(false)
      await refresh()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const updateItem = useMatterMutation({
    matterId,
    mutationFn: ({ item, status }: { item: MatterItem; status: 'done' | 'open' }) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchItem(
        matterId,
        item.id,
        { status, completed_at: status === 'done' ? Date.now() : null },
        { expectedVersion: matter.version }
      )
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  // L4 批次 3 —— 行动项的**执行档**（`exec_profile`）走既有 item PATCH 面，不新开端点：
  // 派发时服务端从 item 冻结这一档，所以改的是「以后派出去按哪档结算」。
  const setItemProfile = useMatterMutation({
    matterId,
    mutationFn: ({ item, profile }: { item: MatterItem; profile: MatterItemExecProfile }) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchItem(
        matterId,
        item.id,
        { exec_profile: profile },
        { expectedVersion: matter.version }
      )
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  // G-11 —— 行内改标题 / 删除条目。与勾选完成同一条用户直接操作路径（patchItem/deleteItem +
  // 乐观锁），不是 Agent 提案；删除是软删（后端留 restoreItem 反向通道），不弹二次确认。
  const renameItem = useMatterMutation({
    matterId,
    mutationFn: ({ item, title }: { item: MatterItem; title: string }) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchItem(matterId, item.id, { title }, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const removeItem = useMatterMutation({
    matterId,
    mutationFn: (item: MatterItem) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.deleteItem(matterId, item.id, { expectedVersion: matter.version })
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const permanentDelete = useMatterMutation({
    matterId,
    mutationFn: async () => {
      if (!matter) throw new Error('Matter is not loaded')
      return api.permanentDelete(matterId, deleteConfirmation, {
        expectedVersion: matter.version,
        reason: 'user_confirmed_permanent_delete'
      })
    },
    onSuccess: async () => {
      // 走 refreshMatter 而不是只刷 list：永久删除会 CASCADE 掉这个事项的 pending 提案，
      // 焦点页那份跨事项聚合不失效就会留下指向已消失事项的幽灵条目。
      await refresh()
      setDeleteOpen(false)
      onRemoved()
    },
    onError: (error) => toastError(t('matters.toast.deleteFailed'), errorMessage(error))
  })

  const toggleResourcePin = useMatterMutation({
    matterId,
    mutationFn: (item: MatterResourceListItem) => {
      if (!matter) return Promise.reject(new Error('Matter is not loaded'))
      return api.patchResource(
        matterId,
        item.resource.id,
        { pinned: !item.link.pinned },
        { expectedVersion: matter.version }
      )
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const cancelRun = useMatterMutation({
    matterId,
    mutationFn: (runId: number) => api.cancelRun(matterId, runId),
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })
  const reviewMutation = useMatterMutation({
    matterId,
    mutationFn: ({
      kind,
      payload
    }: { kind: 'accept'; payload: ReviewAcceptPayload } | { kind: 'reject'; payload: string }) => {
      if (!matter || reviewId == null) return Promise.reject(new Error('Review is not loaded'))
      return kind === 'accept'
        ? api.acceptUpdate(
            matterId,
            reviewId,
            {
              selected_change_ids: payload.selectedIds,
              edited_changes: payload.editedChanges,
              edited_summary: payload.editedSummary
            },
            { expectedVersion: matter.version }
          )
        : api.rejectUpdate(matterId, reviewId, payload, { expectedVersion: matter.version })
    },
    // G-33 —— 接受/拒绝各报各的后果（设计 §2.23）。
    // 🔴 **两者都不带撤销**：`accept_update` / `reject_update` 在服务端不产出 undo descriptor
    // （service.py 那两个方法没有 `_undo_descriptor` 调用），也没有等价的反向端点 —— 接受会
    // 把 N 项变化落进正式状态并写多条事件，"反过来"不是一次调用能表达的。这里如实只报结果，
    // 不做假撤销按钮。
    onSuccess: async (_result, variables) => {
      const next = updates.filter((item) => item.id !== reviewId)[0]
      setReviewError(null)
      await refresh()
      toastSuccess(
        variables.kind === 'accept'
          ? t('matters.toast.reviewAccepted', {
              // 与提案计数同一口径（Python proposal_change_count）：摘要即当前状态，也算一项。
              count:
                variables.payload.selectedIds.length +
                ((
                  variables.payload.editedSummary ??
                  updates.find((item) => item.id === reviewId)?.summary
                )?.trim()
                  ? 1
                  : 0)
            })
          : t('matters.toast.reviewRejected')
      )
      setReviewId(next?.id ?? null)
    },
    onError: (error) => {
      // 🔴 这里**只剩文案**：重新拉取由 `useMatterMutation` 统一做掉了（原来这一处是全仓
      // 唯一写对了的，另外四处漏了 —— 那正是 0812「完全无法操作」的成因）。别在这里再抄
      // 一遍 invalidate，两套刷新会漂开。
      const writeError = asWriteError(error)
      if (isMatterStaleError(error)) {
        setReviewError(
          writeError.code === 'E_UPDATE_STALE'
            ? t('matters.review.staleReload')
            : t('matters.review.versionReload')
        )
        return
      }
      toastError(t('matters.toast.saveFailed'), errorMessage(error))
    }
  })

  return {
    refresh,
    patch,
    patchAgentConfig,
    transition,
    addItem,
    updateItem,
    setItemProfile,
    renameItem,
    removeItem,
    permanentDelete,
    toggleResourcePin,
    cancelRun,
    reviewMutation
  }
}
