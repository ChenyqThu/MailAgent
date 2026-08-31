// 日历事件的与会者字段 —— chip 输入 + 通讯录补全。
//
// 08-27 P4d：原来只能「输入 email 后回车」，通讯录早就有了却要人手打邮箱。这里接上
// compose 刚打通的那条链，**复用**而不是抄一份：
//   · 取数     useContactSuggest（同端点 / 同查询键 ⇒ 同一份缓存 / 同一档 debounce）
//   · 下拉行   ContactSuggestRow + ContactSuggestAddRow（头像 · 姓名/组织 · 邮箱三段）
//   · chip 名  useRecipientDirectoryNames（POST /contacts/resolve 批量解析）
//   · 头像     RecipientAvatar（同一套色槽 ⇒ 下拉里选的人和落成的 chip 是同一个颜色）
//
// 🔴 没有整体复用 compose 的 `RecipientField`：它的取值是 `string[]`、外壳是表头那一行
// （`.folder-field-row` + `.field-label`），还带内外部染色、跨字段去重、chip 详情浮层与
// 键盘选 chip 模式。这里的取值是 `EventAttendeeInput[]`（带 CN 名字，直接进 ICS），外壳
// 是模态里的 `.ef-field`/`.chip-field`，也没有第二个收件人字段可去重。把这些差异塞进
// RecipientField 就是靠 prop 分叉出第二种组件，所以只共用上面四件，壳各写各的。
//
// 手输一个通讯录里没有的合法邮箱仍然直接能加（补全没命中时下拉给「添加 xxx」那一行，
// 回车 / 逗号 / 分号 / 失焦也照样提交）—— 「不在通讯录」不等于「不能加」。

import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { useAnchoredPosition } from '@shared/hooks/useAnchoredPosition'
import {
  ContactSuggestAddRow,
  ContactSuggestRow
} from '@shared/components/email/compose/ContactSuggestRow'
import { useContactSuggest } from '@shared/components/email/compose/contact-suggest'
import { RecipientAvatar } from '@shared/components/email/compose/recipient-avatar'
import { useRecipientDirectoryNames } from '@shared/components/email/compose/useRecipientDirectory'
import type { EventAttendeeInput } from '@shared/api/types'

/** 下拉宽度与 compose 一致（三段行在更窄的宽度下组织段会先被挤没）。 */
const DROPDOWN_WIDTH = 344
const DROPDOWN_MAX_HEIGHT = 280
/** 非法输入的红描边脉冲时长。 */
const INVALID_PULSE_MS = 700

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

interface Props {
  value: EventAttendeeInput[]
  /** 只有用户动手（加 / 删）才会调用 —— 预填不走这里，故调用方可据此置 dirty。 */
  onChange: (next: EventAttendeeInput[]) => void
}

