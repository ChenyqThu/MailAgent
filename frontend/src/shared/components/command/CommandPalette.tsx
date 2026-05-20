// Search-module 1:1 mockup-search.html — ⌘K command palette + jump.
//
// Replaces the Sprint 7 D3 / Sprint 9 D4 simplified palette. This rewrite
// brings the visual + interaction model strictly in line with the design
// SSoT at frontend/ref/mockup-search.html: a 720px glass-pop overlay on
// top of a soft-blurred app backdrop, with three result groups (JUMP /
// EMAIL / AI ACTIONS) and continuous keyboard navigation across them.
//
// Surface stack drawn over the live app:
//   .palette-veil (z 40) — inset 36px / 24px so title bar + status bar stay
//                          interactive; backdrop-filter blurs whatever was
//                          behind, dimmed by ink-0/55. Click dismisses.
//   .palette-pane (z 50) — 720px centered glass-pop with input + scrollable
//                          result list + footer (kbd hints + FTS5 stats).
//
// Result groups (always rendered in this order, empties skipped):
//   1. JUMP — top mailboxes (filtered by current query if any) + "open AI
//      panel" + Admin kanban shortcut. Cheap reads, no IPC bombing.
//   2. EMAIL — FTS5 hits, max MAX_EMAIL_HITS. subject + sender lang-pip +
//      priority chip + time, plus snippet (already <mark>-tagged by the
//      backend snippet() call). Subject highlighted client-side via
//      highlightTerms util — backend snippet() only covers body_markdown.
//   3. AI ACTIONS — only when EMAIL has hits. Currently markAllRead +
//      reRunAi are wired; summarize is held with a Soon pill until the
//      AIChatPanel learns batch context.
//
// Keyboard contract:
//   Esc           → close palette
//   ↑ / ↓         → continuous flat index over [jump,email,actions]
//   Tab / Shift+Tab → jump to first row of next / previous non-empty group
//   Enter         → run() the highlighted entry
//   ⌘Enter        → V1 alias of Enter (true "new window" pop-out is a
//                   future detail-window sprint; mockup line 1003 hints
//                   at it via `pal-hint`)
//
// FTS5 + Chinese:
//   - debounced 250ms via useDebouncedValue
//   - normalizeFtsQuery (shared util) appends `*` to trailing CJK token
//     so `产品` matches `本周产品评审` — fixes the pre-rewrite palette bug
//     where this normalisation lived only inside SearchPage.
//
// Persistence:
//   localStorage `mailagent.search.lastQuery` — restored on every open
//   transition (Linear / Raycast pattern, mockup line 1289-1313).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import {
  BarChart3,
  Check,
  Folder,
  History,
  Mail,
  RotateCcw,
  Search as SearchIcon,
  Sparkle,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useMailbox } from '@shared/state/mailbox'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { showAIChatPanel } from '@shared/state/ai-chat-panel'
import { closeCommandPalette, useCommandPalette } from '@shared/state/command-palette'
import { toastError, toastSuccess } from '@shared/state/toast'
import { normalizeFtsQuery } from '@shared/lib/search_query'
import { extractTerms, highlightTerms } from '@shared/lib/highlight_terms'
import { parseSender } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import type { AIPriority, MailboxSummary, SearchHit, SearchResult } from '@shared/api/types'

// ─── Tunables ──────────────────────────────────────────────────────────

const LAST_QUERY_KEY = 'mailagent.search.lastQuery'
const MAX_EMAIL_HITS = 8
const MAX_JUMP_MAILBOXES = 3
const DEBOUNCE_MS = 250
const CJK_RATIO_THRESHOLD = 0.4
const CJK_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/g
// DOMPurify Config uses mutable arrays — keep the literals plain so the
// types match without an `as const` cast (which would mark them readonly).
const SNIPPET_PURIFY: DOMPurifyConfig = { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] }

const PRIORITY_LABEL: Record<AIPriority, string> = {
  critical: 'CRITICAL',
  urgent: 'URGENT',
  important: 'IMPORTANT',
  normal: 'NORMAL',
  low: 'LOW'
}
const PRIORITY_CLASS: Record<AIPriority, string> = {
  critical: 'text-crit bg-crit/15 border-crit/30',
  urgent: 'text-urg bg-urg/15 border-urg/30',
  important: 'text-impt bg-impt/15 border-impt/30',
  normal: 'text-norm bg-norm/15 border-norm/30',
  low: 'text-low bg-low/15 border-low/30'
}

