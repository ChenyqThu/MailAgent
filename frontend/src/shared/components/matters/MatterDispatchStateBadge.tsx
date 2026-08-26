/**
 * 一次行动项派发的执行态徽标（L4 批次 3）。详情页的行内 live badge 与例外面的行头共用
 * 同一颗 —— 两处各画一遍就会长成两种「等你回答」，而这一批的整个卖点就是这两个态在
 * 屏幕上分得清。
 *
 * 🔴 只吃后端 `state`，不接受调用方传色 / 传文案：色调表在 `matterDispatchVocab.ts`，
 * 文案在 `matters.dispatch.state.*`。
 */

import { useTranslation } from 'react-i18next'

import type { MatterItemDispatchState } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'

import { MATTER_DISPATCH_STATE_ICONS, MATTER_DISPATCH_STATE_TONES } from './matterDispatchVocab'
import { MATTER_TONE_CHIP_CLASS } from './matterVocab'

export function MatterDispatchStateBadge({
  state,
  className
}: {
  state: MatterItemDispatchState
  className?: string
}): React.ReactElement {
  const { t } = useTranslation()
  const Icon = MATTER_DISPATCH_STATE_ICONS[state]
  return (
    <span
      data-testid="dispatch-state-badge"
      data-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-micro',
        MATTER_TONE_CHIP_CLASS[MATTER_DISPATCH_STATE_TONES[state]],
        className
      )}
    >
      <Icon size={10} strokeWidth={2} />
      {t(`matters.dispatch.state.${state}`)}
    </span>
  )
}
