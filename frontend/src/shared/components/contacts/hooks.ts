// 通讯录 hooks（task 08-13 WP2）。flag 投影与 components/matters/hooks.ts 的
// useMatterFlags 共用 `useAppConfig` 那一次 `/chat/config`（🔴 不直读 env，与
// /api/contacts 的 require_contacts_enabled 读同一个冻结单例）。

import { useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'

import { createContactsApi } from '@shared/api/contacts'
import type { ContactProfileRefreshResult, ContactsApi } from '@shared/api/contacts'
import type { EnrichedEmailMeta } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import type {
  ContactAgentHistoryResponse,
  ContactAgentStatus,
  ContactBackfillProgress,
  ContactProfileDailySummary,
  ContactDetailDto,
  ContactListResponse,
  ContactMailDirection,
  ContactMailsResponse,
  ContactMattersResponse,
  ContactProfileSuggestionField,
  ContactSort,
  ContactSuggestionListResponse,
  ContactSuggestionStatus,
  ContactView
} from '@shared/api/types/contact'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { useAppConfig } from '@shared/hooks/useAppConfig'
import type { AppConfigFlags } from '@shared/hooks/useAppConfig'
import { qk } from '@shared/lib/queryKeys'

export function useContactsApi(): ContactsApi {
  return useMemo(() => createContactsApi(resolveApiBaseUrl()), [])
}

export interface ContactFlags {
  contactsEnabled: boolean
  contactAgentEnabled: boolean
  loading: boolean
}

/** 🔴 治理 Agent 的语义是 **AND**：后端 `/api/contacts/suggestions` 先过 router 级
 *  `require_contacts_enabled`、再过端点级 `require_contact_agent_enabled`，所以
 *  `contactAgentEnabled` 在这里取合取，UI 不会显示一个必然 E_DISABLED 的入口。
 *  模块级 = 引用稳定（见 useAppConfig 的 select 约定）。 */
const selectContactFlags = (
  flags: AppConfigFlags
): { contactsEnabled: boolean; contactAgentEnabled: boolean } => ({
  contactsEnabled: flags.contactsEnabled,
  contactAgentEnabled: flags.contactsEnabled && flags.contactAgentEnabled
})

/** 通讯录总闸 + 治理 Agent 闸的**双 flag 投影**（WP7；形状照 matters 的
 *  `useMatterFlags`）。数据源是与事项**共享**的那一次 `/chat/config`（`useAppConfig`：
 *  单 key 单请求，启动阶段不再同端点发两遍；失败即 error 而不是缓存成「已禁用」）。 */
export function useContactFlags(): ContactFlags {
  const query = useAppConfig(selectContactFlags)
  return {
    contactsEnabled: query.data?.contactsEnabled === true,
    contactAgentEnabled: query.data?.contactAgentEnabled === true,
    loading: query.isPending
  }
}

/** 总闸单读（WP2 起的既有签名，5 个调用点原样保留）。 */
export function useContactsEnabled(): { enabled: boolean; loading: boolean } {
  const flags = useContactFlags()
  return { enabled: flags.contactsEnabled, loading: flags.loading }
}

/** 单页列表（选人弹层 / 治理抽屉用）。工作台主列表走下面的 `useContactListPaged`。
 *
 *  🔴 `limit` 不是可选的装饰：不传 = 服务端一次返回全表（「全部」视图实测 900KB）。
 *  每个消费者都该按自己真正要渲染的条数传一个上限 —— 弹层本来就只显示前 N 条。 */
export function useContactList(options: {
  view: ContactView
  q: string
  sort: ContactSort
  enabled: boolean
  limit?: number
}): ReturnType<typeof useQuery<ContactListResponse>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: [...qk.contacts.list(options.view, options.q, options.sort), options.limit ?? null],
    queryFn: () =>
      api.list({
        view: options.view,
        q: options.q || undefined,
        sort: options.sort,
        limit: options.limit
      }),
    enabled: options.enabled,
    // 缓存配方同 useEmailListRows（速赢包 §2）: 切走再切回 <5min 直接命中缓存（无网络、
    // 无骨架），gcTime 15min 防「离开一会儿回来整份被 GC → 完整冷加载」。写侧靠
    // useInvalidateContact 精确失效，不靠短 staleTime。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    placeholderData: (previous) => previous
  })
}

