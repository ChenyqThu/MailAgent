// S4 (task 08-18) — @ 事项 的 trigger adapter（`@` 的第三组）。
//
// 形状抄 `AgentComposer::useEmailMentionAdapter` 一字不改的那套异步桥：popover 要的是**同步**
// adapter（search(query) → items）+ 一个独立的 isLoading，所以 search() 只调度一次防抖 fetch 并
// 返回 ref 里缓存的当前 query 结果；fetch 落地后 setState → adapter 重建 → popover 重读。
// 单独成文件（不是塞回 AgentComposer）跟的是 `useAgentMentionAdapter` 的先例：适配层可以脱开
// Lexical / 整个 composer 单测。
//
// 搜索面走**既有**的事项搜索（`mattersApi.list({ q, limit })`，⌘K 的「事项」组同一个调用形状），
// 不新建端点。
//
// 🔴 fetch 落地即把每行**收窄成三字段** `MatterMentionRef`（public_id / title / status）：
// 这一步就是「只发标识、不发正文」那条判据在代码里的落点 —— 组件手里从此没有 description /
// current_summary 可发（理由见 mention-context.ts::MatterMentionRef）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Unstable_TriggerItem } from '@assistant-ui/react'

import type { MatterListResponse } from '@shared/api/types/matter'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { useMattersApi, useMattersEnabled } from '@shared/components/matters/hooks'
import type { MatterMentionRef } from '@shared/lib/mention-context'

import { MATTER_MENTION_CATEGORY_ID, matterMentionItemId } from './agentMention'

/** Local mirror of @assistant-ui/core's Unstable_TriggerAdapter (not re-exported from react) —
 *  same local type the other two adapters declare. */
type TriggerAdapter = {
  categories: () => readonly { readonly id: string; readonly label: string }[]
  categoryItems: (categoryId: string) => readonly Unstable_TriggerItem[]
  search: (query: string) => readonly Unstable_TriggerItem[]
}

/** Impossible initial query so the FIRST real search (even '') counts as a new one. */
const MENTION_SENTINEL = '\u0000'
const SEARCH_DEBOUNCE_MS = 180
const SEARCH_LIMIT = 8

export function useMatterMentionAdapter(controls: ChatComposerControls | null): {
  adapter: TriggerAdapter
  isLoading: boolean
  onInserted: (item: Unstable_TriggerItem) => void
} {
  const { t } = useTranslation()
  const mattersApi = useMattersApi()
  const mattersEnabled = useMattersEnabled()
  // 供不供得上 onAddMatterMention 就是这一组出不出的开关 —— 事项对话不供给（见
  // composerControlsContext 上的红字）。加上功能总闸：关掉 Matters 时 `@` 不该出现「事项」。
  const visible = controls?.onAddMatterMention != null && mattersEnabled

  const [items, setItems] = useState<readonly Unstable_TriggerItem[]>([])
  const [loading, setLoading] = useState(false)
  const stateRef = useRef<{ query: string; items: readonly Unstable_TriggerItem[] }>({
    query: MENTION_SENTINEL,
    items: []
  })
  const refsRef = useRef<Map<string, MatterMentionRef>>(new Map())
  const seqRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchNow = useCallback(
    (q: string) => {
      const seq = ++seqRef.current
      setLoading(true)
      void mattersApi
        .list({ q, limit: SEARCH_LIMIT })
        .then((res: MatterListResponse) => {
          if (seq !== seqRef.current) return
          const mapped = res.items.map((matter) => {
            const id = matterMentionItemId(matter.public_id)
            // 🔴 收窄发生在这里，一次，且是唯一入口。
            refsRef.current.set(id, {
              public_id: matter.public_id,
              title: matter.title,
              status: matter.status
            })
            return {
              id,
              type: 'matter',
              label: matter.title || matter.public_id,
              description: matter.public_id,
              metadata: { icon: 'matter', publicId: matter.public_id }
            } satisfies Unstable_TriggerItem
          })
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
    [mattersApi]
  )

  const adapter = useMemo<TriggerAdapter>(
    () => ({
      categories: () =>
        visible ? [{ id: MATTER_MENTION_CATEGORY_ID, label: t('agentView.mention.matters') }] : [],
      categoryItems: (categoryId: string) =>
        visible && categoryId === MATTER_MENTION_CATEGORY_ID ? stateRef.current.items : [],
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
      if (ref) controls?.onAddMatterMention?.(ref)
    },
    [controls]
  )

  return { adapter, isLoading: loading, onInserted }
}
