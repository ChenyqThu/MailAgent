// Compose recipient chip field (To / Cc / Bcc).
//
// Reuses the existing composer CSS tokens authored for the folder DraftEditor
// (`.folder-field-row` + `.recipient-chip` + `.rc-av` + `.rc-close`, see
// index.css §Composer). Enter / comma commits a chip; Backspace on an empty
// input deletes the last chip; × removes one. The owner's own address is
// filtered out so a reply-all chip set doesn't loop the mail back to the user.
//
// Outlook-style autocomplete: typing ≥1 char surfaces a dropdown of contacts
// aggregated from local mail history (email:contactSuggest). ↑/↓ moves the
// highlight, Tab / Enter / click fills the highlighted contact as a chip, Esc
// dismisses. Dropdown options use onMouseDown-preventDefault so picking one
// doesn't trigger the input's onBlur-commit (which would otherwise turn a
// half-typed address into a chip before the click lands).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import type { ContactSuggestion } from '@shared/api/types'

interface Props {
  label: string
  values: string[]
  placeholder: string
  onChange: (next: string[]) => void
  /** Owner email — filtered out of additions (case-insensitive). */
  selfEmail?: string | null
}

// 130ms — snappier than the palette's 250ms search debounce so completion
// feels keystroke-tight, still coarse enough to skip a query per keypress.
const SUGGEST_DEBOUNCE_MS = 130
const SUGGEST_LIMIT = 8

function chipInitials(addr: string): string {
  const at = addr.split('@')[0] ?? addr
  return (at.slice(0, 2) || '?').toUpperCase()
}

function localPart(addr: string): string {
  return addr.split('@')[0] || addr
}

