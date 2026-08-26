/**
 * 所有带乐观锁（`expectedVersion`）的事项写操作的**唯一出口**。
 *
 * 0812 dogfood P0「不管点哪个都是 matter version changed，完全无法操作」的病根不是冲突
 * 本身，而是**冲突之后 UI 永不自愈**：`expectedVersion` 取自渲染时那份 `matter.version`，
 * 而各处 `onError` 只弹 toast、不刷新任何 query ⇒ 发生过一次冲突（后台 Agent 在写 / 用户
 * 连点两下 / 上一次成功的刷新还没落地）之后，手里的版本号就永远停在旧值，**之后每一次
 * 点击都必定失败**，只能刷新整页。
 *
 * 🔴 为什么是一个共享出口而不是「每处补一个 onError」：这次漏掉的就是四处（确认建议 /
 * 忽略建议 / 删干系人 / 存干系人），而它们与已经写对的那处（提案审阅）长得一模一样 ——
 * 靠人记得写是这类 bug 的复发机制。这里把「冲突 ⇒ 重新拉事项」焊在包装里，调用方**没有
 * 关掉它的入口**：`onError` 只能追加自己的 UI 反馈，跑不掉刷新那一步。
 *
 * 配套的结构闸：`frontend/tests/components/matters/matterMutationGate.test.ts` —— 事项组件
 * 目录下凡是出现 `expectedVersion` 的文件，都不许再直接用 `useMutation`。
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { QueryClient, UseMutationOptions, UseMutationResult } from '@tanstack/react-query'

import { asWriteError } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'

import { MATTER_TAGS_QUERY_KEY } from './matterTags'

/**
 * 「手里这份事项已经过期」的两个后端错误码。
 * - `E_VERSION_CONFLICT` — 乐观锁**真冲突**：matter 级字段（patch/归档/评审…）恒严格 CAS；
 *   子实体路径（item/干系人/资料/关系）0813 起服务端先做 bounded auto-rebase（版本账本
 *   盖住 gap 且 scope 不重叠即放行），仍抛 = 救不回来，不再是「仅仅 stale」。
 * - `E_UPDATE_STALE` — 提案在评审期间被别的写入作废（accept 对 stale 行硬拒）。
 * 两者的处置相同：重新拉取事项，下一次操作才有最新版本可用。
 */
export const MATTER_STALE_CODES = ['E_VERSION_CONFLICT', 'E_UPDATE_STALE'] as const

export function isMatterStaleError(error: unknown): boolean {
  const code = asWriteError(error).code
  return MATTER_STALE_CODES.some((candidate) => candidate === code)
}

/**
 * 冲突后的重新拉取。失效 `['matters','detail',id]` 前缀即可覆盖 detail / resources /
 * stakeholders / runs / updates / context-snapshot（见 `queryKeys.ts` 里它们共用的前缀），
 * 不用逐个列 —— 少列一个就是下一个「某个面永远停在旧数据」。
 */
export async function refetchMatterAfterStale(
  client: QueryClient,
  matterId: string | null | undefined
): Promise<void> {
  await refreshMatter(client, matterId)
}

/**
 * 事项写入成功后的刷新 —— **所有**事项面共用的唯一出口（详情 / 工作台 / 焦点 /
 * 事项对话 / PiP，以及 SSE `matter.changed` 到达时）。
 *
 * 0818 dogfood：「在事项里已经接受的建议，在待审阅 · Agent 更新提案里不会立刻更新，
 * 还会留着」。病根不是某处漏了一行，而是这张清单被**手抄在 `MatterDetail.refresh()` 里**，
 * 而焦点页的提案聚合用的是跨事项的 `['matters','pending-updates']` —— 它结构上不在
 * `detail(id)` 前缀下，那份手抄清单里也没列它。
 *
 * 🔴 `pendingUpdates()` 必须显式列在这里：它跨事项，没有任何前缀能连带覆盖它。
 * 🔴 新增事项相关的顶层缓存键时，加进这里 —— 不要在调用点再抄一份
 *    （闸：`frontend/tests/components/matters/matterRefreshGate.test.ts`）。
 */
export async function refreshMatter(
  client: QueryClient,
  matterId: string | null | undefined
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: qk.matters.list() }),
    client.invalidateQueries({ queryKey: qk.matters.pendingUpdates() }),
    // 同上一条的处境：例外面第四源是**跨事项**聚合（`['matters','item-dispatches']`），
    // detail 前缀覆盖不到它 —— 在详情里回答 / 取消一次派发后，例外面那条不失效就会挂着。
    client.invalidateQueries({ queryKey: qk.matters.itemDispatches() }),
    client.invalidateQueries({ queryKey: MATTER_TAGS_QUERY_KEY }),
    ...(matterId ? [client.invalidateQueries({ queryKey: qk.matters.detail(matterId) })] : [])
  ])
}

/** 事项标识：定值，或从 mutation 变量里取（一个面板对多个事项写入时，如捕获浮层）。 */
export type MatterMutationTarget<TVariables> =
  | string
  | null
  | ((variables: TVariables) => string | null | undefined)

export type UseMatterMutationOptions<TData, TVariables, TOnMutateResult> = UseMutationOptions<
  TData,
  Error,
  TVariables,
  TOnMutateResult
> & {
  /** 本次写入的目标事项 —— 冲突时按它重新拉取。 */
  matterId: MatterMutationTarget<TVariables>
}

export function useMatterMutation<TData = unknown, TVariables = void, TOnMutateResult = unknown>(
  options: UseMatterMutationOptions<TData, TVariables, TOnMutateResult>
): UseMutationResult<TData, Error, TVariables, TOnMutateResult> {
  const client = useQueryClient()
  const { matterId, onError, ...rest } = options
  return useMutation<TData, Error, TVariables, TOnMutateResult>({
    ...rest,
    onError: (error, variables, onMutateResult, context) => {
      // 🔴 恒先刷新再交给调用方：调用方的 onError 可能弹 toast、可能改本地状态，但它无论
      // 怎么写都影响不到这一步。这就是「以后新加 mutation 忘了处理冲突」不可能发生的原因。
      if (isMatterStaleError(error)) {
        const target = typeof matterId === 'function' ? matterId(variables) : matterId
        void refetchMatterAfterStale(client, target)
      }
      return onError?.(error, variables, onMutateResult, context)
    }
  })
}
