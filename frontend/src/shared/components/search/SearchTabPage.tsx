// 「新标签页」搜索页（task 08-27-l4-tab-workspace P2 补批 Lane S，/search 路由）。
//
// 形态权威 = 原型 Main.dc.html 的搜索面（.scol：slogo → 大搜索框 → hint chips →
// 「最近打开」）。搜索内核**复用 ⌘K palette 的那一套**：同一组 query key（qk.palette.*，
// 与面板共享缓存、共享后端 FTS5 路径）+ 同三枚结果行组件（EmailHitRow / MatterHitRow /
// PersonHitRow）+ 同一个 agentic 入口（runGatewaySearchAgent）。palette 本批不动语义，
// 激活语义（activateHit / activateMatter / activateContact）按 CommandPalette 的同名
// 实现照抄（去掉 closeCommandPalette）——那边改激活链路时这里要跟。
//
// 结构（300 行上限拆分）：本文件 = 编排（状态接线 / 三路检索 / 激活 / 键盘 / 输入行）；
//   - SearchRecallColumn —— 左列 336 召回面（最近搜索 + 已保存；🔴 不是装饰，/search
//     无 NavDomain ⇒ Sidebar 无 DomainPanel，没有它左列边界会从 392 塌到 56）；
//   - SearchRecentOpens —— 空态「最近打开」（标签工作区自己的数据）；
//   - SearchResultGroups —— 结果四组（🔴 组序 = 本文件 flat 键盘序，两侧同步改）。
//
// 点结果：email/matter → 开对象标签（搜索标签保留不变身，原型 open() 语义）；
// contact → 主标签导航（palette 现行语义）。
//
// query 与 AI 结果态住在 `state/search-tab.ts`（会话内保持，续改 1）：切走再切回
// 是 remount（单挂载切换），组件本地 useState 会丢；FTS 结果由 query + 共享缓存回放。
// 本组件只留纯视图态（highlight 悬停光标 —— remount 归零无感）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Search as SearchGlyph, X } from 'lucide-react'

import type { SearchHit, SearchResult } from '@shared/api/types'
import type { ContactRowDto } from '@shared/api/types/contact'
import type { Matter } from '@shared/api/types/matter'
import { runGatewaySearchAgent } from '@shared/assistant/searchAgentClient'
import { useContactsApi, useContactsEnabled } from '@shared/components/contacts/hooks'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { PageFrame } from '@shared/components/layout/PageFrame'
import { useMattersApi, useMattersEnabled } from '@shared/components/matters/hooks'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { useDebouncedValue } from '@shared/hooks/useDebouncedValue'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { toggleDslToken } from '@shared/lib/dsl_token'
import { extractTerms } from '@shared/lib/highlight_terms'
import { viewForMailbox } from '@shared/lib/mailboxSemantics'
import { qk } from '@shared/lib/queryKeys'
import { useDomainCollapsed } from '@shared/state/nav-shell'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'
import { useSearchHistory } from '@shared/state/search-history'
import { useSearchTabPage } from '@shared/state/search-tab'
import { toastSuccess } from '@shared/state/toast'

import { SearchRecallColumn } from './SearchRecallColumn'
import { SearchRecentOpens } from './SearchRecentOpens'
import { FLAT_BASE, SearchResultGroups } from './SearchResultGroups'

