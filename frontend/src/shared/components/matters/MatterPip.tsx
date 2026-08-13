import type { ComponentType } from 'react'

import { cn } from '@shared/lib/cn'

import { MATTER_TONE_CHIP_CLASS } from './matterVocab'
import type { MatterTone } from './matterVocab'

/** 设计 `ui.jsx::Pip`（sm 档）：tone 色 12% 底 + 25% 边 + 同色前景。底与边一律取
 *  `MATTER_TONE_CHIP_CLASS` 单源，不在这里另写一套 alpha。
 *
 *  住在自己的文件里而不是某个页面组件内：清单行（`MatterList`）、聚焦页的临近到期行
 *  （`MatterFocus`）、⌘K 命中行（`MatterHitRow`）三处要的是**同一颗** StatusChip，抄第二份
 *  就会漂（同一个状态在三个面前长得不一样是最容易被忽略的那类不一致）。 */
export function MatterPip({
  tone,
  icon: Icon,
  className,
  children
}: {
  tone: MatterTone
  // 收得比 `LucideIcon` 宽一档：attention 词表里的 icon 是 `ComponentType<{size,className}>`，
  // 与 lucide 的 ForwardRefExoticComponent 不互相赋值，取两者的公共调用形状。
  icon: ComponentType<{ size?: number; className?: string }>
  className?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--r-ctl)] border px-1.5 py-px text-[10.5px] leading-4',
        MATTER_TONE_CHIP_CLASS[tone],
        className
      )}
    >
      <Icon size={10} className="shrink-0" />
      {children}
    </span>
  )
}
