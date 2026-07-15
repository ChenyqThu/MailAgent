// Compose editor suggestion dropdowns — slash 块菜单 + @mention 联系人菜单。
//
// TipTap v3 Suggestion 的 render() 桥（ReactRenderer 工厂 createSuggestionRender）
// 在 editor-extensions.ts（本文件保持 components-only，react-refresh 约束）。
// 浮层材质 .glass-pop + 菜单档圆角 --r-ctl（与 ui/popover.tsx 同族）。
//
// 键盘导航：组件经 React 19 ref-as-prop 暴露 SuggestMenuHandle.onKeyDown
// （↑/↓ 循环、Enter 选中）；Escape 在 render 工厂层直接销毁浮层。

import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SuggestionKeyDownProps } from '@tiptap/suggestion'

import { cn } from '@shared/lib/cn'
import type { ContactSuggestion } from '@shared/api/types'

import type { SlashItem } from './editor-extensions'

/** 键盘导航句柄 — render 工厂的 onKeyDown 转发进来。 */
export interface SuggestMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

/** Mention 节点属性（选中联系人 → TipTap mention attrs）。 */
export interface MentionSelectAttrs {
  id: string
  label: string
}

// 阴影由 .glass-pop 自带的 --pop-shadow 提供（index.css 浮层材质），不叠 ad-hoc shadow
// （与 RecipientField 下拉同一配方，避免与材质体系漂移）。
const MENU_SURFACE = cn(
  'rounded-[var(--r-ctl)] glass-pop border border-ink-border-soft',
  'py-1 overflow-y-auto scrollbar-thin'
)

const ITEM_ROW = cn(
  'w-full text-left px-2.5 py-1.5 flex items-center gap-2',
  'transition-colors duration-fast'
)

/** ↑/↓/Enter 键盘导航共享逻辑 — 高亮索引 render 时 clamp（同 RecipientField 模式）。 */
function useSuggestKeyboard<T>(
  items: readonly T[],
  onSelect: (item: T) => void,
  ref: React.Ref<SuggestMenuHandle> | undefined
): [number, (i: number) => void] {
  const [rawIndex, setRawIndex] = useState(0)
  const index = Math.min(rawIndex, Math.max(0, items.length - 1))
  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
        if (items.length === 0) return false
        if (event.key === 'ArrowDown') {
          setRawIndex((index + 1) % items.length)
          return true
        }
        if (event.key === 'ArrowUp') {
          setRawIndex((index - 1 + items.length) % items.length)
          return true
        }
        if (event.key === 'Enter') {
          const it = items[index]
          if (it !== undefined) onSelect(it)
          return true
        }
        return false
      }
    }),
    [items, index, onSelect]
  )
  return [index, setRawIndex]
}

/** slash 块菜单 — 图标 + 标题 + 副标题，头部「基础块」分组标签。 */
export function SlashMenu({
  items,
  command,
  ref
}: {
  items: SlashItem[]
  command: (item: SlashItem) => void
  query?: string
  ref?: React.Ref<SuggestMenuHandle>
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [index, setIndex] = useSuggestKeyboard(items, command, ref)
  if (items.length === 0) return null
  return (
    <div className={cn(MENU_SURFACE, 'w-60 max-h-72')}>
      <div className="px-2.5 pt-1 pb-0.5 text-micro font-medium uppercase tracking-wide text-ink-fg-3">
        {t('compose.editor.slashGroupBasic')}
      </div>
      {items.map((it, i) => {
        const ItemIcon = it.icon
        return (
          <button
            key={it.id}
            type="button"
            // onMouseDown preventDefault: 保住编辑器选区/焦点，点击不触发 blur。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => command(it)}
            onMouseEnter={() => setIndex(i)}
            className={cn(ITEM_ROW, i === index ? 'bg-ink-3' : 'hover:bg-ink-3')}
          >
            <span className="w-7 h-7 rounded-[var(--r-ctl)] border border-ink-border/60 bg-ink-2/50 grid place-items-center text-ink-fg-2 shrink-0">
              <ItemIcon size={15} strokeWidth={2} />
            </span>
            <span className="flex flex-col min-w-0">
              <span className="text-meta text-ink-fg truncate">
                {t(`compose.editor.${it.labelKey}`)}
              </span>
              <span className="text-micro text-ink-fg-3 truncate">
                {t(`compose.editor.${it.subtitleKey}`)}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function contactInitials(c: ContactSuggestion): string {
  const base = (c.name?.trim() || c.email.split('@')[0] || '?').slice(0, 2)
  return base.toUpperCase()
}

/** @mention 联系人菜单 — 头像缩写 + 姓名 + 邮箱。选中 = 插 mention 节点 + onPick 回调。 */
export function MentionMenu({
  items,
  command,
  onPick,
  ref
}: {
  items: ContactSuggestion[]
  command: (attrs: MentionSelectAttrs) => void
  query?: string
  /** T5 接线点：mention 选中联系人时回调（用于自动加进收件人）。 */
  onPick?: (contact: ContactSuggestion) => void
  ref?: React.Ref<SuggestMenuHandle>
}): React.ReactElement | null {
  const select = (c: ContactSuggestion): void => {
    onPick?.(c)
    command({ id: c.email, label: c.name?.trim() ? c.name : c.email })
  }
  const [index, setIndex] = useSuggestKeyboard(items, select, ref)
  if (items.length === 0) return null
  return (
    <div className={cn(MENU_SURFACE, 'w-64 max-h-60')}>
      {items.map((c, i) => (
        <button
          key={c.email}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => select(c)}
          onMouseEnter={() => setIndex(i)}
          className={cn(ITEM_ROW, i === index ? 'bg-ink-3' : 'hover:bg-ink-3')}
        >
          <span className="w-7 h-7 rounded-full bg-ink-3 grid place-items-center text-micro font-medium text-ink-fg-2 shrink-0">
            {contactInitials(c)}
          </span>
          <span className="flex flex-col min-w-0">
            <span className="text-meta text-ink-fg truncate">{c.name?.trim() || c.email}</span>
            <span className="text-micro font-mono text-ink-fg-3 truncate">{c.email}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