// 与 CommandPalette 的 resolveBuildTarget 同判据（那边未导出；远程 web 无 LLM key，
// agentic 入口必 E_UNSUPPORTED，不给注定失败的 chip）。
function resolveBuildTarget(): string | undefined {
  const metaTarget = (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
    ?.VITE_BUILD_TARGET
  if (metaTarget) return metaTarget
  if (typeof process !== 'undefined') return process.env?.VITE_BUILD_TARGET
  return undefined
}
const IS_WEB = resolveBuildTarget() === 'web'

// 与 palette 同一截断口径（同 query key 必须同 limit —— 缓存是共享的，limit 不同会让
// 两个消费方拿到彼此的形状）。
const MAX_EMAIL_HITS = 50
const MAX_CONTACT_HITS = 8
const CONTACT_FETCH_LIMIT = 16
const DEBOUNCE_MS = 250

interface FlatEntry {
  run(): void
}

export function SearchTabPage(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const mailApi = useMailApi()
  const mattersApi = useMattersApi()
  const mattersEnabled = useMattersEnabled()
  const contactsApi = useContactsApi()
  const { enabled: contactsEnabled } = useContactsEnabled()
  const openMatter = useMatterNavigation((state) => state.open)
  const openContact = useContactNavigation((state) => state.open)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const setActiveEmail = useActiveEmail((s) => s.setActive)
  const setView = useEmailFilter((s) => s.setView)
  const pushHistory = useSearchHistory((s) => s.pushHistory)
  // /search 左列跟随邮件域的折叠记忆（Sidebar 在 /search 上回落 mail 域）。
  const recallHidden = useDomainCollapsed('mail')

  // query / AI 结果态 = 会话内 store（续改 1，见文件头）；highlight 是纯视图态留本地。
  const query = useSearchTabPage((s) => s.query)
  const aiHits = useSearchTabPage((s) => s.aiHits)
  const aiError = useSearchTabPage((s) => s.aiError)
  const setQuery = useSearchTabPage((s) => s.setQuery)
  const dismissAiError = useSearchTabPage((s) => s.dismissAiError)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const debouncedRaw = useDebouncedValue(query, DEBOUNCE_MS)
  const normalised = useMemo(() => debouncedRaw.trim(), [debouncedRaw])
  const queryTerms = useMemo(() => extractTerms(debouncedRaw), [debouncedRaw])
  const hasQuery = normalised.length > 0

  // error 码 → 文案：palette formatAiError 的同一词表（palette.ai.*）。
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

  const activeMailbox = useMailbox((s) => s.active)

  // agentic 搜索（palette F3/G-A7 的同一状态机；状态与在途 controller 在 store）：
  // 切走**不 abort**，run 离场续跑，回来看结果；新输入 / 新 run 才掐旧的。写入一律按
  // `ac.signal.aborted` 闸（被顶掉的旧 run 不许再写）。
  const runAiSearch = useCallback(async (): Promise<void> => {
    const store = useSearchTabPage.getState()
    const nl = store.query.trim()
    if (nl.length === 0) return
    const ac = store.beginAiRun() // 并发由 store 拦（在途返回 null）
    if (ac === null) return
    try {
      const res = await runGatewaySearchAgent(mailApi, {
        query: nl,
        mailbox: activeMailbox || undefined,
        signal: ac.signal,
        onPhase: (p) => {
          if (!ac.signal.aborted) useSearchTabPage.getState().setAiPhase(p)
        }
      })
      if (ac.signal.aborted) return
      if (res.ok) {
        useSearchTabPage.getState().resolveAiRun(res.hits, res.summary)
        return
      }
      if (res.fallbackDsl) {
        // setQuery 会 abort 本 run（currentRun 即 ac）并整体重置 AI 态 —— finally 那腿
        // 因 aborted 跳过，searching 已随重置归位。
        useSearchTabPage.getState().setQuery(res.fallbackDsl)
        toastSuccess(t('palette.ai.fellBack'))
        return
      }
      const code = res.error?.code ?? ''
      if (code === 'E_ABORTED') return
      useSearchTabPage.getState().failAiRun(formatAiError(code))
    } catch (err) {
      if (ac.signal.aborted) return
      useSearchTabPage
        .getState()
        .failAiRun(
          formatAiError(err instanceof Error ? ((err as Error & { code?: string }).code ?? '') : '')
        )
    } finally {
      if (!ac.signal.aborted) useSearchTabPage.getState().endAiRun()
    }
  }, [mailApi, activeMailbox, formatAiError, t])

  // ── 三路检索（与 palette 同 query key —— 缓存共享，后端路径同一条）────────────

  const searchQ = useQuery<SearchResult>({
    queryKey: qk.palette.search(normalised),
    queryFn: () => mailApi.email.search({ query: normalised, limit: MAX_EMAIL_HITS }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled: hasQuery
  })
  const hits: SearchHit[] = useMemo(() => searchQ.data?.items ?? [], [searchQ.data?.items])
  const isSearching = searchQ.isFetching && hasQuery

  // 与 palette 同判据（CommandPalette G-B3）：settled 成功搜索推一次进历史 —— 左列
  // 「最近搜索」由页内搜索与 ⌘K 共同喂，不再是单向账本。palette 侧多一个 open 闸，
  // 页面的等价物就是「挂载着」。
  useEffect(() => {
    if (normalised.length === 0) return
    if (!searchQ.isSuccess || searchQ.isPlaceholderData) return
    pushHistory(normalised)
    // 只在 settled query 变化（success 翻转）时重跑 —— palette 同款依赖面。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalised, searchQ.isSuccess, searchQ.isPlaceholderData])

  const mattersQ = useQuery({
    queryKey: qk.matters.paletteSearch(normalised),
    queryFn: () => mattersApi.list({ q: normalised, limit: 8 }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled: mattersEnabled && hasQuery
  })
  const matterHits: Matter[] = useMemo(() => mattersQ.data?.items ?? [], [mattersQ.data?.items])
  const visibleMatterHits = mattersEnabled ? matterHits : []

  const contactsQ = useQuery({
    queryKey: qk.contacts.paletteSearch(normalised),
    queryFn: () =>
      contactsApi.list({ view: 'all', q: normalised, sort: 'density', limit: CONTACT_FETCH_LIMIT }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled: contactsEnabled && hasQuery
  })
  const contactHits: ContactRowDto[] = useMemo(
    () =>
      (contactsQ.data?.items ?? [])
        .filter((row) => row.hidden_at === null)
        .slice(0, MAX_CONTACT_HITS),
    [contactsQ.data?.items]
  )
  const visibleContactHits = contactsEnabled ? contactHits : []
  const contactOverflow = Math.max(0, (contactsQ.data?.total ?? 0) - visibleContactHits.length)

  // AI 命中已显示的邮件不在 EMAIL 组重复（palette G-A7 ⑤ 同规则）。
  const dedupedHits: SearchHit[] = useMemo(() => {
    if (aiHits.length === 0) return hits
    const aiIds = new Set(aiHits.map((h) => h.internal_id))
    return hits.filter((h) => !aiIds.has(h.internal_id))
  }, [hits, aiHits])

  // ── 激活（CommandPalette 同名实现照抄，去掉关面板）───────────────────────────

  const activateHit = useCallback(
    (hit: SearchHit): void => {
      const targetView = viewForMailbox(hit.mailbox)
      setView(targetView)
      if (hit.mailbox) setActiveMailbox(hit.mailbox)
      setActiveEmail(hit.internal_id, { navTarget: true })
      void navigate({ to: '/', search: { view: targetView } })
    },
    [setView, setActiveMailbox, setActiveEmail, navigate]
  )

  const activateMatter = useCallback(
    (matter: Matter): void => {
      openMatter(matter.public_id)
      void navigate({ to: '/matters' })
    },
    [navigate, openMatter]
  )

  const activateContact = useCallback(
    (contact: ContactRowDto): void => {
      openContact(contact.id)
      void navigate({ to: '/contacts' })
    },
    [navigate, openContact]
  )

  // ── 键盘：↑↓ 走扁平序（🔴 与 SearchResultGroups 的组渲染同序），⏎ 开高亮，⌘⏎ AI ──

  const flat: FlatEntry[] = useMemo(() => {
    const out: FlatEntry[] = []
    for (const matter of visibleMatterHits) out.push({ run: () => activateMatter(matter) })
    for (const contact of visibleContactHits) out.push({ run: () => activateContact(contact) })
    for (const h of aiHits) out.push({ run: () => activateHit(h) })
    for (const h of dedupedHits) out.push({ run: () => activateHit(h) })
    return out
  }, [
    visibleMatterHits,
    visibleContactHits,
    aiHits,
    dedupedHits,
    activateMatter,
    activateContact,
    activateHit
  ])

  // 列表缩短时在 render 期收编高亮（palette 同款 clamp，不多一帧）。
  if (flat.length > 0 && highlight >= flat.length) {
    setHighlight(flat.length - 1)
  } else if (flat.length === 0 && highlight !== 0) {
    setHighlight(0)
  }

  const setHighlightFromRow = useCallback((flatIdx: number): void => {
    setHighlight(flatIdx - FLAT_BASE)
  }, [])

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (flat.length > 0) setHighlight((h) => (h + 1) % flat.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (flat.length > 0) setHighlight((h) => (h - 1 + flat.length) % flat.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.metaKey && !IS_WEB && query.trim().length > 0) {
          void runAiSearch()
          return
        }
        flat[highlight]?.run()
      }
    },
    [flat, highlight, query, runAiSearch]
  )

  // store.setQuery 自带「清 AI 态 + abort 在途 run」（palette onChange 同规则）。
  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      setQuery(e.target.value)
      setHighlight(0)
    },
    [setQuery]
  )

  const applyToken = useCallback(
    (token: string): void => {
      setQuery(toggleDslToken(useSearchTabPage.getState().query, token))
      inputRef.current?.focus()
    },
    [setQuery]
  )

  const runStoredQuery = useCallback(
    (q: string): void => {
      setQuery(q)
      setHighlight(0)
      inputRef.current?.focus()
    },
    [setQuery]
  )

  const onAiChip = useCallback((): void => {
    if (query.trim().length === 0) {
      inputRef.current?.focus()
      return
    }
    void runAiSearch()
  }, [query, runAiSearch])

  const hintChips: ReadonlyArray<{ label: string; onClick(): void }> = [
    { label: 'from:david', onClick: () => applyToken('from:david') },
    { label: 'has:attachment', onClick: () => applyToken('has:attachment') },
    ...(IS_WEB ? [] : [{ label: t('searchTab.hintAi'), onClick: onAiChip }])
  ]

  return (
    <PageFrame ariaLabel="search" mainClassName="flex-1 flex overflow-hidden min-w-0">
      <SearchRecallColumn onRunQuery={runStoredQuery} hidden={recallHidden} />

      {/* 主列 —— 原型 .scol：560 居中，空态 margin-top 110；有查询时上移让位结果。 */}
      <section className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
        <div
          className={cn(
            'mx-auto flex w-[560px] max-w-[calc(100%-48px)] flex-col pb-16',
            hasQuery ? 'mt-7' : 'mt-[110px]'
          )}
        >
          <div className="mb-6 flex items-center justify-center gap-2.5 text-aux text-ink-fg-2">
            <SearchGlyph size={16} strokeWidth={1.7} aria-hidden />
            <span>{t('searchTab.slogan')}</span>
          </div>

          <div className="flex h-12 items-center gap-3 rounded-xl border border-ink-fg/[0.16] bg-ink-fg/[0.05] px-4 focus-within:border-ink-fg/25">
            <SearchGlyph
              size={17}
              strokeWidth={1.8}
              className="shrink-0 text-ink-fg-2"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              placeholder={t('searchTab.placeholder')}
              autoComplete="off"
              spellCheck={false}
              aria-label={t('tabs.searchTitle')}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-fg outline-none placeholder:text-ink-fg-2"
            />
            <kbd className="flex h-[22px] shrink-0 items-center rounded-[5px] border border-ink-border px-1.5 font-mono text-micro text-ink-fg-2">
              ⌘K
            </kbd>
          </div>

          <div className="mt-3 flex justify-center gap-2">
            {hintChips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={chip.onClick}
                className="flex h-6 items-center rounded-md border border-ink-border-soft bg-ink-fg/[0.05] px-2.5 font-mono text-micro text-ink-fg-2 transition hover:text-ink-fg"
              >
                {chip.label}
              </button>
            ))}
          </div>

          {aiError && (
            <div className="mt-3 flex items-start gap-1.5 text-micro text-ink-fg-2">
              <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-warn" />
              <span className="min-w-0 flex-1 leading-snug">{aiError}</span>
              <button
                type="button"
                onClick={dismissAiError}
                title={t('palette.ai.dismiss')}
                aria-label={t('palette.ai.dismiss')}
                className="shrink-0 rounded p-0.5 text-ink-fg-2 transition hover:bg-ink-fg/[0.08] hover:text-ink-fg"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          )}

          {!hasQuery && <SearchRecentOpens />}

          {hasQuery && (
            <SearchResultGroups
              queryTerms={queryTerms}
              highlight={highlight}
              onRowHighlight={setHighlightFromRow}
              matterHits={visibleMatterHits}
              mattersBusy={mattersQ.isFetching && hasQuery}
              contactHits={visibleContactHits}
              contactsBusy={contactsQ.isFetching && hasQuery}
              contactOverflow={contactOverflow}
              aiHits={aiHits}
              dedupedHits={dedupedHits}
              emailBusy={isSearching}
              onActivateHit={activateHit}
              onActivateMatter={activateMatter}
              onActivateContact={activateContact}
            />
          )}
        </div>
      </section>
    </PageFrame>
  )
}
