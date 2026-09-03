// P2-L8（资料库 epic）— @ 资料库 的 trigger adapter（`@` 的第四组）。
//
// 形状逐字抄 `useMatterMentionAdapter`（它自己抄的是 AgentComposer::useEmailMentionAdapter）：
// popover 要的是**同步** adapter（search(query) → items）+ 一个独立的 isLoading，所以 search()
// 只调度一次防抖 fetch 并返回 ref 里缓存的当前 query 结果；fetch 落地后 setState → adapter 重建
// → popover 重读。单独成文件的理由同前两组：适配层可以脱开 Lexical / 整个 composer 单测。
//
// 搜索面走**既有**的 `GET /library/search`（⌘K 第五 lane、事项关联第四 tab、agent 的
// `library_search` 同一个服务端内核），不新建端点。
//
// 🔴 fetch 落地即把每行**收窄成四字段** `LibraryMentionRef`（file_id / path / name / size_bytes）：
// 这一步就是「只发标识、不发正文」那条判据在代码里的落点 —— 组件手里从此没有 snippet 可发
// （理由见 mention-context.ts::LibraryMentionRef）。
//
// 🔴 投影行（mail-attachments 下的邮件附件）`id` 恒 null，`library_read(file_id=…)` 对它结构上
// 不可调，故整行跳过：宁可 @ 不到，也不生成一个模型读不开的引用。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Unstable_TriggerItem } from '@assistant-ui/react'

import { createLibraryApi } from '@shared/api/library'
import type { LibrarySearchResponse } from '@shared/api/types/library'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import type { LibraryMentionRef } from '@shared/lib/mention-context'

import { LIBRARY_MENTION_CATEGORY_ID, libraryMentionItemId } from './agentMention'

/** Local mirror of @assistant-ui/core's Unstable_TriggerAdapter (not re-exported from react) —
 *  same local type the other three adapters declare. */
type TriggerAdapter = {
  categories: () => readonly { readonly id: string; readonly label: string }[]
  categoryItems: (categoryId: string) => readonly Unstable_TriggerItem[]
  search: (query: string) => readonly Unstable_TriggerItem[]
}

/** Impossible initial query so the FIRST real search (even '') counts as a new one. */
const MENTION_SENTINEL = '\u0000'
const SEARCH_DEBOUNCE_MS = 180
const SEARCH_LIMIT = 8

export function useLibraryMentionAdapter(controls: ChatComposerControls | null): {
  adapter: TriggerAdapter
  isLoading: boolean
  onInserted: (item: Unstable_TriggerItem) => void
} {
  const { t } = useTranslation()
  const libraryApi = useMemo(() => createLibraryApi(resolveApiBaseUrl()), [])
  // 供不供得上 onAddLibraryMention 就是这一组出不出的开关（同「事项」那组的既有约定）。资料库
  // 没有功能总闸（design §9.1「模型在不在就是开关」），所以这里只有这一个判据。
  const visible = controls?.onAddLibraryMention != null

  const [items, setItems] = useState<readonly Unstable_TriggerItem[]>([])
  const [loading, setLoading] = useState(false)
  const stateRef = useRef<{ query: string; items: readonly Unstable_TriggerItem[] }>({
    query: MENTION_SENTINEL,
    items: []
  })
  const refsRef = useRef<Map<string, LibraryMentionRef>>(new Map())
  const seqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchNow = useCallback(
    (q: string) => {
      const seq = ++seqRef.current
      setLoading(true)
      void libraryApi
        .search(q, SEARCH_LIMIT)
        .then((res: LibrarySearchResponse) => {
          if (seq !== seqRef.current) return
          const mapped: Unstable_TriggerItem[] = []
          for (const hit of res.hits) {
            if (hit.id == null) continue
            const id = libraryMentionItemId(hit.id)
            // 🔴 收窄发生在这里，一次，且是唯一入口。
            refsRef.current.set(id, {
              file_id: hit.id,
              path: hit.path,
              name: hit.filename,
              size_bytes: hit.size_bytes
            })
            mapped.push({
              id,
              type: 'library',
              label: hit.filename || hit.path,
              description: hit.path,
              metadata: { icon: 'library', fileId: hit.id }
            })
          }
          stateRef.current = { query: q, items: mapped }
          setItems(mapped)
        })
        .catch(() => {
          if (seq !== seqRef.current) return
          stateRef.current = { query: q, items: [] }
          setItems([])
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    },
    [libraryApi]
  )

  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () =>
        visible ? [{ id: LIBRARY_MENTION_CATEGORY_ID, label: t('library.mention.group') }] : [],
      categoryItems: (categoryId: string) =>
        visible && categoryId === LIBRARY_MENTION_CATEGORY_ID ? stateRef.current.items : [],
      search: (query: string) => {
        if (!visible) return []
        if (query === MENTION_SENTINEL) return []
        if (query !== stateRef.current.query) {
          // New query — clear stale items + invalidate any in-flight fetch (seq bump) so a late
          // response for the OLD query can't repopulate stale results. Then (re)schedule.
          stateRef.current = { query, items: [] }
          seqRef.current += 1
          if (timerRef.current) clearTimeout(timerRef.current)
          if (query.trim().length > 0) {
            timerRef.current = setTimeout(() => fetchNow(query), SEARCH_DEBOUNCE_MS)
          }
        }
        return stateRef.current.items
      }
    }),
    // `items` participates so a settled fetch re-creates the adapter → the popover re-reads fresh
    // items (search() itself reads stateRef, so eslint flags items as unused — that IS the point).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchNow, items, t, visible]
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  const onInserted = useCallback(
    (item: Unstable_TriggerItem) => {
      const ref = refsRef.current.get(item.id)
      if (ref) controls?.onAddLibraryMention?.(ref)
    },
    [controls]
  )

  return { adapter, isLoading: loading, onInserted }
}