/** 工作台主列表首屏页大小。200 ≈ 一屏能滚几轮的量（活库 known 视图共 616 人），
 *  服务端按 keyset 续页；小于这个数会让「刚进页面就要续拉」变成常态。 */
export const CONTACT_LIST_PAGE_SIZE = 200

/** 工作台主列表 (keyset 分页) 的 options 单源 —— useContactListPaged 与启动预热
 *  (lib/startupPrefetch T2 的 prefetchInfiniteQuery 首页) 共用: key / queryFn /
 *  分页参数 / 缓存配方一体, 预热写进缓存的必然被工作台首挂命中 (防 key 漂移)。 */
export function contactListPagedOptions(
  api: ContactsApi,
  view: ContactView,
  q: string,
  sort: ContactSort
): {
  queryKey: ReturnType<typeof qk.contacts.listPaged>
  queryFn: (context: { pageParam: unknown }) => Promise<ContactListResponse>
  initialPageParam: string | undefined
  getNextPageParam: (lastPage: ContactListResponse) => string | undefined
  staleTime: number
  gcTime: number
} {
  return {
    queryKey: qk.contacts.listPaged(view, q, sort),
    queryFn: ({ pageParam }) =>
      api.list({
        view,
        q: q || undefined,
        sort,
        limit: CONTACT_LIST_PAGE_SIZE,
        cursor: pageParam as string | undefined
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  }
}

/** 工作台主列表（keyset 分页）。
 *
 *  `placeholderData: (prev) => prev` 在 infinite query 上的形态一致：切视图 / 改搜索词
 *  时上一份 pages 留在原位（列表不闪骨架），新结果到达原地替换 —— 与单页版同一配方。 */
export function useContactListPaged(options: {
  view: ContactView
  q: string
  sort: ContactSort
  enabled: boolean
}): ReturnType<typeof useInfiniteQuery<ContactListResponse, Error>> {
  const api = useContactsApi()
  return useInfiniteQuery({
    ...contactListPagedOptions(api, options.view, options.q, options.sort),
    enabled: options.enabled,
    placeholderData: (previous) => previous
  })
}

export function useContactDetail(
  contactId: number | null,
  enabled: boolean
): ReturnType<typeof useQuery<ContactDetailDto>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.detail(contactId ?? -1),
    queryFn: () => api.get(contactId as number),
    enabled: enabled && contactId !== null,
    // WP6 画像生成是分钟级后台任务（可离开页面）：running 时 3s 轮询同一份 detail，
    // 落地态即停 —— 不另开 job 键（画像态本来就是 detail 投影的一部分，多一个键就多
    // 一个会与 detail 打架的真源）。形态照 useBackfillProgress 的 refetchInterval。
    refetchInterval: (query) => (query.state.data?.profile?.status === 'running' ? 3_000 : false),
    // 同 useContactList 的配方（画像 running 时由上面的 3s 轮询接管，与 staleTime 无关）。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
}

// useContactProfileEnabled 已随 2026-08-19 cutover 退役：画像 venue env 闸删除、
// 投影键恒 true，画像卡徽标只报行启停 —— 零消费点后一并删除。

/** 手动「立即更新画像」。202 即返回（生成在后端异步跑）；invalidate 让 detail 立刻
 *  读到 `status:'running'`，随后由上面的 3s 轮询接管到落地态。 */
export function useRefreshContactProfile(
  contactId: number
): UseMutationResult<ContactProfileRefreshResult, Error, void> {
  const api = useContactsApi()
  const invalidate = useInvalidateContact()
  return useMutation({
    mutationFn: () => api.refreshProfile(contactId),
    onSuccess: async () => {
      await invalidate(contactId)
    }
  })
}

/** 采纳建议值（写身份字段 + 落锁）。🔒 §4.2：**零乐观更新** —— 写入失败时建议项必须
 *  留在原位，所以只在成功后 invalidate，不预先把行摘掉。 */
export function useAdoptProfileSuggestion(
  contactId: number
): UseMutationResult<
  ContactDetailDto,
  Error,
  { field: ContactProfileSuggestionField; value: string }
> {
  const api = useContactsApi()
  const invalidate = useInvalidateContact()
  return useMutation({
    mutationFn: (input) => api.adoptProfileSuggestion(contactId, input.field, input.value),
    onSuccess: async () => {
      await invalidate(contactId)
    }
  })
}

/** 忽略建议值（只本轮消失）。同样零乐观更新。 */
export function useIgnoreProfileSuggestion(
  contactId: number
): UseMutationResult<ContactDetailDto, Error, ContactProfileSuggestionField> {
  const api = useContactsApi()
  const invalidate = useInvalidateContact()
  return useMutation({
    mutationFn: (field) => api.ignoreProfileSuggestion(contactId, field),
    onSuccess: async () => {
      await invalidate(contactId)
    }
  })
}

/** 详情页「关联邮件」首屏页大小（旧 `ContactDetail::MAIL_PAGE_SIZE`，随查询一起搬过来）。 */
export const CONTACT_MAIL_PAGE_SIZE = 6

/** 关联邮件（keyset 分页）。
 *
 *  🔴 有**两个**声明点：`ContactDetail` 顶层 + 它内部的 `ContactMailList`。顶层那次是
 *  waterfall 拆解（task 08-20 P0-3）—— 这条查询原先写在「detail 没到就早返回骨架」之后的
 *  子组件里，等于「detail 回来了才开始拉邮件」（首屏 4 跳的最后一跳）；声明到顶层后它在
 *  mount 那一刻就与 detail 并发发出。子组件那次是它自己的数据源，两处同 queryKey ⇒
 *  react-query 按 key 去重，仍然只有一次请求、一份缓存。 */
export function useContactMails(
  contactId: number,
  direction: ContactMailDirection
): ReturnType<typeof useInfiniteQuery<ContactMailsResponse, Error>> {
  const api = useContactsApi()
  return useInfiniteQuery({
    queryKey: qk.contacts.mails(contactId, direction),
    queryFn: ({ pageParam }) =>
      api.listMails(contactId, { direction, cursor: pageParam, limit: CONTACT_MAIL_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 30_000
  })
}

export function useContactMatters(
  contactId: number | null,
  enabled: boolean
): ReturnType<typeof useQuery<ContactMattersResponse>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.matters(contactId ?? -1),
    queryFn: () => api.listMatters(contactId as number),
    enabled: enabled && contactId !== null,
    staleTime: 30_000
  })
}

