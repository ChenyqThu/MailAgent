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
  Trash2,
  type LucideIcon
} from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import type { MatterStakeholderSummary } from '@shared/api/types/matter'
import { RecipientAvatar } from '@shared/components/email/compose/recipient-avatar'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import {
  formatMatterAgo,
  formatMatterDueRelative,
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
import { getOrderedVisibleMatters } from './matterListOrder'
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
/** E10②（dogfood 轮 2）—— 在真正跌进 `NARROW_LIST_WIDTH` 的整段折叠之前，先单独让出
 *  事项编号（`MAT-xxxx`）这一项：它是行 1 里信息密度最低、最不影响一眼判断的一项，比一次性
 *  砍掉优先级/状态整段更省得体。同一个 ResizeObserver 出两档，不另起监听。 */
const ID_HIDE_WIDTH = 440
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

interface MatterListProps {
  matters: readonly Matter[]
  view: MatterView
  selectedId: string | null
  attention?: MatterAttentionIndex
  /** 待审阅徽标的口径 —— 复用工作台既有的 pendingUpdates 查询，清单不自己发请求。 */
  updates?: MatterUpdateIndex
  search: string
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
  onSearchChange,
  onSelect,
  onCreate
}: MatterListProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const paneRef = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  // E10②：与 `narrow` 同一个 ResizeObserver 出两档（宽 → 隐编号 → 整段折叠），不另起监听。
  const [hideId, setHideId] = useState(false)
  // 到期色 / 更新时间的基准时刻在挂载时冻结（react-hooks/purity：render 期间不许调
  // Date.now()）。与 MatterDetail / MatterFocus 同一模式。
  const [now] = useState(() => Date.now())
  const visible = useMemo(
    () => getOrderedVisibleMatters(matters, search, attention),
    [attention, matters, search]
  )
  const locale = i18n.language || 'zh-CN'
  const viewLabel = t(`matters.views.${view}`)

  useEffect(() => {
    const pane = paneRef.current
    if (!pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = entry.contentRect.width
      setNarrow(width < NARROW_LIST_WIDTH)
      setHideId(width < ID_HIDE_WIDTH)
    })
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  const EmptyIcon = EMPTY_VIEW_ICONS[view] ?? (search.trim() ? Search : Layers)

  return (
    <section
      ref={paneRef}
      // E19（dogfood 轮 2 #19）—— 不在这里再画一条分界线：MattersWorkspace 的可拖拽
      // 分隔条（`role="separator"`）已经在列表/详情之间画了唯一一条竖线（design app.jsx
      // 只在 `sel` 存在时给 ListPane 外层套 `borderRight`，即那唯一一条线）；这里再加
      // `border-r` 会与分隔条的线并排出现，变成肉眼可见的双线。
      className="flex h-full min-w-0 flex-col bg-ink-1/55"
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
            narrow={narrow}
            hideId={hideId}
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
  narrow: boolean
  /** E10②—— 比 `narrow` 早一档触发：只让出事项编号，优先级/状态/健康度仍留在行 1。 */
  hideId: boolean
  now: number
  locale: string
  onSelect(): void
}

/**
 * 清单行（设计 `list.jsx::MatterRow`）：三行结构 —— 行 1 标题与身份 + 右端状态、
 * 行 2 下一步 / 到期 / 更新时间 / 头像组、行 3 事项类型与关注信号。
 *
 * E16（dogfood 轮 2 #16，owner 拍板偏离设计稿）—— 行 3 右下角原是最多 3 个标签 chip
 * + `+N` 溢出徽标：标签名长度不可控，行窄时一样会挤爆。改成显示单一的事项类型
 * （`matter.matter_type`，本就是个短字符串，天然没有这个溢出面）；标签仍在详情页 /
 * 左轨标签视图可见，只是清单行不再是它的展示面。
 *
 * R3-#7（dogfood 轮 3 #7）—— 行 3 左右对调：类型（`matter.matter_type`）恒在，挪到左端
 * 撑住这一行；关注信号（`signals`）不是每个事项都有，挪到右端——没有异常状态时右侧空着，
 * 不会像原先「左边空着」那样显得突兀。只动布局位置，不改数据来源与显示判据。
 *
 * E12（dogfood 轮 2 #12，改判前一版）—— 选中态左条改回**通高**（`top-0 bottom-0`，与
 * `EmailRow.is-selected::before` 同一套「通高直角条」几何，ARCHITECTURE §7.3）、常态临界
 * 信号左条维持**胶囊**（`top-2 bottom-2` + 圆角，design `list.jsx::MatterRow` 的
 * `top:8/bottom:8/borderRadius:2` 原样映射）。🔴 覆盖前一批 G-04 的「维持仓库药丸签名，不照抄
 * 设计」这条裁决：`row-selected acc-select` 是**导航面**（sidebar/settings-rail/会话行）专属的
 * 胶囊签名；DESIGN.md §18.1 C4 + 2026-07-12 owner 二次 dogfood 已把 EmailRow 的选中签名改回
 * 「整行 wash + 通高左条」，本行是与 EmailRow 同构的编辑区列表行（`border-b` 逐行分割线、非导航
 * 卡片），沿用 C4 而不是 C5 才是与仓库现状一致——上一版的比对对象本身已经过期。整行 wash 走
 * `--sel-wash`（`AgentThreadList` 同款 `[background-image:var(--sel-wash)]` 写法，非虚拟化列表
 * 不用担心 EmailRow 那套 divider-in-background-image 的合并问题，`border-b` 是独立层）。
 */
function MatterRow({
  matter,
  selected,
  signals,
  pendingCount,
  narrow,
  hideId,
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
        // E10①（dogfood 轮 2）—— 补 whitespace-nowrap：这颗 chip 是 shrink-0，挤压的行里
        // 浏览器不会缩小它，但没有 nowrap 时文字本身会在 chip 内部折成两行（不是"消失"而是
        // "长高"），看起来就是 owner 说的「优先级 chip 换行错乱」。
        'shrink-0 whitespace-nowrap rounded-[var(--r-ctl)] border px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.02em]',
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
        // E12 —— 选中态整行 wash（AgentThreadList 同款 `--sel-wash` 写法）；未选中保留 hover。
        selected ? '[background-image:var(--sel-wash)]' : 'hover:bg-ink-3'
      )}
    >
      {selected ? (
        // 通高直角条（同 EmailRow.is-selected::before 的几何：top-0/bottom-0，方角）。
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-coral/100" />
      ) : critical ? (
        // 胶囊左条（设计 `list.jsx::MatterRow` 的 `top:8/bottom:8/borderRadius:2`）。
        <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-sm bg-fail" />
      ) : null}
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-body font-medium text-ink-fg">{matter.title}</span>
        {/* E10②—— 编号先让位（`hideId`），优先级 chip 撑到真正的窄变体（`narrow`）才让位。 */}
        {!hideId ? (
          <span className="shrink-0 font-mono text-micro tracking-[0.02em] text-ink-fg-3">
            {matter.public_id}
          </span>
        ) : null}
        {!narrow ? priorityTag : null}
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

      {signals.length > 0 || matter.matter_type !== null ? (
        <span className={cn('mt-1.5 flex min-w-0 items-center gap-2', narrow && 'flex-wrap')}>
          {/* E16 —— 单一事项类型徽标取代原来的标签 chip 列表（本就不设上限的用户内容 =
              最容易在窄行溢出的一项，owner 拍板换成天然定长的类型）。
              R3-#7 —— 类型恒在，靠左撑住这一行；无异常状态时右侧留空即可。 */}
          {matter.matter_type !== null ? (
            <span className="max-w-[8.5rem] shrink-0 truncate rounded-full border border-ink-border-soft bg-ink-2/65 px-2 py-0.5 font-mono text-meta text-ink-fg-2">
              {matter.matter_type}
            </span>
          ) : null}
          <span className="flex-1" />
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
