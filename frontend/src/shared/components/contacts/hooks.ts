// 通讯录 hooks（task 08-13 WP2）。flag 投影镜像 components/matters/hooks.ts 的
// useMatterFlags（/chat/config 投影、staleTime 30s、retry:false、catch→false ——
// 🔴 不直读 env，与 /api/contacts 的 require_contacts_enabled 读同一个冻结单例）。

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'

import { createContactsApi } from '@shared/api/contacts'
import type { ContactProfileRefreshResult, ContactsApi } from '@shared/api/contacts'
import type {
  ContactBackfillProgress,
  ContactDetailDto,
  ContactListResponse,
  ContactMailDirection,
  ContactMattersResponse,
  ContactProfileSuggestionField,
  ContactSort,
  ContactView
} from '@shared/api/types/contact'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { qk } from '@shared/lib/queryKeys'

export function useContactsApi(): ContactsApi {
  return useMemo(() => createContactsApi(resolveApiBaseUrl()), [])
}

export function useContactsEnabled(): { enabled: boolean; loading: boolean } {
  const query = useQuery({
    queryKey: qk.contacts.config(),
    queryFn: async (): Promise<boolean> => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return false
        const body = (await response.json()) as { data?: { contactsEnabled?: unknown } }
        return body.data?.contactsEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return { enabled: query.data === true, loading: query.isPending }
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
