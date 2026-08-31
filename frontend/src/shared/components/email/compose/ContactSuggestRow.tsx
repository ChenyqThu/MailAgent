// 联系人补全下拉的行形态（compose 收件人 / 日历与会者共用）。
//
// 行内容 = 头像 · 姓名（无姓名时 local-part 斜体降级）· 组织 · 邮箱三段，对齐通讯录
// 既有的 PersonPicker。名字与邮箱都打命中高亮 —— 用户刚敲的那几个字可能落在任意一段。
//
// 抽出来的理由：第二处（日历与会者）要用同一套行形态。抄一份的话，下一次改行内容
// 只会改到其中一处，两边慢慢长歪。取数口径在 ./contact-suggest。

import { RecipientAvatar } from './recipient-avatar'
import { cn } from '@shared/lib/cn'
import type { ContactSuggestion } from '@shared/api/types'

/** Wrap the first case-insensitive match of `q` in <mark> (React node, no HTML). */
function highlightMatch(text: string, q: string): React.ReactNode {
  if (!q) return text
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-transparent text-ink-fg font-medium">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}

function localPart(addr: string): string {
  return addr.split('@')[0] || addr
}

const ROW_CLASS =
  'w-full text-left px-2.5 py-1.5 flex items-center gap-2.5 transition-colors duration-fast'

interface ContactSuggestRowProps {
  contact: ContactSuggestion
  /** 命中高亮按这一串标（= useContactSuggest 返回的 debounced）。 */
  query: string
  active: boolean
  /** listbox 的 aria-activedescendant 要指到行上，故 id 由调用方给。 */
  optionId: string
  onPick: () => void
  onHover: () => void
  /** 行尾标记（compose 的「外部联系人」黄点）。不给就不占位。 */
  badge?: React.ReactNode
}

export function ContactSuggestRow({
  contact,
  query,
  active,
  optionId,
  onPick,
  onHover,
  badge
}: ContactSuggestRowProps): React.ReactElement {
  return (
    <li role="option" id={optionId} aria-selected={active}>
      <button
        type="button"
        // 保持输入框焦点，否则 onBlur-commit 会先于 click 落地，把半截地址变成 chip。
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
        onMouseEnter={onHover}
        className={cn(ROW_CLASS, active ? 'bg-ink-3' : 'hover:bg-ink-3')}
      >
        <RecipientAvatar name={contact.name ?? ''} email={contact.email} size={30} />
        <span className="flex flex-col min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'truncate text-body text-ink-fg',
                contact.name ? 'font-medium' : 'italic text-ink-fg-1'
              )}
            >
              {highlightMatch(contact.name || localPart(contact.email), query)}
            </span>
            {contact.org && (
              <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-2">
                {highlightMatch(contact.org, query)}
              </span>
            )}
            {badge}
          </span>
          <span className="text-micro font-mono text-ink-fg-3 truncate">
            {highlightMatch(contact.email, query)}
          </span>
        </span>
      </button>
    </li>
  )
}

interface ContactSuggestAddRowProps {
  /** e.g. 「添加 “bob@x.com”」 */
  label: string
  /** e.g. 「使用这个邮箱地址」 */
  hint: string
  active: boolean
  optionId: string
  onPick: () => void
  onHover: () => void
  /** 左侧 30px 槽（与候选行的头像同宽，换控件不位移）。 */
  icon: React.ReactNode
}

/** 「补全没命中，但你敲的是个完整地址」那一行 —— 不在通讯录里也要能加。 */
export function ContactSuggestAddRow({
  label,
  hint,
  active,
  optionId,
  onPick,
  onHover,
  icon
}: ContactSuggestAddRowProps): React.ReactElement {
  return (
    <li role="option" id={optionId} aria-selected={active}>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPick}
        onMouseEnter={onHover}
        className={cn(ROW_CLASS, active ? 'bg-ink-3' : 'hover:bg-ink-3')}
      >
        <span className="w-[30px] h-[30px] rounded-full bg-ink-4 grid place-items-center text-ink-fg-2 shrink-0">
          {icon}
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-aux text-ink-fg truncate">{label}</span>
          <span className="text-aux text-ink-fg-3 truncate">{hint}</span>
        </span>
      </button>
    </li>
  )
}
