// F3 (阶段2·2.6) — 事件状态图例: 状态形态化 (斜纹=暂定 / 空心=待回复 /
// 删除线+灰=已拒绝 / 删除线+深灰=已取消) 的解码器。toolbar sync-pill 旁
// info 入口, CSS-only hover/focus 触发 (.cal-legend-tip, 复刻 .sync-tip
// 模式, 零 JS 状态)。swatch 与消费面同款 CSS 配方 — 图例即样本。

import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const LEGEND_KINDS = ['tentative', 'needs-action', 'declined', 'cancelled'] as const

export function CalendarStatusLegend(): React.ReactElement {
  const { t } = useTranslation()
  const labels: Record<(typeof LEGEND_KINDS)[number], { label: string; shape: string }> = {
    tentative: {
      label: t('calendar.toolbar.legend.tentative', '暂定'),
      shape: t('calendar.toolbar.legend.tentativeShape', '斜纹填充')
    },
    'needs-action': {
      label: t('calendar.toolbar.legend.needsAction', '待回复'),
      shape: t('calendar.toolbar.legend.needsActionShape', '空心描边')
    },
    declined: {
      label: t('calendar.toolbar.legend.declined', '已拒绝'),
      shape: t('calendar.toolbar.legend.declinedShape', '删除线 + 灰')
    },
    cancelled: {
      label: t('calendar.toolbar.legend.cancelled', '已取消'),
      shape: t('calendar.toolbar.legend.cancelledShape', '删除线 + 深灰')
    }
  }
  const aria = t('calendar.toolbar.legend.aria', '事件状态图例')
  return (
    <div className="cal-legend">
      <button type="button" className="nav-btn" aria-label={aria} title={aria}>
        <Info size={13} strokeWidth={2} />
      </button>
      <div className="cal-legend-tip glass-pop" role="tooltip">
        <div className="text-aux text-ink-fg font-medium mb-1">
          {t('calendar.toolbar.legend.title', '事件状态图例')}
        </div>
        {LEGEND_KINDS.map((kind) => (
          <div key={kind} className="cal-legend-row">
            <span className="cal-legend-swatch" data-kind={kind} aria-hidden />
            <span className="cal-legend-label" data-kind={kind}>
              {labels[kind].label}
            </span>
            <span className="cal-legend-shape">{labels[kind].shape}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
