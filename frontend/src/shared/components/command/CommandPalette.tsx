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
//   - raw query passed to backend smart mode (T3); CJK transform unified
//     server-side so the palette and CLI/API share one search path.
//
// Open behaviour:
//   Each closed→open transition starts from an empty query — the palette is
//   a fresh search every time (no last-session prefill).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  BarChart3,
  Check,
  Folder,
  History,
  Loader2,
  RotateCcw,
  AlertTriangle,
  Search as SearchIcon,
  Sparkle,
  Sparkles,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useMailbox } from '@shared/state/mailbox'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { showAIChatPanel } from '@shared/state/ai-chat-panel'
import { closeCommandPalette, useCommandPalette } from '@shared/state/command-palette'
import { toastError, toastSuccess } from '@shared/state/toast'
import { extractTerms } from '@shared/lib/highlight_terms'
import type { MailboxSummary, SearchHit, SearchResult } from '@shared/api/types'
import { EmailHitRow } from './EmailHitRow'

// ─── Tunables ──────────────────────────────────────────────────────────

// P1b: 8 → 50。用户要「更多搜索结果 + 滚动查看」。pane 有 max-height 钳制
// (index.css .palette-pane) + 结果 <ul> overflow-y-auto, 多结果在列表内滚动而非
// 撑爆; 键盘导航走 scrollIntoView 保选中项可见。50 = search IPC limit 与列表
// 展示的单一截断点 (searchEmails clamp 上限 200, 50 在范围内), 不设无界。
const MAX_EMAIL_HITS = 50
const MAX_JUMP_MAILBOXES = 3
const DEBOUNCE_MS = 250
const CJK_RATIO_THRESHOLD = 0.4
const CJK_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/g