/** 「本会话已经见过 drained」的闩（task 08-20 P3-10）。
 *
 *  端点判据是 `scanned >= total`（`routers/contacts.py::backfill_progress`，两条
 *  `COUNT(*) FROM email_metadata`），扫完之后条本身不显示（`BackfillBar:18`）——
 *  再问下去就是每次进通讯录为一条不显示的条多发一次请求。
 *
 *  🔴 有意**不**落 localStorage：`drained` 并不单调（新邮件进来 total 先涨、水位线还没跟上时
 *  会翻回 false），把它写进磁盘等于永久藏掉这条进度条。会话级闩最多让「开着应用时来了一大批
 *  新邮件」那一次不显示进度，重启即恢复。 */
let backfillDrainedSeen = false

/** 测试用复位 —— 模块级闩会跨用例存活，不复位就是用例间互相污染（照 `resetMatterWorkspace`）。 */
export function resetBackfillDrainedLatch(): void {
  backfillDrainedSeen = false
}

/** BackfillBar：未 drained 时 5s 轮询，drained 后停（可关，关了不影响扫描）。 */
export function useBackfillProgress(
  enabled: boolean
): ReturnType<typeof useQuery<ContactBackfillProgress>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.progress(),
    queryFn: async () => {
      const progress = await api.backfillProgress()
      if (progress.drained) backfillDrainedSeen = true
      return progress
    },
    // 见过一次 drained 就整条查询关掉：本次挂载靠下面的 refetchInterval 停轮询，
    // **之后**每次重新进页面靠这个闩不再发第一次请求。
    enabled: enabled && !backfillDrainedSeen,
    refetchInterval: (query) => (query.state.data?.drained === false ? 5_000 : false),
    // 未 drained 的实时性由上面的 5s 轮询负责; staleTime 只决定「重新挂载要不要立刻再拉」
    // —— 4s 等于每次进页面都为一条进度条多发一次请求（drained 后那条还不显示）。
    staleTime: 60_000
  })
}

