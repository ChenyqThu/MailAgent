import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  Calendar,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Quote,
  Sparkles,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'

import type { Matter, MatterAttentionSignal, MatterUpdate } from '@shared/api/types/matter'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import {
  deriveFocusStats,
  formatMatterDueRelative,
  isLiveMatter
} from '@shared/lib/matterDerive'
import { cn } from '@shared/lib/cn'

import { AttentionActions } from './attention'
import { ATTENTION_META, attentionTone } from './attentionMeta'
import type { MatterQuickFilter } from './matterListQuery'
import { MatterPip } from './MatterPip'
import {
  MATTER_STATUS_ICONS,
  MATTER_STATUS_TONES,
  MATTER_TONE_TEXT_CLASS,
  matterDueTone
} from './matterVocab'

const DAY = 86_400_000

interface MatterFocusProps {
  matters: readonly Matter[]
  signals: readonly MatterAttentionSignal[]
  updates: ReadonlyMap<string, readonly MatterUpdate[]>
  onSelect(matter: Matter): void
  onReview(matter: Matter, updateId: number): void
  onSignal(matterId: string, signalId: number, action: 'resolved' | 'snoozed' | 'dismissed'): void
  /** V3-13 —— 看板定位改成分诊台：每个 tile 都是带筛选预设的列表入口（切到「事项」tab
   *  并套用对应快捷筛选），不再落到已退役的左轨 view。 */
  onJump(filter: MatterQuickFilter): void
}