// Static syntax legend shown in the empty-result tile — lets users discover
// field search (from:/after:/has:/is:) without cluttering the high-frequency
// jump flow. Display-only: clicking would inject a bare prefix that searches
// to empty, so these intentionally aren't interactive.
const SEARCH_SYNTAX_HINTS: ReadonlyArray<{ token: string; labelKey: string }> = [
  { token: 'from:', labelKey: 'palette.email.syntaxFrom' },
  { token: 'after:', labelKey: 'palette.email.syntaxAfter' },
  { token: 'has:attachment', labelKey: 'palette.email.syntaxHas' },
  { token: 'is:unread', labelKey: 'palette.email.syntaxUnread' }
]

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
    if (mailbox === '草稿箱') return 'drafts'
    return 'all'
  }, [])

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null)
  const [actionRunning, setActionRunning] = useState<string | null>(null)
  // P4b — AI 自然语言检索: loading 标记 + 解析结果 banner（成功显 DSL / 失败显
  // error 码）。banner 与搜索框解耦——用户可在 setQuery(dsl) 后继续编辑搜索框微调。
  const [aiLoading, setAiLoading] = useState(false)
  const [aiBanner, setAiBanner] = useState<{ kind: 'parsed'; dsl: string } | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  // Adjust-on-prop-change pattern (react.dev): reset query + highlight when
  // the palette transitions closed→open. Always start from an empty query so
  // each open is a fresh search (no stale last-session prefill).
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setQuery('')
      setHighlight(0)
      setLastLatencyMs(null)
      setActionRunning(null)
      setAiLoading(false)
      setAiBanner(null)
      setAiError(null)
    }
  }

  const inputRef = useRef<HTMLInputElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)
  const { dialogRef, handleTab } = useFocusTrap({ open })
  // 退场延迟卸载：veil 淡入 + pane 位移缩放。pane 用 translateX(-50%) 居中，
  // 故 from 带 xPercent:-50 让 GSAP transform 复刻居中（否则会被 GSAP 覆盖跳位），
  // 进场结束 clearProps 回落到 CSS 居中。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '.palette-pane',
    backdrop: '.palette-veil',
    from: { autoAlpha: 0, xPercent: -50, y: 8, scale: 0.97 }
  })

  // Focus input on open transition.
  useEffect(() => {
    if (!open) return
    const tid = window.setTimeout(() => inputRef.current?.focus(), 0)
    return (): void => window.clearTimeout(tid)
  }, [open])

  const debouncedRaw = useDebouncedValue(query, DEBOUNCE_MS)
  // T3: CJK transform 统一到后端 smart 模式，前端只 trim（消除前端/后端双 normalizer 分叉）。
  const normalised = useMemo(() => debouncedRaw.trim(), [debouncedRaw])
  const queryTerms = useMemo(() => extractTerms(debouncedRaw), [debouncedRaw])
  const lang = detectLang(query)
  const langLabel = lang === 'zh' ? t('palette.lang.zh') : t('palette.lang.en')

  const mailboxesQ = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    enabled: open
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: `?? []` 仅在 query 空档产生新数组; 包 useMemo 属 React Compiler 迁移债, 此处行为无害。
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
    // Keep the previous query's hits visible while a new query is in flight so
    // editing the search box does not flash the list to empty between debounced
    // re-runs. Matches EmailList / EmailDetail usage.
    placeholderData: keepPreviousData,
    enabled: open
  })

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: 同上, `?? []` 空档新数组无害, React Compiler 迁移时统一收。
  const hits: SearchHit[] = searchQ.data?.items ?? []
  const totalIndexed = searchQ.data?.total_indexed ?? null
  // keepPreviousData 会在新 query 在途时沿用上个 query 的 data；placeholder 期间
  // 不显示 stale warning（避免从非法→合法 query 时提示滞后一拍）。
  const parseWarnings: string[] = searchQ.isPlaceholderData
    ? []
    : (searchQ.data?.parse_warnings ?? [])
  // parse_warnings code → 友好提示文案（i18next-icu 单括号插值）。
  const formatWarning = (code: string): string => {
    const [head, a, b] = code.split(':')
    switch (head) {
      case 'empty_value':
        return t('palette.warn.emptyValue', { field: a ?? '' })
      case 'unknown_value':
        return t('palette.warn.unknownValue', { field: a ?? '', value: b ?? '' })
      case 'invalid_date':
      case 'invalid_relative_date':
        return t('palette.warn.invalidDate', { field: a ?? '', value: b ?? '' })
      case 'unsupported_or':
        return a === 'negated' ? t('palette.warn.negatedOr') : t('palette.warn.crossClassOr')
      case 'unclosed_quote':
        return t('palette.warn.unclosedQuote')
      case 'dangling_or':
        return t('palette.warn.danglingOr')
      case 'empty_text':
        return t('palette.warn.emptyText')
      case 'parse_error':
        return t('palette.warn.parseError')
      default:
        return t('palette.warn.generic')
    }
  }
  const isSearching = searchQ.isFetching && normalised.length > 0

  // ──────────────────────────────────────────────────────────────────
  // JUMP items — mailbox-matches + open-AI-panel + admin shortcut
  // ──────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // P4b — AI 自然语言检索: 当前输入 → LLM → DSL → 填回搜索框 + banner
  // ──────────────────────────────────────────────────────────────────

  // error 码 → 友好文案（i18next-icu 单括号插值）。未知码回退 generic。
  const formatAiError = useCallback(
    (code: string): string => {
      switch (code) {
        case 'E_NO_LLM_KEY':
          return t('palette.ai.errNoKey')
        case 'E_EMPTY':
          return t('palette.ai.errEmpty')
        case 'E_UNSUPPORTED':
          return t('palette.ai.errUnsupported')
        default:
          return t('palette.ai.errGeneric')
      }
    },
    [t]
  )

  const runAiUnderstand = useCallback(async (): Promise<void> => {
    const nl = query.trim()
    if (nl.length === 0 || aiLoading) return
    setAiLoading(true)
    setAiError(null)
    setAiBanner(null)
    try {
      const res = await mailApi.email.nlToDsl(nl)
      if (res.error || !res.dsl) {
        setAiError(formatAiError(res.error ?? 'E_NO_OUTPUT'))
        return
      }
      // 填回搜索框 → 触发既有搜索路径；banner 提示解析结果（可关 / 直接编辑微调）。
      setQuery(res.dsl)
      setAiBanner({ kind: 'parsed', dsl: res.dsl })
      setHighlight(0)
    } catch (err) {
      // nlToDsl 设计上不 reject；兜底仍处理（IPC 异常等）。
      setAiError(
        formatAiError(err instanceof Error ? ((err as Error & { code?: string }).code ?? '') : '')
      )
    } finally {
      setAiLoading(false)
    }
  }, [query, aiLoading, mailApi, formatAiError])

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

    // P4b — AI 理解入口（仅当输入框有内容时）。放在 jump 组首位 → ⌘K 输入 → ⏎
    // 即可触发 AI 翻译（自然填进 flat-index 键盘导航）。label 用 live `query`
    // 实时回显当前输入。
    const liveQuery = query.trim()
    if (liveQuery.length > 0) {
      out.push({
        id: 'ai:understand',
        icon: aiLoading ? (
          <Loader2
            size={14}
            strokeWidth={1.75}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        ) : (
          <Sparkles size={14} strokeWidth={1.75} />
        ),
        label: (
          <span className="text-body flex-1 truncate">
            <span className="text-ink-fg font-medium">
              {aiLoading
                ? t('palette.ai.loading')
                : t('palette.ai.understand', { query: liveQuery })}
            </span>
            {!aiLoading && (
              <>
                <span className="text-ink-fg-3 mx-1">·</span>
                <span className="text-ink-fg-2">{t('palette.ai.understandHint')}</span>
              </>
            )}
          </span>
        ),
        run: () => {
          void runAiUnderstand()
        }
      })
    }

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
  }, [
    debouncedRaw,
    query,
    aiLoading,
    runAiUnderstand,
    hits,
    mailboxes,
    navigate,
    setActiveMailbox,
    t
  ])

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
          // navTarget: 跳转目标可能不在 EmailList 当前(分页/邮箱)列表里;
          // 标记后 EmailList 的 active-reset 会豁免它, 否则会被重置成列表第一封。
          setActiveEmail(h.internal_id, { navTarget: true })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: setActiveMailbox/setView 是 zustand 稳定 setter、viewForMailbox 是模块级纯函数, 列入只添噪声。
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

  if (!shouldRender) return null

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
    // display:contents 包裹层只为 GSAP 提供一个 scope 根（不生成盒子，veil/pane
    // 仍按各自 fixed 定位），useExitAnimation 经选择器分别动 veil/pane。
    <div ref={scopeRef} style={{ display: 'contents' }}>
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
            onChange={(e) => {
              setQuery(e.target.value)
              // 用户手动改输入 → 清掉上一次 AI 失败提示（成功 banner 留着供对照微调）。
              if (aiError) setAiError(null)
            }}
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

        {/* Parse warnings — 字段语法被忽略/降级时给可见反馈（T0） */}
        {hasQuery && parseWarnings.length > 0 && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2 shrink-0">
            <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-amber-500" />
            <span className="leading-snug">
              {parseWarnings.map((w) => formatWarning(w)).join('；')}
            </span>
          </div>
        )}

        {/* P4b — AI 解析结果 banner（成功显 DSL，可关 / 直接编辑搜索框微调）。 */}
        {aiBanner && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro shrink-0">
            <Sparkles size={12} strokeWidth={2} className="mt-px shrink-0 text-coral" aria-hidden />
            <span className="leading-snug text-ink-fg-1 flex-1 min-w-0 break-words">
              {t('palette.ai.parsedAs', { dsl: aiBanner.dsl })}
            </span>
            <button
              type="button"
              onClick={() => setAiBanner(null)}
              title={t('palette.ai.dismiss')}
              aria-label={t('palette.ai.dismiss')}
              className="text-ink-fg-2 hover:text-ink-fg p-0.5 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}

        {/* P4b — AI 解析失败 banner（无 key / web 不支持 / LLM 报错）。 */}
        {aiError && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2 shrink-0">
            <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-amber-500" />
            <span className="leading-snug flex-1 min-w-0">{aiError}</span>
            <button
              type="button"
              onClick={() => setAiError(null)}
              title={t('palette.ai.dismiss')}
              aria-label={t('palette.ai.dismiss')}
              className="text-ink-fg-2 hover:text-ink-fg p-0.5 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}

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
                  isSearching ? (
                    // In-flight (debounce settled + query running). keepPreviousData
                    // keeps stale hits below, so we surface the live state here as a
                    // restrained spinner + label instead of flashing the list empty.
                    <>
                      <Loader2
                        size={12}
                        strokeWidth={2}
                        className="animate-spin motion-reduce:animate-none text-ink-fg-2"
                        aria-hidden
                      />
                      <span>{t('palette.searching')}</span>
                    </>
                  ) : (
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
                  )
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
                          // navTarget: 跳转目标可能不在 EmailList 当前(分页/邮箱)列表里;
                          // 标记后 EmailList 的 active-reset 会豁免它, 否则会被重置成列表第一封。
                          setActiveEmail(h.internal_id, { navTarget: true })
                          void navigate({ to: '/', search: { view: targetView } })
                        }}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="px-5">
                  <div className="empty-tile">
                    {isSearching ? (
                      <Loader2
                        size={18}
                        strokeWidth={1.75}
                        className="animate-spin motion-reduce:animate-none text-ink-fg-3"
                        aria-hidden
                      />
                    ) : (
                      <SearchIcon
                        size={18}
                        strokeWidth={1.75}
                        className="text-ink-fg-3"
                        aria-hidden
                      />
                    )}
                    <div className="text-aux text-ink-fg-1">
                      {isSearching ? t('palette.searching') : t('palette.email.emptyTitle')}
                    </div>
                    {!isSearching && (
                      <>
                        <div className="text-meta text-ink-fg-3">
                          {t('palette.email.emptyHint')}
                        </div>
                        <div className="mt-1.5 flex flex-col items-center gap-1">
                          <div className="text-micro uppercase tracking-wide text-ink-fg-3">
                            {t('palette.email.syntaxLabel')}
                          </div>
                          <div className="flex flex-wrap justify-center gap-x-2.5 gap-y-1">
                            {SEARCH_SYNTAX_HINTS.map((h) => (
                              <span
                                key={h.token}
                                className="text-micro inline-flex items-center gap-1"
                              >
                                <code className="font-mono text-ink-fg-1 bg-ink-fg/[0.06] px-1 py-px rounded">
                                  {h.token}
                                </code>
                                <span className="text-ink-fg-3">{t(h.labelKey)}</span>
                              </span>
                            ))}
                          </div>
                          <div className="text-micro text-ink-fg-3">
                            {t('palette.email.syntaxHint')}
                          </div>
                        </div>
                      </>
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
                            <span className="text-meta font-mono text-ink-fg-3 animate-pulse motion-reduce:animate-none">
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
    </div>,
    document.body
  )
}
