// WP-22「context 环四段明细」（task 08-05）—— 点环弹出的明细面（纯展示，数据由
// ContextUsageRing 备好）。参照物 = lobe-chat 的 Context Details：分段彩条 + 各段行 +
// Total Used / Remaining / Total Available。
//
// 三条与「不撒谎」直接相关的形态决定：
//   ① **Total Used 不带 ≈，各段带**。前者是模型实报的 prompt tokens（权威），后者全是字符数
//      换算（见 contextUsage.lib.ts 的系数注释）。两种数字长得一样却可信度不同，靠 ≈ 区分。
//   ② **上限未知 → 只出各段与已用，不出 Remaining / Total Available**（WP-15 同一条纪律：
//      拿猜的上限编「还能塞多少」比不显示更糟）。
//   ③ **分段条的分母是「各段之和」不是上限**：占用只有 5% 时按上限画会把四段压成看不见的细丝，
//      明细就白开了。「离上限还有多远」由环本体 + 下面的 Remaining 行回答，各司其职。

import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'

import { formatTokens } from './modelDetailCard.lib'

import type { ContextBreakdown, ContextSegmentKey } from './contextUsage.lib'

/** 段色 = 4 个不同色相的调色板色（蓝 / 紫 / 琥珀 / 绿），明暗主题各有一套值。
 *  两条约束：① 避开 warn/fail —— 这两个在本 app 恒表示「出问题了」，当分类色会误导；
 *  ② 不用 accent（coral）—— 它是用户可换的主题色，换到某些色相时会与相邻段撞色，而分类色
 *  的全部价值就是彼此分得开。 */
const SEGMENT_COLOR: Record<ContextSegmentKey, string> = {
  system: 'bg-info',
  tools: 'bg-ai',
  memory: 'bg-impt',
  messages: 'bg-ok'
}

function TotalRow({
  id,
  label,
  value,
  strong
}: {
  id: string
  label: string
  value: string
  strong?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2" data-testid={`context-total-${id}`}>
      <span className="min-w-0 flex-1 truncate text-ink-fg-2">{label}</span>
      <span
        className={cn(
          'shrink-0 tabular-nums',
          strong ? 'font-medium text-ink-fg' : 'text-ink-fg-1'
        )}
      >
        {value}
      </span>
    </div>
  )
}

export function ContextUsageDetails({
  breakdown,
  loading
}: {
  breakdown: ContextBreakdown
  /** 可测段还在拉（/chat/config）。总量先出，段位后到 —— 不为了对齐而让整个面空着。 */
  loading: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { segments, hasSegments, used, limit, remaining, estimateExceedsTotal } = breakdown

  return (
    <>
      <p className="text-meta font-medium text-ink-fg">{t('chat.contextUsage.detailsTitle')}</p>
      <p className="mt-0.5 text-micro text-ink-fg-3">{t('chat.contextUsage.detailsSubtitle')}</p>

      {hasSegments && (
        <>
          {/* 分段条。🔴 宽度只能走内联 style（比例是运行时算的），但它挂在**子元素**上 ——
              被 useExitAnimation 的 reduced-motion 分支 `clearProps:'all'` 清空的只有弹层根，
              子元素不受影响（16b 踩过的是把几何写在根上那一档）。 */}
          <div
            className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-full bg-ink-4"
            data-testid="context-usage-bar"
            aria-hidden="true"
          >
            {segments.map((s) => (
              <span
                key={s.key}
                className={SEGMENT_COLOR[s.key]}
                style={{ width: `${(s.share * 100).toFixed(2)}%` }}
              />
            ))}
          </div>

          <ul className="mt-2 space-y-1">
            {segments.map((s) => (
              <li
                key={s.key}
                data-testid={`context-segment-${s.key}`}
                className="flex items-center gap-2 text-micro"
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', SEGMENT_COLOR[s.key])} />
                <span className="min-w-0 flex-1 truncate text-ink-fg-2">
                  {t(`chat.contextUsage.segment.${s.key}`)}
                </span>
                <span className="shrink-0 tabular-nums text-ink-fg-1">
                  ≈{formatTokens(s.tokens)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {!hasSegments && (
        <p className="mt-2 text-micro leading-snug text-ink-fg-3">
          {loading
            ? t('chat.contextUsage.segmentsLoading')
            : t('chat.contextUsage.segmentsUnavailable')}
        </p>
      )}

      <div className="mt-2 space-y-1 border-t border-ink-border-soft pt-2 text-micro">
        <TotalRow
          id="used"
          label={t('chat.contextUsage.totalUsed')}
          value={formatTokens(used)}
          strong
        />
        {/* 上限未命中 → 这两行整个不出现（见文件头 ②）。 */}
        {typeof limit === 'number' && remaining !== null && (
          <>
            <TotalRow
              id="remaining"
              label={t('chat.contextUsage.remaining')}
              value={formatTokens(remaining)}
            />
            <TotalRow
              id="limit"
              label={t('chat.contextUsage.totalAvailable')}
              value={formatTokens(limit)}
            />
          </>
        )}
      </div>

      {hasSegments && (
        <p className="mt-2 text-micro leading-snug text-ink-fg-3">
          {t('chat.contextUsage.estimateNote')}
          {estimateExceedsTotal ? ` ${t('chat.contextUsage.estimateExceeds')}` : ''}
        </p>
      )}
    </>
  )
}
