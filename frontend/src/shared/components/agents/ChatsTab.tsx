// Sprint 20 — Chats tab（按设计稿 chat-tab.jsx 双栏实现）：左会话列表（搜索 +
// backend 过滤 + 选中）+ 右 transcript 内联预览。S3 W2：transcript 从 legacy
// MessageList 换成统一的 ReadOnlyTranscript（assistant-ui 只读 thread；有
// ui_message_json 渲染完整 parts，legacy 行降级纯文本）。「在收件箱继续」仍可跳
// 回实时 chat 面板。
import type { TFunction } from 'i18next'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronLeft,
  ExternalLink,
  History,
  Mail,
  MessageSquare,
  Search,
  Sliders,
  Sparkles
} from 'lucide-react'

import type { ChatBackendKind, ChatMessage, ChatSessionListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useActiveEmail } from '@shared/state/active-email'
import { openAIChatSession } from '@shared/state/ai-chat-panel'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { ReadOnlyTranscript } from '@shared/assistant/ReadOnlyTranscript'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useNarrow } from './hooks'

// redesign Phase 5 — notion-agent retired as a NEW-session backend; its history surfacing (the filter
// tab + label) is removed here. Old notion-agent session ROWS stay readable via the per-email panel.
type BackendFilter = 'all' | 'custom-api'
const SESSIONS_QUERY_KEY = qk.chat.allSessions()

function relTime(epochMs: number, t: TFunction): string {
  const diff = Date.now() - epochMs
  if (diff < 60_000) return t('chat.sidebar.justNow')
  if (diff < 3_600_000) return t('chat.sidebar.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('chat.sidebar.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('chat.sidebar.daysAgo', { n: Math.floor(diff / 86_400_000) })
}

function backendLabel(item: ChatSessionListItem, t: TFunction): string {
  return item.backend_model ?? t('chat.backend.customApi')
}

// ─── 会话行 ──────────────────────────────────────────────────────────────────
function SessionRow({
  item,
  selected,
  onSelect,
  t
}: {
  item: ChatSessionListItem
  selected: boolean
  onSelect: () => void
  t: TFunction
}): React.ReactElement {
  const subject = item.email_subject?.trim() || null
  const firstMsg = item.first_user_message?.trim() || null
  const title = subject ?? firstMsg ?? t('sessions.untitled')
  const preview = subject ? firstMsg : null
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-full text-left px-3 py-2.5 rounded-lg',
        'border transition-colors duration-fast',
        selected
          ? 'bg-ink-3 border-ink-border'
          : 'bg-transparent border-transparent hover:bg-ink-fg/[0.03]'
      )}
    >
      {selected && (
        <span
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-sm"
          style={{ background: 'rgb(var(--c-accent))' }}
        />
      )}
      <div className="flex items-center gap-2 min-w-0">
        <Mail size={13} strokeWidth={1.75} className="text-ink-fg-3 shrink-0" />
        <span className="text-body font-medium text-ink-fg truncate min-w-0" title={title}>
          {title}
        </span>
      </div>
      {preview && (
        <p className="mt-1 text-meta text-ink-fg-2 line-clamp-1" title={preview}>
          {preview}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-micro font-mono text-ink-fg-3">
        <span className="inline-flex items-center gap-1">
          <Sparkles size={10} strokeWidth={2} className="text-coral" />
          {backendLabel(item, t)}
        </span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1">
          <MessageSquare size={10} strokeWidth={2} />
          {t('chat.sidebar.messageCount', { n: item.message_count })}
        </span>
        <span aria-hidden>·</span>
        <span>{relTime(item.updated_at, t)}</span>
      </div>
    </button>
  )
}

