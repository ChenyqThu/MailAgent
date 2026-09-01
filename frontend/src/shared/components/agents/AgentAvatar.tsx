import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dices } from 'lucide-react'

import type { AgentAvatarConfig } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { BotAvatar } from '@shared/bot-avatar/BotAvatar'
import { useBotAvatarTheme } from '@shared/bot-avatar/useBotAvatarTheme'
import { useShowcaseState } from '@shared/bot-avatar/useShowcaseState'
import { BOT_AVATAR_COLORS, COLORS } from '@shared/bot-avatar/colors'
import { BOT_AVATAR_SHAPES } from '@shared/bot-avatar/shapes'
import type { BotColor, BotShape, BotState } from '@shared/bot-avatar/types'
import { isAgentAvatarImage, resolveAgentAvatar, shuffledAgentAvatar } from './agentAvatarIdentity'
import { avatarShellClass } from './avatarShell'
import { fileToAvatarImage, type AvatarImageFailure } from './avatarImage'

export function AgentAvatar({
  agentId,
  config,
  size = 40,
  title,
  className,
  state = 'idle',
  animated = false
}: {
  agentId: string
  config?: AgentAvatarConfig | null
  size?: number
  title?: string
  className?: string
  /** 状态表情（静态档 = 池首帧离散切换；动画档 = 引擎补间）。 */
  state?: BotState
  /** 默认静态 —— 列表位点不许动画（prd §4.6-3），动画位点显式声明。 */
  animated?: boolean
}): React.ReactElement {
  const avatar = useMemo(() => resolveAgentAvatar(agentId, config), [agentId, config])
  // 上传态（WP7）：同一层裁剪外壳里换成图片，object-cover 兜住非正方源（客户端已裁成
  // 正方，这里是防手改库/未来放宽比例的最后一道）。所有消费点都走本组件，故一处即全局。
  //
  // 0813 dogfood：外壳从 rounded-full 换成圆角方形（avatarShell 单源）。上传图**跟随**
  // 同一档 —— ① 混排列表里 bot 圆角方、上传图正圆 = 又一次口径分裂；② 上传图早已被
  // 客户端居中裁成正方（avatarImage.squareCrop），圆裁是在已经裁过一次的图上再切掉四角，
  // 圆角方形严格**多**露出用户自己的照片。
  const uploaded = isAgentAvatarImage(config) ? config.data : null
  return (
    <span
      className={cn(avatarShellClass(size), className)}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      {uploaded ? (
        <img
          src={uploaded}
          alt={title ?? ''}
          width={size}
          height={size}
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <BotAvatar config={avatar} state={state} size={size} animated={animated} title={title} />
      )}
    </span>
  )
}