type Group = 'jump' | 'email' | 'actions'

// ─── Tiny helpers ──────────────────────────────────────────────────────

function detectLang(s: string): 'zh' | 'en' {
  if (!s) return 'en'
  const matches = s.match(CJK_RE)
  const ratio = matches ? matches.length / s.length : 0
  return ratio >= CJK_RATIO_THRESHOLD ? 'zh' : 'en'
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const tid = window.setTimeout(() => setV(value), ms)
    return (): void => window.clearTimeout(tid)
  }, [value, ms])
  return v
}

function safeRead(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* privacy mode — drop the persist, in-memory state still works */
  }
}

function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return formatRelativeTime(iso)
  } catch {
    return ''
  }
}

// ─── Small subcomponents ───────────────────────────────────────────────

interface GroupHeaderProps {
  title: string
  countLabel?: string
  subtitle?: string
  aside?: React.ReactNode
}

function GroupHeader({ title, countLabel, subtitle, aside }: GroupHeaderProps): React.ReactElement {
  // Mockup line 750-754 — UPPERCASE mono ASCII titles ("Jump" / "Email" /
  // "AI Actions"). DESIGN.md §14 forbids CJK in mono so the title literal
  // stays English even under zh-CN; right-hand subtitle / aside can be
  // localised because they render at normal-case body weight.
  return (
    <h2 className="text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-2 px-5 py-1.5 flex items-center gap-2">
      <span>{title}</span>
      {countLabel !== undefined && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="text-ink-fg-3 tabular-nums">{countLabel}</span>
        </>
      )}
      {subtitle && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="text-ink-fg-3 normal-case tracking-normal">{subtitle}</span>
        </>
      )}
      {aside && (
        <span className="ml-auto flex items-center gap-1.5 text-ink-fg-3 normal-case tracking-normal">
          {aside}
        </span>
      )}
    </h2>
  )
}

function KbdHint({ keys, label }: { keys: string; label: string }): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
        {keys}
      </kbd>
      <span className="normal-case">{label}</span>
    </span>
  )
}

function FooterDot(): React.ReactElement {
  return <span className="text-ink-fg-3">·</span>
}

// ─── Main component ────────────────────────────────────────────────────

