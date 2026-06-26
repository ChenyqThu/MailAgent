// dogfood-2 — 复刻 assistant-ui demo message-timing.tsx：AI 回复底部「答复时间」badge，hover 显示
// 首 token 耗时 / 总耗时 / 速度(tok/s) / chunks。数据来自 @assistant-ui/react 的 useMessageTiming()
// —— ai-sdk runtime 自动记录 TTFT/总时/速度/chunks，无需后端。流未完成 / legacy ExternalStore 无
// timing 数据时 (`totalStreamTime===undefined`) render null（自动降级）。放进 ActionBarPrimitive.Root
// 内继承 autohide（hover 才显示）。

import type { FC } from 'react'
import { useMessageTiming } from '@assistant-ui/react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@shared/components/ui/tooltip'

function formatTimingMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export const MessageTiming: FC<{
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}> = ({ className, side = 'top' }) => {
  const { t } = useTranslation()
  const timing = useMessageTiming()
  if (timing?.totalStreamTime === undefined) return null

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('agentView.timing.label')}
            className={cn(
              'flex items-center rounded p-1 font-mono text-meta tabular-nums text-ink-fg-3',
              'transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg-1',
              className
            )}
          >
            {formatTimingMs(timing.totalStreamTime)}
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={8}>
          <div className="grid min-w-[8.5rem] gap-1.5 text-meta">
            {timing.firstTokenTime !== undefined && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-ink-fg-3">{t('agentView.timing.firstToken')}</span>
                <span className="font-mono tabular-nums">
                  {formatTimingMs(timing.firstTokenTime)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <span className="text-ink-fg-3">{t('agentView.timing.total')}</span>
              <span className="font-mono tabular-nums">
                {formatTimingMs(timing.totalStreamTime)}
              </span>
            </div>
            {timing.tokensPerSecond !== undefined && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-ink-fg-3">{t('agentView.timing.speed')}</span>
                <span className="font-mono tabular-nums">
                  {timing.tokensPerSecond.toFixed(1)} tok/s
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-4">
              <span className="text-ink-fg-3">{t('agentView.timing.chunks')}</span>
              <span className="font-mono tabular-nums">{timing.totalChunks}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
