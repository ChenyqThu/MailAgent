// 联系人补全的取数口径（debounce 档位 / 条数上限 / 查询键）单源。
//
// compose 的收件人字段与日历的与会者字段用**同一条**补全链：同一个端点、同一个
// 查询键（⇒ 同一份缓存）、同一档 debounce。抽出来是因为出现了第二处消费方，
// 照抄一份会让两边的 debounce 与上限各自漂移，缓存也被切成两份。
//
// 下拉行的渲染形态在 ./ContactSuggestRow —— react-refresh 规则不许组件文件兼职
// 导出 hook，所以取数与行形态分两个文件。

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import type { ContactSuggestion } from '@shared/api/types'

/** 130ms — 比命令面板的 250ms 搜索 debounce 紧，仍能省掉逐键一次查询。 */
export const SUGGEST_DEBOUNCE_MS = 130
/** 下拉一次最多几条候选。 */
export const SUGGEST_LIMIT = 8

interface ContactSuggestOptions {
  /** 输入框里的原始文本；debounce 由本 hook 内部做。 */
  query: string
  /** 通常 = 输入框聚焦。false 时一次都不查。 */
  enabled: boolean
  /** 不再建议的地址（本人 / 已选 / 跨字段去重）。同时进查询键。 */
  exclude: string[]
  limit?: number
}

interface ContactSuggestResult {
  /** 实际发查询用的那一串（下拉里的命中高亮也按它标）。 */
  debounced: string
  suggestions: ContactSuggestion[]
}

/** 输入 → debounce → `email:contactSuggest`。服务端两条 lane（邮件头聚合 + 通讯录
 *  display_name/formal_name/organization/name_variants）合流，故姓名片段（含中文）
 *  同样命中，不是只认邮箱。 */
export function useContactSuggest({
  query,
  enabled,
  exclude,
  limit = SUGGEST_LIMIT
}: ContactSuggestOptions): ContactSuggestResult {
  const mailApi = useMailApi()
  const [settled, setSettled] = useState('')

  useEffect(() => {
    const id = window.setTimeout(() => setSettled(query.trim()), SUGGEST_DEBOUNCE_MS)
    return (): void => window.clearTimeout(id)
  }, [query])

  // 输入被清空（选中候选 / 提交成 chip）时不等这一档 debounce —— 否则刚选完的
  // 那一刻旧的一批候选还会在下拉里挂 130ms。
  const debounced = query.trim() === '' ? '' : settled

  const suggestQ = useQuery<ContactSuggestion[]>({
    queryKey: qk.contactSuggest(debounced, exclude),
    queryFn: () => mailApi.email.contactSuggest(debounced, limit, exclude),
    enabled: enabled && debounced.length >= 1,
    staleTime: 30_000
  })

  const suggestions = useMemo(() => suggestQ.data ?? [], [suggestQ.data])
  return { debounced, suggestions }
}
