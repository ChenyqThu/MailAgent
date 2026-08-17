// 通讯录 hooks（task 08-13 WP2）。flag 投影镜像 components/matters/hooks.ts 的
// useMatterFlags（/chat/config 投影、staleTime 30s、retry:false、catch→false ——
// 🔴 不直读 env，与 /api/contacts 的 require_contacts_enabled 读同一个冻结单例）。

import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { createContactsApi } from '@shared/api/contacts'
import type { ContactsApi } from '@shared/api/contacts'
import type {
  ContactBackfillProgress,
  ContactDetailDto,
  ContactListResponse,
  ContactMailDirection,
  ContactMattersResponse,
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
    staleTime: 15_000
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
