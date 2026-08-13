import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Ban,
  CheckCircle2,
  CircleHelp,
  Eye,
  Hourglass,
  Layers,
  ListChecks,
  Search,
  Sparkles,
  Tag,
  Trash2,
  type LucideIcon
} from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import type { MatterStakeholderSummary, MatterTagDefinition } from '@shared/api/types/matter'
import { RecipientAvatar } from '@shared/components/email/compose/recipient-avatar'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import {
  formatMatterAgo,
  formatMatterDueRelative,
  matterTagViewName,
  nextAction,
  trashDaysRemaining
} from '@shared/lib/matterDerive'
import { openAttentionFor } from '@shared/lib/matterDerive'
import type {
  MatterAttentionIndex,
  MatterNextActionKind,
  MatterUpdateIndex,
  MatterView
} from '@shared/lib/matterDerive'
import { cn } from '@shared/lib/cn'

import { ATTENTION_META, attentionTone } from './attentionMeta'
import { MatterPip } from './MatterPip'
import { MatterTagChip } from './MatterTagMarker'
import { getOrderedVisibleMatters } from './matterListOrder'
import { matterTagMap, resolveMatterTag } from './matterTags'
import {
  MATTER_HEALTH_ICONS,
  MATTER_HEALTH_TEXT_CLASS,
  MATTER_PRIORITY_TONES,
  MATTER_STATUS_ICONS,
  MATTER_STATUS_TONES,
  MATTER_TONE_CHIP_CLASS,
  MATTER_TONE_TEXT_CLASS,
  matterDueTone
} from './matterVocab'

/** 设计 `list.jsx::ListPane` 用 ResizeObserver 在 360px 处切窄列变体（不是窗口断点：
 *  清单列本身可被用户拖宽拖窄，看窗口就会在拖到 300px 时仍按宽列排）。 */
const NARROW_LIST_WIDTH = 360
/** 设计 `list.jsx:170` `AvatarStack size={19} max={3}`。 */
const AVATAR_STACK_MAX = 3

/** 设计 `list.jsx::nextAction` 每档配的 icon（listcheck / hourglass / ban / eye /
 *  checkcircle / helpcircle）。文案与 tone 由 `matterDerive.nextAction` 给。 */
const NEXT_ACTION_ICONS: Record<MatterNextActionKind, LucideIcon> = {
  action: ListChecks,
  waiting: Hourglass,
  blocker: Ban,
  monitoring: Eye,
  done: CheckCircle2,
  missing: CircleHelp
}

const EMPTY_VIEW_ICONS: Partial<Record<MatterView, LucideIcon>> = {
  archived: Archive,
  trash: Trash2
}

/** 视图 key → 展示名。标签视图的名字是**用户内容**（标签名，永不翻译）；其余走词表。 */
function useMatterViewLabel(view: MatterView): string {
  const { t } = useTranslation()
  return matterTagViewName(view) ?? t(`matters.views.${view}`)
}

interface MatterListProps {
  matters: readonly Matter[]
  view: MatterView
  selectedId: string | null
  attention?: MatterAttentionIndex
  /** 待审阅徽标的口径 —— 复用工作台既有的 pendingUpdates 查询，清单不自己发请求。 */
  updates?: MatterUpdateIndex
  search: string
  tagDefinitions?: readonly MatterTagDefinition[]
  onSearchChange(value: string): void
  onSelect(matter: Matter): void
  onCreate(): void
}

