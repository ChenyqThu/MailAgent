// G-14 —— ContextTab 的「关联资料」入口（设计 §2.9 / §2.22 的 660px 三 tab 模态）。
//
// 与批次 2b 的 `MatterLinkPopover` 是**两个 surface**：那个长在邮件侧，回答「这封信属于哪个
// 事项」；这个长在事项侧，回答「这个事项还要挂哪些资料」。方向相反、候选池不同，故不合并。
//
// 三个 tab 的数据来源（全部是真数据，无 mock）：
//   ① 邮件与会话 —— 推荐候选走 `GET /{id}/resource-candidates`（与 Agent 建议同一个候选引擎，
//      但零写入）；搜索走既有 FTS5 邮件搜索 `email.search`（桌面与远程 web 同一条 serve-api）。
//   ② 链接粘贴 —— provider 由域名本地识别（`matterLinkProviders.ts`），连接态取自真实的 MCP
//      connector 行；闸关 / 还没取到 / 这家没有 connector 时说中性话，**不谎报「已连接」**。
//   ③ 附件 —— Q5 裁定只做「本事项已关联邮件的附件」引用，**无本地上传区**；一次批量取
//      （`GET /{id}/resource-attachments`），不按封扇出。

import { useEffect, useMemo, useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link2, Loader2, Mail, Paperclip, Search, Sparkles } from 'lucide-react'

import type {
  Matter,
  MatterMutationResult,
  MatterResourceAttachment,
  MatterResourceCandidate,
  MatterResourceListItem
} from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { fetchConnectorToolsEnabled } from '@shared/components/settings/custom-ai/shared'
import { Checkbox } from '@shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { useConnectorQuickRows } from '@shared/hooks/useConnectorQuickRows'
import { useDebouncedValue } from '@shared/hooks/useDebouncedValue'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import {
  detectMatterLinkProvider,
  deriveMatterLinkTitle,
  isMatterLinkUrlish,
  matterLinkConnectionState,
  normalizeMatterLinkUrl
} from './matterLinkProviders'
import { useMatterMutation } from './matterMutation'
import { useMatterUndoToast } from './useMatterUndoToast'

export type MatterLinkResourceTab = 'mail' | 'link' | 'file'

const MAIL_SEARCH_LIMIT = 25
const RECENT_MAIL_LIMIT = 20
const CANDIDATE_LIMIT = 10
// ⌘K palette 用的也是 250ms（`CommandPalette.tsx::DEBOUNCE_MS`）。
const MAIL_SEARCH_DEBOUNCE_MS = 250

interface MatterLinkResourceModalProps {
  matter: Matter
  /** 已关联资料 —— 用来把候选/搜索里已经挂过的那些剔掉（外部键去重，不靠标题）。 */
  resources: readonly MatterResourceListItem[]
  open: boolean
  /** 打开时预选哪个 tab（G-17 ③「+ 关联」按分组直达）。 */
  initialTab?: MatterLinkResourceTab
  onOpenChange(open: boolean): void
  onChanged(): void
}

interface MailRow {
  internalId: number
  subject: string
  sender: string | null
  date: string | null
  /** 推荐候选才有：为什么它跟这个事项相关（服务端产出的可读理由）。 */
  reason?: string
  confidence?: number
}

interface LinkCard {
  url: string
  title: string
}

