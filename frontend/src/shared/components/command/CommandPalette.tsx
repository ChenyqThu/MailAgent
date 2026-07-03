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
  Bookmark,
  BookmarkPlus,
  Check,
  Clock,
  Folder,
  History,
  Loader2,
  RotateCcw,
  AlertTriangle,
  Search as SearchIcon,
  Sparkle,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { useMailbox } from '@shared/state/mailbox'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { openChatModal } from '@shared/state/ai-chat-panel'
import { runGatewaySearchAgent } from '@shared/assistant/searchAgentClient'
import { closeCommandPalette, useCommandPalette } from '@shared/state/command-palette'
import { useSearchHistory } from '@shared/state/search-history'
import { toastError, toastSuccess } from '@shared/state/toast'
import { extractTerms } from '@shared/lib/highlight_terms'
import { hasDslToken, toggleDslToken } from '@shared/lib/dsl_token'
import type { MailboxSummary, SearchAgentPhase, SearchHit, SearchResult } from '@shared/api/types'
import { EmailHitRow } from './EmailHitRow'
import { PaletteThinkingPhrases } from './PaletteThinkingPhrases'

// G-A7 ① — 远程 web build 上 runSearchAgent 必返 E_UNSUPPORTED（LLM key 在桌面）。
// 用项目一致的 VITE_BUILD_TARGET 信号（见 factory.ts / StatusBar.tsx / EnvField.tsx）
// gate 掉注定失败的 AI 入口行，web 不展示。
//
// 读取链复刻 vite 自身的 env 来源：build 时 vite 从 process.env 的 VITE_* 注入
// import.meta.env，故生产取 import.meta.env（已注入），回退 process.env（vitest 下
// import.meta.env 不可达，单测经 vi.stubEnv('VITE_BUILD_TARGET','web') 走此腿）。
function resolveBuildTarget(): string | undefined {
  const metaTarget = (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
    ?.VITE_BUILD_TARGET
  if (metaTarget) return metaTarget
  if (typeof process !== 'undefined') return process.env?.VITE_BUILD_TARGET
  return undefined
}
const IS_WEB = resolveBuildTarget() === 'web'

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

// G-B3 — facet chips: clickable DSL tokens that toggle in/out of the query.
// `is:unread` / `has:attachment` surface DSL the palette otherwise hides behind
// the static cheat-sheet. (Per-mailbox `in:` chips intentionally omitted — see
// the facetChips useMemo comment.)
const FIXED_FACETS: ReadonlyArray<{ token: string; labelKey: string }> = [
  { token: 'is:unread', labelKey: 'palette.facet.unread' },
  { token: 'has:attachment', labelKey: 'palette.facet.hasAttachment' }
]

type Group = 'jump' | 'ai' | 'email' | 'actions'

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

  // G-B3 — search history + saved searches (localStorage-backed).
  const history = useSearchHistory((s) => s.history)
  const savedSearches = useSearchHistory((s) => s.saved)
  const pushHistory = useSearchHistory((s) => s.pushHistory)
  const removeHistory = useSearchHistory((s) => s.removeHistory)
  const clearHistory = useSearchHistory((s) => s.clearHistory)
  const addSaved = useSearchHistory((s) => s.addSaved)
  const removeSaved = useSearchHistory((s) => s.removeSaved)

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

  // Open a search hit (shared by EMAIL FTS hits + AI agentic hits): sync the
  // EmailList view + mailbox so the row is actually surfaced, mark it as a nav
  // target so EmailList's active-reset exempts it, then navigate('/').
  const activateHit = useCallback(
    (hit: SearchHit): void => {
      const targetView = viewForMailbox(hit.mailbox)
      closeCommandPalette()
      setView(targetView)
      if (hit.mailbox) setActiveMailbox(hit.mailbox)
      setActiveEmail(hit.internal_id, { navTarget: true })
      void navigate({ to: '/', search: { view: targetView } })
    },
    [viewForMailbox, setView, setActiveMailbox, setActiveEmail, navigate]
  )

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null)
  const [actionRunning, setActionRunning] = useState<string | null>(null)
  // F3 — agentic 搜索: 用户在 AI 入口行触发 → runSearchAgent 跑一次性 search agent。
  //   aiSearching: 进行态（结果区顶部渲染 PaletteThinkingPhrases 一行短语流光）。
  //   aiHits:      命中真实带 snippet 的 SearchHit（候选池 ∩ matched_internal_ids）。
  //   aiSummary:   present_results.summary，渲染成一条 AI summary 行（非交互）。
  //   aiError:     友好错误文案（无 key / 超时 / 配额 / agent 出错…）；E_ABORTED 静默。
  // fallbackDsl 不入 state——直接 setQuery(fallbackDsl) 填回输入框走普通搜索 + 轻提示。
  const [aiSearching, setAiSearching] = useState(false)
  const [aiHits, setAiHits] = useState<SearchHit[]>([])
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  // G-A7 ② — agent 诚实返回 0 命中（ok:true, hits=[]）时仍要渲染明确空态。aiCompleted
  //   跟踪「AI 搜索已跑完一次」，区别于「未搜索」（false）与 abort/error（仍 false）。
  // G-A7 ③ — aiPhase 反映 runSearchAgent onPhase 真实阶段：检索中 → 整理中。
  const [aiCompleted, setAiCompleted] = useState(false)
  const [aiPhase, setAiPhase] = useState<SearchAgentPhase>('searching')
  // 当前在途 search agent 的 AbortController：输入变化 / 再次触发 / 关闭面板 → abort。
  const aiAbortRef = useRef<AbortController | null>(null)
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
      setAiSearching(false)
      setAiHits([])
      setAiSummary(null)
      setAiError(null)
      setAiCompleted(false)
      setAiPhase('searching')
    }
  }

  // 关闭面板时 abort 在途 search agent（避免后台 run 在面板关后继续 + setState）。
  // ref 访问放 effect 而非 render 路径（react-hooks/refs）。
  useEffect(() => {
    if (open) return
    if (aiAbortRef.current) {
      aiAbortRef.current.abort()
      aiAbortRef.current = null
    }
  }, [open])

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

  // G-B3 — record history on a *settled* successful search (not every keystroke):
  // debounce → normalised → searchQ resolves (non-placeholder) → push once. This
  // captures the queries the user actually let run, de-duped + capped in the store.
  useEffect(() => {
    if (!open) return
    if (normalised.length === 0) return
    if (!searchQ.isSuccess || searchQ.isPlaceholderData) return
    pushHistory(normalised)
    // Only re-run when the settled query string changes (success transition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, normalised, searchQ.isSuccess, searchQ.isPlaceholderData])

  // ──────────────────────────────────────────────────────────────────
  // JUMP items — mailbox-matches + open-AI-panel + admin shortcut
  // ──────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // F3 — agentic 搜索: AI 入口行 → runSearchAgent → 进行态 + 命中行 + summary
  // ──────────────────────────────────────────────────────────────────

  const activeMailbox = useMailbox((s) => s.active)

  // error 码 → 友好文案（i18next-icu 单括号插值）。未知码回退 generic。
  const formatAiError = useCallback(
    (code: string): string => {
      switch (code) {
        case 'E_NO_LLM_KEY':
          return t('palette.ai.errNoKey')
        case 'E_EMPTY':
        case 'E_NO_OUTPUT':
          return t('palette.ai.errEmpty')
        case 'E_UNSUPPORTED':
          return t('palette.ai.errUnsupported')
        case 'E_TIMEOUT':
          return t('palette.ai.errTimeout')
        case 'E_QUOTA':
          return t('palette.ai.errQuota')
        case 'E_AGENT':
        case 'E_BACKEND_CRASH':
        case 'E_UPSTREAM':
        case 'E_COST_BUDGET':
        case 'E_MAX_ITER':
          return t('palette.ai.errAgent')
        default:
          return t('palette.ai.errGeneric')
      }
    },
    [t]
  )

  const runAiSearch = useCallback(async (): Promise<void> => {
    const nl = query.trim()
    // 并发由 aiSearching gate 拦住（在途时再点不会重入）；故无需读旧 ref，只新建 +
    // 写入 ref 供 onChange / 关闭 effect 外部 abort。staleness 一律用 ac.signal.aborted
    // 判断（外部 abort 会置位），不读 ref.current —— 避开 render 输出嵌 ref-reader 的坑。
    if (nl.length === 0 || aiSearching) return
    const ac = new AbortController()
    aiAbortRef.current = ac
    setAiSearching(true)
    setAiHits([])
    setAiSummary(null)
    setAiError(null)
    setAiCompleted(false)
    setAiPhase('searching')
    setHighlight(0)
    try {
      // S3 W1 — agentic 搜索改走 embedded AI SDK Gateway 的 headless run（POST
      // /api/ai/search-agent）；结构化结果契约（hits/summary/error/fallbackDsl）不变。
      // legacy 的 mailApi.chat.runSearchAgent 自此无消费方（W3 随引擎删除）。
      const res = await runGatewaySearchAgent(mailApi, {
        query: nl,
        mailbox: activeMailbox || undefined,
        signal: ac.signal,
        // G-A7 ③ — 真实阶段驱动进行态 UI（检索中 → 整理中）。旧 run 被 abort 后
        // 不再写 phase（避免 stale phase 覆盖新 run 的进行态）。
        onPhase: (p) => {
          if (!ac.signal.aborted) setAiPhase(p)
        }
      })
      // 被关闭面板/输入变化 abort 掉的旧 run → 静默丢弃（不覆盖新状态）。
      if (ac.signal.aborted) return
      if (res.ok) {
        setAiHits(res.hits)
        setAiSummary(res.summary)
        // G-A7 ② — 标记完成，让 0 命中也能渲染明确空态（区别于「未搜索」）。
        setAiCompleted(true)
        return
      }
      // fallbackDsl → 填回输入框走普通搜索 + 轻提示（不弹错误 banner）。
      if (res.fallbackDsl) {
        setQuery(res.fallbackDsl)
        toastSuccess(t('palette.ai.fellBack'))
        return
      }
      const code = res.error?.code ?? ''
      // E_ABORTED 静默（用户主动取消）。
      if (code === 'E_ABORTED') return
      setAiError(formatAiError(code))
    } catch (err) {
      // runSearchAgent 设计上不 throw；兜底仍处理（意外异常）。
      if (ac.signal.aborted) return
      setAiError(
        formatAiError(err instanceof Error ? ((err as Error & { code?: string }).code ?? '') : '')
      )
    } finally {
      if (!ac.signal.aborted) setAiSearching(false)
    }
  }, [query, aiSearching, mailApi, activeMailbox, formatAiError, t])

  // G-A7 ⑥ — AI 结果 → 普通搜索出口：清掉 AI 态让纯 FTS 接管（query 保留在输入框，
  //   EMAIL 组用同一 query 召回全部命中）。abort 在途（防边角 race）。ref 访问放
  //   callback 体（事件触发时执行，非 render 路径）。
  const switchToPlainSearch = useCallback((): void => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort()
      aiAbortRef.current = null
    }
    setAiSearching(false)
    setAiHits([])
    setAiSummary(null)
    setAiError(null)
    setAiCompleted(false)
    setAiPhase('searching')
    setHighlight(0)
    inputRef.current?.focus()
  }, [])

  // G-B3 — facet chip click: toggle the DSL token in/out of the live query.
  // Pure string op (toggleDslToken) then setQuery; keeps focus in the input so
  // the user can keep typing. Not part of the flat keyboard index (mouse-only),
  // so the jump→ai→email→actions Enter contract is untouched.
  const toggleFacet = useCallback((token: string): void => {
    setQuery((q) => toggleDslToken(q, token))
    inputRef.current?.focus()
  }, [])

  // G-B3 — pin the current query as a saved search (MVP: query is its own name).
  const saveCurrentSearch = useCallback((): void => {
    const q = query.trim()
    if (q.length === 0) return
    addSaved(q, q)
    toastSuccess(t('palette.saved.savedToast'))
  }, [query, addSaved, t])

  // G-B3 — run a history/saved entry: drop it into the input and let plain FTS
  // take over (clears any in-flight AI state so the empty-tile picks → results).
  const runStoredQuery = useCallback(
    (q: string): void => {
      switchToPlainSearch()
      setQuery(q)
    },
    [switchToPlainSearch]
  )

  interface JumpRow {
    id: string
    icon: React.ReactNode
    label: React.ReactNode
    aside?: React.ReactNode
    // G-A7 ④ — AI 检索入口行。普通 Enter 命中此行不再启动多秒 AI（改打开首条 FTS
    //   命中 / no-op）；只有 ⌘Enter 或鼠标点击才触发 runAiSearch。kbd 提示显 ⌘⏎。
    isAiEntry?: boolean
    run(): void
  }

  const jumpItems: JumpRow[] = useMemo(() => {
    const out: JumpRow[] = []
    const q = debouncedRaw.trim()

    // F3 — AI 检索入口（仅当输入框有内容时）。放在 jump 组首位 → ⌘K 输入 → ⌘⏎
    // 即可触发 agentic 搜索（自然填进 flat-index 键盘导航）。label 用 live `query`
    // 实时回显当前输入。
    // G-A7 ① — 远程 web 上 runSearchAgent 必返 E_UNSUPPORTED（LLM key 在桌面），不
    //   push 注定失败的入口行。
    const liveQuery = query.trim()
    if (liveQuery.length > 0 && !IS_WEB) {
      // run 内 runAiSearch 仅写/管理 aiAbortRef（在途 AbortController），且只在
      // Enter/click 事件触发时执行、绝不在 render 期跑；规则保守地把「render 输出里
      // 嵌了碰 ref 的函数」也标。真重构需把 AbortController 提 reducer/state，会每
      // 触发都 re-render。React Compiler 迁移债。
      // eslint-disable-next-line react-hooks/refs
      out.push({
        id: 'ai:understand',
        isAiEntry: true,
        icon: aiSearching ? (
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
              {t('palette.ai.understand', { query: liveQuery })}
            </span>
            {!aiSearching && (
              <>
                <span className="text-ink-fg-3 mx-1">·</span>
                <span className="text-ink-fg-2">{t('palette.ai.understandHint')}</span>
              </>
            )}
          </span>
        ),
        run: () => {
          void runAiSearch()
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
    // MailAgent 通用 agent 视图 (/sessions)——legacy Cmd+O centered dialog 已随
    // legacy runtime 退役。
    out.push({
      id: 'jump:general-agent',
      icon: <Sparkles size={14} strokeWidth={1.75} />,
      label: (
        <span className="text-body flex-1 truncate">
          <span className="text-ink-fg font-medium">{t('nav.agentView')}</span>
          <span className="text-ink-fg-3 mx-1">·</span>
          <span className="text-ink-fg-2">{t('palette.jump.generalAgentMeta')}</span>
        </span>
      ),
      run: () => {
        closeCommandPalette()
        void navigate({ to: '/sessions' })
      }
    })
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
        openChatModal()
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
    aiSearching,
    runAiSearch,
    hits,
    mailboxes,
    navigate,
    setActiveMailbox,
    t
  ])

  // G-A7 ⑤ — AI/FTS 双组去重：AI 命中存在时，EMAIL(FTS) 组过滤掉已在 aiHits 出现
  //   的 internal_id（避免同一封邮件两组各显一次）。无 AI 命中时 === hits（零行为变化）。
  //   flat 键盘索引 + data-flat-idx offset 全部基于 dedupedHits 重算。
  const dedupedHits: SearchHit[] = useMemo(() => {
    if (aiHits.length === 0) return hits
    const aiIds = new Set(aiHits.map((h) => h.internal_id))
    return hits.filter((h) => !aiIds.has(h.internal_id))
  }, [hits, aiHits])

  // ──────────────────────────────────────────────────────────────────
  // G-B3 — facet chips: is:unread / has:attachment (DSL tokens the palette
  //   otherwise hides behind the static cheat-sheet). active = the live query
  //   already contains the token (toggle removes it). Per-mailbox `in:` chips
  //   are intentionally NOT rendered: mailbox scoping is already served by the
  //   auto-applied active mailbox (search passes `mailbox: activeMailbox`) and
  //   the interactive mailbox jump rows — a duplicate `in:` chip would collide
  //   with those rows (same label) for no added capability.
  // ──────────────────────────────────────────────────────────────────
  const facetChips: ReadonlyArray<{ token: string; label: string; active: boolean }> = useMemo(
    () =>
      FIXED_FACETS.map((f) => ({
        token: f.token,
        label: t(f.labelKey),
        active: hasDslToken(query, f.token)
      })),
    [query, t]
  )

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
    if (dedupedHits.length === 0) return []
    const ids = dedupedHits.map((h) => h.internal_id)
    return [
      {
        id: 'action:markAllRead',
        iconTone: 'ok',
        icon: <Check size={14} strokeWidth={1.75} />,
        label: t('palette.actions.markAllRead'),
        meta: t('palette.actions.markAllReadMeta', { n: dedupedHits.length }),
        async run() {
          setActionRunning('action:markAllRead')
          try {
            await mailApi.email.flag(null, {
              ids,
              isRead: true,
              allowConcurrent: true
            })
            toastSuccess(t('palette.actions.doneToast', { n: dedupedHits.length }))
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
        meta: t('palette.actions.reRunAiMeta', { n: dedupedHits.length }),
        async run() {
          setActionRunning('action:reRunAi')
          try {
            const settled = await Promise.allSettled(
              dedupedHits.map((h) => mailApi.llm.run(h.internal_id, { force: true }))
            )
            const ok = settled.filter((r) => r.status === 'fulfilled').length
            if (ok < dedupedHits.length) {
              const firstErr = settled.find((r) => r.status === 'rejected') as
                | PromiseRejectedResult
                | undefined
              const msg = firstErr ? String(firstErr.reason) : ''
              toastError(t('palette.actions.errToast'), `${ok}/${dedupedHits.length} · ${msg}`)
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
        meta: t('palette.actions.summarizeMeta', { n: dedupedHits.length }),
        disabled: true,
        soon: true,
        async run() {
          /* disabled — wired in a future sprint when AIChatPanel accepts batch context */
        }
      }
    ]
  }, [dedupedHits, mailApi, queryClient, t])

  // ──────────────────────────────────────────────────────────────────
  // Flat index for ↑↓ + Tab keyboard navigation
  // ──────────────────────────────────────────────────────────────────

  interface FlatEntry {
    group: Group
    indexInGroup: number
    disabled?: boolean
    // G-A7 ④ — 标记 AI 检索入口 flat entry，让普通 Enter 分流（不启动 AI）。
    isAiEntry?: boolean
    run(): void | Promise<void>
  }

  const flat: FlatEntry[] = useMemo(() => {
    const out: FlatEntry[] = []
    jumpItems.forEach((j, i) =>
      out.push({ group: 'jump', indexInGroup: i, isAiEntry: j.isAiEntry, run: j.run })
    )
    // AI agentic hits: same activate closure as EMAIL hits; the AI summary row
    // and the in-flight phrase row are NOT entries (non-interactive).
    aiHits.forEach((h, i) => out.push({ group: 'ai', indexInGroup: i, run: () => activateHit(h) }))
    // Search hit may live in a mailbox the user isn't currently viewing.
    // activateHit syncs view + mailbox so EmailList scrolls to + highlights
    // the row instead of silently jumping the EmailDetail pane.
    // dedupedHits — AI 命中已显示的 internal_id 不在 EMAIL 组重复（G-A7 ⑤）。
    dedupedHits.forEach((h, i) =>
      out.push({ group: 'email', indexInGroup: i, run: () => activateHit(h) })
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
  }, [jumpItems, aiHits, dedupedHits, actionItems, activateHit])

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
      const order: Group[] = ['jump', 'ai', 'email', 'actions']
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
        // G-A7 ④ — 桌面 ⌘Enter = 触发 AI 搜索（query 非空）。全局快捷，无论当前高亮
        //   在哪一行；优先于普通 Enter。web 上 AI 不可用 → 不拦截，fall through 到
        //   普通 Enter（基线「⌘Enter = Enter 别名」语义，跑高亮行；web 无 AI 入口行
        //   故落点恒为真实可执行行，绝不退化成 no-op）。
        if (e.metaKey && !IS_WEB && query.trim().length > 0) {
          void runAiSearch()
          return
        }
        const entry = flat[highlight]
        if (!entry || entry.disabled) return
        // 普通 Enter 落在 AI 入口行 → 永不启动多秒 AI。改打开「最佳 FTS 命中」
        //   （首条 email 命中）；无 email 命中则 no-op，保护「打开最佳命中」肌肉记忆。
        if (entry.isAiEntry) {
          if (dedupedHits.length > 0) activateHit(dedupedHits[0])
          return
        }
        void entry.run()
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
    [flat, handleTab, highlight, jumpToGroupBoundary, query, runAiSearch, dedupedHits, activateHit]
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

  // EMAIL 组以 dedupedHits 为准（AI 命中已在 AI 组显示，G-A7 ⑤）。
  const hasHits = dedupedHits.length > 0
  const hasQuery = normalised.length > 0
  // AI 命中存在且去重后 EMAIL 组为空 → 整组不渲染（命中全在 AI 组，避免误导「未找到」空态）。
  const showEmailGroup = hasQuery && (dedupedHits.length > 0 || aiHits.length === 0)
  // G-A7 ② — AI 搜索跑完一次且 0 命中（agent 诚实说没找到）→ 渲染明确空态。
  const showAiEmpty = aiCompleted && !aiSearching && aiHits.length === 0
  const countLabel =
    totalIndexed === null
      ? `${dedupedHits.length}`
      : t('palette.email.countLabel', { n: dedupedHits.length, total: totalIndexed })

  // Pre-compute flat index offsets for each group so renderer can stamp
  // data-flat-idx without recomputing during the map. Order matches the flat
  // index builder: jump → ai → email → actions.
  let cursor = 0
  const jumpStartIdx = cursor
  cursor += jumpItems.length
  const aiStartIdx = cursor
  cursor += aiHits.length
  const emailStartIdx = cursor
  cursor += dedupedHits.length
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
              // 用户手动改输入 → abort 在途 AI 检索 + 清掉上一次 AI 结果/进行态/错误，
              // 让普通 FTS 搜索干净接管（避免 stale agentic 命中行残留）。
              if (aiAbortRef.current) {
                aiAbortRef.current.abort()
                aiAbortRef.current = null
              }
              if (aiSearching) setAiSearching(false)
              if (aiHits.length > 0) setAiHits([])
              if (aiSummary !== null) setAiSummary(null)
              if (aiError) setAiError(null)
              // G-A7 ② — 编辑 query 也清「AI 跑完」标记，否则 0 命中空态会黏住。
              if (aiCompleted) setAiCompleted(false)
              setAiPhase('searching')
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
                // 清空 query 一并清 AI 态（abort 在途 + 清命中/完成标记 + focus），
                // 否则 AI 组会在空 query 下黏住（G-A7 ②）。
                switchToPlainSearch()
              }}
              title="Clear"
              aria-label="Clear search"
              className="text-ink-fg-2 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* G-B3 — facet chips row: click toggles a DSL token in/out of the query.
            Mouse-only (NOT in the flat keyboard index) so the jump→ai→email→
            actions Enter contract is unchanged. The "save this search" control
            appears once the query is non-empty (MVP: query is its own name). */}
        {facetChips.length > 0 && (
          <div className="px-4 py-1.5 flex items-center gap-1.5 flex-wrap border-b border-ink-border-soft shrink-0">
            {facetChips.map((c) => (
              <button
                key={c.token}
                type="button"
                onClick={() => toggleFacet(c.token)}
                aria-pressed={c.active}
                className={cn(
                  'text-micro px-2 py-0.5 rounded-full border transition shrink-0',
                  c.active
                    ? 'bg-coral/[0.14] border-coral/40 text-coral'
                    : 'bg-ink-fg/[0.04] border-ink-border-soft text-ink-fg-2 hover:text-ink-fg hover:bg-ink-fg/[0.08]'
                )}
              >
                {c.label}
              </button>
            ))}
            {hasQuery && (
              <button
                type="button"
                onClick={saveCurrentSearch}
                title={t('palette.saved.save')}
                aria-label={t('palette.saved.save')}
                className="ml-auto inline-flex items-center gap-1 text-micro text-ink-fg-2 hover:text-ink-fg transition shrink-0"
              >
                <BookmarkPlus size={12} strokeWidth={2} className="shrink-0" aria-hidden />
                <span>{t('palette.saved.save')}</span>
              </button>
            )}
          </div>
        )}

        {/* Parse warnings — 字段语法被忽略/降级时给可见反馈（T0） */}
        {hasQuery && parseWarnings.length > 0 && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2 shrink-0">
            <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-warn" />
            <span className="leading-snug">
              {parseWarnings.map((w) => formatWarning(w)).join('；')}
            </span>
          </div>
        )}

        {/* F3 — AI 检索失败 banner（无 key / 超时 / 配额 / agent 出错 / web 不支持）。 */}
        {aiError && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2 shrink-0">
            <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-warn" />
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
                      {/* G-A7 ④ — AI 入口行显 ⌘⏎ AI 搜索（普通 ⏎ 改打开首条命中），
                          其余 jump 行保持 ⏎ 打开。 */}
                      <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
                        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
                          {j.isAiEntry ? '⌘⏎' : '⏎'}
                        </kbd>
                        <span>
                          {j.isAiEntry ? t('palette.kbd.aiSearch') : t('palette.kbd.open')}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </div>
            </>
          )}

          {/* G-B3 — empty-state recall: when the query box is empty, surface
              recent searches + saved searches (clickable → setQuery). Falls
              back to the static syntax legend when both are empty. These rows
              are mouse-only (NOT in the flat keyboard index) to keep the
              jump→ai→email→actions Enter contract intact. */}
          {!hasQuery && (history.length > 0 || savedSearches.length > 0) && (
            <>
              {history.length > 0 && (
                <>
                  <GroupHeader
                    title="Recent"
                    countLabel={String(history.length)}
                    aside={
                      <button
                        type="button"
                        onClick={clearHistory}
                        className="text-micro text-ink-fg-3 hover:text-ink-fg transition normal-case tracking-normal"
                      >
                        {t('palette.history.clear')}
                      </button>
                    }
                  />
                  <div className="px-3 space-y-px">
                    {history.map((h) => (
                      <div
                        key={`hist-${h}`}
                        className="pal-row group"
                        onClick={() => runStoredQuery(h)}
                      >
                        <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
                          <Clock size={14} strokeWidth={1.75} />
                        </span>
                        <span className="text-body flex-1 truncate text-ink-fg-1">{h}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeHistory(h)
                          }}
                          title={t('palette.history.remove')}
                          aria-label={t('palette.history.remove')}
                          className="opacity-0 group-hover:opacity-100 text-ink-fg-3 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {savedSearches.length > 0 && (
                <>
                  <GroupHeader title="Saved" countLabel={String(savedSearches.length)} />
                  <div className="px-3 space-y-px">
                    {savedSearches.map((s) => (
                      <div
                        key={`saved-${s.id}`}
                        className="pal-row group"
                        onClick={() => runStoredQuery(s.query)}
                      >
                        <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
                          <Bookmark size={14} strokeWidth={1.75} />
                        </span>
                        <span className="text-body flex-1 truncate text-ink-fg-1">{s.name}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeSaved(s.id)
                          }}
                          title={t('palette.saved.remove')}
                          aria-label={t('palette.saved.remove')}
                          className="opacity-0 group-hover:opacity-100 text-ink-fg-3 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
                        >
                          <Trash2 size={12} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* AI SEARCH group — agentic 检索进行态 + summary + 真实命中行 / 空态。在途时
              顶部渲染一行 phrase+shimmer（不展开过程，phase 驱动短语组 G-A7 ③）；命中
              用同款 EmailHitRow（纳入 flat 键盘索引）；summary 行 / phrase 行 / 空态 tile
              / 转普通搜索行均不进 flat 索引（非交互或自管点击）。 */}
          {(aiSearching || aiHits.length > 0 || showAiEmpty) && (
            <>
              <GroupHeader
                title="AI Search"
                countLabel={aiHits.length > 0 ? String(aiHits.length) : undefined}
              />
              {aiSearching && (
                <div className="px-5 py-1.5 flex items-center gap-2 text-aux text-ink-fg-2">
                  <Sparkles
                    size={14}
                    strokeWidth={1.75}
                    className="shrink-0 text-coral"
                    aria-hidden
                  />
                  {/* G-A7 ③ — phase 驱动短语组（检索中 → 整理中）。 */}
                  <PaletteThinkingPhrases phase={aiPhase} />
                </div>
              )}
              {!aiSearching && aiSummary && (
                <div className="px-5 py-1.5 flex items-start gap-2 text-aux text-ink-fg-1">
                  <Sparkles
                    size={14}
                    strokeWidth={1.75}
                    className="mt-px shrink-0 text-coral"
                    aria-hidden
                  />
                  <span className="leading-snug min-w-0 break-words">
                    {t('palette.ai.summary', { text: aiSummary })}
                  </span>
                </div>
              )}
              {aiHits.length > 0 && (
                <div className="px-3 space-y-px">
                  {aiHits.map((h, i) => {
                    const idx = aiStartIdx + i
                    const selected = idx === highlight
                    return (
                      <EmailHitRow
                        key={`ai-${h.internal_id}`}
                        hit={h}
                        flatIdx={idx}
                        selected={selected}
                        setHighlight={setHighlight}
                        queryTerms={queryTerms}
                        onActivate={() => activateHit(h)}
                      />
                    )
                  })}
                </div>
              )}
              {/* G-A7 ② — AI 跑完且 0 命中（agent 诚实说没找到）→ 明确空态 tile。
                  有 summary 时已在上方渲染（summary 解释了为何没找到）。 */}
              {showAiEmpty && (
                <div className="px-5 pb-1">
                  <div className="empty-tile">
                    <Sparkles size={18} strokeWidth={1.75} className="text-ink-fg-3" aria-hidden />
                    <div className="text-aux text-ink-fg-1">{t('palette.ai.emptyTitle')}</div>
                    <div className="text-meta text-ink-fg-3">{t('palette.ai.emptyHint')}</div>
                  </div>
                </div>
              )}
              {/* G-A7 ⑥ — 转普通搜索出口：清掉 AI 态让纯 FTS 接管（query 保留在输入框）。
                  仅 AI 跑完（有命中或空态）时出现，非 flat 索引（鼠标点击 = 明确意图）。 */}
              {(aiHits.length > 0 || showAiEmpty) && (
                <div className="px-5 pt-0.5 pb-1">
                  <button
                    type="button"
                    onClick={switchToPlainSearch}
                    className="text-micro text-ink-fg-2 hover:text-ink-fg inline-flex items-center gap-1 transition"
                  >
                    <SearchIcon size={11} strokeWidth={2} className="shrink-0" aria-hidden />
                    <span>{t('palette.ai.viewInPlain')}</span>
                  </button>
                </div>
              )}
            </>
          )}

          {/* EMAIL group — rendered whenever the user typed something so
              the empty-tile has a home. Aside shows live latency + FTS5
              health dot. */}
          {showEmailGroup && (
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
                  {dedupedHits.map((h, i) => {
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
                        onActivate={() => activateHit(h)}
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
          {/* G-A7 ④ — 桌面 ⌘⏎ = AI 搜索（web 无 LLM key → 保留新窗口占位提示）。 */}
          <KbdHint
            keys="⌘⏎"
            label={IS_WEB ? t('palette.kbd.newWindow') : t('palette.kbd.aiSearch')}
          />
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