export function MatterList({
  matters,
  view,
  selectedId,
  attention,
  updates,
  search,
  tagDefinitions = [],
  onSearchChange,
  onSelect,
  onCreate
}: MatterListProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const paneRef = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  // 到期色 / 更新时间的基准时刻在挂载时冻结（react-hooks/purity：render 期间不许调
  // Date.now()）。与 MatterDetail / MatterFocus 同一模式。
  const [now] = useState(() => Date.now())
  const visible = useMemo(
    () => getOrderedVisibleMatters(matters, search, attention),
    [attention, matters, search]
  )
  const tagsByName = useMemo(() => matterTagMap(tagDefinitions), [tagDefinitions])
  const locale = i18n.language || 'zh-CN'
  const viewLabel = useMatterViewLabel(view)

  useEffect(() => {
    const pane = paneRef.current
    if (!pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_LIST_WIDTH)
    })
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  const EmptyIcon =
    EMPTY_VIEW_ICONS[view] ??
    (search.trim() ? Search : matterTagViewName(view) !== null ? Tag : Layers)

  return (
    <section
      ref={paneRef}
      className="flex h-full min-w-0 flex-col border-r border-ink-border bg-ink-1/55"
    >
      <div className="border-b border-ink-border p-3">
        <label className="flex items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-2">
          <Search size={14} className="text-ink-fg-2" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            // 设计 list.jsx:364 —— placeholder 跟随当前视图名，而不是一句放之四海的通用提示。
            placeholder={t('matters.list.searchInView', { view: viewLabel })}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-ink-fg-2"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {visible.map((matter) => (
          <MatterRow
            key={matter.public_id}
            matter={matter}
            selected={selectedId === matter.public_id}
            signals={openAttentionFor(matter, attention)}
            pendingCount={
              updates?.get(matter.public_id)?.filter((update) => update.review_status === 'pending')
                .length ?? 0
            }
            tagsByName={tagsByName}
            narrow={narrow}
            now={now}
            locale={locale}
            onSelect={() => onSelect(matter)}
          />
        ))}
        {visible.length === 0 ? (
          <EmptyState
            icon={<EmptyIcon size={22} />}
            title={
              search.trim()
                ? t('matters.empty.search', { query: search.trim() })
                : view === 'trash'
                  ? t('matters.empty.trash')
                  : view === 'archived'
                    ? t('matters.empty.archived')
                    : t('matters.empty.default', { view: viewLabel })
            }
            hint={
              search.trim()
                ? t('matters.empty.hintSearch')
                : view === 'trash'
                  ? t('matters.empty.hintTrash')
                  : view === 'archived'
                    ? t('matters.empty.hintArchived')
                    : t('matters.empty.hintDefault')
            }
            className="px-5 py-12"
            action={
              view !== 'trash' && view !== 'archived' ? (
                <button
                  type="button"
                  onClick={onCreate}
                  className="rounded-[var(--r-ctl)] bg-coral/100 px-3 py-2 text-body font-medium text-accent-fg"
                >
                  {t('matters.create.submit')}
                </button>
              ) : null
            }
          />
        ) : null}
      </div>
    </section>
  )
}

interface MatterRowProps {
  matter: Matter
  selected: boolean
  signals: ReturnType<typeof openAttentionFor>
  pendingCount: number
  tagsByName: ReadonlyMap<string, MatterTagDefinition>
  narrow: boolean
  now: number
  locale: string
  onSelect(): void
}

/**
 * 清单行（设计 `list.jsx::MatterRow`）：三行结构 —— 行 1 标题与身份 + 右端状态、
 * 行 2 下一步 / 到期 / 更新时间 / 头像组、行 3 关注信号与标签。
 *
 * 🔴 选中态**维持仓库 v3 药丸签名**（`row-selected acc-select`），不照抄设计的
 * `accent/0.07` 底 + 3px 左条：主题 v3 的选中签名是全仓统一的，列表行破例就会与
 * 邮件列表、导航面各说各话（HANDOFF §0「样式接仓库 token」）。
 */