// ─── 左：会话列表面板 ─────────────────────────────────────────────────────────
function SessionListPane({
  items,
  selectedId,
  onSelect,
  query,
  onQuery,
  filter,
  onFilter,
  showFilter,
  title,
  total,
  isLoading,
  fluid,
  t
}: {
  items: ChatSessionListItem[]
  selectedId: number | null
  onSelect: (id: number) => void
  query: string
  onQuery: (v: string) => void
  filter: BackendFilter
  onFilter: (f: BackendFilter) => void
  /** 锁定 backend 时隐藏筛选 chips（per-agent 视图无需筛选）。 */
  showFilter: boolean
  title: string
  total: number
  isLoading: boolean
  fluid?: boolean
  t: TFunction
}): React.ReactElement {
  return (
    // 主题 v2 — 会话列表面板透到页面玻璃底, 不画 ink 实底 (割裂)。
    <div
      className="flex flex-col h-full"
      style={{
        width: fluid ? '100%' : 340,
        flexShrink: 0,
        borderRight: fluid ? 'none' : '1px solid rgb(var(--ink-border))'
      }}
    >
      <div className="shrink-0 px-3.5 pt-3.5 pb-2.5 border-b border-ink-border-soft">
        <div className="flex items-center gap-2 mb-2.5">
          <History size={15} strokeWidth={1.75} className="text-coral" />
          <h2 className="text-body font-semibold text-ink-fg">{title}</h2>
          <span className="text-meta font-mono text-ink-fg-3">{total}</span>
        </div>
        <label className="relative block mb-2.5">
          <Search
            size={13}
            strokeWidth={1.75}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-fg-3 pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t('sessions.searchPlaceholder')}
            aria-label={t('sessions.searchPlaceholder')}
            className={cn(
              'w-full h-8 pl-8 pr-3 rounded-md text-body',
              'input-surface border border-ink-border-soft text-ink-fg',
              'placeholder:text-ink-fg-3 focus:outline-none focus:ring-1 focus:ring-c-accent/40'
            )}
          />
        </label>
        {showFilter && (
          /* v0.7.2 — 统一 SegmentedControl（等分：fluid，对应旧 flex-1）。 */
          <SegmentedControl<BackendFilter>
            value={filter}
            onChange={onFilter}
            ariaLabel={t('sessions.filterLabel')}
            fluid
            className="w-full"
            options={[
              { value: 'all', label: t('sessions.filterAll') },
              { value: 'custom-api', label: t('chat.backend.customApi') }
            ]}
          />
        )}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {isLoading && items.length === 0 ? (
          <div className="px-2 py-6 text-meta text-ink-fg-3">{t('agents.reports.loading')}</div>
        ) : items.length === 0 ? (
          <div className="px-2 py-6 text-meta text-ink-fg-3">{t('sessions.noMatchTitle')}</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((it) => (
              <SessionRow
                key={it.id}
                item={it}
                selected={it.id === selectedId}
                onSelect={() => onSelect(it.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 右：transcript 预览（ReadOnlyTranscript，read-only）───────────────────────
function TranscriptPane({
  session,
  onBack,
  narrow,
  t
}: {
  session: ChatSessionListItem
  onBack?: () => void
  narrow: boolean
  t: TFunction
}): React.ReactElement {
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((s) => s.setActive)
  const msgsQ = useQuery({
    queryKey: qk.chat.messages(session.id),
    queryFn: () => mailApi.chat.listMessages(session.id),
    staleTime: 10_000
  })
  const messages: ChatMessage[] = msgsQ.data ?? []
  const title =
    session.email_subject?.trim() || session.first_user_message?.trim() || t('sessions.untitled')

  const continueInInbox = (): void => {
    // P2c — general (email_id=null, anchor_type='general') sessions aren't anchored
    // to an inbox email, so "continue in inbox" doesn't apply (Cmd+O reopens them
    // in P3). Email sessions navigate to their owning email as before.
    if (session.email_id == null) return
    setActiveEmail(session.email_id, { navTarget: true })
    // 交付文档 §3.1 — pass the session's backend kind so the panel opens on the
    // matching agent (per-kind session scoping).
    openAIChatSession(session.email_id, session.id, session.backend_kind)
    void navigate({ to: '/' })
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="shrink-0 flex items-center gap-2.5 px-4 py-3 border-b border-ink-border-soft">
        {narrow && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('agents.reports.backToList')}
            className="grid place-items-center text-ink-fg-1 hover:text-ink-fg"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
        )}
        <Mail size={14} strokeWidth={1.75} className="text-ink-fg-3 shrink-0" />
        <h2 className="text-body font-semibold text-ink-fg flex-1 truncate min-w-0" title={title}>
          {title}
        </h2>
        <span className="inline-flex items-center gap-1.5 text-meta font-mono text-coral shrink-0">
          <Sliders size={11} strokeWidth={2} />
          {backendLabel(session, t)}
        </span>
        <button
          type="button"
          onClick={continueInInbox}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md text-meta font-medium shrink-0',
            'text-ink-fg-1 bg-transparent border border-ink-border',
            'hover:bg-ink-4 hover:text-ink-fg transition-colors duration-fast'
          )}
        >
          <ExternalLink size={12} strokeWidth={2} />
          {t('agents.chats.continue')}
        </button>
      </div>
      {msgsQ.isLoading ? (
        <div className="flex-1 grid place-items-center text-meta text-ink-fg-3">
          {t('agents.reports.loading')}
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 grid place-items-center text-meta text-ink-fg-3">
          {t('agents.chats.emptyTranscript')}
        </div>
      ) : (
        // read-only transcript — messages 已加载完才 mount（ReadOnlyTranscript 的
        // mount contract）；keyed by session id 切换重挂。
        <ReadOnlyTranscript messages={messages} sessionKey={session.id} />
      )}
    </div>
  )
}

// ─── tab ─────────────────────────────────────────────────────────────────────
// backend 传值 → 锁定该 backend（隐藏筛选 chips，标题用 backend 名）；不传 → 全部
// 会话 + 筛选分类（AI 会话历史）。三处复用：Custom AI=custom-api、Notion Agent 页=
// notion-agent、/sessions=不传（全部）。
export function ChatsTab({ backend }: { backend?: ChatBackendKind } = {}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const narrow = useNarrow()
  const scoped = backend !== undefined
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BackendFilter>('all')
  const [picked, setPicked] = useState<number | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)

  const sessionsQ = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => mailApi.chat.listAllSessions(),
    staleTime: 10_000
  })
  const all = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data])
  // scoped 视图先按 backend 取全集（用于计数 + 空态）。
  const scopedAll = useMemo(
    () => (backend ? all.filter((s) => s.backend_kind === backend) : all),
    [all, backend]
  )
  const effFilter: BackendFilter = scoped ? (backend as BackendFilter) : filter
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((s) => {
      if (effFilter !== 'all' && s.backend_kind !== effFilter) return false
      if (q === '') return true
      return [s.email_subject, s.email_sender, s.first_user_message, s.backend_model]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
  }, [all, query, effFilter])

  // 派生选中：picked 仍在过滤结果里 → 用它，否则回落第一条（避免 set-state-in-effect）。
  const selected = useMemo(() => {
    if (picked !== null) {
      const hit = filtered.find((s) => s.id === picked)
      if (hit) return hit
    }
    return filtered[0] ?? null
  }, [filtered, picked])

  const onSelect = (id: number): void => {
    setPicked(id)
    if (narrow) setMobileDetail(true)
  }

  const title = scoped ? t('chat.backend.customApi') : t('sessions.title')

  const list = (
    <SessionListPane
      items={filtered}
      selectedId={selected?.id ?? null}
      onSelect={onSelect}
      query={query}
      onQuery={setQuery}
      filter={filter}
      onFilter={setFilter}
      showFilter={!scoped}
      title={title}
      total={scopedAll.length}
      isLoading={sessionsQ.isLoading}
      fluid={narrow}
      t={t}
    />
  )

  if (scopedAll.length === 0 && !sessionsQ.isLoading) {
    return (
      <EmptyState
        fill
        icon={<Sparkles size={28} strokeWidth={1.5} />}
        title={t('sessions.emptyTitle')}
        hint={t('sessions.emptyHint')}
      />
    )
  }

  if (narrow) {
    return mobileDetail && selected ? (
      <TranscriptPane session={selected} narrow onBack={() => setMobileDetail(false)} t={t} />
    ) : (
      <div className="h-full w-full">{list}</div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      {selected ? (
        <TranscriptPane session={selected} narrow={false} t={t} />
      ) : (
        <div className="flex-1 grid place-items-center text-meta text-ink-fg-3">
          {t('agents.chats.selectHint')}
        </div>
      )}
    </div>
  )
}
