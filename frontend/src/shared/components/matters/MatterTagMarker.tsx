import type { CSSProperties } from 'react'
import { X } from 'lucide-react'

import type { MatterTagColor, MatterTagDefinition, MatterTagShape } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'

type MatterTagVisual = Pick<MatterTagDefinition, 'name' | 'color' | 'shape'>

/** `md` = picker 行 / 管理器（设计 TagMark size 8）；`sm` = 标签 chip 里的小标（size 6）。 */
type MatterTagMarkerSize = 'sm' | 'md'

interface MatterTagMarkerProps {
  color: MatterTagColor
  shape: MatterTagShape
  size?: MatterTagMarkerSize
  className?: string
}

function fillStyle(color: MatterTagColor): CSSProperties {
  return { backgroundColor: `rgb(var(${color}))` }
}

function borderStyle(color: MatterTagColor): CSSProperties {
  return { borderColor: `rgb(var(${color}))` }
}

const WELL_CLASS: Record<MatterTagMarkerSize, string> = {
  sm: 'inline-flex h-2 w-2 shrink-0 items-center justify-center',
  md: 'inline-flex h-4 w-4 shrink-0 items-center justify-center'
}

/** 每形状按尺寸档取标记本体的几何（设计 matter-agent.jsx:47-56 `TagMark`）。 */
const MARK_CLASS: Record<MatterTagShape, Record<MatterTagMarkerSize, string>> = {
  circle: { sm: 'h-1.5 w-1.5 rounded-full', md: 'h-2.5 w-2.5 rounded-full' },
  ring: {
    sm: 'h-1.5 w-1.5 rounded-full border-[1.5px] bg-transparent',
    md: 'h-2.5 w-2.5 rounded-full border-2 bg-transparent'
  },
  square: { sm: 'h-1.5 w-1.5 rounded-[1px]', md: 'h-2.5 w-2.5 rounded-[2px]' },
  diamond: {
    sm: 'h-[5px] w-[5px] rotate-45 rounded-[1px]',
    md: 'h-2.5 w-2.5 rotate-45 rounded-[2px]'
  },
  bar: { sm: 'h-2 w-[3px] rounded-full', md: 'h-4 w-1.5 rounded-full' }
}

export function MatterTagMarker({
  color,
  shape,
  size = 'md',
  className
}: MatterTagMarkerProps): React.ReactElement {
  return (
    <span aria-hidden="true" className={cn(WELL_CLASS[size], className)}>
      <span
        className={MARK_CLASS[shape][size]}
        style={shape === 'ring' ? borderStyle(color) : fillStyle(color)}
      />
    </span>
  )
}

interface MatterTagChipProps {
  tag: MatterTagVisual
  disabled?: boolean
  className?: string
  removeLabel?: string
  onRemove?(): void
}

/**
 * 标签 chip —— 轮 3 #2：按设计 matter-agent.jsx:113-128 用**标签自己的颜色**上色
 * （文字 = 标签色 · 底 = 色/0.1 · 边 = 色/0.26），不再是一律中性 ink 的胶囊；
 * 圆角是小矩形档（设计 5 → `--r-ctl`），移除钮是 chip **内部**一枚 13px 小 x
 * （常驻 55% 透明度，hover 全亮 + 色/0.18 底），不再整颗 chip 都是删除按钮。
 *
 * 颜色经 `--tag-c` 这个局部 CSS 变量进 Tailwind 任意值类（值是 token 引用不是字面量），
 * hover 态才能用类表达 —— 同 `MatterTagMarker` 的 token-var 用法。
 */
export function MatterTagChip({
  tag,
  disabled = false,
  className,
  removeLabel,
  onRemove
}: MatterTagChipProps): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-[var(--r-ctl)] border py-1 pl-[7px] pr-[5px] text-micro leading-none',
        'border-[rgb(var(--tag-c)/0.26)] bg-[rgb(var(--tag-c)/0.1)] text-[rgb(var(--tag-c))]',
        className
      )}
      style={{ '--tag-c': `var(${tag.color})` } as CSSProperties}
    >
      <MatterTagMarker color={tag.color} shape={tag.shape} size="sm" />
      <span className="min-w-0 truncate">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          aria-label={removeLabel}
          className={cn(
            'grid size-[13px] shrink-0 place-items-center rounded-[3px] opacity-55',
            'transition-[opacity,background-color] duration-fast ease-standard',
            'hover:bg-[rgb(var(--tag-c)/0.18)] hover:opacity-100',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-coral/70',
            'disabled:opacity-40'
          )}
        >
          <X size={8} strokeWidth={3} />
        </button>
      ) : null}
    </span>
  )
}