export function MatterLinkResourceModal({
  matter,
  resources,
  open,
  initialTab = 'mail',
  onOpenChange,
  onChanged
}: MatterLinkResourceModalProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const mailApi = useMailApi()
  const pushUndoToast = useMatterUndoToast()

  const [tab, setTab] = useState<MatterLinkResourceTab>(initialTab)
  const [search, setSearch] = useState('')
  const [mailPicked, setMailPicked] = useState<number[]>([])
  const [attachmentPicked, setAttachmentPicked] = useState<string[]>([])
  const [rawLinks, setRawLinks] = useState('')
  const [linkOff, setLinkOff] = useState<string[]>([])
  const [subscribeThread, setSubscribeThread] = useState(true)
  const [pinned, setPinned] = useState(false)

  // 每次打开都回到干净状态（tab 跟随调用方的预选）。
  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    setSearch('')
    setMailPicked([])
    setAttachmentPicked([])
    setRawLinks('')
    setLinkOff([])
    setSubscribeThread(true)
    setPinned(false)
  }, [open, initialTab])

  const linkedKeys = useMemo(
    () => new Set(resources.map((item) => item.resource.external_key)),
    [resources]
  )

  // ── tab ① 数据 ───────────────────────────────────────────────────────────
  const candidates = useQuery({
    queryKey: qk.matters.resourceCandidates(matter.public_id),
    queryFn: () => api.listResourceCandidates(matter.public_id, { limit: CANDIDATE_LIMIT }),
    enabled: open,
    staleTime: 30_000
  })

  // LOW-2 —— 与 ⌘K palette 同款 250ms 防抖：不防抖时每敲一个键就是一次 FTS5 全库查询。
  const normalisedSearch = useDebouncedValue(search.trim(), MAIL_SEARCH_DEBOUNCE_MS)
  // 两条路的返回形状不同（`search` 给 SearchHit、`list` 给 EmailMeta），在 queryFn 里就收敛成
  // 这个交集 —— 弹窗只需要这四个字段，把差异挡在数据层比在渲染层各判一次干净。
  const mailSearch = useQuery<MailRow[]>({
    queryKey: qk.matters.resourcePickerMail(normalisedSearch),
    queryFn: async () => {
      if (normalisedSearch) {
        const result = await mailApi.email.search({
          query: normalisedSearch,
          limit: MAIL_SEARCH_LIMIT
        })
        return result.items.map((hit) => ({
          internalId: hit.internal_id,
          subject: hit.subject ?? '',
          sender: hit.sender ?? null,
          date: hit.date_received ?? null
        }))
      }
      // 空 query 走「最近的邮件」。`list` 本来就是 date DESC（`orderBy` 只有 listEnriched
      // 消费），所以不传排序参数 —— 传了也不生效，写上去只会误导下一个读代码的人。
      const items = await mailApi.email.list({ limit: RECENT_MAIL_LIMIT })
      return items.map((item) => ({
        internalId: item.internal_id,
        subject: item.subject ?? '',
        sender: item.sender_name || item.sender || null,
        date: item.date_received ?? null
      }))
    },
    enabled: open && tab === 'mail',
    staleTime: 15_000
  })

  const candidateRows: MailRow[] = useMemo(() => {
    const items = candidates.data?.items ?? []
    return items
      .filter((item: MatterResourceCandidate) => !linkedKeys.has(item.external_key))
      .map((item) => ({
        internalId: item.metadata.internal_id,
        subject: item.title ?? '',
        sender: null,
        date: item.metadata.date_received ?? null,
        reason: item.reason,
        confidence: item.confidence
      }))
      .filter((row) => matchesQuery(row, normalisedSearch))
  }, [candidates.data, linkedKeys, normalisedSearch])

  const searchRows: MailRow[] = useMemo(() => {
    const seen = new Set(candidateRows.map((row) => row.internalId))
    return (mailSearch.data ?? []).filter(
      (row) => !seen.has(row.internalId) && !linkedKeys.has(`email:${row.internalId}`)
    )
  }, [mailSearch.data, candidateRows, linkedKeys])

  // ── tab ② 数据（provider 识别 + 真实连接态） ──────────────────────────────
  const linkCards: LinkCard[] = useMemo(() => {
    const seen = new Set<string>()
    const cards: LinkCard[] = []
    for (const line of rawLinks.split(/[\s\n]+/)) {
      const value = line.trim()
      if (!value || !isMatterLinkUrlish(value)) continue
      const url = normalizeMatterLinkUrl(value)
      if (seen.has(url)) continue
      seen.add(url)
      cards.push({ url, title: deriveMatterLinkTitle(url) })
    }
    return cards
  }, [rawLinks])
  const activeLinkCards = linkCards.filter((card) => !linkOff.includes(card.url))

  const connectorsNeeded = open && tab === 'link' && linkCards.length > 0
  const connectorFlag = useQuery({
    queryKey: qk.chat.config('connectorToolsEnabled'),
    queryFn: fetchConnectorToolsEnabled,
    // 🔴 只在链接 tab 真的有内容要判时才问 —— 打开弹窗本身不该发多余请求。
    enabled: connectorsNeeded,
    staleTime: 30_000,
    retry: false
  })
  // flag 门在 hook 内部（未知 ⇒ 按 off，一个 `/api/connector/*` 都不发）。
  const connectors = useConnectorQuickRows(connectorsNeeded)
  // 🔴 「还没回来」≠「一家都没连」—— 抄 MatterToolFacePanel 的在途计数判据（同一份 qk 构造，
  // 不手抄字面量）：两条查询都不在途，才允许把 unknown 降级成「未连接」。
  const connectorsPending =
    useIsFetching({ queryKey: qk.chat.config('connectorToolsEnabled') }) +
      useIsFetching({ queryKey: qk.connectors() }) >
    0

  // ── tab ③ 数据 ───────────────────────────────────────────────────────────
  const attachments = useQuery({
    queryKey: qk.matters.resourceAttachments(matter.public_id),
    queryFn: () => api.listResourceAttachments(matter.public_id),
    enabled: open && tab === 'file',
    staleTime: 30_000
  })
  const attachmentRows = (attachments.data ?? []).filter(
    (row) => !row.linked && !linkedKeys.has(row.external_key)
  )

  // ── 提交 ─────────────────────────────────────────────────────────────────
  const selectedCount = mailPicked.length + activeLinkCards.length + attachmentPicked.length

  const link = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: async () => {
      const attachmentIndex = new Map(
        (attachments.data ?? []).map((row) => [row.external_key, row])
      )
      // 🔴 逐条串行 + 每条用**上一条返回的 version**：`add_resource` 是带 CAS 的写，一批并发
      // 发出去必然自撞乐观锁（0812 那条「Agent 挂十几份就撞锁」是同一个病根）。
      let version = matter.version
      // G-33 —— 留住最后一条写入的返回，供「只关联了一项」时给 toast 配撤销（见 onSuccess）。
      let lastResult: MatterMutationResult | null = null
      // LOW-3 —— 真正被订阅的会话数。勾了「订阅整条会话」**不等于**每封都能订阅：没有
      // thread_id 的邮件后端会退成单封关联并回一条 `thread_unavailable` warning，按选中数报
      // 就是高报。判据取每次写入自己的 warnings，不靠 UI 侧猜。
      let subscribedThreads = 0
      const advance = (next: MatterMutationResult | null | undefined): void => {
        version = next?.matter?.version ?? version + 1
        lastResult = next ?? null
      }
      for (const internalId of mailPicked) {
        const result = await api.linkResource(
          matter.public_id,
          {
            source_resource: {
              provider: 'mailagent',
              kind: 'email',
              internal_id: internalId,
              link_scope: subscribeThread ? 'thread' : 'single'
            },
            pinned,
            confirmed: true
          },
          { expectedVersion: version, reason: 'user_linked_resource_from_context' }
        )
        if (subscribeThread && !(result.warnings ?? []).includes('thread_unavailable')) {
          subscribedThreads += 1
        }
        advance(result)
      }
      for (const card of activeLinkCards) {
        advance(
          await api.linkResource(
            matter.public_id,
            {
              // 落库形状固定 web/url —— provider 识别只是显示层，见 matterLinkProviders.ts。
              provider: 'web',
              kind: 'url',
              external_key: card.url,
              canonical_url: card.url,
              title: card.title,
              pinned,
              confirmed: true
            },
            { expectedVersion: version, reason: 'user_linked_url_from_context' }
          )
        )
      }
      for (const key of attachmentPicked) {
        const row = attachmentIndex.get(key)
        if (!row) continue
        advance(
          await api.linkResource(
            matter.public_id,
            {
              provider: 'mailagent',
              kind: 'file',
              external_key: row.external_key,
              title: row.filename,
              pinned,
              confirmed: true
            },
            { expectedVersion: version, reason: 'user_linked_attachment_from_context' }
          )
        )
      }
      return {
        version,
        lastResult: lastResult as MatterMutationResult | null,
        subscribedThreads
      }
    },
    // G-33 —— 设计 §2.23：报「关联了几项」+「几条会话被订阅」，订阅是这次操作的**后续影响**，
    // 不说出来用户不知道以后的回复会自动进来。
    // 🔴 撤销只在**恰好一项**时给：后端每次 `add_resource` 只为单条产出 undo descriptor，多选
    // 是 N 次串行写入，拿最后一条的 descriptor 当「撤销」会只撤掉一条却让人以为全撤了。这条
    // 纪律与后端 `len(pending) == 1` 的判据同源。
    onSuccess: (result) => {
      const title = t('matters.linkResource.linkedDetail', {
        count: selectedCount,
        subscribed: result.subscribedThreads
      })
      if (selectedCount === 1) {
        pushUndoToast(title, result.lastResult, matter.public_id)
      } else {
        toastSuccess(title)
      }
      onOpenChange(false)
      onChanged()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const tabs: Array<{ key: MatterLinkResourceTab; icon: typeof Mail; count: number }> = [
    { key: 'mail', icon: Mail, count: mailPicked.length },
    { key: 'link', icon: Link2, count: activeLinkCards.length },
    { key: 'file', icon: Paperclip, count: attachmentPicked.length }
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[84vh] w-[660px] max-w-[calc(100vw-2rem)] grid-rows-[auto_auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>{t('matters.linkResource.title')}</DialogTitle>
          <DialogDescription>{t('matters.linkResource.subtitle')}</DialogDescription>
          {/* V3-25（H3§6.4）—— 摘要按来源分三档，规则说在关联前而不是让人事后猜为什么有的
              资料有摘要、有的没有。DialogDescription 已经是一个 <p>，故另起一行而不是塞进去。 */}
          <p className="text-meta leading-5 text-ink-fg-3">
            {t('matters.linkResource.summaryRule')}
          </p>
        </DialogHeader>

        <div className="flex gap-1">
          {tabs.map((entry) => {
            const active = tab === entry.key
            const TabIcon = entry.icon
            return (
              <button
                key={entry.key}
                type="button"
                aria-pressed={active}
                onClick={() => setTab(entry.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] border px-3 py-1.5 text-aux',
                  'transition-colors duration-fast ease-standard',
                  active
                    ? 'border-coral/30 bg-coral/10 font-medium text-coral'
                    : 'border-transparent text-ink-fg-2 hover:bg-ink-3'
                )}
              >
                <TabIcon size={13} />
                {t(`matters.linkResource.tabs.${entry.key}`)}
                {entry.count > 0 ? (
                  <span className="font-mono text-meta">{entry.count}</span>
                ) : null}
              </button>
            )
          })}
        </div>

        <div className="min-h-0 overflow-y-auto pr-1 scrollbar-thin">
          {tab === 'mail' ? (
            <MailTab
              candidateRows={candidateRows}
              searchRows={searchRows}
              search={search}
              activeQuery={normalisedSearch}
              onSearch={setSearch}
              loading={candidates.isPending || mailSearch.isFetching}
              picked={mailPicked}
              onToggle={(id) =>
                setMailPicked((current) =>
                  current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
                )
              }
              subscribeThread={subscribeThread}
              onSubscribeThread={setSubscribeThread}
            />
          ) : null}

          {tab === 'link' ? (
            <LinkTab
              raw={rawLinks}
              onRaw={setRawLinks}
              cards={linkCards}
              off={linkOff}
              onToggle={(url) =>
                setLinkOff((current) =>
                  current.includes(url)
                    ? current.filter((value) => value !== url)
                    : [...current, url]
                )
              }
              flagEnabled={connectorFlag.data}
              rows={connectors.rows}
              rowsLoaded={!connectorsPending}
            />
          ) : null}

          {tab === 'file' ? (
            <FileTab
              rows={attachmentRows}
              loading={attachments.isPending}
              picked={attachmentPicked}
              onToggle={(key) =>
                setAttachmentPicked((current) =>
                  current.includes(key)
                    ? current.filter((value) => value !== key)
                    : [...current, key]
                )
              }
            />
          ) : null}
        </div>

        <DialogFooter className="items-center justify-start gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-aux text-ink-fg-2">
            <Checkbox checked={pinned} onCheckedChange={setPinned} />
            {t('matters.linkResource.pinAfterLink')}
          </label>
          <span className="ml-auto text-aux text-ink-fg-3">
            {t('matters.linkResource.selected', { count: selectedCount })}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-[var(--r-ctl)] px-3 py-2 text-aux hover:bg-ink-3"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={selectedCount === 0 || link.isPending}
            onClick={() => link.mutate()}
            className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-4 py-2 text-aux font-medium text-accent-fg disabled:opacity-50"
          >
            {link.isPending ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
            {t('matters.linkResource.submit')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function matchesQuery(row: MailRow, query: string): boolean {
  if (!query) return true
  return row.subject.toLowerCase().includes(query.toLowerCase())
}

// ── tab ① 邮件与会话 ────────────────────────────────────────────────────────

function MailTab({
  candidateRows,
  searchRows,
  search,
  activeQuery,
  onSearch,
  loading,
  picked,
  onToggle,
  subscribeThread,
  onSubscribeThread
}: {
  candidateRows: MailRow[]
  searchRows: MailRow[]
  search: string
  /** 防抖后**已经生效**的查询串。分组标题按它取 —— 用 `search` 会在防抖窗口里先把标题改成
   *  「搜索结果」，而底下列的还是上一轮的「最近邮件」。 */
  activeQuery: string
  onSearch(value: string): void
  loading: boolean
  picked: number[]
  onToggle(internalId: number): void
  subscribeThread: boolean
  onSubscribeThread(value: boolean): void
}): React.ReactElement {
  const { t } = useTranslation()
  const empty = candidateRows.length === 0 && searchRows.length === 0
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1.5">
        <Search size={13} className="shrink-0 text-ink-fg-3" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t('matters.linkResource.mailSearchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-aux outline-none placeholder:text-ink-fg-3"
        />
        {loading ? <Loader2 size={12} className="shrink-0 animate-spin text-ink-fg-3" /> : null}
      </label>

      {candidateRows.length > 0 ? (
        <PickerGroup
          label={t('matters.linkResource.groupRelated')}
          count={candidateRows.length}
          hint={t('matters.linkResource.groupRelatedHint')}
        >
          {candidateRows.map((row) => (
            <MailPickRow
              key={row.internalId}
              row={row}
              on={picked.includes(row.internalId)}
              onToggle={() => onToggle(row.internalId)}
            />
          ))}
        </PickerGroup>
      ) : null}

      {searchRows.length > 0 ? (
        <PickerGroup
          label={t(
            activeQuery ? 'matters.linkResource.groupResults' : 'matters.linkResource.groupRecent'
          )}
          count={searchRows.length}
        >
          {searchRows.map((row) => (
            <MailPickRow
              key={row.internalId}
              row={row}
              on={picked.includes(row.internalId)}
              onToggle={() => onToggle(row.internalId)}
            />
          ))}
        </PickerGroup>
      ) : null}

      {empty && !loading ? (
        <EmptyState
          icon={<Mail size={22} />}
          title={t('matters.linkResource.mailEmptyTitle')}
          hint={t('matters.linkResource.mailEmptyHint')}
        />
      ) : null}

      <label className="flex cursor-pointer items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2/60 px-3 py-2.5">
        <Checkbox
          checked={subscribeThread}
          onCheckedChange={onSubscribeThread}
          className="mt-0.5"
        />
        <span className="text-aux leading-5 text-ink-fg-2">
          {t('matters.linkResource.subscribeThread')}
        </span>
      </label>
    </div>
  )
}

function MailPickRow({
  row,
  on,
  onToggle
}: {
  row: MailRow
  on: boolean
  onToggle(): void
}): React.ReactElement {
  return (
    <PickerRow on={on} onToggle={onToggle}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-ink-fg">{row.subject}</span>
        <span className="mt-0.5 block truncate text-meta text-ink-fg-3">
          {[row.sender, row.date ? new Date(row.date).toLocaleDateString() : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {row.reason ? (
          <span className="mt-1 flex items-start gap-1.5 text-meta leading-4 text-ai">
            <Sparkles size={11} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{row.reason}</span>
          </span>
        ) : null}
      </span>
    </PickerRow>
  )
}

// ── tab ② 链接粘贴 ──────────────────────────────────────────────────────────

function LinkTab({
  raw,
  onRaw,
  cards,
  off,
  onToggle,
  flagEnabled,
  rows,
  rowsLoaded
}: {
  raw: string
  onRaw(value: string): void
  cards: LinkCard[]
  off: string[]
  onToggle(url: string): void
  flagEnabled: boolean | undefined
  rows: ReadonlyArray<{ connector_id: string; enabled: boolean; status: string }>
  rowsLoaded: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <textarea
        value={raw}
        onChange={(event) => onRaw(event.target.value)}
        rows={2}
        placeholder={t('matters.linkResource.linkPlaceholder')}
        className="w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 py-2 font-mono text-aux leading-6 text-ink-fg outline-none placeholder:font-sans placeholder:text-ink-fg-3 focus-visible:border-coral/60 focus-visible:ring-2 focus-visible:ring-coral/70"
      />
      {cards.length === 0 ? (
        <EmptyState
          icon={<Link2 size={22} />}
          title={t('matters.linkResource.linkEmptyTitle')}
          hint={t('matters.linkResource.linkEmptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {cards.map((card) => {
            const provider = detectMatterLinkProvider(card.url)
            const ProviderIcon = provider.icon
            const state = matterLinkConnectionState({
              connectorId: provider.connectorId,
              flagEnabled,
              rowsLoaded,
              rows
            })
            const on = !off.includes(card.url)
            const providerName = t(`matters.linkResource.providers.${provider.key}`)
            return (
              <div
                key={card.url}
                className={cn(
                  'flex gap-2.5 rounded-[var(--r-card)] border px-3 py-2.5',
                  on ? 'border-coral/30 bg-coral/[0.05]' : 'border-ink-border bg-ink-2/60'
                )}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={() => onToggle(card.url)}
                  aria-label={card.title}
                  className="mt-0.5"
                />
                <span className="grid size-6 shrink-0 place-items-center rounded bg-ink-4 text-ink-fg-2">
                  <ProviderIcon size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-body font-medium text-ink-fg">
                      {card.title}
                    </span>
                    <span className="rounded-full bg-ink-4 px-2 py-0.5 text-meta text-ink-fg-2">
                      {providerName}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-meta text-ink-fg-3">{card.url}</div>
                  <div className="mt-1 text-meta leading-4 text-ink-fg-2">
                    {/* 🔴 只有真判定为 connected 才说「已连接」。unknown（闸关 / 在途 / 这家没
                        connector）说的是那句在**所有**状态下都成立的地板保证。 */}
                    {state === 'connected'
                      ? t('matters.linkResource.providerConnected', { name: providerName })
                      : state === 'disconnected'
                        ? t('matters.linkResource.providerDisconnected', { name: providerName })
                        : t('matters.linkResource.providerLinkOnly')}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── tab ③ 附件（只引用，无上传 —— Q5） ─────────────────────────────────────

function FileTab({
  rows,
  loading,
  picked,
  onToggle
}: {
  rows: MatterResourceAttachment[]
  loading: boolean
  picked: string[]
  onToggle(key: string): void
}): React.ReactElement {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-aux text-ink-fg-3">
        <Loader2 size={14} className="animate-spin" />
        {t('matters.linkResource.fileLoading')}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Paperclip size={22} />}
        title={t('matters.linkResource.fileEmptyTitle')}
        hint={t('matters.linkResource.fileEmptyHint')}
      />
    )
  }
  return (
    <PickerGroup
      label={t('matters.linkResource.groupAttachments')}
      count={rows.length}
      hint={t('matters.linkResource.groupAttachmentsHint')}
    >
      {rows.map((row) => (
        <PickerRow
          key={row.external_key}
          on={picked.includes(row.external_key)}
          onToggle={() => onToggle(row.external_key)}
        >
          <Paperclip size={13} className="shrink-0 text-ink-fg-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-ink-fg">{row.filename}</span>
            <span className="mt-0.5 block truncate text-meta text-ink-fg-3">
              {[
                formatBytes(row.size_bytes),
                row.email_sender,
                row.email_subject ? `《${row.email_subject}》` : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </PickerRow>
      ))}
    </PickerGroup>
  )
}

function formatBytes(size: number | null): string | null {
  if (size === null || !Number.isFinite(size) || size <= 0) return null
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

// ── 共用分组 / 行 ───────────────────────────────────────────────────────────

function PickerGroup({
  label,
  count,
  hint,
  children
}: {
  label: string
  count: number
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-fg-3">
          {label}
        </span>
        <span className="font-mono text-meta text-ink-fg-3">{count}</span>
        {hint ? <span className="text-meta text-ink-fg-3">{hint}</span> : null}
      </div>
      <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border">
        {children}
      </div>
    </section>
  )
}

function PickerRow({
  on,
  onToggle,
  children
}: {
  on: boolean
  onToggle(): void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 border-t border-ink-border px-3 py-2 first:border-t-0',
        'transition-colors duration-fast ease-standard',
        on ? 'bg-coral/[0.07]' : 'hover:bg-ink-3/60'
      )}
    >
      <Checkbox checked={on} onCheckedChange={onToggle} className="mt-0.5" />
      {children}
    </label>
  )
}