/** "a@x, b@y; c@z" → ['a@x', 'b@y', 'c@z']. */
function splitTokens(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
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

export function RecipientField({
  label,
  values,
  placeholder,
  onChange,
  selfEmail
}: Props): React.ReactElement {
  const mailApi = useMailApi()
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [focused, setFocused] = useState(false)
  // Esc dismisses the dropdown without clearing the input; reset on next edit.
  const [dismissed, setDismissed] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const normalizedSelf = (selfEmail ?? '').trim().toLowerCase()

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(input.trim()), SUGGEST_DEBOUNCE_MS)
    return (): void => window.clearTimeout(id)
  }, [input])

  // Exclude self + already-picked chips so the dropdown never re-suggests them.
  const exclude = useMemo(
    () => [normalizedSelf, ...values.map((v) => v.toLowerCase())].filter(Boolean),
    [normalizedSelf, values]
  )

  // React Query owns the fetch (debounce feeds `debounced`); gated on focus so
  // the dropdown only queries while the user is actively in the field. Stale
  // responses dedupe by queryKey, so no manual cancel flag is needed.
  const suggestQ = useQuery<ContactSuggestion[]>({
    queryKey: ['contactSuggest', debounced, exclude],
    queryFn: () => mailApi.email.contactSuggest(debounced, SUGGEST_LIMIT, exclude),
    enabled: focused && debounced.length >= 1,
    staleTime: 30_000
  })
  // useMemo so the `?? []` fallback keeps a stable identity across renders —
  // otherwise handleKey's useCallback deps churn every render.
  const suggestions = useMemo(() => suggestQ.data ?? [], [suggestQ.data])

  const dropdownOpen = focused && !dismissed && debounced.length >= 1 && suggestions.length > 0

  // Clamp highlight when the list shrinks under us (react.dev "adjust state on
  // prop change" — render-time setState, same pattern as MentionPopover).
  const maxIndex = Math.max(0, suggestions.length - 1)
  if (highlightedIndex > maxIndex) {
    setHighlightedIndex(maxIndex)
  }

  const addTokens = useCallback(
    (tokens: string[]) => {
      if (tokens.length === 0) return
      const seen = new Set(values.map((v) => v.toLowerCase()))
      const next = [...values]
      for (const tok of tokens) {
        const lower = tok.toLowerCase()
        if (seen.has(lower)) continue
        if (normalizedSelf && lower === normalizedSelf) continue
        seen.add(lower)
        next.push(tok)
      }
      if (next.length !== values.length) onChange(next)
    },
    [values, onChange, normalizedSelf]
  )

  const commit = useCallback(() => {
    const tokens = splitTokens(input)
    addTokens(tokens)
    setInput('')
  }, [input, addTokens])

  const selectSuggestion = useCallback(
    (c: ContactSuggestion) => {
      addTokens([c.email])
      setInput('')
      setDebounced('')
      setHighlightedIndex(0)
      inputRef.current?.focus()
    },
    [addTokens]
  )

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (dropdownOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setHighlightedIndex((cur) => Math.min(cur + 1, suggestions.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setHighlightedIndex((cur) => Math.max(cur - 1, 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          const c = suggestions[highlightedIndex]
          if (c) {
            // Tab on an open dropdown fills the contact instead of leaving the
            // field; Enter does the same. preventDefault stops focus-jump /
            // newline so the chip lands and the cursor stays put.
            e.preventDefault()
            selectSuggestion(c)
            return
          }
        }
        if (e.key === 'Escape') {
          // ComposePanel listens for Escape on `window` to close the whole
          // panel. React's stopPropagation doesn't reach native window
          // listeners, so stop the native event here — but only while the
          // dropdown is open, so a closed dropdown still lets Escape close
          // compose as usual.
          e.preventDefault()
          e.nativeEvent.stopImmediatePropagation()
          setDismissed(true)
          return
        }
      }
      // Dropdown closed (or key not consumed) → original chip behaviour.
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Backspace' && input === '' && values.length > 0) {
        onChange(values.slice(0, -1))
      }
    },
    [dropdownOpen, suggestions, highlightedIndex, selectSuggestion, commit, input, values, onChange]
  )

  const removeAt = useCallback(
    (idx: number) => onChange(values.filter((_, i) => i !== idx)),
    [values, onChange]
  )

  const listboxId = `recipient-suggest-${label}`

  return (
    <div className="folder-field-row">
      <span className="field-label">{label}</span>
      <div className="relative flex items-center gap-1.5 flex-wrap min-w-0">
        {values.map((addr, i) => (
          <span key={`${addr}-${i}`} className="recipient-chip">
            <span className="rc-av">{chipInitials(addr)}</span>
            <span className="break-all">{addr}</span>
            <button
              type="button"
              className="rc-close"
              aria-label={`remove ${addr}`}
              onClick={() => removeAt(i)}
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(e) => {
            setInput(e.target.value)
            setDismissed(false)
          }}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commit()
          }}
          aria-label={label}
          role="combobox"
          aria-expanded={dropdownOpen}
          aria-controls={dropdownOpen ? listboxId : undefined}
          aria-activedescendant={
            dropdownOpen && suggestions[highlightedIndex]
              ? `${listboxId}-${suggestions[highlightedIndex].email}`
              : undefined
          }
          autoComplete="off"
        />
        {dropdownOpen && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            className={cn(
              'absolute top-full left-0 mt-1 z-50 w-[280px] max-w-full',
              'rounded-lg border border-ink-border bg-ink-2 shadow-md',
              'max-h-[240px] overflow-y-auto py-1'
            )}
          >
            {suggestions.map((c, idx) => (
              <li
                key={c.email}
                role="option"
                id={`${listboxId}-${c.email}`}
                aria-selected={idx === highlightedIndex}
              >
                <button
                  type="button"
                  // Keep input focused so onBlur-commit doesn't fire before the
                  // click resolves and turn a half-typed address into a chip.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectSuggestion(c)}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 flex items-center gap-2',
                    'transition-colors duration-fast',
                    idx === highlightedIndex ? 'bg-ink-3' : 'hover:bg-ink-3'
                  )}
                >
                  <span className="w-6 h-6 rounded-full bg-ink-3 grid place-items-center text-micro font-medium text-ink-fg-2 shrink-0">
                    {chipInitials(c.email)}
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-meta text-ink-fg truncate">
                      {highlightMatch(c.name || localPart(c.email), debounced)}
                    </span>
                    <span className="text-micro font-mono text-ink-fg-3 truncate">
                      {highlightMatch(c.email, debounced)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