export function CommandPalette(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useCommandPalette((s) => s.open)
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const setActiveEmail = useActiveEmail((s) => s.setActive)
  const setView = useEmailFilter((s) => s.setView)

  // Pick the EmailList view that will surface a hit's mailbox so the
  // row is actually visible after we navigate('/'). '收件箱' / '发件箱'
  // have first-class views; anything else falls back to 'all' which
  // spans every mailbox.
  const viewForMailbox = useCallback((mailbox: string | null | undefined): EmailView => {
    if (mailbox === '收件箱') return 'inbox'
    if (mailbox === '发件箱') return 'outbox'
    return 'all'
  }, [])

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null)
  const [actionRunning, setActionRunning] = useState<string | null>(null)
  // Adjust-on-prop-change pattern (react.dev): reset query + highlight when
  // the palette transitions closed→open. Prefer lastQuery prefill so the
  // user can rebound to whatever they had typed last session.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      const prefill = safeRead(LAST_QUERY_KEY)
      setQuery(prefill)
      setHighlight(0)
      setLastLatencyMs(null)
      setActionRunning(null)
    }
  }

  const inputRef = useRef<HTMLInputElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)
  const { dialogRef, handleTab } = useFocusTrap({ open })

  // Focus input on open transition + persist query on every change.
  useEffect(() => {
    if (!open) return
    const tid = window.setTimeout(() => inputRef.current?.focus(), 0)
    return (): void => window.clearTimeout(tid)
  }, [open])
  useEffect(() => {
    if (!open) return
    safeWrite(LAST_QUERY_KEY, query)
  }, [open, query])

  const debouncedRaw = useDebouncedValue(query, DEBOUNCE_MS)
  const normalised = useMemo(() => normalizeFtsQuery(debouncedRaw), [debouncedRaw])
  const queryTerms = useMemo(() => extractTerms(debouncedRaw), [debouncedRaw])
  const lang = detectLang(query)
  const langLabel = lang === 'zh' ? t('palette.lang.zh') : t('palette.lang.en')

  const mailboxesQ = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    enabled: open
  })
  const mailboxes: MailboxSummary[] = mailboxesQ.data ?? []

  // Single search query covers both "user typed something" and "open the
  // palette to baseline-load total_indexed for the footer". The IPC handler
  // returns empty items + cached COUNT in ~1ms for blank queries.
  const searchQ = useQuery<SearchResult>({
    queryKey: ['palette', 'search', normalised],
    queryFn: async () => {
      const isEmpty = normalised.length === 0
      const t0 = performance.now()
      const r = await mailApi.email.search({
        query: isEmpty ? '' : normalised,
        limit: isEmpty ? 0 : MAX_EMAIL_HITS
      })
      if (!isEmpty) {
        setLastLatencyMs(Math.round(performance.now() - t0))
      }
      return r
    },
    staleTime: 30_000,
    placeholderData: undefined,
    enabled: open
  })

  const hits: SearchHit[] = searchQ.data?.items ?? []
  const totalIndexed = searchQ.data?.total_indexed ?? null
  const isSearching = searchQ.isFetching && normalised.length > 0

  // ──────────────────────────────────────────────────────────────────
  // JUMP items — mailbox-matches + open-AI-panel + admin shortcut
  // ──────────────────────────────────────────────────────────────────

  interface JumpRow {
    id: string
    icon: React.ReactNode
    label: React.ReactNode
    aside?: React.ReactNode
    run(): void
  }

  const jumpItems: JumpRow[] = useMemo(() => {
    const out: JumpRow[] = []
    const q = debouncedRaw.trim()
    const baseList =
      q.length === 0
        ? mailboxes.slice(0, MAX_JUMP_MAILBOXES)
        : mailboxes
            .filter((m) => m.mailbox.toLowerCase().includes(q.toLowerCase()))
            .slice(0, MAX_JUMP_MAILBOXES)

    for (const mb of baseList) {
      const matchedCount = hits.filter((h) => h.mailbox === mb.mailbox).length
      const showMatch = q.length > 0 && matchedCount > 0
      const trailing = showMatch
        ? t('palette.mailbox.matchedSuffix', { query: q, n: matchedCount })
        : t('palette.mailbox.hint', { unread: mb.unread, total: mb.total })
      out.push({
        id: `mailbox:${mb.mailbox}`,
        icon: <Folder size={14} strokeWidth={1.75} />,
        label: (
          <span className="text-body flex-1 truncate">
            <span className="text-ink-fg font-medium">{mb.mailbox}</span>
            <span className="text-ink-fg-3 mx-1">·</span>
            <span className="text-ink-fg-2">{trailing}</span>
          </span>
        ),
        aside:
          mb.unread > 0 ? (
            <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
              {mb.unread} unread
            </span>
          ) : null,
        run: () => {
          closeCommandPalette()
          setActiveMailbox(mb.mailbox)
          void navigate({ to: '/' })
        }
      })
    }

    // Always offer the AI panel jump + admin kanban shortcut as static rows
    // so users can ⌘K → ⏎ to surface them without typing.
    out.push({
      id: 'jump:ai-history',
      icon: <History size={14} strokeWidth={1.75} />,
      label: (
        <span className="text-body flex-1 truncate">
          <span className="text-ink-fg font-medium">{t('palette.jump.aiHistory')}</span>
          <span className="text-ink-fg-3 mx-1">·</span>
          <span className="text-ink-fg-2">{t('palette.jump.aiHistoryMeta')}</span>
        </span>
      ),
      run: () => {
        closeCommandPalette()
        showAIChatPanel()
      }
    })
    out.push({
      id: 'jump:admin',
      icon: <BarChart3 size={14} strokeWidth={1.75} />,
      label: (
        <span className="text-body flex-1 truncate">
          <span className="text-ink-fg font-medium">{t('palette.jump.admin')}</span>
          <span className="text-ink-fg-3 mx-1">·</span>
          <span className="text-ink-fg-2">{t('palette.jump.adminMeta', { n: 0 })}</span>
        </span>
      ),
      run: () => {
        closeCommandPalette()
        void navigate({ to: '/admin/kanban' })
      }
    })
    return out
  }, [debouncedRaw, hits, mailboxes, navigate, setActiveMailbox, t])

  // ──────────────────────────────────────────────────────────────────
  // AI ACTIONS — wired markAllRead + reRunAi; summarize disabled with Soon
  // ──────────────────────────────────────────────────────────────────

  interface ActionRow {
    id: string
    icon: React.ReactNode
    label: string
    meta: string
    iconTone: 'ok' | 'info' | 'coral'
    disabled?: boolean
    soon?: boolean
    run(): Promise<void>
  }

  const actionItems: ActionRow[] = useMemo(() => {
    if (hits.length === 0) return []
    const ids = hits.map((h) => h.internal_id)
    return [
      {
        id: 'action:markAllRead',
        iconTone: 'ok',
        icon: <Check size={14} strokeWidth={1.75} />,
        label: t('palette.actions.markAllRead'),
        meta: t('palette.actions.markAllReadMeta', { n: hits.length }),
        async run() {
          setActionRunning('action:markAllRead')
          try {
            await mailApi.email.flag(null, {
              ids,
              isRead: true,
              allowConcurrent: true
            })
            toastSuccess(t('palette.actions.doneToast', { n: hits.length }))
            await queryClient.invalidateQueries({ queryKey: ['emails'] })
            closeCommandPalette()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toastError(t('palette.actions.errToast'), msg)
          } finally {
            setActionRunning(null)
          }
        }
      },
      {
        id: 'action:reRunAi',
        iconTone: 'info',
        icon: <RotateCcw size={14} strokeWidth={1.75} />,
        label: t('palette.actions.reRunAi'),
        meta: t('palette.actions.reRunAiMeta', { n: hits.length }),
        async run() {
          setActionRunning('action:reRunAi')
          try {
            const settled = await Promise.allSettled(
              hits.map((h) => mailApi.llm.run(h.internal_id, { force: true }))
            )
            const ok = settled.filter((r) => r.status === 'fulfilled').length
            if (ok < hits.length) {
              const firstErr = settled.find((r) => r.status === 'rejected') as
                | PromiseRejectedResult
                | undefined
              const msg = firstErr ? String(firstErr.reason) : ''
              toastError(t('palette.actions.errToast'), `${ok}/${hits.length} · ${msg}`)
            } else {
              toastSuccess(t('palette.actions.doneToast', { n: ok }))
            }
            await queryClient.invalidateQueries({ queryKey: ['emails'] })
            closeCommandPalette()
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toastError(t('palette.actions.errToast'), msg)
          } finally {
            setActionRunning(null)
          }
        }
      },
      {
        id: 'action:summarize',
        iconTone: 'coral',
        icon: <Sparkle size={14} strokeWidth={1.75} />,
        label: t('palette.actions.summarize'),
        meta: t('palette.actions.summarizeMeta', { n: hits.length }),
        disabled: true,
        soon: true,
        async run() {
          /* disabled — wired in a future sprint when AIChatPanel accepts batch context */
        }
      }
    ]
  }, [hits, mailApi, queryClient, t])

  // ──────────────────────────────────────────────────────────────────
  // Flat index for ↑↓ + Tab keyboard navigation
  // ──────────────────────────────────────────────────────────────────

  interface FlatEntry {
    group: Group
    indexInGroup: number
    disabled?: boolean
    run(): void | Promise<void>
  }

  const flat: FlatEntry[] = useMemo(() => {
    const out: FlatEntry[] = []
    jumpItems.forEach((j, i) => out.push({ group: 'jump', indexInGroup: i, run: j.run }))
    hits.forEach((h, i) =>
      out.push({
        group: 'email',
        indexInGroup: i,
        run: () => {
          // Search hit may live in a mailbox the user isn't currently
          // viewing. Sync view + mailbox so EmailList actually scrolls
          // to + highlights the row instead of silently jumping the
          // EmailDetail pane while the list shows nothing selected.
          const targetView = viewForMailbox(h.mailbox)
          closeCommandPalette()
          setView(targetView)
          if (h.mailbox) setActiveMailbox(h.mailbox)
          setActiveEmail(h.internal_id)
          void navigate({ to: '/', search: { view: targetView } })
        }
      })
    )
    actionItems.forEach((a, i) =>
      out.push({
        group: 'actions',
        indexInGroup: i,
        disabled: a.disabled,
        run: () => a.run()
      })
    )
    return out
  }, [jumpItems, hits, actionItems, navigate, setActiveEmail])

  // Clamp highlight in render (no extra paint cycle).
  if (flat.length > 0 && highlight >= flat.length) {
    setHighlight(Math.max(0, flat.length - 1))
  } else if (flat.length === 0 && highlight !== 0) {
    setHighlight(0)
  }

  // ──────────────────────────────────────────────────────────────────
  // Keyboard handler
  // ──────────────────────────────────────────────────────────────────

  const jumpToGroupBoundary = useCallback(
    (forward: boolean) => {
      if (flat.length === 0) return
      const order: Group[] = ['jump', 'email', 'actions']
      const present = order.filter((g) => flat.some((f) => f.group === g))
      if (present.length <= 1) return
      const curGroup = flat[highlight]?.group ?? present[0]
      const idx = present.indexOf(curGroup)
      const nextGroup = forward
        ? present[(idx + 1) % present.length]
        : present[(idx - 1 + present.length) % present.length]
      const target = flat.findIndex((f) => f.group === nextGroup)
      if (target >= 0) setHighlight(target)
    },
    [flat, highlight]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCommandPalette()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (flat.length === 0) return
        setHighlight((h) => (h + 1) % flat.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (flat.length === 0) return
        setHighlight((h) => (h - 1 + flat.length) % flat.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const entry = flat[highlight]
        if (entry && !entry.disabled) void entry.run()
        return
      }
      if (e.key === 'Tab') {
        if (flat.length === 0) {
          handleTab(e)
          return
        }
        e.preventDefault()
        jumpToGroupBoundary(!e.shiftKey)
      }
    },
    [flat, handleTab, highlight, jumpToGroupBoundary]
  )

  // Scroll highlighted option into view (keyboard nav past viewport).
  useEffect(() => {
    if (!open) return
    const root = dialogRef.current
    if (!root) return
    const opt = root.querySelector<HTMLElement>(`[data-flat-idx="${highlight}"]`)
    opt?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight, dialogRef])

  if (!open) return null

  const hasHits = hits.length > 0
  const hasQuery = normalised.length > 0
  const countLabel =
    totalIndexed === null
      ? `${hits.length}`
      : t('palette.email.countLabel', { n: hits.length, total: totalIndexed })

  // Pre-compute flat index offsets for each group so renderer can stamp
  // data-flat-idx without recomputing during the map.
  let cursor = 0
  const jumpStartIdx = cursor
  cursor += jumpItems.length
  const emailStartIdx = cursor
  cursor += hits.length
  const actionStartIdx = cursor

  return createPortal(
    <>
      {/* ─ Veil — soft dim + blur of the app behind. Click dismisses. ─ */}
      <div
        ref={veilRef}
        className="palette-veil"
        role="presentation"
        onClick={closeCommandPalette}
      />

      {/* ─ Pane — the actual palette dialog. ─ */}
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.aria.label')}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="palette-pane glass-pop"
      >
        {/* Input row */}
        <div className="px-4 h-12 flex items-center gap-3 border-b border-ink-border-soft shrink-0">
          <SearchIcon size={15} strokeWidth={2} className="text-ink-fg-2 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-controls="palette-listbox"
            aria-expanded={true}
            aria-activedescendant={flat.length > 0 ? `palette-opt-${highlight}` : undefined}
            className="palette-input flex-1"
          />
          <span
            className="lang-pip shrink-0"
            title={t('palette.lang.detected')}
            aria-label={t('palette.lang.detected')}
          >
            {langLabel}
          </span>
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              title="Clear"
              aria-label="Clear search"
              className="text-ink-fg-2 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Result body */}
        <ul
          id="palette-listbox"
          role="listbox"
          aria-label={t('palette.aria.list')}
          className="flex-1 overflow-y-auto scrollbar-thin py-2"
        >
          {/* JUMP group */}
          {jumpItems.length > 0 && (
            <>
              <GroupHeader title="Jump" countLabel={String(jumpItems.length)} />
              <div className="px-3 space-y-px">
                {jumpItems.map((j, i) => {
                  const idx = jumpStartIdx + i
                  const selected = idx === highlight
                  return (
                    <li
                      key={j.id}
                      role="option"
                      id={`palette-opt-${idx}`}
                      data-flat-idx={idx}
                      aria-selected={selected}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={j.run}
                      className={cn('pal-row', selected && 'is-selected')}
                    >
                      <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
                        {j.icon}
                      </span>
                      {j.label}
                      {j.aside && <span className="shrink-0 mr-2">{j.aside}</span>}
                      <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
                        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
                          ⏎
                        </kbd>
                        <span>{t('palette.kbd.open')}</span>
                      </span>
                    </li>
                  )
                })}
              </div>
            </>
          )}

          {/* EMAIL group — rendered whenever the user typed something so
              the empty-tile has a home. Aside shows live latency + FTS5
              health dot. */}
          {hasQuery && (
            <>
              <GroupHeader
                title="Email"
                countLabel={countLabel}
                aside={
                  <>
                    <span className="w-1 h-1 rounded-full bg-ok" aria-hidden />
                    <span>{t('palette.footer.fts5Healthy')}</span>
                    {lastLatencyMs !== null && (
                      <>
                        <FooterDot />
                        <span className="tabular-nums">{lastLatencyMs}ms</span>
                      </>
                    )}
                  </>
                }
              />
              {hasHits ? (
                <div className="px-3 space-y-px">
                  {hits.map((h, i) => {
                    const idx = emailStartIdx + i
                    const selected = idx === highlight
                    return (
                      <EmailHitRow
                        key={h.internal_id}
                        hit={h}
                        flatIdx={idx}
                        selected={selected}
                        setHighlight={setHighlight}
                        queryTerms={queryTerms}
                        onActivate={() => {
                          const targetView = viewForMailbox(h.mailbox)
                          closeCommandPalette()
                          setView(targetView)
                          if (h.mailbox) setActiveMailbox(h.mailbox)
                          setActiveEmail(h.internal_id)
                          void navigate({ to: '/', search: { view: targetView } })
                        }}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="px-5">
                  <div className="empty-tile">
                    <SearchIcon
                      size={18}
                      strokeWidth={1.75}
                      className="text-ink-fg-3"
                      aria-hidden
                    />
                    <div className="text-aux text-ink-fg-1">
                      {isSearching ? t('palette.searching') : t('palette.email.emptyTitle')}
                    </div>
                    {!isSearching && (
                      <div className="text-meta text-ink-fg-3">{t('palette.email.emptyHint')}</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* AI ACTIONS group */}
          {actionItems.length > 0 && (
            <>
              <GroupHeader
                title="AI Actions"
                subtitle={t('palette.actions.subtitle', { n: hits.length })}
                aside={
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden />
                    <span>{t('palette.actions.aside')}</span>
                  </>
                }
              />
              <div className="px-3 space-y-px pb-1">
                {actionItems.map((a, i) => {
                  const idx = actionStartIdx + i
                  const selected = idx === highlight
                  const isRunning = actionRunning === a.id
                  const disabled = a.disabled || isRunning
                  return (
                    <li
                      key={a.id}
                      role="option"
                      id={`palette-opt-${idx}`}
                      data-flat-idx={idx}
                      aria-selected={selected}
                      aria-disabled={disabled || undefined}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={disabled ? undefined : () => void a.run()}
                      className={cn('pal-row', selected && 'is-selected')}
                    >
                      <span
                        className={cn(
                          'w-5 h-5 grid place-items-center shrink-0',
                          a.iconTone === 'ok' && 'text-ok',
                          a.iconTone === 'info' && 'text-info',
                          a.iconTone === 'coral' && 'text-coral'
                        )}
                      >
                        {a.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-body text-ink-fg flex items-center gap-2">
                          <span className="truncate">{a.label}</span>
                          {a.soon && (
                            <span className="text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded text-ink-fg-2 bg-ink-fg/[0.06] border border-ink-border-soft shrink-0">
                              {t('palette.actions.soon')}
                            </span>
                          )}
                          {isRunning && (
                            <span className="text-meta font-mono text-ink-fg-3 animate-pulse">
                              {t('palette.actions.running')}
                            </span>
                          )}
                        </div>
                        <div className="text-meta text-ink-fg-2 truncate mt-0.5">{a.meta}</div>
                      </div>
                      <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
                        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
                          ⏎
                        </kbd>
                        <span>{t('palette.kbd.run')}</span>
                      </span>
                    </li>
                  )
                })}
              </div>
            </>
          )}
        </ul>

        {/* Footer — kbd hints + FTS5 stats. Mockup line 985-1020. */}
        <footer className="px-3 h-8 border-t border-ink-border-soft flex items-center gap-3 text-micro font-mono text-ink-fg-2 shrink-0">
          <KbdHint keys="↑↓" label={t('palette.kbd.navigate')} />
          <FooterDot />
          <KbdHint keys="⇥" label={t('palette.kbd.selectGroup')} />
          <FooterDot />
          <KbdHint keys="⏎" label={t('palette.kbd.open')} />
          <FooterDot />
          <KbdHint keys="⌘⏎" label={t('palette.kbd.newWindow')} />
          <FooterDot />
          <KbdHint keys="esc" label={t('palette.kbd.dismiss')} />

          <span className="ml-auto flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-ok" aria-hidden />
            <span>{t('palette.footer.fts5Healthy')}</span>
            {lastLatencyMs !== null && (
              <>
                <FooterDot />
                <span className="tabular-nums">{lastLatencyMs}ms</span>
              </>
            )}
            {totalIndexed !== null && (
              <>
                <FooterDot />
                <span className="tabular-nums">
                  {t('palette.email.countLabel', { n: hits.length, total: totalIndexed })}
                </span>
              </>
            )}
          </span>
        </footer>
      </section>
    </>,
    document.body
  )
}

// ─── EmailHitRow — extracted because the JSX is dense + heavy ────────

interface EmailHitRowProps {
  hit: SearchHit
  flatIdx: number
  selected: boolean
  setHighlight(idx: number): void
  queryTerms: ReadonlyArray<string>
  onActivate(): void
}

function EmailHitRow({
  hit,
  flatIdx,
  selected,
  setHighlight,
  queryTerms,
  onActivate
}: EmailHitRowProps): React.ReactElement {
  const { t } = useTranslation()
  const parsed = parseSender(hit.sender)
  const senderName = parsed.name || parsed.email.split('@')[0] || hit.sender
  const senderAddr = parsed.email
  const time = shortTime(hit.date_received)

  // Subject + snippet — both wrapped via DOMPurify before injecting because
  // user content reaches the DOM. highlightTerms entity-encodes everything
  // else; backend snippet() inserts literal <mark> only.
  const subjectHtml = useMemo(
    () => DOMPurify.sanitize(highlightTerms(hit.subject, queryTerms), SNIPPET_PURIFY),
    [hit.subject, queryTerms]
  )
  const snippetHtml = useMemo(
    () => (hit.snippet ? DOMPurify.sanitize(hit.snippet, SNIPPET_PURIFY) : ''),
    [hit.snippet]
  )

  return (
    <li
      role="option"
      id={`palette-opt-${flatIdx}`}
      data-flat-idx={flatIdx}
      aria-selected={selected}
      onMouseEnter={() => setHighlight(flatIdx)}
      onClick={onActivate}
      className={cn('pal-row', selected && 'is-selected')}
    >
      <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
        <Mail size={14} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-aux text-ink-fg font-medium truncate">
            {senderName}
            {senderAddr && (
              <>
                <span className="text-ink-fg-3"> · </span>
                <span className="text-ink-fg-2">{senderAddr}</span>
              </>
            )}
          </span>
          {hit.lang === 'en' && (
            <span className="lang-pip shrink-0" aria-label="English">
              EN
            </span>
          )}
          {hit.ai_priority && (
            <span
              className={cn(
                'text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0',
                PRIORITY_CLASS[hit.ai_priority]
              )}
            >
              {PRIORITY_LABEL[hit.ai_priority]}
            </span>
          )}
          {time && (
            <span className="text-meta font-mono text-ink-fg-2 shrink-0 tabular-nums">{time}</span>
          )}
        </div>
        <div
          className="text-body text-ink-fg mt-0.5 truncate [&_mark]:bg-coral/25 [&_mark]:text-ink-fg [&_mark]:rounded [&_mark]:px-0.5"
          dangerouslySetInnerHTML={{
            __html: subjectHtml || hit.subject || t('palette.email.untitled')
          }}
        />
        {snippetHtml && (
          <div
            className="text-meta text-ink-fg-2 mt-1 line-clamp-2 [&_mark]:bg-coral/15 [&_mark]:text-ink-fg-1 [&_mark]:rounded [&_mark]:px-0.5"
            dangerouslySetInnerHTML={{ __html: snippetHtml }}
          />
        )}
      </div>
      <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
          ⏎
        </kbd>
        <span>{t('palette.kbd.open')}</span>
        <span className="text-ink-fg-3">·</span>
        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
          ⌘⏎
        </kbd>
        <span>{t('palette.kbd.newWindow')}</span>
      </span>
    </li>
  )
}