// ── WP7 治理台 ────────────────────────────────────────────────────────────────

/** 队列 tab 同时渲染两批：待审 + 被守卫拦下的（服务端 `list_suggestions` 只收单个
 *  status，拿不到一起）。`blocked` 那批没有动作按钮，只是「留在队列里」的证据。 */
export function useContactSuggestions(
  status: ContactSuggestionStatus,
  enabled: boolean
): ReturnType<typeof useQuery<ContactSuggestionListResponse>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.suggestions(status),
    queryFn: () => api.listSuggestions({ status }),
    enabled,
    staleTime: 15_000
  })
}

/** 胶囊徽标 + 抽屉脚的数据源。🔴 `enabled=false`（治理 flag 关）→ react-query 不发
 *  请求、不起轮询，胶囊也不进 DOM —— 两层门（`AgentPendingBadge` 先例）。 */
export function useContactAgentStatus(
  enabled: boolean
): ReturnType<typeof useQuery<ContactAgentStatus>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.agentStatus(),
    queryFn: () => api.agentStatus(),
    enabled,
    // 治理扫描是每天一次的后台节拍：60s 一探足够让徽标在扫描落地后自己浮出来，
    // 又不至于像待审批红点那样 5s 敲一次。
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000
  })
}

/** v2 工作台「运行」tab 的治理扫描历史。
 *  🔴 `retry:false` —— 后端批还没合并时这个端点是 404，重试三次只是把「加载失败」拖慢
 *  三倍；一次失败即进 error 态，由调用方渲染一行提示（红线：契约未上线不炸页面）。 */
export const CONTACT_AGENT_HISTORY_LIMIT = 10

export function useContactAgentHistory(
  enabled: boolean
): ReturnType<typeof useQuery<ContactAgentHistoryResponse>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.agentHistory(CONTACT_AGENT_HISTORY_LIMIT),
    queryFn: () => api.agentHistory({ limit: CONTACT_AGENT_HISTORY_LIMIT }),
    enabled,
    retry: false,
    staleTime: 30_000
  })
}

/** v2 工作台「运行」tab 的画像批处理只读镜子。同样 `retry:false` + 只在抽屉开着时发。
 *  🔴 有意**不**在这里给画像行的开关：那个开关在 Agents 页的「联系人画像」卡上，两处都能
 *  改会立刻分裂出「哪个是权威」（原型裁量 5）。 */
export function useContactProfileDailySummary(
  enabled: boolean
): ReturnType<typeof useQuery<ContactProfileDailySummary>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.profileDailySummary(),
    queryFn: () => api.profileDailySummary(),
    enabled,
    retry: false,
    staleTime: 30_000
  })
}

/** 采纳 / 忽略 / 手动扫描之后的统一失效：两条队列 + 徽标计数 + 扫描历史。
 *  🔴 历史也要失效 —— 手点「现在跑一次」之后历史里立刻多一行 queued，不失效的话
 *  用户看到的又是「什么都没发生」（WP7 dogfood 的同一个坑）。 */
export function useInvalidateContactSuggestions(): () => Promise<void> {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['contacts', 'suggestions'] }),
      queryClient.invalidateQueries({ queryKey: qk.contacts.agentStatus() }),
      queryClient.invalidateQueries({ queryKey: ['contacts', 'agent-history'] })
    ])
  }
}

/** 治理 agent 的系统提示词（`agent_config.db` 的 `contact_agent` 文档）。
 *  🔴 「库里空 = 跟随代码默认」是**存储**语义（默认文案升级时没自定义过的用户能跟着
 *  走），所以界面显示的生效值 = `content || defaultContent`，不是把空 content 原样
 *  摆出来（matters 0812 dogfood 的同一个缺口）。 */
export interface ContactAgentPromptDoc {
  content: string
  defaultContent: string
}

