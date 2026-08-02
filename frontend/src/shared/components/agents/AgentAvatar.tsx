import { useMemo } from 'react'
import { palettes, shapes, type ShapeId } from '@oreo-design/avatar'
import { Avatar } from '@oreo-design/avatar/react'

import type { AgentAvatarConfig } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { resolveAgentAvatar, shuffledAgentAvatar } from './agentAvatarIdentity'

export function AgentAvatar({
  agentId,
  config,
  size = 40,
  title,
  className
}: {
  agentId: string
  config?: AgentAvatarConfig | null
  size?: number
  title?: string
  className?: string
}): React.ReactElement {
  const avatar = useMemo(() => resolveAgentAvatar(agentId, config), [agentId, config])
  return (
    <span
      className={cn('inline-flex shrink-0 overflow-hidden rounded-full', className)}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      <Avatar
        shape={avatar.shape}
        palette={avatar.palette}
        variantId={avatar.variant_id}
        drift={8}
        size={size}
        title={title}
      />
    </span>
  )
}

export function AgentAvatarEditor({
  agentId,
  value,
  onChange,
  shuffleLabel,
  shapeLabel,
  paletteLabel
}: {
  agentId: string
  value?: AgentAvatarConfig | null
  onChange: (value: AgentAvatarConfig) => void
  shuffleLabel: string
  shapeLabel: string
  paletteLabel: string
}): React.ReactElement {
  const resolved = resolveAgentAvatar(agentId, value)
  const setShape = (shape: ShapeId): void => onChange({ ...resolved, shape })

  return (
    <div className="flex flex-col gap-3 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1/45 p-3">
      <div className="flex items-center gap-3">
        <AgentAvatar agentId={agentId} config={resolved} size={52} />
        <div className="min-w-0 flex-1 text-meta text-ink-fg-2">
          {shapes.find((shape) => shape.id === resolved.shape)?.name} ·{' '}
          {palettes.find((palette) => palette.id === resolved.palette)?.name}
        </div>
        <button
          type="button"
          onClick={() => onChange(shuffledAgentAvatar(agentId, resolved))}
          className="h-8 rounded-md border border-ink-border px-3 text-meta font-medium text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 motion-reduce:transition-none"
        >
          {shuffleLabel}
        </button>
      </div>

      <div>
        <div className="mb-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
          {shapeLabel}
        </div>
        <div className="grid grid-cols-6 gap-2">
          {shapes.map((shape) => (
            <button
              key={shape.id}
              type="button"
              aria-label={shape.name}
              aria-pressed={resolved.shape === shape.id}
              title={shape.name}
              onClick={() => setShape(shape.id)}
              className={cn(
                'grid aspect-square place-items-center rounded-lg border transition-colors duration-fast motion-reduce:transition-none',
                resolved.shape === shape.id
                  ? 'border-coral bg-coral/10'
                  : 'border-transparent hover:border-ink-border hover:bg-ink-3'
              )}
            >
              <Avatar
                shape={shape.id}
                palette={resolved.palette}
                variantId={resolved.variant_id}
                drift={8}
                size={32}
              />
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
          {paletteLabel}
        </div>
        <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10">
          {palettes.map((palette) => (
            <button
              key={palette.id}
              type="button"
              aria-label={palette.name}
              aria-pressed={resolved.palette === palette.id}
              title={palette.name}
              onClick={() => onChange({ ...resolved, palette: palette.id })}
              className={cn(
                'grid aspect-square place-items-center rounded-md border transition-transform duration-fast motion-reduce:transition-none',
                resolved.palette === palette.id
                  ? 'scale-110 border-coral bg-coral/10'
                  : 'border-transparent hover:scale-105 hover:border-ink-border'
              )}
            >
              <Avatar
                shape={resolved.shape}
                palette={palette.id}
                variantId={resolved.variant_id}
                drift={8}
                size={24}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