export function AttendeeField({ value, onChange }: Props): React.ReactElement {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  // Esc 只收起下拉，不清输入（与 compose 同）。下次编辑重新放开。
  const [dismissed, setDismissed] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)

  const emails = useMemo(() => value.map((a) => a.email), [value])
  const lowerSet = useMemo(() => new Set(emails.map((e) => e.toLowerCase())), [emails])
  const exclude = useMemo(() => [...lowerSet], [lowerSet])

  // 预填的与会者（编辑既有事件）用户一个字没打，补全查询压根不会发 —— chip 上的
  // 姓名只能来自这一批解析。
  const directoryNames = useRecipientDirectoryNames(emails)
  const { debounced, suggestions } = useContactSuggest({ query: input, enabled: focused, exclude })

  const trimmed = input.trim().replace(/[,;]$/, '')
  const rawAddVisible =
    isEmail(trimmed) &&
    !lowerSet.has(trimmed.toLowerCase()) &&
    !suggestions.some((s) => s.email.toLowerCase() === trimmed.toLowerCase())

  const optionCount = suggestions.length + (rawAddVisible ? 1 : 0)
  const dropdownOpen = focused && !dismissed && optionCount > 0
  const rawOptionIndex = suggestions.length

  // 选项变少时把高亮夹回范围内（render 期条件 setState，react.dev「按 props 调整 state」）。
  const maxIndex = Math.max(0, optionCount - 1)
  if (highlightedIndex > maxIndex) setHighlightedIndex(maxIndex)

  const position = useAnchoredPosition(fieldRef, dropdownOpen, {
    width: DROPDOWN_WIDTH,
    maxHeight: DROPDOWN_MAX_HEIGHT
  })

  const add = useCallback(
    (attendee: EventAttendeeInput): void => {
      if (lowerSet.has(attendee.email.toLowerCase())) {
        setInput('')
        return
      }
      onChange([...value, attendee])
      setInput('')
      setDismissed(false)
      setHighlightedIndex(0)
      inputRef.current?.focus()
    },
    [lowerSet, onChange, value]
  )

  /** 手输提交（回车 / 逗号 / 分号 / 失焦）。非法地址不加，红描边脉冲一下。 */
  const commitTyped = useCallback((): void => {
    const v = input.trim().replace(/[,;]$/, '')
    if (!v) return
    if (!isEmail(v)) {
      setInvalid(true)
      window.setTimeout(() => setInvalid(false), INVALID_PULSE_MS)
      return
    }
    add({ email: v })
  }, [add, input])

  const removeAt = useCallback(
    (idx: number): void => onChange(value.filter((_, i) => i !== idx)),
    [onChange, value]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (dropdownOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightedIndex((cur) => (cur + 1) % optionCount)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightedIndex((cur) => (cur - 1 + optionCount) % optionCount)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const picked = suggestions[highlightedIndex]
        if (picked) add({ email: picked.email, name: picked.name || undefined })
        else if (rawAddVisible) add({ email: trimmed })
        return
      }
      if (e.key === 'Escape') {
        // 🔴 模态的 Esc 关闭挂在 window 上，React 的 stopPropagation 到不了原生监听器：
        // 下拉开着时按 Esc 应该只收下拉，不能顺手把整个表单关掉。
        e.preventDefault()
        e.nativeEvent.stopImmediatePropagation()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      commitTyped()
      return
    }
    if (e.key === 'Backspace' && input === '' && value.length > 0) {
      e.preventDefault()
      removeAt(value.length - 1)
    }
  }

  const listboxId = 'ef-attendee-suggest'
  const activeDescendant = dropdownOpen
    ? highlightedIndex < suggestions.length
      ? `${listboxId}-${suggestions[highlightedIndex]?.email}`
      : `${listboxId}-rawadd`
    : undefined

  return (
    <div className="ef-field">
      <label className="ef-label" htmlFor="ef-att-input">
        {t('calendar.form.attendees.label', '与会者')}
      </label>
      <div
        ref={fieldRef}
        className={cn('chip-field', focused && 'focus', invalid && 'invalid')}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((a, idx) => {
          // 通讯录 display_name 权威 > 事件里带的 CN > 裸邮箱。名字是显示口径，
          // 地址才是真值，所以 title 恒带完整地址。
          const name = directoryNames.get(a.email.trim().toLowerCase()) ?? a.name ?? ''
          return (
            <span key={a.email} className="chip" title={name ? `${name} <${a.email}>` : a.email}>
              <RecipientAvatar name={name} email={a.email} size={16} />
              <span className="max-w-[200px] truncate">{name || a.email}</span>
              <button
                type="button"
                className="chip-x"
                onClick={(e) => {
                  e.stopPropagation()
                  removeAt(idx)
                }}
                aria-label={t('calendar.form.attendees.removeChip', '移除 {email}', {
                  email: a.email
                })}
                title={t('calendar.shared.closeAria', '关闭')}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          id="ef-att-input"
          type="text"
          className="chip-input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setDismissed(false)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commitTyped()
          }}
          placeholder={
            value.length === 0
              ? t('calendar.form.attendees.placeholder', '搜姓名或邮箱，回车添加')
              : ''
          }
          autoComplete="off"
          aria-label={t('calendar.form.attendees.label', '与会者')}
          role="combobox"
          aria-expanded={dropdownOpen}
          aria-controls={dropdownOpen ? listboxId : undefined}
          aria-activedescendant={activeDescendant}
        />
      </div>
      <div className="chip-hint">
        {t('calendar.form.attendees.hint', 'Enter 添加 · ⌫ 删除上一个 · 点 × 移除')}
      </div>

      {/* 🔴 下拉 portal 到 body：`.efm-body` 是 `overflow-y: auto` 的滚动容器，
          absolute 浮层会被它齐边裁掉（同 useAnchoredPosition 的来由）。 */}
      {dropdownOpen &&
        position &&
        createPortal(
          <ul
            id={listboxId}
            role="listbox"
            aria-label={t('calendar.form.attendees.suggestAria', '与会者候选')}
            style={{
              top: position.top,
              left: position.left,
              width: DROPDOWN_WIDTH,
              maxHeight: position.maxHeight
            }}
            className="glass-pop fixed z-[100] overflow-y-auto py-1"
          >
            {suggestions.map((c, idx) => (
              <ContactSuggestRow
                key={c.email}
                contact={c}
                query={debounced}
                active={idx === highlightedIndex}
                optionId={`${listboxId}-${c.email}`}
                onPick={() => add({ email: c.email, name: c.name || undefined })}
                onHover={() => setHighlightedIndex(idx)}
              />
            ))}
            {rawAddVisible && (
              <ContactSuggestAddRow
                label={t('calendar.form.attendees.addRaw', '添加 “{email}”', { email: trimmed })}
                hint={t('calendar.form.attendees.addRawHint', '不在通讯录，直接用这个邮箱')}
                active={highlightedIndex === rawOptionIndex}
                optionId={`${listboxId}-rawadd`}
                onPick={() => add({ email: trimmed })}
                onHover={() => setHighlightedIndex(rawOptionIndex)}
                icon={<Plus size={15} />}
              />
            )}
          </ul>,
          document.body
        )}
    </div>
  )
}