export function useContactAgentPrompt(
  enabled: boolean
): ReturnType<typeof useQuery<ContactAgentPromptDoc>> {
  return useQuery({
    queryKey: qk.contacts.agentPrompt(),
    queryFn: async (): Promise<ContactAgentPromptDoc> => {
      const response = await fetch(`${resolveApiBaseUrl()}/agent/profile/docs/contact_agent`, {
        credentials: 'include'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as {
        data?: { content?: string; defaultContent?: string }
      }
      return {
        content: payload.data?.content ?? '',
        defaultContent: payload.data?.defaultContent ?? ''
      }
    },
    enabled,
    staleTime: 30_000
  })
}

/** 保存提示词。空内容 = 恢复默认（服务端 `store.py` 的 `empty_allowed` 含
 *  `contact_agent`），所以「恢复默认」不是把当前默认文本写进库。 */
export function useSaveContactAgentPrompt(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (content: string): Promise<void> => {
      const response = await fetch(`${resolveApiBaseUrl()}/agent/profile/docs/contact_agent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.contacts.agentPrompt() })
    }
  })
}

/** 画像证据角标 hover 时懒查那封邮件的 meta（主题用来让 owner 不点进去就能确认引的是哪封）。
 *
 *  🔴 走 `listEnriched({ internalIds })` 而不是 `email.get()`：后者的记录**带 body**，
 *  一张画像卡可能有十几个角标，为了一行标题把正文搬过 IPC 不划算。`internalIds` 这个 filter
 *  的注释里写的就是「已知 id 批量取 enriched 用」。
 *  🔴 `enabled` 由 hover 驱动 —— 渲染画像时**不预取**，鼠标碰到哪个查哪个。
 *  主题不会变 ⇒ staleTime 给到 5 分钟，同一角标反复 hover 只查一次。 */
export function useEvidenceEmailMeta(
  internalId: number,
  enabled: boolean
): ReturnType<typeof useQuery<EnrichedEmailMeta | null>> {
  const api = useMailApi()
  return useQuery({
    queryKey: qk.email.meta(internalId),
    queryFn: async (): Promise<EnrichedEmailMeta | null> => {
      const rows = await api.email.listEnriched({ internalIds: [internalId], limit: 1 })
      // 空数组 = 那封邮件已经不在库里（删了 / 还没同步到）→ null，由渲染侧说人话。
      return rows[0] ?? null
    },
    enabled,
    staleTime: 300_000,
    retry: false
  })
}

/** 组织架构框架（`agent_config.db` 的 `contact_org_frame` 文档）。与上面那对
 *  `contact_agent` 是同一套通用 profile doc 端点，只换文档名 —— 名字两侧手写字符串是该
 *  机制的现状（服务端也是白名单里的字面量），跟随。
 *
 *  🔴 与提示词不同，这份文档**没有内置默认**：它是 owner 自己的组织架构，空 = 不约束
 *  （治理 agent 照常提建议，只是没有「框架外」这条判据）。所以这里只取 `content`，
 *  不把端点顺带返回的 `defaultContent` 摆出来假装有个默认框架可回退。 */
export function useContactOrgFrame(enabled: boolean): ReturnType<typeof useQuery<string>> {
  return useQuery({
    queryKey: qk.contacts.orgFrame(),
    queryFn: async (): Promise<string> => {
      const response = await fetch(`${resolveApiBaseUrl()}/agent/profile/docs/contact_org_frame`, {
        credentials: 'include'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { data?: { content?: string } }
      return payload.data?.content ?? ''
    },
    enabled,
    staleTime: 30_000
  })
}

/** 保存组织架构框架。空内容 = 清空 = 不约束（不是「恢复默认」——没有默认）。 */
export function useSaveContactOrgFrame(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (content: string): Promise<void> => {
      const response = await fetch(`${resolveApiBaseUrl()}/agent/profile/docs/contact_org_frame`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.contacts.orgFrame() })
    }
  })
}

/** 写操作后的统一失效：列表 + 该联系人 detail 前缀（连带 mails/matters）。 */
export function useInvalidateContact(): (contactId?: number) => Promise<void> {
  const queryClient = useQueryClient()
  return async (contactId?: number) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] }),
      contactId !== undefined
        ? queryClient.invalidateQueries({ queryKey: qk.contacts.detail(contactId) })
        : Promise.resolve()
    ])
  }
}

export type { ContactMailDirection }