export function MatterFocus({
  matters,
  signals,
  updates,
  onSelect,
  onReview,
  onSignal,
  onJump
}: MatterFocusProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [now] = useState(() => Date.now())
  const locale = i18n.language || 'zh-CN'
  const live = matters.filter(isLiveMatter)
  const stats = deriveFocusStats(live, signals, updates, now)
  const matterById = new Map(live.map((matter) => [matter.public_id, matter]))
  const attentionItems = signals
    .filter(
      (signal) =>
        signal.state === 'open' &&
        signal.matter?.public_id &&
        matterById.has(signal.matter.public_id)
    )
    .sort(
      (left, right) =>
        Number(attentionTone(right) === 'critical') - Number(attentionTone(left) === 'critical')
    )
  const reviewItems = [...updates.entries()]
    .flatMap(([matterId, items]) =>
      items
        .filter((item) => item.review_status === 'pending')
        .map((update) => ({ matter: matterById.get(matterId), update }))
    )
    .filter((item): item is { matter: Matter; update: MatterUpdate } => item.matter != null)
  const dueSoon = live
    .filter(
      (matter) =>
        matter.status !== 'done' &&
        matter.status !== 'canceled' &&
        matter.due_at != null &&
        matter.due_at >= now &&
        matter.due_at <= now + 14 * DAY
    )
    .sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0))

  return (
    <section className="h-full overflow-y-auto p-5 scrollbar-thin">
      <div className="mx-auto max-w-[880px] space-y-5">
        <header>
          <h1 className="text-subj font-semibold text-ink-fg">{t('matters.focus.title')}</h1>
          <p className="mt-1 text-body text-ink-fg-2">{t('matters.focus.summary', { ...stats })}</p>
        </header>
        <div className="grid grid-cols-4 gap-3 max-[1000px]:grid-cols-2">
          <StatTile
            label={t('matters.focus.attention')}
            value={stats.attentionCount}
            icon={TriangleAlert}
            tone="critical"
            onClick={() => onJump('attn')}
          />
          <StatTile
            label={t('matters.focus.review')}
            value={stats.reviewCount}
            icon={Sparkles}
            tone="info"
            onClick={() => onJump('proposal')}
          />
          <StatTile
            label={t('matters.focus.due14')}
            value={stats.dueSoonCount}
            icon={Clock3}
            tone="warn"
            // ⚠️ 已知的窗口错位（留给 V3-15 收口）：tile 计数仍是既有的「14 天内到期、不含
            // 逾期」，而落点的 `due` 快捷筛选按设计是「≤7 天、含逾期」。V3-15 会把 tile 与
            // 下方「临近到期」区一起改成 7 天含逾期口径，两处必须同改（计数与列表劈叉的
            // 风险在 gap-list V3-15 有记档），不在本批顺手动。
            onClick={() => onJump('due')}
          />
          <StatTile
            // V3-13 —— 第四 tile 从「健康活跃率」（看了不产生动作）换成「缺少下一步」计数：
            // 四个 tile 的预设钉死为 attn / proposal / due / nonext。判据 = nextAction().kind
            // === 'missing'（deriveFocusStats.missingNextCount，按 kind 不按文案）。
            label={t('matters.focus.nonext')}
            value={stats.missingNextCount}
            icon={CircleHelp}
            tone="warn"
            onClick={() => onJump('nonext')}
          />
        </div>

        {reviewItems.length > 0 ? (
          <section>
            <SectionTitle>{t('matters.focus.reviewSection')}</SectionTitle>
            <div className="space-y-2">
              {reviewItems.map(({ matter, update }) => {
                const sources = update.changes.reduce(
                  (count, change) => count + (change.sources?.length ?? 0),
                  0
                )
                const hasField = update.changes.some((change) => change.kind === 'field')
                return (
                  <button
                    key={update.id}
                    type="button"
                    onClick={() => onReview(matter, update.id)}
                    className="w-full rounded-[var(--r-card)] border border-ai/25 bg-ai/[0.06] p-4 text-left hover:bg-ai/10"
                  >
                    <div className="flex items-center gap-3">
                      <span className="grid size-8 place-items-center rounded-lg bg-ai/15 text-ai">
                        <Sparkles size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-body">{matter.title}</strong>
                        <span className="text-meta font-mono text-ink-fg-2">
                          {matter.public_id} · {formatAgo(update.created_at, now)}
                        </span>
                      </span>
                      <ChevronRight size={16} className="text-ai" />
                    </div>
                    <p className="mt-3 line-clamp-2 text-body text-ink-fg-1">{update.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Chip tone="info">
                        {t('matters.focus.changeCount', { count: update.change_count })}
                      </Chip>
                      {hasField ? (
                        <Chip tone="warn">
                          <ArrowDown size={10} />
                          {t('matters.focus.hasField')}
                        </Chip>
                      ) : null}
                      {sources > 0 ? (
                        <Chip tone="neutral">
                          <Quote size={10} />
                          {t('matters.focus.sourceCount', { count: sources })}
                        </Chip>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        <section>
          <SectionTitle aside={t('matters.focus.attentionHint')}>
            {t('matters.focus.attentionSection')}
          </SectionTitle>
          {attentionItems.length > 0 ? (
            <div className="divide-y divide-ink-border rounded-[var(--r-card)] border border-ink-border bg-ink-1/75">
              {attentionItems.map((signal, index) => {
                const matter = matterById.get(signal.matter?.public_id ?? '')
                if (!matter) return null
                const tone = attentionTone(signal)
                const Icon = ATTENTION_META[signal.kind].icon
                return (
                  <div
                    key={signal.id ?? `${signal.kind}-${index}`}
                    className="group flex items-center gap-3 px-3 py-3"
                  >
                    <span
                      className={cn(
                        'grid size-[22px] shrink-0 place-items-center rounded',
                        tone === 'critical'
                          ? 'bg-fail/12 text-fail'
                          : tone === 'warn'
                            ? 'bg-warn/12 text-warn'
                            : 'bg-ai/12 text-ai'
                      )}
                    >
                      <Icon size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body">{signal.why}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-meta text-ink-fg-2">
                        <button
                          type="button"
                          onClick={() => onSelect(matter)}
                          className="truncate text-ai hover:underline"
                        >
                          {matter.title}
                        </button>
                        <span className="font-mono">{matter.public_id}</span>
                        <span>
                          ·{' '}
                          {formatAgo(signal.last_observed_at ?? signal.first_opened_at ?? now, now)}
                        </span>
                      </span>
                    </span>
                    <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <AttentionActions
                        matterId={matter.public_id}
                        signal={signal}
                        onAction={onSignal}
                        compact
                      />
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <EmptyState
              icon={<CheckCircle2 size={22} className="text-ok" />}
              title={t('matters.focus.attentionEmpty')}
              hint={t('matters.focus.attentionEmptyDetail')}
            />
          )}
        </section>

        <section>
          <SectionTitle>{t('matters.focus.dueSection')}</SectionTitle>
          {dueSoon.length > 0 ? (
            <div className="divide-y divide-ink-border rounded-[var(--r-card)] border border-ink-border bg-ink-1/75">
              {dueSoon.map((matter) => {
                // 设计 §2.5：52px 的 mono **短**文案（相对天数，不带「到期」二字 —— 整段
                // 标题已经写着「临近到期」了），tone 走与清单行同一支 `matterDueTone`，
                // neutral 档染 info（这一段里“还早”不是灰噪音，是可以先放一放的信息）。
                const tone = matterDueTone(matter.due_at, now)
                const StatusIcon = MATTER_STATUS_ICONS[matter.status]
                return (
                  <button
                    key={matter.public_id}
                    type="button"
                    onClick={() => onSelect(matter)}
                    className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-ink-3"
                  >
                    <span
                      title={new Date(matter.due_at as number).toLocaleDateString()}
                      className={cn(
                        'w-[52px] shrink-0 font-mono text-meta tabular-nums',
                        tone === null || tone === 'neutral'
                          ? 'text-ai'
                          : MATTER_TONE_TEXT_CLASS[tone]
                      )}
                    >
                      {formatMatterDueRelative(matter.due_at as number, now, locale)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body">{matter.title}</span>
                    <MatterPip tone={MATTER_STATUS_TONES[matter.status]} icon={StatusIcon}>
                      {t(`matters.status.${matter.status}`)}
                    </MatterPip>
                    <span className="font-mono text-meta text-ink-fg-2">{matter.public_id}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <EmptyState icon={<Calendar size={22} className="text-ok" />} title={t('matters.focus.dueEmpty')} />
          )}
        </section>
      </div>
    </section>
  )
}

function StatTile({
  label,
  value,
  icon: Icon,
  tone,
  onClick
}: {
  label: string
  value: number | string
  icon: LucideIcon
  tone: 'critical' | 'info' | 'warn' | 'success'
  onClick?: () => void
}): React.ReactElement {
  const colors =
    tone === 'critical'
      ? 'text-fail'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'success'
          ? 'text-ok'
          : 'text-ai'
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className="rounded-[var(--r-card)] border border-ink-border bg-ink-1/75 p-4 text-left hover:bg-ink-2"
    >
      {/* 设计 §7.2：语义色从图标扩到数值 —— 数字才是一眼要读的东西，
          只给图标上色等于把语义放在了视线的次要位置。 */}
      <div className="flex items-center justify-between">
        <strong className={cn('text-[24px] leading-none', colors)}>{value}</strong>
        <Icon size={17} className={colors} />
      </div>
      <p className="mt-2 text-meta text-ink-fg-2">{label}</p>
    </Tag>
  )
}
function SectionTitle({
  children,
  aside
}: {
  children: React.ReactNode
  aside?: string
}): React.ReactElement {
  return (
    <h2 className="mb-2 flex items-center justify-between text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
      <span>{children}</span>
      {aside ? (
        <span className="font-normal normal-case tracking-normal text-ink-fg-3">{aside}</span>
      ) : null}
    </h2>
  )
}
function Chip({
  children,
  tone
}: {
  children: React.ReactNode
  tone: 'info' | 'warn' | 'neutral'
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-1 text-meta',
        tone === 'info'
          ? 'bg-ai/10 text-ai'
          : tone === 'warn'
            ? 'bg-warn/10 text-warn'
            : 'bg-ink-3 text-ink-fg-2'
      )}
    >
      {children}
    </span>
  )
}
function formatAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
