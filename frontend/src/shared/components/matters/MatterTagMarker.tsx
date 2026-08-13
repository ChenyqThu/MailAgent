import type { CSSProperties } from 'react'
import { X } from 'lucide-react'

import type { MatterTagColor, MatterTagDefinition, MatterTagShape } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'

type MatterTagVisual = Pick<MatterTagDefinition, 'name' | 'color' | 'shape'>

interface MatterTagMarkerProps {
  color: MatterTagColor
  shape: MatterTagShape
  className?: string
}

function fillStyle(color: MatterTagColor): CSSProperties {
  return { backgroundColor: `rgb(var(${color}))` }
}

function borderStyle(color: MatterTagColor): CSSProperties {
  return { borderColor: `rgb(var(${color}))` }
}

export function MatterTagMarker({
  color,
  shape,
  className
}: MatterTagMarkerProps): React.ReactElement {
  if (shape === 'ring') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}
      >
        <span
          className="h-2.5 w-2.5 rounded-full border-2 bg-transparent"
          style={borderStyle(color)}
        />
      </span>
    )
  }
  if (shape === 'square') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}
      >
        <span className="h-2.5 w-2.5 rounded-[2px]" style={fillStyle(color)} />
      </span>
    )
  }
  if (shape === 'diamond') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}
      >
        <span className="h-2.5 w-2.5 rotate-45 rounded-[2px]" style={fillStyle(color)} />
      </span>
    )
  }
  if (shape === 'bar') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}
      >
        <span className="h-4 w-1.5 rounded-full" style={fillStyle(color)} />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', className)}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={fillStyle(color)} />
    </span>
  )
}

interface MatterTagChipProps {
  tag: MatterTagVisual
  selected?: boolean
  disabled?: boolean
  className?: string
  removeLabel?: string
  onRemove?(): void
}

export function MatterTagChip({
  tag,
  selected = false,
  disabled = false,
  className,
  removeLabel,
  onRemove
}: MatterTagChipProps): React.ReactElement {
  const content = (
    <>
      <MatterTagMarker color={tag.color} shape={tag.shape} />
      <span className="min-w-0 truncate">{tag.name}</span>
      {onRemove ? <X size={11} className="shrink-0 opacity-55" /> : null}
    </>
  )
  const classes = cn(
    // E18（dogfood 轮 2 #18）—— icon（marker）与文本间距原 gap-1.5(6px) 偏宽，收到 gap-1(4px)。
    'inline-flex max-w-full items-center gap-1 rounded-[var(--r-pill)] border px-2 py-1 text-meta',
    'border-ink-border-soft bg-ink-2/65 text-ink-fg-1',
    selected && 'border-coral/35 bg-coral/10 text-ink-fg',
    className
  )
  if (!onRemove) return <span className={classes}>{content}</span>
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onRemove}
      aria-label={removeLabel}
      className={cn(
        classes,
        'transition-[color,background-color,border-color,transform] duration-fast ease-standard',
        'hover:border-fail/35 hover:bg-fail/10 hover:text-fail',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70',
        'active:scale-[0.98] disabled:opacity-50'
      )}
    >
      {content}
    </button>
  )
}