// ─── 编辑器（08-12 living-bot-avatar：Grok 化重做）───────────────────────────
// 结构：顶栏 Bot/上传 两 tab + 右侧「重置」（写 null 回派生态）；Bot tab = 48px 动画预览
// （指针跟随 gaze）+ 8 形网格（当前色渲染，静态档）+ 11 色 swatch 圆点 + 随机骰子；
// 上传 tab = 现有 fileToAvatarImage 管线 + 4 错误码 UI 原样迁入。
export function AgentAvatarEditor({
  agentId,
  value,
  onChange
}: {
  agentId: string
  value?: AgentAvatarConfig | null
  onChange: (value: AgentAvatarConfig | null) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const theme = useBotAvatarTheme()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadErr, setUploadErr] = useState<AvatarImageFailure | null>(null)
  const [uploading, setUploading] = useState(false)
  const uploaded = isAgentAvatarImage(value)
  // 初始 tab 跟当前身份走：上传图落上传 tab，其余（bot/legacy/null）落 Bot tab。
  const [tab, setTab] = useState<'bot' | 'upload'>(uploaded ? 'upload' : 'bot')
  // 0813 dogfood：预览随机换动作巡演（Bot tab 可见时常开）——「设置的时候能看到效果」。
  const previewState = useShowcaseState(tab === 'bot')

  // 上传态下 resolve 落到 id 派生基底（prd §6.1）—— 切到 Bot tab 显示派生基底，
  // 点任一候选 = 隐式切回 bot 身份并丢弃图片，故不单设「移除图片」钮。
  const resolved = resolveAgentAvatar(agentId, value)

  // 任何一次落值都清掉上一次上传的报错：否则「原图超过 10MB」之后点换一换/任一候选，
  // 头像明明已经换了，红字还留在原地 —— 看起来像这次操作也失败了。
  const emit = (next: AgentAvatarConfig | null): void => {
    setUploadErr(null)
    onChange(next)
  }
  const setShape = (shape: BotShape): void => emit({ type: 'bot', shape, color: resolved.color })
  const setColor = (color: BotColor): void => emit({ type: 'bot', shape: resolved.shape, color })

  const onPick = (file: File | undefined): void => {
    if (!file) return
    setUploadErr(null)
    setUploading(true)
    void fileToAvatarImage(file)
      .then((result) => {
        if (result.ok) emit(result.avatar)
        else setUploadErr(result.reason)
      })
      .finally(() => setUploading(false))
  }

  const tabClass = (active: boolean): string =>
    cn(
      'h-7 rounded-md px-2.5 text-meta font-medium transition-colors duration-fast motion-reduce:transition-none',
      active ? 'bg-ink-3 text-ink-fg-1' : 'text-ink-fg-2 hover:text-ink-fg-1'
    )

  return (
    <div className="flex flex-col gap-3 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1/45 p-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="avatar-tab-bot"
          aria-pressed={tab === 'bot'}
          onClick={() => setTab('bot')}
          className={tabClass(tab === 'bot')}
        >
          {t('agents.avatar.tabBot')}
        </button>
        <button
          type="button"
          data-testid="avatar-tab-upload"
          aria-pressed={tab === 'upload'}
          onClick={() => setTab('upload')}
          className={tabClass(tab === 'upload')}
        >
          {t('agents.avatar.tabUpload')}
        </button>
        <div className="flex-1" />
        {/* 重置 = 写 null 回派生态（prd §5.1 编辑器保存语义） */}
        <button
          type="button"
          data-testid="avatar-reset"
          onClick={() => emit(null)}
          className="h-7 shrink-0 rounded-md px-2.5 text-meta font-medium text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg-1 motion-reduce:transition-none"
        >
          {t('agents.avatar.reset')}
        </button>
      </div>

      {tab === 'bot' ? (
        <>
          <div className="flex items-center gap-3">
            {/* 编辑预览是动画位点（prd §6.2）：眼睛跟指针 + showcase 随机动作巡演 ——
                编辑时的「活」感展示（0813 dogfood）。 */}
            <span className={avatarShellClass(48)}>
              <BotAvatar
                config={resolved}
                state={previewState}
                size={48}
                animated
                mouseInteractive
              />
            </span>
            <div className="min-w-0 flex-1" />
            <button
              type="button"
              data-testid="avatar-shuffle"
              aria-label={t('agents.avatar.shuffle')}
              title={t('agents.avatar.shuffle')}
              onClick={() => emit(shuffledAgentAvatar(agentId, value))}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-ink-border text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 motion-reduce:transition-none"
            >
              <Dices size={15} aria-hidden />
            </button>
          </div>

          <div>
            <div className="mb-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
              {t('agents.avatar.shape')}
            </div>
            {/* 0813 dogfood：形状排改自适应换行网格（原 grid-cols-8 恒单行 —— 窄容器里
                8 格挤到比格内 30px bot 还小，就是 owner 说的「显示不下」）。auto-fill 按
                容器宽度能塞几列就几列、塞不下自动折行，故对**任意条数**成立（并行批会把
                形状加到 10+，这里不按 8 硬编码）；`min(36px,100%)` 让轨道下限跟着容器收，
                容器再窄也不溢出 ⇒ 结构上产生不了横向滚动条。用 auto-fill 而非 auto-fit：
                auto-fit 会在条数少时把空轨道折叠、把格子拉成大方块。 */}
            <div
              className="grid grid-cols-[repeat(auto-fill,minmax(min(36px,100%),1fr))] gap-1.5"
              data-testid="avatar-shape-grid"
            >
              {BOT_AVATAR_SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-label={shape}
                  aria-pressed={resolved.shape === shape}
                  title={shape}
                  onClick={() => setShape(shape)}
                  className={cn(
                    'grid aspect-square place-items-center rounded-lg border transition-colors duration-fast motion-reduce:transition-none',
                    resolved.shape === shape
                      ? 'border-coral bg-coral/10'
                      : 'border-transparent hover:border-ink-border hover:bg-ink-3'
                  )}
                >
                  <BotAvatar config={{ shape, color: resolved.color }} size={30} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
              {t('agents.avatar.color')}
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="avatar-color-grid">
              {BOT_AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={color}
                  aria-pressed={resolved.color === color}
                  title={color}
                  onClick={() => setColor(color)}
                  className={cn(
                    'grid h-7 w-7 place-items-center rounded-full border transition-transform duration-fast motion-reduce:transition-none',
                    resolved.color === color
                      ? 'scale-110 border-coral'
                      : 'border-transparent hover:scale-105 hover:border-ink-border'
                  )}
                >
                  {/* swatch 圆点用 body 主色（跟随主题），不渲染整只 bot —— Grok 同款纯色点 */}
                  <span
                    aria-hidden
                    className="h-5 w-5 rounded-full border border-ink-border-soft"
                    style={{ background: COLORS[color][theme].body }}
                  />
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <AgentAvatar agentId={agentId} config={value} size={48} />
            {/* 有意不 truncate：上传态那句是「怎么换回去」的唯一提示，宁可折成两行也不要截断。 */}
            <div className="min-w-0 flex-1 text-meta text-ink-fg-2">
              {uploaded ? t('agents.avatar.uploaded') : t('agents.avatar.uploadHint')}
            </div>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="h-8 shrink-0 rounded-md border border-ink-border px-3 text-meta font-medium text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 disabled:opacity-50 motion-reduce:transition-none"
            >
              {uploading ? t('agents.avatar.uploading') : t('agents.avatar.upload')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="avatar-upload-input"
              onChange={(e) => {
                onPick(e.target.files?.[0])
                // 同一张图连选两次也要触发 change（否则第二次静默无反应）。
                e.target.value = ''
              }}
            />
          </div>

          {uploadErr && (
            <div className="text-meta text-fail" role="alert">
              {t(`agents.avatar.uploadErr.${uploadErr}`)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── 抽屉统一身份头部（0804 dogfood 3b/3d/3e）────────────────────────────────
// 五个 agent 抽屉（custom + report/search/preprocess/project_progress 四个预设）共用的
// 「头像 + 名称」并排头部。默认**只**渲染这一行（头像编辑器折叠）—— 编辑器整块常驻会把
// 抽屉首屏吃掉大半（3b）。点「更换」展开 AgentAvatarEditor（Bot/上传 tab + 重置）。
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
  inputStyle,
  meta
}: {
  agentId: string
  value?: AgentAvatarConfig | null
  /** null = 重置回派生态（编辑器「重置」按钮），抽屉侧照常入 patch（avatar: null）。 */
  onChange: (value: AgentAvatarConfig | null) => void
  name: string
  /** 省略 = 该抽屉没有可编辑名称 → 右侧只读展示 name。 */
  onNameChange?: (value: string) => void
  namePlaceholder?: string
  /** 给了就用调用方那份输入框样式（CustomAgentDrawer 沿用抽屉的普通输入框外观）；
   *  省略 = 走内建的标题式输入框（配置页 hero 头）。 */
  inputStyle?: React.CSSProperties
  /** 名称下的一行元信息（模型 / 排程摘要等）。只放现成的事实，缺省就不占位。 */
  meta?: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)

  return (
    <div className="flex flex-col gap-2.5">
      {/* 头像与名字紧邻成一组身份（「更换」是对头像的动作，靠右收在行尾，不再插在两者
          中间把名字推离头像）。56px 基线：hero 头要能一眼看出这是「谁」。 */}
      <div className="flex items-center gap-3">
        <AgentAvatar agentId={agentId} config={value} size={56} />
        <div className="min-w-0 flex-1">
          {onNameChange ? (
            <input
              type="text"
              value={name}
              placeholder={namePlaceholder}
              onChange={(e) => onNameChange(e.target.value)}
              className={
                inputStyle
                  ? undefined
                  : 'w-full rounded-[var(--r-ctl)] border border-transparent bg-transparent px-2 py-1 text-[16px] font-semibold text-ink-fg transition-colors duration-fast hover:border-ink-border-soft hover:bg-ink-1/40 motion-reduce:transition-none'
              }
              style={inputStyle}
            />
          ) : (
            // px-2 与可编辑态输入框的内边距对齐：两态下名字的左边缘落在同一条竖线上。
            <div className="truncate px-2 text-[16px] font-semibold text-ink-fg">{name}</div>
          )}
          {meta && <div className="mt-1 truncate px-2 text-[11.5px] text-ink-fg-3">{meta}</div>}
        </div>
        <button
          type="button"
          aria-expanded={editing}
          onClick={() => setEditing((prev) => !prev)}
          className="h-8 shrink-0 rounded-[var(--r-ctl)] border border-ink-border px-3 text-meta font-medium text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg-1 motion-reduce:transition-none"
        >
          {editing ? t('agents.avatar.collapse') : t('agents.avatar.change')}
        </button>
      </div>

      {editing && <AgentAvatarEditor agentId={agentId} value={value} onChange={onChange} />}
    </div>
  )
}
