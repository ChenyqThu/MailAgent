// Compose recipient chip field (To / Cc / Bcc).
//
// The field itself is the input surface: chips + an inline text input flow in one
// wrap, and clicking the blank area focuses the input (design/compose §2.1).
// `values` stays a plain string[] so ComposePanel keeps its existing wiring;
// display names / internal-external status are derived per-render (name from an
// autocomplete cache, internal from the domain list), never stored in `values`.
//
// Capabilities (design/compose-handoff §2):
//  1. inline editing            — field is the input; blank click focuses it.
//  2. avatar autocomplete       — email:contactSuggest (debounced), avatar + name
//                                 + email rows; a valid unmatched email gets an
//                                 "添加 xxx" row.
//  3. full keyboard             — empty-input ←/Backspace enters chip-select;
//                                 ←/→ move; Backspace/Delete remove; Enter opens
//                                 detail; Esc exits; dropdown ↑/↓/Enter/Tab;
//                                 Enter / , / ; (or space when the token has @)
//                                 commits a chip.
//  4. paste-split               — pasting text with multiple addresses splits
//                                 into one chip each.
//  5. internal / external       — external chips take a --c-warn wash + border +
//                                 yellow dot; internal domains come from the
//                                 `internalDomains` prop, else the fixed org
//                                 whitelist (DEFAULT_INTERNAL_DOMAINS).
//  6. chip detail popover       — avatar / name / email / badge + edit·copy·remove
//                                 (RecipientDetailPopover, .glass-pop material).
//  7. cross-field dedup         — `excludeEmails` is filtered from suggestions and
//                                 blocked from being added (mirrors self-filter).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@shared/lib/cn'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import type { ContactSuggestion } from '@shared/api/types'
import { RecipientAvatar } from './recipient-avatar'
import { RecipientDetailPopover } from './recipient-detail'

interface Props {
  label: string
  values: string[]
  placeholder: string
  onChange: (next: string[]) => void
  /** Owner email — filtered out of additions + suggestions (case-insensitive). */
  selfEmail?: string | null
  /** Cross-field dedup: excluded from suggestions AND blocked from being added. */
  excludeEmails?: string[]
  /** Domains treated as internal; default = DEFAULT_INTERNAL_DOMAINS. */
  internalDomains?: string[]
  /** Focus the input on mount (new-compose To field). */
  autoFocus?: boolean
}

// 130ms — snappier than the palette's 250ms search debounce so completion feels
// keystroke-tight, still coarse enough to skip a query per keypress.
const SUGGEST_DEBOUNCE_MS = 130
const SUGGEST_LIMIT = 8

// Fixed org whitelist for internal/external classification (owner decision,
// 2026-07-15). Overridable per-instance via the `internalDomains` prop.
export const DEFAULT_INTERNAL_DOMAINS = ['tp-link.com', 'tp-link.com.hk', 'omadanetworks.com']

