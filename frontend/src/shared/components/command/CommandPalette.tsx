// Sprint 7 D3 — ⌘K Command Palette.
//
// Surfaces three command categories at once:
//   1. Navigation — /inbox · /search · /admin · /llm · /calendar · /settings
//   2. Mailbox switch — every mailbox from the live `email:listMailboxes` IPC
//   3. Email search — first 8 hits from the live FTS5 search (debounced
//      250ms) when the input has 2+ chars
//
// Karpathy simplicity: no `cmdk` dep. Substring filtering is enough for
// our command count (~10 items); FTS5 search is already debounced server-
// side via tanstack-query staleTime. Total surface < 350 LoC.
//
// Keyboard:
//   Esc                   → close
//   ↑ / ↓                 → move highlight (+ scroll into view)
//   Enter                 → execute highlighted
//   Tab / Shift+Tab       → cycle focus inside the palette
//                           (querySelectorAll focus-trap, same pattern as
//                            KeyboardHelpModal + ResyncConfirmDialog)
//
// A11y: input has role=combobox + aria-haspopup=listbox + aria-controls +
// aria-activedescendant pointing to the highlighted option id. Each option
// row carries role=option + aria-selected + an id of `palette-opt-<idx>`
// so VoiceOver / NVDA actually announces the highlighted command.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Cog,
  Inbox,
  Mail,
  Search as SearchIcon,
  Sparkles
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useMailbox } from '@shared/state/mailbox'
import { useActiveEmail } from '@shared/state/active-email'
import { closeCommandPalette, useCommandPalette } from '@shared/state/command-palette'

type CommandKind = 'nav' | 'mailbox' | 'search'

interface Command {
  id: string
  kind: CommandKind
  /** Display label. */
  label: string
  /** Optional secondary line (route path, snippet, etc). */
  hint?: string
  icon: React.ReactNode
  run: () => void
}

interface NavSpec {
  id: string
  labelKey: string
  to: '/' | '/search' | '/admin/llm' | '/admin/kanban' | '/admin/calendar' | '/settings'
  icon: React.ReactNode
}

// Sprint 11 V1.4 — route reorg: `/admin/{llm,kanban,calendar}` replaced the
// flat `/admin /llm /calendar`. palette.nav.admin still labels the dead-letter
// dashboard; its target is now /admin/kanban.
const NAV_COMMANDS: ReadonlyArray<NavSpec> = [
  {
    id: 'inbox',
    labelKey: 'palette.nav.inbox',
    to: '/',
    icon: <Inbox size={14} strokeWidth={1.75} />
  },
  {
    id: 'search',
    labelKey: 'palette.nav.search',
    to: '/search',
    icon: <SearchIcon size={14} strokeWidth={1.75} />
  },
  {
    id: 'admin',
    labelKey: 'palette.nav.admin',
    to: '/admin/kanban',
    icon: <BarChart3 size={14} strokeWidth={1.75} />
  },
  {
    id: 'llm',
    labelKey: 'palette.nav.llm',
    to: '/admin/llm',
    icon: <Sparkles size={14} strokeWidth={1.75} />
  },
  {
    id: 'calendar',
    labelKey: 'palette.nav.calendar',
    to: '/admin/calendar',
    icon: <CalendarDays size={14} strokeWidth={1.75} />
  },
  {
    id: 'settings',
    labelKey: 'palette.nav.settings',
    to: '/settings',
    icon: <Cog size={14} strokeWidth={1.75} />
  }
]

function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return (): void => clearTimeout(t)
  }, [value, ms])
  return v
}

