import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
        <div className="grid grid-cols-6 gap-2" data-testid="avatar-shape-grid">
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
              {/* background={null} —— 库默认给 SVG 铺一层**不透明方形底 rect**，且它画在圆形
                  mask 之外 → 网格项四角常年露色块。本 App 从不传 appearance（恒 light）→ 那层
                  底恒 #ffffff，所以**深色主题下也是白边**（库的 #0b0b0d 深色底走不到）。顶层列表
                  的 AgentAvatar 靠 overflow-hidden+rounded-full 裁掉了它，网格项没有那层裁剪。
                  圆内像素不受影响：六个 shape 的 body 首元素都是 opacity=1、无 filter、包住整个
                  mask 圆盘的满幅圆角 rect，底色从来看不见（去掉后 SVG 只少这一行）。 */}
              <Avatar
                shape={shape.id}
                palette={resolved.palette}
                variantId={resolved.variant_id}
                drift={8}
                size={32}
                background={null}
              />
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
          {paletteLabel}
        </div>
        <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10" data-testid="avatar-palette-grid">
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
              {/* 同上：消掉库自带的方形底 rect（见形状网格注释）。 */}
              <Avatar
                shape={resolved.shape}
                palette={palette.id}
                variantId={resolved.variant_id}
                drift={8}
                size={24}
                background={null}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── 抽屉统一身份头部（0804 dogfood 3b/3d/3e）────────────────────────────────
// 五个 agent 抽屉（custom + report/search/preprocess/project_progress 四个预设）共用的
// 「头像 + 名称」并排头部。默认**只**渲染这一行（头像编辑器折叠）—— 编辑器整块常驻会把
// 抽屉首屏吃掉大半（3b）。点「更换」展开 AgentAvatarEditor（换一换 + 形状/配色网格）。
//
// 名称语义按抽屉现状分两态：给了 onNameChange = 可编辑输入框（custom / search，它们本来
// 就有 title 字段）；省略 = 只读展示（三个预设单例行没有可编辑名称，保存 patch 只带 avatar）。
export function AgentIdentityHeader({
  agentId,
  value,
  onChange,
  name,
  onNameChange,
  namePlaceholder,
  inputStyle
}: {
  agentId: string
  value?: AgentAvatarConfig | null
  onChange: (value: AgentAvatarConfig) => void
  name: string
  /** 省略 = 该抽屉没有可编辑名称 → 右侧只读展示 name。 */
  onNameChange?: (value: string) => void
  namePlaceholder?: string
  /** 可编辑态的输入框样式（各抽屉复用自己那份 inputStyle，避免视觉漂移）。 */
  inputStyle?: React.CSSProperties
}): React.ReactElement {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)

  return (
    <div className="flex flex-col gap-2.5">
      {/* 单行 48px 基线：头像 / 「更换」/ 名称三者垂直居中对齐（左列若竖排堆按钮，
          名称输入框的中线会与头像中线错开一截）。 */}
      <div className="flex items-center gap-3">
        <AgentAvatar agentId={agentId} config={value} size={48} />
        <button
          type="button"
          aria-expanded={editing}
          onClick={() => setEditing((prev) => !prev)}
          className="h-8 shrink-0 rounded-[var(--r-ctl)] border border-ink-border px-3 text-meta font-medium text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg-1 motion-reduce:transition-none"
        >
          {editing ? t('agents.avatar.collapse') : t('agents.avatar.change')}
        </button>
        <div className="min-w-0 flex-1">
          {onNameChange ? (
            <input
              type="text"
              value={name}
              placeholder={namePlaceholder}
              onChange={(e) => onNameChange(e.target.value)}
              style={inputStyle}
            />
          ) : (
            <div
              className="truncate"
              style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}
            >
              {name}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <AgentAvatarEditor
          agentId={agentId}
          value={value}
          onChange={onChange}
          shuffleLabel={t('agents.avatar.shuffle')}
          shapeLabel={t('agents.avatar.shape')}
          paletteLabel={t('agents.avatar.palette')}
        />
      )}
    </div>
  )
}
