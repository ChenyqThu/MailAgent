// compose 收件人 / 发件人的「地址 → 通讯录姓名」批量解析。
//
// 复用 WP4 既有的 `POST /api/contacts/resolve`（邮件详情头 PersonChip 同一个端点、
// 同一个 query key）—— 那里已经证明了「一批地址一次往返、键 = 归一后的原输入串」
// 这条路，compose 不另造读面。
//
// 为什么 chip 不能只靠补全学到的名字：reply / forward / 草稿续编的收件人是**预填**
// 的，用户一个字都没打，补全查询压根不会发 —— 那些 chip 只能显示裸邮箱。这个 hook
// 补的就是这一段。
//
// 🔴 服务端 `RESOLVE_MAX_EMAILS = 100`，超了整批 400。这里截断而不是放行：收件人
// 超过 100 个时，宁可后面那些显示裸邮箱，也不能让整批解析失败。

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useContactsApi, useContactsEnabled } from '@shared/components/contacts/hooks'
import { qk } from '@shared/lib/queryKeys'

/** 与服务端 `contacts.py::RESOLVE_MAX_EMAILS` 同值（超出即整批 E_INVALID_ARG）。 */
const RESOLVE_MAX_EMAILS = 100

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map()

/**
 * 归一（trim + lower）去重 + 排序后解析，返回 `归一地址 → 通讯录姓名`。
 *
 * 姓名口径与 PersonChip 一致：`display_name || formal_name`（两者都空 = 不给名字，
 * 调用方回落裸邮箱）；不在库的地址不进 map。
 */
export function useRecipientDirectoryNames(emails: readonly string[]): ReadonlyMap<string, string> {
  const { enabled } = useContactsEnabled()
  const contactsApi = useContactsApi()

  // queryKey 吃排序后的地址集 —— 同一组收件人稳定命中缓存（EmailDetail 同约定）。
  const addresses = useMemo(() => {
    const out = new Set<string>()
    for (const raw of emails) {
      const normalized = raw.trim().toLowerCase()
      // 无 @ 的碎 token 不值一次往返，服务端 normalize 也会拒掉。
      if (normalized.includes('@')) out.add(normalized)
    }
    return [...out].sort().slice(0, RESOLVE_MAX_EMAILS)
  }, [emails])

  const resolveQ = useQuery({
    queryKey: qk.contacts.resolve(addresses),
    queryFn: () => contactsApi.resolve(addresses),
    enabled: enabled && addresses.length > 0,
    staleTime: 30_000
  })

  return useMemo(() => {
    const items = resolveQ.data?.items
    if (!items) return EMPTY_NAMES
    const out = new Map<string, string>()
    for (const [addr, chip] of Object.entries(items)) {
      const name = (chip?.display_name || chip?.formal_name || '').trim()
      if (name) out.set(addr.trim().toLowerCase(), name)
    }
    return out
  }, [resolveQ.data])
}