function substringMatch(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

// Sprint 10 visual review H-1 — FTS5 `snippet()` wraps hits in literal
// `<mark>...</mark>` tags so SearchPage can DOMPurify them into a coral
// highlight. Palette renders the hint as plain text, so without this strip
// users see literal "<mark>meeting</mark>" inside the row. Strip the tag
// pair but keep the highlighted substring untouched.
function stripMarkTags(input: string | null | undefined): string {
  if (!input) return ''
  return input.replace(/<\/?mark>/gi, '')
}

export function CommandPalette(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useCommandPalette((s) => s.open)
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const setActiveMailbox = useMailbox((s) => s.setActive)

  const setActiveEmail = useActiveEmail((s) => s.setActive)

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  // Track previous open state to reset query/highlight inside render on
  // open transitions (react.dev "Adjusting state on prop change") — keeps
  // the renderer from doing a flash of stale data and avoids the
  // `react-hooks/set-state-in-effect` lint that a useEffect+setState would
  // trigger.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setQuery('')
      setHighlight(0)
    }
  }
  const debouncedQuery = useDebouncedValue(query, 250)
  const inputRef = useRef<HTMLInputElement>(null)
  // Sprint 9 D4.1 — shared focus-trap hook. Replaces the inline
  // querySelectorAll Tab cycle that previously lived in onKeyDown.
  const { dialogRef, handleTab } = useFocusTrap({ open })

  // Focus the input on every open transition. The reset lives in the
  // adjust-on-prop-change block above; this effect's only job is the
  // imperative DOM call (allowed inside an effect — it's the documented
  // pattern for synchronizing with external systems like the focus model).
  // The outer dialog div carries tabIndex={-1} so if focus somehow exits
  // the palette (e.g. a Tab through a future cmdk-style tool row), the
  // backdrop is still a valid keydown target.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return (): void => window.clearTimeout(id)
  }, [open])

  // Mailboxes — cheap (cached in the same query the Sidebar uses).
  const mailboxesQ = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    enabled: open
  })
  // FTS5 search results — only when 2+ chars typed.
  // Sprint 9 D4.2 (Sprint 7 review LOW #3) — explicit `placeholderData:
  // undefined` so a stale snippet from the previous query doesn't render
  // under the new query string while react-query refetches. tanstack v5's
  // default is already `undefined` (no carry-over), but setting it
  // explicitly documents intent and protects against a future default
  // flip to `keepPreviousData` style behaviour.
  const searchQ = useQuery({
    queryKey: ['palette', 'search', debouncedQuery],
    queryFn: () =>
      mailApi.email.search({
        query: debouncedQuery.trim(),
        limit: 8
      }),
    staleTime: 30_000,
    placeholderData: undefined,
    enabled: open && debouncedQuery.trim().length >= 2
  })

  // Build the flat command list (filtered by `query`).
  const commands: Command[] = useMemo(() => {
    const out: Command[] = []

    for (const nav of NAV_COMMANDS) {
      const label = t(nav.labelKey)
      if (!substringMatch(label, query)) continue
      out.push({
        id: `nav:${nav.id}`,
        kind: 'nav',
        label,
        hint: nav.to,
        icon: nav.icon,
        run: () => {
          closeCommandPalette()
          void navigate({ to: nav.to })
        }
      })
    }

    for (const mb of mailboxesQ.data ?? []) {
      const label = t('palette.mailbox.go', { name: mb.mailbox })
      if (!substringMatch(label, query) && !substringMatch(mb.mailbox, query)) continue
      out.push({
        id: `mailbox:${mb.mailbox}`,
        kind: 'mailbox',
        label,
        hint: t('palette.mailbox.hint', { unread: mb.unread, total: mb.total }),
        icon: <Mail size={14} strokeWidth={1.75} />,
        run: () => {
          closeCommandPalette()
          setActiveMailbox(mb.mailbox)
          void navigate({ to: '/' })
        }
      })
    }

    for (const hit of searchQ.data ?? []) {
      out.push({
        id: `search:${hit.internal_id}`,
        kind: 'search',
        label: hit.subject ?? t('palette.search.untitled'),
        hint: stripMarkTags(hit.snippet) || hit.sender || '',
        icon: <SearchIcon size={14} strokeWidth={1.75} className="text-coral" />,
        // Sprint 8 §2.2 (Sprint 7 ship-review MEDIUM #3) — Enter on a search
        // hit now selects the email and navigates to /inbox so the
        // EmailDetail pane lands on the right row. The previous "back to
        // /search" path forced the user to re-type their query and click
        // the result a second time, which broke the only useful path
        // through the palette.
        run: () => {
          closeCommandPalette()
          setActiveEmail(hit.internal_id)
          void navigate({ to: '/' })
        }
      })
    }

    return out
  }, [t, query, mailboxesQ.data, searchQ.data, navigate, setActiveMailbox, setActiveEmail])

  // Clamp highlight inside render — same "Adjusting state on prop change"
  // pattern. Reading `commands.length` directly during render keeps the
  // displayed highlight consistent with the (just-derived) list size, with
  // no extra frame where a stale index points past the end.
  if (commands.length > 0 && highlight >= commands.length) {
    setHighlight(Math.max(0, commands.length - 1))
  } else if (commands.length === 0 && highlight !== 0) {
    setHighlight(0)
  }

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCommandPalette()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (commands.length === 0 ? 0 : (h + 1) % commands.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) =>
          commands.length === 0 ? 0 : (h - 1 + commands.length) % commands.length
        )
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = commands[highlight]
        if (cmd) cmd.run()
        return
      }
      // Sprint 9 D4.1 — Tab cycle delegated to useFocusTrap. Behaviour
      // (forward + reverse wrap with `!root.contains(active)` guard)
      // unchanged.
      if (e.key === 'Tab') {
        handleTab(e)
      }
    },
    [commands, highlight, handleTab]
  )

  // Sprint 7 review (opus MEDIUM) — scroll the highlighted option into view
  // so ArrowDown past the visible viewport doesn't strand the user. Uses
  // `block: 'nearest'` so the input + already-visible rows don't jitter.
  useEffect(() => {
    if (!open) return
    const root = dialogRef.current
    if (!root) return
    const opt = root.querySelector<HTMLElement>(`#palette-opt-${highlight}`)
    opt?.scrollIntoView({ block: 'nearest' })
    // `dialogRef` is a stable ref object from useFocusTrap (its identity
    // never changes across renders), so including it in deps is a no-op
    // at runtime while satisfying the exhaustive-deps rule.
  }, [open, highlight, dialogRef])

  if (!open) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('palette.aria.label')}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh] focus:outline-none"
      onClick={closeCommandPalette}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-[560px] max-h-[60vh] rounded-lg bg-ink-2 border border-ink-border',
          'shadow-[0_8px_24px_rgba(0,0,0,0.35)] flex flex-col overflow-hidden'
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ink-border-soft">
          <SearchIcon size={14} strokeWidth={1.75} className="text-ink-fg-2" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={true}
            aria-controls="palette-listbox"
            aria-activedescendant={commands.length > 0 ? `palette-opt-${highlight}` : undefined}
            className={cn(
              'flex-1 bg-transparent text-body text-ink-fg placeholder:text-ink-fg-3',
              'focus:outline-none'
            )}
          />
          <kbd className="text-meta font-mono text-ink-fg-3 px-1.5 py-0.5 rounded border border-ink-border">
            Esc
          </kbd>
        </div>
        <ul
          id="palette-listbox"
          role="listbox"
          aria-label={t('palette.aria.list')}
          className="flex-1 overflow-y-auto scrollbar-thin"
        >
          {commands.length === 0 && (
            <li className="px-3 py-6 text-aux text-ink-fg-2 text-center">
              {searchQ.isFetching && debouncedQuery.length >= 2
                ? t('palette.searching')
                : t('palette.noResults')}
            </li>
          )}
          {commands.map((cmd, idx) => (
            <li
              key={cmd.id}
              id={`palette-opt-${idx}`}
              role="option"
              aria-selected={idx === highlight}
              onMouseEnter={() => setHighlight(idx)}
              onClick={cmd.run}
              className={cn(
                'flex items-center gap-2 px-3 py-2 cursor-pointer',
                'transition-colors duration-fast',
                idx === highlight ? 'bg-coral/15' : 'hover:bg-ink-3'
              )}
            >
              <span className="shrink-0 grid place-items-center w-[18px] h-[18px] text-ink-fg-2">
                {cmd.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-aux text-ink-fg truncate">{cmd.label}</div>
                {cmd.hint && <div className="text-meta text-ink-fg-3 truncate">{cmd.hint}</div>}
              </div>
              <ArrowRight size={12} strokeWidth={2} className="text-ink-fg-3 shrink-0" />
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  )
}