function MatterRow({
  matter,
  selected,
  signals,
  pendingCount,
  tagsByName,
  narrow,
  now,
  locale,
  onSelect
}: MatterRowProps): React.ReactElement {
  const { t } = useTranslation()
  const trashDays = trashDaysRemaining(matter, now)
  const critical = signals.some((signal) => signal.severity === 'critical')
  const action = nextAction(matter)
  const ActionIcon = NEXT_ACTION_ICONS[action.kind]
  const HealthIcon = MATTER_HEALTH_ICONS[matter.health]
  const StatusIcon = MATTER_STATUS_ICONS[matter.status]
  const dueTone = matterDueTone(matter.due_at, now)
  const people = matter.stakeholder_summary ?? []

  const statusChip = (
    <MatterPip tone={MATTER_STATUS_TONES[matter.status]} icon={StatusIcon}>
      {t(`matters.status.${matter.status}`)}
    </MatterPip>
  )
  const priorityTag = (
    <span
      className={cn(
        'shrink-0 rounded-[var(--r-ctl)] border px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.02em]',
        MATTER_TONE_CHIP_CLASS[MATTER_PRIORITY_TONES[matter.priority]]
      )}
    >
      {matter.priority.toUpperCase()}
    </span>
  )
  const updatedAgo = (
    <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
      {formatMatterAgo(matter.updated_at, now, locale)}
    </span>
  )
  const avatars = <MatterAvatarStack people={people} total={matter.stakeholder_count ?? 0} />

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative block w-full border-b border-ink-border px-4 py-2.5 text-left transition-colors duration-fast',
        // Theme v3 mapping: prototype tone colors map to repository semantic tokens;
        // selection keeps the canonical wash + left-bar signature instead of inline colors.
        selected ? 'row-selected acc-select' : 'hover:bg-ink-3',
        !selected && critical && 'border-l-[3px] border-l-fail'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-body font-medium text-ink-fg">{matter.title}</span>
        {!narrow ? (
          <>
            <span className="shrink-0 font-mono text-micro tracking-[0.02em] text-ink-fg-3">
              {matter.public_id}
            </span>
            {priorityTag}
          </>
        ) : null}
        {/* 设计 ui.jsx:29 `HealthChip bare` —— 只留 icon，同色无底无边。 */}
        <span
          title={t(`matters.health.${matter.health}`)}
          className={cn('inline-flex shrink-0', MATTER_HEALTH_TEXT_CLASS[matter.health])}
        >
          <HealthIcon size={12} strokeWidth={2.4} />
        </span>
        {pendingCount > 0 ? (
          <MatterPip tone="info" icon={Sparkles}>
            {t('matters.views.review')}
          </MatterPip>
        ) : null}
        {matter.archived_at !== null && matter.deleted_at === null ? (
          <MatterPip tone="neutral" icon={Archive}>
            {t('matters.list.archived')}
          </MatterPip>
        ) : null}
        {matter.deleted_at !== null ? (
          <MatterPip tone="critical" icon={Trash2}>
            {t('matters.list.trashDays', { count: trashDays ?? 0 })}
          </MatterPip>
        ) : null}
        <span className="flex-1" />
        {!narrow ? statusChip : null}
      </span>

      <span className="mt-1.5 flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'inline-flex min-w-0 flex-1 items-center gap-1.5 text-meta',
            action.tone === 'neutral' ? 'text-ink-fg-1' : MATTER_TONE_TEXT_CLASS[action.tone]
          )}
        >
          <ActionIcon size={12} className="shrink-0" />
          <span className="truncate">
            {action.title !== null
              ? t(`matters.nextAction.${action.kind}`, { title: action.title })
              : t(`matters.nextAction.${action.kind}`)}
          </span>
        </span>
        {matter.due_at !== null && dueTone !== null ? (
          <span
            title={new Date(matter.due_at).toLocaleDateString()}
            className={cn(
              'shrink-0 text-micro tabular-nums',
              dueTone === 'neutral' ? 'text-ink-fg-3' : MATTER_TONE_TEXT_CLASS[dueTone]
            )}
          >
            {t('matters.list.dueRelative', {
              value: formatMatterDueRelative(matter.due_at, now, locale)
            })}
          </span>
        ) : null}
        {!narrow ? (
          <>
            {updatedAgo}
            {avatars}
          </>
        ) : null}
      </span>

      {narrow ? (
        <span className="mt-1.5 flex min-w-0 items-center gap-2">
          {statusChip}
          {priorityTag}
          <span className="flex-1" />
          {updatedAgo}
          {avatars}
        </span>
      ) : null}

      {signals.length > 0 || matter.tags.length > 0 ? (
        <span className={cn('mt-1.5 flex min-w-0 items-center gap-2', narrow && 'flex-wrap')}>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {signals.map((signal) => {
              const SignalIcon = ATTENTION_META[signal.kind].icon
              return (
                <MatterPip key={signal.id} tone={attentionTone(signal)} icon={SignalIcon}>
                  {t(`matters.attention.kind.${signal.kind}`)}
                </MatterPip>
              )
            })}
          </span>
          <span className="flex-1" />
          <span className="flex shrink-0 items-center gap-1">
            {matter.tags.slice(0, 3).map((tag) => (
              <MatterTagChip
                key={tag}
                tag={resolveMatterTag(tagsByName, tag)}
                className="max-w-[8.5rem] py-0.5"
              />
            ))}
            {matter.tags.length > 3 ? (
              <span className="rounded-[var(--r-pill)] border border-ink-border-soft bg-ink-2/65 px-2 py-0.5 font-mono text-meta text-ink-fg-2">
                +{matter.tags.length - 3}
              </span>
            ) : null}
          </span>
        </span>
      ) : null}
    </button>
  )
}

/** 设计 `ui.jsx::AvatarStack`：重叠头像 + 超出档的 `+N`。头像复用仓库既有的 `.avatar`
 *  调色板（`RecipientAvatar`）—— 同一个人在邮件列表与事项清单里必须是同一种颜色。 */
function MatterAvatarStack({
  people,
  total
}: {
  people: readonly MatterStakeholderSummary[]
  total: number
}): React.ReactElement | null {
  if (people.length === 0) return null
  const shown = people.slice(0, AVATAR_STACK_MAX)
  const rest = total - shown.length
  return (
    <span className="inline-flex shrink-0 items-center">
      {shown.map((person, index) => (
        <span
          key={person.email_normalized ?? person.display_name ?? index}
          title={person.display_name ?? person.email_normalized ?? undefined}
          className={cn('flex rounded-full ring-[1.5px] ring-ink-1', index > 0 && '-ml-1.5')}
        >
          <RecipientAvatar
            name={person.display_name ?? ''}
            email={person.email_normalized ?? ''}
            size={19}
          />
        </span>
      ))}
      {rest > 0 ? <span className="ml-1 text-micro text-ink-fg-3">+{rest}</span> : null}
    </span>
  )
}