// Address-looking token finder (paste / comma-typed multi). Parens / quotes /
// square brackets are excluded from tokens so "Alice (alice@example.com)"
// yields the bare address; apostrophes stay in (o'brien@x.com is legal) and
// get edge-trimmed by canonicalizeEmail.
const EMAIL_RE = /[^\s,;<>()"[\]]+@[^\s,;<>()"[\]]+\.[^\s,;<>()"[\]]+/g
// A cleaned token that looks like a complete address.
const SINGLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Stray wrapping punctuation around a pasted/typed token (quotes, brackets,
// trailing prose dots/commas).
const EDGE_TRIM_RE = /^[\s"'<>()[\]{},;:.]+|[\s"'<>()[\]{},;:.]+$/g
// Junk that must not survive inside an address (RFC quoted-local exotica is
// out of scope for a compose chip field).
const INNER_JUNK_RE = /["<>()[\]{}]/

/**
 * 单一 canonical 入口（codex review Finding 6）：规整前后引号/括号/尖括号/标点
 * → 形状校验；返回 null = 拒收。粘贴 / 输入提交 / blur 提交 / chip 编辑四条
 * 提交路全走它（去重统一在 addTokens / commitChipEdit 按 lower-case 比对）。
 */
function canonicalizeEmail(raw: string): string | null {
  const stripped = raw.replace(EDGE_TRIM_RE, '')
  if (!stripped || INNER_JUNK_RE.test(stripped)) return null
  return SINGLE_EMAIL_RE.test(stripped) ? stripped : null
}

function extractEmails(raw: string): string[] {
  const out: string[] = []
  for (const token of raw.match(EMAIL_RE) ?? []) {
    const email = canonicalizeEmail(token)
    if (email) out.push(email)
  }
  return out
}

function localPart(addr: string): string {
  return addr.split('@')[0] || addr
}

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

interface ChipContact {
  email: string
  name: string
  external: boolean
  /** false when no internal-domain list is known. */
  determinable: boolean
}

export function RecipientField({
  label,
  values,
  placeholder,
  onChange,
  selfEmail,
  excludeEmails,
  internalDomains,
  autoFocus
}: Props): React.ReactElement {
  const mailApi = useMailApi()
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [focused, setFocused] = useState(false)
  // Esc dismisses the dropdown without clearing the input; reset on next edit.
  const [dismissed, setDismissed] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  // Keyboard chip-selection mode (index into `values`, or null when typing).
  const [chipSel, setChipSel] = useState<number | null>(null)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [detail, setDetail] = useState<{ index: number; rect: DOMRect } | null>(null)
  // Bumped when a suggestion teaches us a name for an already-present chip, so
  // pasted/pre-filled chips upgrade from bare email to name once recognised.
  const [, setCacheTick] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // email(lower) → display name, accumulated from picks + loaded suggestions.
  const nameCacheRef = useRef<Map<string, string>>(new Map())

  const normalizedSelf = (selfEmail ?? '').trim().toLowerCase()

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(input.trim()), SUGGEST_DEBOUNCE_MS)
    return (): void => window.clearTimeout(id)
  }, [input])

  const valuesLower = useMemo(() => values.map((v) => v.toLowerCase()), [values])
  const valuesLowerSet = useMemo(() => new Set(valuesLower), [valuesLower])

  // Self + already-picked + cross-field addresses: never re-suggested, never added.
  const blockedSet = useMemo(
    () =>
      new Set(
        [normalizedSelf, ...(excludeEmails ?? []).map((e) => e.trim().toLowerCase())].filter(
          Boolean
        )
      ),
    [normalizedSelf, excludeEmails]
  )
  const exclude = useMemo(() => [...blockedSet, ...valuesLower], [blockedSet, valuesLower])

  // Internal domains: explicit prop wins; otherwise the fixed org whitelist.
  const internalDomainSet = useMemo(() => {
    const list =
      internalDomains && internalDomains.length > 0 ? internalDomains : DEFAULT_INTERNAL_DOMAINS
    return new Set(list.map((d) => d.trim().toLowerCase()).filter(Boolean))
  }, [internalDomains])

  const isExternal = useCallback(
    (email: string): boolean => {
      if (internalDomainSet.size === 0) return false
      const domain = (email.split('@')[1] ?? '').toLowerCase()
      if (!domain) return false
      return !internalDomainSet.has(domain)
    },
    [internalDomainSet]
  )

  const buildChip = useCallback(
    (addr: string): ChipContact => ({
      email: addr,
      name: nameCacheRef.current.get(addr.toLowerCase()) ?? '',
      external: isExternal(addr),
      determinable: internalDomainSet.size > 0
    }),
    [isExternal, internalDomainSet]
  )

  // React Query owns the fetch (debounce feeds `debounced`); gated on focus so
  // the dropdown only queries while the user is actively in the field.
  const suggestQ = useQuery<ContactSuggestion[]>({
    queryKey: qk.contactSuggest(debounced, exclude),
    queryFn: () => mailApi.email.contactSuggest(debounced, SUGGEST_LIMIT, exclude),
    enabled: focused && debounced.length >= 1,
    staleTime: 30_000
  })
  const suggestions = useMemo(() => suggestQ.data ?? [], [suggestQ.data])

  // Learn names as suggestions stream in; upgrade any matching chip's label.
  useEffect(() => {
    if (suggestions.length === 0) return
    let learnedForChip = false
    for (const s of suggestions) {
      if (!s.name) continue
      const key = s.email.toLowerCase()
      if (nameCacheRef.current.get(key) !== s.name) {
        nameCacheRef.current.set(key, s.name)
        if (valuesLowerSet.has(key)) learnedForChip = true
      }
    }
    if (learnedForChip) setCacheTick((t) => t + 1)
  }, [suggestions, valuesLowerSet])

  const trimmed = input.trim()
  // The raw-add row ("添加 xxx") shows when the canonicalized input is a complete
  // address not already suggested or picked or blocked.
  const canonicalInput = canonicalizeEmail(trimmed)
  const rawAddVisible =
    canonicalInput !== null &&
    !suggestions.some((c) => c.email.toLowerCase() === canonicalInput.toLowerCase()) &&
    !valuesLowerSet.has(canonicalInput.toLowerCase()) &&
    !blockedSet.has(canonicalInput.toLowerCase())

  const optionCount = suggestions.length + (rawAddVisible ? 1 : 0)
  const dropdownOpen = focused && !dismissed && optionCount > 0

  // Clamp highlight when the option list shrinks under us (render-time setState,
  // react.dev "adjust state on prop change").
  const maxIndex = Math.max(0, optionCount - 1)
  if (highlightedIndex > maxIndex) {
    setHighlightedIndex(maxIndex)
  }

  const addTokens = useCallback(
    (tokens: string[]) => {
      if (tokens.length === 0) return
      const seen = new Set(valuesLower)
      const next = [...values]
      for (const tok of tokens) {
        const lower = tok.toLowerCase()
        if (seen.has(lower)) continue
        if (blockedSet.has(lower)) continue
        seen.add(lower)
        next.push(tok)
      }
      if (next.length !== values.length) onChange(next)
    },
    [values, valuesLower, onChange, blockedSet]
  )

  const commitInput = useCallback((): boolean => {
    const emails = extractEmails(input)
    if (emails.length === 0) return false
    addTokens(emails)
    setInput('')
    setDismissed(false)
    return true
  }, [input, addTokens])

  const selectSuggestion = useCallback(
    (c: ContactSuggestion) => {
      if (c.name) nameCacheRef.current.set(c.email.toLowerCase(), c.name)
      addTokens([c.email])
      setInput('')
      setDebounced('')
      setHighlightedIndex(0)
      inputRef.current?.focus()
    },
    [addTokens]
  )

  const pickRawAdd = useCallback(() => {
    if (!canonicalInput) return
    addTokens([canonicalInput])
    setInput('')
    setDebounced('')
    setHighlightedIndex(0)
    inputRef.current?.focus()
  }, [canonicalInput, addTokens])

  const removeAt = useCallback(
    (idx: number) => onChange(values.filter((_, i) => i !== idx)),
    [values, onChange]
  )

  // 行内 chip 编辑提交（blur / Enter）：与其余三条提交路同走 canonicalizeEmail，
  // 非法输入保留原 chip；编辑成已存在/被屏蔽地址 → 合并去重（移除本 chip）。
  const commitChipEdit = useCallback(
    (idx: number, raw: string) => {
      setEditingIdx(null)
      const v = raw.trim()
      if (!v) {
        onChange(values.filter((_, j) => j !== idx))
        return
      }
      const canonical = canonicalizeEmail(v)
      if (!canonical) return
      const lower = canonical.toLowerCase()
      if (values.some((x, j) => j !== idx && x.toLowerCase() === lower) || blockedSet.has(lower)) {
        onChange(values.filter((_, j) => j !== idx))
        return
      }
      if (values[idx] === canonical) return
      const next = [...values]
      next[idx] = canonical
      onChange(next)
    },
    [values, onChange, blockedSet]
  )

  const openDetailAt = useCallback((idx: number) => {
    const el = wrapRef.current?.querySelectorAll('[data-recipient-chip]')[idx]
    const rect = el?.getBoundingClientRect()
    if (rect) setDetail({ index: idx, rect })
  }, [])

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // 1. Keyboard chip-selection mode (input is empty; input keeps focus).
      if (chipSel !== null) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          setChipSel(Math.max(0, chipSel - 1))
          return
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          if (chipSel >= values.length - 1) {
            setChipSel(null)
            inputRef.current?.focus()
          } else {
            setChipSel(chipSel + 1)
          }
          return
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          removeAt(chipSel)
          if (values.length <= 1) {
            setChipSel(null)
            inputRef.current?.focus()
          } else {
            setChipSel(chipSel > 0 ? chipSel - 1 : 0)
          }
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          openDetailAt(chipSel)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          setChipSel(null)
          inputRef.current?.focus()
          return
        }
        // Any printable key → leave selection mode and let it type into the input.
        if (e.key.length === 1) setChipSel(null)
      }

      // 2. Dropdown navigation.
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
          if (highlightedIndex < suggestions.length) {
            const c = suggestions[highlightedIndex]
            if (c) selectSuggestion(c)
          } else if (rawAddVisible) {
            pickRawAdd()
          }
          return
        }
        if (e.key === 'Escape') {
          // Swallow so ComposePanel's window-level Escape doesn't close compose;
          // React stopPropagation doesn't reach native window listeners.
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          setDismissed(true)
          return
        }
      }

      // 3. Commit the typed token as a chip.
      if (
        (e.key === 'Enter' ||
          e.key === ',' ||
          e.key === ';' ||
          (e.key === ' ' && input.includes('@'))) &&
        trimmed
      ) {
        if (commitInput()) e.preventDefault()
        return
      }

      // 4. Enter chip-selection from the empty input (Backspace or ←-at-start).
      if (e.key === 'Backspace' && input === '' && values.length > 0) {
        e.preventDefault()
        setChipSel(values.length - 1)
        return
      }
      if (
        e.key === 'ArrowLeft' &&
        input === '' &&
        values.length > 0 &&
        e.currentTarget.selectionStart === 0
      ) {
        e.preventDefault()
        setChipSel(values.length - 1)
      }
    },
    [
      chipSel,
      values,
      removeAt,
      openDetailAt,
      dropdownOpen,
      optionCount,
      highlightedIndex,
      suggestions,
      rawAddVisible,
      selectSuggestion,
      pickRawAdd,
      input,
      trimmed,
      commitInput
    ]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData('text')
      const emails = extractEmails(text)
      // Only intercept when the paste actually carries addresses; otherwise let
      // it drop into the input normally (e.g. pasting a half-typed local part).
      if (emails.length >= 1 && (emails.length > 1 || /[\s,;<>]/.test(text.trim()))) {
        e.preventDefault()
        addTokens(emails)
        setInput('')
        setDismissed(false)
      }
    },
    [addTokens]
  )

  const commitOnBlur = useCallback(() => {
    setFocused(false)
    commitInput()
  }, [commitInput])

  const listboxId = `recipient-suggest-${label}`
  const rawOptionIndex = suggestions.length

  return (
    <div className="folder-field-row">
      <span className="field-label">{label}</span>
      {/* 外层 relative 仅作 dropdown/popover 锚点 (无 overflow, 不裁剪浮层)。 */}
      <div className="relative min-w-0">
        {/* chip 区: 超约 3 行后内部滚动 (无上限 flex-wrap 会把整行无限撑高)。
            点击空白聚焦末尾输入, 方便直接续打新地址。 */}
        <div
          ref={wrapRef}
          className="flex items-center gap-1.5 flex-wrap max-h-[74px] overflow-y-auto scrollbar-thin"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setChipSel(null)
              inputRef.current?.focus()
            }
          }}
        >
          {values.map((addr, i) => {
            if (editingIdx === i) {
              return (
                <input
                  key={`edit-${addr}-${i}`}
                  autoFocus
                  defaultValue={addr}
                  aria-label={`edit ${addr}`}
                  className="recipient-chip !bg-ink-3 min-w-[160px] outline-none"
                  onBlur={(e) => commitChipEdit(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      e.nativeEvent.stopImmediatePropagation()
                      setEditingIdx(null)
                    }
                  }}
                />
              )
            }
            const chip = buildChip(addr)
            const selected = chipSel === i
            return (
              <span
                key={`${addr}-${i}`}
                data-recipient-chip
                data-selected={selected || undefined}
                className={cn('recipient-chip cursor-pointer select-none')}
                style={{
                  ...(chip.external
                    ? {
                        background: 'rgb(var(--c-warn) / 0.14)',
                        borderColor: 'rgb(var(--c-warn) / 0.5)'
                      }
                    : null),
                  ...(selected ? { boxShadow: '0 0 0 2px rgb(var(--c-accent) / 0.55)' } : null)
                }}
                title={chip.email}
                onClick={() => openDetailAt(i)}
              >
                <RecipientAvatar name={chip.name} email={chip.email} size={18} />
                <span className="max-w-[220px] truncate">{chip.name || chip.email}</span>
                {chip.external && (
                  <span
                    title="外部联系人"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      flexShrink: 0,
                      background: 'rgb(var(--c-warn))',
                      boxShadow: '0 0 0 2px rgb(var(--c-warn) / 0.18)'
                    }}
                  />
                )}
                <button
                  type="button"
                  className="rc-close"
                  aria-label={`remove ${chip.email}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeAt(i)
                  }}
                >
                  <X size={11} strokeWidth={2.2} />
                </button>
              </span>
            )
          })}
          <input
            ref={inputRef}
            value={input}
            placeholder={values.length === 0 ? placeholder : ''}
            onChange={(e) => {
              setInput(e.target.value)
              setDismissed(false)
              setChipSel(null)
            }}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            onFocus={() => setFocused(true)}
            onBlur={commitOnBlur}
            aria-label={label}
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-controls={dropdownOpen ? listboxId : undefined}
            aria-activedescendant={
              dropdownOpen && highlightedIndex < suggestions.length
                ? `${listboxId}-${suggestions[highlightedIndex]?.email}`
                : dropdownOpen && rawAddVisible && highlightedIndex === rawOptionIndex
                  ? `${listboxId}-rawadd`
                  : undefined
            }
            autoComplete="off"
          />
        </div>

        {dropdownOpen && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="glass-pop absolute top-full left-0 mt-1 z-50 w-[300px] max-w-full max-h-[260px] overflow-y-auto py-1"
          >
            {suggestions.map((c, idx) => {
              const external = isExternal(c.email)
              return (
                <li
                  key={c.email}
                  role="option"
                  id={`${listboxId}-${c.email}`}
                  aria-selected={idx === highlightedIndex}
                >
                  <button
                    type="button"
                    // Keep the input focused so onBlur-commit doesn't fire before
                    // the click resolves and turn a half-typed address into a chip.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectSuggestion(c)}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    className={cn(
                      'w-full text-left px-2.5 py-1.5 flex items-center gap-2.5',
                      'transition-colors duration-fast',
                      idx === highlightedIndex ? 'bg-ink-3' : 'hover:bg-ink-3'
                    )}
                  >
                    <RecipientAvatar name={c.name ?? ''} email={c.email} size={30} />
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="text-meta text-ink-fg truncate flex items-center gap-1.5">
                        {highlightMatch(c.name || localPart(c.email), debounced)}
                        {external && (
                          <span
                            title="外部联系人"
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 3,
                              flexShrink: 0,
                              background: 'rgb(var(--c-warn))',
                              boxShadow: '0 0 0 2px rgb(var(--c-warn) / 0.18)'
                            }}
                          />
                        )}
                      </span>
                      <span className="text-micro font-mono text-ink-fg-3 truncate">
                        {highlightMatch(c.email, debounced)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}

            {rawAddVisible && (
              <li
                role="option"
                id={`${listboxId}-rawadd`}
                aria-selected={highlightedIndex === rawOptionIndex}
              >
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickRawAdd()}
                  onMouseEnter={() => setHighlightedIndex(rawOptionIndex)}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 flex items-center gap-2.5',
                    'transition-colors duration-fast',
                    highlightedIndex === rawOptionIndex ? 'bg-ink-3' : 'hover:bg-ink-3'
                  )}
                >
                  <span className="w-[30px] h-[30px] rounded-full bg-ink-4 grid place-items-center text-ink-fg-2 shrink-0">
                    <Plus size={15} />
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-meta text-ink-fg truncate">添加 “{canonicalInput}”</span>
                    <span className="text-micro font-mono text-ink-fg-3 truncate">
                      使用这个邮箱地址
                    </span>
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}

        {detail && values[detail.index] !== undefined && (
          <RecipientDetailPopover
            contact={buildChip(values[detail.index]!)}
            anchorRect={detail.rect}
            onClose={() => setDetail(null)}
            onEdit={() => {
              setEditingIdx(detail.index)
              setChipSel(null)
            }}
            onRemove={() => removeAt(detail.index)}
          />
        )}
      </div>
    </div>
  )
}
