// 通讯录 hooks（task 08-13 WP2）。flag 投影镜像 components/matters/hooks.ts 的
// useMatterFlags（/chat/config 投影、staleTime 30s、retry:false、catch→false ——
// 🔴 不直读 env，与 /api/contacts 的 require_contacts_enabled 读同一个冻结单例）。

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'

import { createContactsApi } from '@shared/api/contacts'
import type { ContactProfileRefreshResult, ContactsApi } from '@shared/api/contacts'
import type {
  ContactAgentHistoryResponse,
  ContactAgentStatus,
  ContactBackfillProgress,
  ContactProfileDailySummary,
  ContactDetailDto,
  ContactListResponse,
  ContactMailDirection,
  ContactMattersResponse,
  ContactProfileSuggestionField,
  ContactSort,
  ContactSuggestionListResponse,
  ContactSuggestionStatus,
  ContactView
} from '@shared/api/types/contact'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { qk } from '@shared/lib/queryKeys'

export function useContactsApi(): ContactsApi {
  return useMemo(() => createContactsApi(resolveApiBaseUrl()), [])
}

export interface ContactFlags {
  contactsEnabled: boolean
  contactAgentEnabled: boolean
  loading: boolean
}

/** 通讯录总闸 + 治理 Agent 闸的**双 flag 投影**（WP7；形状照 matters 的
 *  `useMatterFlags`）。一次 `/chat/config` 取两个字段，共用 `qk.contacts.config()`
 *  这一个缓存 —— 两条独立 fetch 会各自缓存，同一份 flag 在两个面上显示成两个值。
 *  🔴 治理 Agent 的语义是 **AND**：后端 `/api/contacts/suggestions` 先过 router 级
 *  `require_contacts_enabled`、再过端点级 `require_contact_agent_enabled`，所以
 *  `contactAgentEnabled` 在这里也取合取，UI 不会显示一个必然 E_DISABLED 的入口。 */
export function useContactFlags(): ContactFlags {
  const query = useQuery({
    queryKey: qk.contacts.config(),
    queryFn: async (): Promise<{ contactsEnabled: boolean; contactAgentEnabled: boolean }> => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return { contactsEnabled: false, contactAgentEnabled: false }
        const body = (await response.json()) as {
          data?: { contactsEnabled?: unknown; contactAgentEnabled?: unknown }
        }
        const contactsEnabled = body.data?.contactsEnabled === true
        return {
          contactsEnabled,
          contactAgentEnabled: contactsEnabled && body.data?.contactAgentEnabled === true
        }
      } catch {
        return { contactsEnabled: false, contactAgentEnabled: false }
      }
    },
    staleTime: 30_000,
    retry: false
  })
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

export function useContactList(options: {
  view: ContactView
  q: string
  sort: ContactSort
  enabled: boolean
}): ReturnType<typeof useQuery<ContactListResponse>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.list(options.view, options.q, options.sort),
    queryFn: () => api.list({ view: options.view, q: options.q || undefined, sort: options.sort }),
    enabled: options.enabled,
    staleTime: 15_000,
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
    staleTime: 15_000
  })
}

/** 画像总闸（`MAILAGENT_CONTACT_PROFILE_ENABLED` + agent 行 enabled 的合取，后端投影）。
 *  ⚠️ 不读 useEnvStore —— 远程 web 端 env 面只读且拿不到 .env，与 useContactsEnabled 同源同形。 */
export function useContactProfileEnabled(): { enabled: boolean; loading: boolean } {
  const query = useQuery({
    queryKey: qk.contacts.profileConfig(),
    queryFn: async (): Promise<boolean> => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return false
        const body = (await response.json()) as { data?: { contactProfileEnabled?: unknown } }
        return body.data?.contactProfileEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return { enabled: query.data === true, loading: query.isPending }
}

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
): UseMutationResult<ContactDetailDto, Error, { field: ContactProfileSuggestionField; value: string }> {
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

/** BackfillBar：未 drained 时 5s 轮询，drained 后停（可关，关了不影响扫描）。 */
export function useBackfillProgress(
  enabled: boolean
): ReturnType<typeof useQuery<ContactBackfillProgress>> {
  const api = useContactsApi()
  return useQuery({
    queryKey: qk.contacts.progress(),
    queryFn: () => api.backfillProgress(),
    enabled,
    refetchInterval: (query) => (query.state.data?.drained === false ? 5_000 : false),
    staleTime: 4_000
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
