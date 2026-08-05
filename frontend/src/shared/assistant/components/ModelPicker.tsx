// W8 模型选择器（task 08-04 WP2，参照 lobe-chat）— **两个 composer 共用一个组件**。
//
// 收编的前身（都已删除，不留双轨）：
//   - `composer.tsx` 的 ComposerModelPicker（邮件面，Cpu 钮 + 裸 model id 扁平列表）
//   - `AgentComposer.tsx` 的 AgentModelPicker + ModelVendorIcon + vendorOf（agent 面，
//     胶囊触发 + 三个内联手绘品牌色 SVG + 按 model-id 前缀正则猜厂商）
// 双 variant 分工抄 ApprovalModePicker / ConnectorQuickPanel 的先例：
//   'icon' = 邮件面 7×7 图标钮 · 'chip' = agent 面 rounded-full 胶囊。
//   composer.tsx:344-347 把「双份漂移」的教训写在案，这里就是它的收敛。
//
// 每行 = 彩色厂商 logo · 模型全名 · 能力 badge · **上下文长度**药丸；hover 出能力卡。
// 选中值仍是完整 providerRef（`providerId:modelId`），写面契约一个字节没变。
//
// 🔴 08-05 dogfood-3 的三处修正（W8 首版做了但 owner 一个都没看到 / 看到的是错的）：
//   ① 元数据**从来就是空的** —— `llm_model` 表在真机上 capabilities/display_name 全 NULL，
//      badge 与药丸恒不渲染。补法是外挂 models.dev 快照（见 useComposerModels 文件头），
//      本文件只管展示；查不到 → 静默降级成裸 id 一行，与引入目录之前逐字一样。
//   ② 药丸语义**改成上下文长度**（原来印的是 maxOutput「最大输出」，和参考产品不是一回事）。
//      maxOutput 搬进 hover 卡。
//   ③ 选中态从 `bg-coral/10 text-coral` 改**中性灰**：彩色 logo + 彩色能力块之后，再来一层
//      coral 整行会打架；参考产品的克制感很大一部分来自这里。
//
// 布局红线（PRD）：邮件面板 360px、左组已 6 控件 —— **升级现有控件、不新增第七个**；
// 弹层 left-0 锚在第 3 个控件（x≈76px）上，宽 264px → 右缘 ≈340 < 348，不越界。
// 能力卡不受这条约束：它 portal 到 body，按视口做响应式定位（见 ModelDetailCard）。
// 不做搜索框（YAGNI 已拍板：lobe 的搜索是几百模型的规模方案，本仓十来个，且 owner 复核
// 时明确说「搜索框确实不关键」）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouter } from '@tanstack/react-router'
import { Brain, ChevronDown, Eye, Settings2, Wrench } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { ProviderBrandIcon } from '@shared/components/icons/providers'
import {
  AI_TAB_ANCHOR_IDS,
  llmProviderAnchorId,
  scrollToAnchorWhenReady
} from '@shared/components/settings/aiTabAnchors'
import {
  DEFAULT_PROVIDER_ID,
  refProviderId,
  stripProviderPrefix
} from '@shared/hooks/useLlmProviders'
import {
  composeComposerModelOption,
  groupComposerModels,
  type ComposerModelOption
} from '@shared/hooks/useComposerModels'

import { ModelDetailCard } from './ModelDetailCard'
import { formatTokens, type ModelDetailAnchor } from './modelDetailCard.lib'
import type { ChatComposerControls } from './composerControlsContext'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

/** 能力位 → 图标 + i18n key + 各自底色。顺序固定（视觉 → 工具 → 推理），跟 Settings 的标签
 *  同一套词。reasoning 复用 Brain（composer 的 extended-thinking 开关同款符号，语义一致）。
 *  底色分色抄参考产品（每类各带浅色底块，不是统一灰）；色值全走 token。 */
const CAPABILITY_ROW = [
  {
    key: 'vision',
    Icon: Eye,
    labelKey: 'settings.providers.models.cap.vision',
    tint: 'bg-info/12 text-info'
  },
  {
    key: 'tools',
    Icon: Wrench,
    labelKey: 'settings.providers.models.cap.tools',
    tint: 'bg-ok/12 text-ok'
  },
  {
    key: 'reasoning',
    Icon: Brain,
    labelKey: 'settings.providers.models.cap.reasoning',
    tint: 'bg-ai/12 text-ai'
  }
] as const

/** 🔴 capabilities === null = 上游与目录都未标注 → 整块不渲染（勿当全 false，prd §4.3b
 *  注记②）。有意不 export（react-refresh/only-export-components：本文件只出组件），
 *  行为由 model_picker.test.tsx 经渲染断言覆盖。 */
function CapabilityBadges({ option }: { option: ComposerModelOption }): React.JSX.Element | null {
  const { t } = useTranslation()
  const caps = option.capabilities
  if (caps === null) return null
  const active = CAPABILITY_ROW.filter((c) => caps[c.key] === true)
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {active.map(({ key, Icon, labelKey, tint }) => (
        <span
          key={key}
          role="img"
          aria-label={t(labelKey)}
          title={t(labelKey)}
          className={cn('grid size-[15px] place-items-center rounded-[3px]', tint)}
        >
          <Icon size={10} strokeWidth={2.25} className="shrink-0" />
        </span>
      ))}
    </span>
  )
}

/** 当前选中值不在启用列表里（Settings 里被取消勾选、或换了 provider）时，仍把它作为一行
 *  显示出来并标「（未启用）」—— 否则菜单里一个 checked 项都没有，用户看不出自己在用什么。
 *  同 provider 的兄弟行能提供 label/protocol 就借来（图标与目录查表因此仍然对）。 */
function withCurrentModel(
  options: ComposerModelOption[],
  current: string | null
): { options: ComposerModelOption[]; orphanRef: string | null } {
  if (current === null || current === '') return { options, orphanRef: null }
  if (options.some((o) => o.ref === current)) return { options, orphanRef: null }
  const providerId = refProviderId(current)
  const sibling = options.find((o) => o.providerId === providerId)
  // 走同一个合成器 → 孤儿行也吃得到目录元数据（否则「被取消勾选的当前模型」会莫名比别的行少
  // 一半信息，看起来像 bug）。
  const orphan = composeComposerModelOption({
    ref: current,
    providerId,
    providerLabel: sibling?.providerLabel ?? null,
    protocol: sibling?.protocol ?? null,
    modelId: stripProviderPrefix(current),
    rowDisplayName: null,
    rowCapabilities: null,
    rowMaxOutput: null
  })
  return { options: [...options, orphan], orphanRef: current }
}

export function ModelPicker({
  controls,
  variant
}: {
  controls: ChatComposerControls
  variant: 'icon' | 'chip'
}): React.JSX.Element | null {
  const { t } = useTranslation()
  // 🔴 `useRouter({ warn: false })` 而不是 `useNavigate()`：后者内部恒 `useRouter()`，在没有
  // RouterProvider 的树里会 console.warn 三行 —— 而两个 composer 的既有单测正是这样渲染的
  // （ConnectorQuickPanel 把 hook 关在展开后的内容里来躲这个，本组件的齿轮躲不掉，因为菜单
  // 一开就在）。真实树里恒有 router；拿不到就把齿轮整个不渲染，不留一个点了会炸的按钮。
  const router = useRouter({ warn: false })
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  // 出入场（WP-03）：配方与同一条工具条上的 MentionPopover 逐字同款（bottom-full 向上展开 →
  // transformOrigin 'bottom left'）。scopeRef 兼作原 menuRef —— hover 卡量的就是这个弹层的 rect。
  // W8 重写这个组件时把旧 ComposerModelPicker 的出入场丢了（motion-gsap.md §8 却一直登记着
  // 「已落地」），这里是把台账补回事实。
  const { shouldRender, scopeRef: menuRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom left' },
    enterDuration: DUR.fast
  })
  // hover 能力卡：{ ref, anchor } —— anchor 在 mouseenter 那一刻从弹层 rect 量一次。
  const [hovered, setHovered] = useState<{ ref: string; anchor: ModelDetailAnchor } | null>(null)

  // 关菜单**恒**走这里：hover 卡是 portal 到 body 的，它的 anchor 是上次量的弹层 rect ——
  // 忘了清，下次开菜单会先闪一张贴在旧位置的卡。（有意不写成「effect 里看 open 变 false 就
  // 清」：那是 setState-in-effect 的级联渲染，规则也拦。）
  const closeMenu = (): void => {
    setOpen(false)
    setHovered(null)
  }

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setHovered(null)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        setHovered(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 打开时把选中项滚进视野（十来个模型也可能超过 320px 的可视高度；恒从顶部开始 = 用户
  // 每次都要自己找当前用的是哪个）。`block: 'nearest'` 而非 'center'：已经可见时不动，
  // 避免开一次弹层就抖一下。
  useEffect(() => {
    if (!open) return
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const current = controls.model
  const { options, orphanRef } = useMemo(
    () => withCurrentModel(controls.availableModels, current),
    [controls.availableModels, current]
  )
  const groups = useMemo(() => groupComposerModels(options), [options])
  const activeOption = options.find((o) => o.ref === current) ?? null
  const hoveredOption = hovered ? (options.find((o) => o.ref === hovered.ref) ?? null) : null

  if (controls.availableModels.length === 0) return null
  const disabled = controls.modelPickerDisabled
  const label = t('chat.composer.model')
  // 触发器文案：优先富元数据的 displayName，其次去前缀的裸 id，最后「切换模型」占位。
  const activeText = activeOption?.displayName ?? (current ? stripProviderPrefix(current) : label)

  const groupLabel = (providerId: string, providerLabel: string | null): string => {
    if (providerLabel) return providerLabel
    if (providerId === DEFAULT_PROVIDER_ID) return t('settings.providers.group.default')
    return providerId
  }

  /** 组标题齿轮：跳设置-AI 的**这一家** provider 卡（找不到就退到「模型服务」整区 —— 卡可能
   *  刚被删）。深链两步走的写法抄 ConnectorQuickPanel 的「管理」按钮。 */
  const openProviderSettings = (providerId: string): void => {
    if (!router) return
    closeMenu()
    void router.navigate({ to: '/settings', search: { tab: 'ai' } })
    scrollToAnchorWhenReady(llmProviderAnchorId(providerId), AI_TAB_ANCHOR_IDS.modelServices)
  }

  const showCard = (optionRef: string): void => {
    const menu = menuRef.current?.getBoundingClientRect()
    if (!menu) return
    setHovered({
      ref: optionRef,
      anchor: { menu: { left: menu.left, right: menu.right, bottom: menu.bottom } }
    })
  }

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && (open ? closeMenu() : setOpen(true))}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        tabIndex={disabled ? -1 : 0}
        className={cn(
          ICON_BTN,
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : open
              ? 'bg-ink-5 text-ink-fg active:scale-[0.96]'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
        )}
      >
        <ProviderBrandIcon
          providerId={activeOption?.providerId ?? (current ? refProviderId(current) : null)}
          protocol={activeOption?.protocol}
          className="size-[14px]"
        />
      </button>
    ) : (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && (open ? closeMenu() : setOpen(true))}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full px-2 text-meta font-medium transition-colors duration-fast',
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : open
              ? 'bg-ink-5 text-ink-fg'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
        )}
      >
        <ProviderBrandIcon
          providerId={activeOption?.providerId ?? (current ? refProviderId(current) : null)}
          protocol={activeOption?.protocol}
        />
        <span className="max-w-[140px] truncate">{activeText}</span>
        <ChevronDown size={13} strokeWidth={2} className="shrink-0 opacity-60" />
      </button>
    )

  return (
    <div className="relative" ref={ref}>
      <HoverTip
        text={disabled ? t('chat.composer.modelHint') : `${label} · ${activeText}`}
        side="top"
      >
        {trigger}
      </HoverTip>
      {shouldRender && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          // 主题 v3 C8/批 4: 紧凑菜单档走 --r-ctl；宽度见文件头「布局红线」。
          // 阴影走 `.glass-pop` 自带的 --pop-shadow（authored 规则排在 utilities 之后，
          // 同特异度源码序胜 —— 再挂 `shadow-[…]` 是死类）。
          className={cn(
            'absolute bottom-full left-0 z-50 mb-1.5 w-[264px] rounded-[var(--r-ctl)] py-1',
            'glass-pop'
          )}
          onMouseLeave={() => setHovered(null)}
        >
          <div className="scrollbar-thin max-h-[320px] overflow-y-auto">
            {groups.map((group) => (
              <div key={group.providerId} role="group">
                {/* 只有一个 provider 时不摆组标题（flag-off 的裸 id 场景、单家用户都属此列）。 */}
                {groups.length > 1 && (
                  <div
                    // 组标题也要清卡：光标从模型行挪到标题上时，卡若不清就变成「悬在标题上却
                    // 显示着上一个模型的详情」。
                    onMouseEnter={() => setHovered(null)}
                    className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-micro font-medium text-ink-fg-3"
                  >
                    <ProviderBrandIcon
                      providerId={group.providerId}
                      protocol={group.options[0]?.protocol}
                      className="size-3"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {groupLabel(group.providerId, group.providerLabel)}
                    </span>
                    {router && (
                      <button
                        type="button"
                        aria-label={t('chat.composer.modelProviderSettings', {
                          name: groupLabel(group.providerId, group.providerLabel)
                        })}
                        title={t('chat.composer.modelProviderSettings', {
                          name: groupLabel(group.providerId, group.providerLabel)
                        })}
                        onClick={() => openProviderSettings(group.providerId)}
                        className="grid size-4 shrink-0 place-items-center rounded text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
                      >
                        <Settings2 size={11} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                )}
                {group.options.map((option) => {
                  const active = option.ref === current
                  const isOrphan = option.ref === orphanRef
                  return (
                    <button
                      key={option.ref}
                      ref={active ? activeRowRef : undefined}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        controls.onModelChange(option.ref)
                        closeMenu()
                      }}
                      onMouseEnter={() => showCard(option.ref)}
                      onFocus={() => showCard(option.ref)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta',
                        'transition-colors duration-fast',
                        // 中性灰选中（08-05 dogfood-3）：hover 用 ink-4，选中再高一档 ink-5，
                        // 两态因此仍分得清。
                        active
                          ? 'bg-ink-5 font-medium text-ink-fg'
                          : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                      )}
                    >
                      <ProviderBrandIcon
                        providerId={option.providerId}
                        protocol={option.protocol}
                        className="size-[14px]"
                      />
                      <span className="min-w-0 flex-1 truncate" title={option.ref}>
                        {option.displayName}
                        {isOrphan && (
                          <span className="ml-1 text-micro text-ink-fg-3">
                            {t('settings.ai.enabledModels.notEnabled')}
                          </span>
                        )}
                      </span>
                      <CapabilityBadges option={option} />
                      {option.contextWindow !== null && (
                        <span
                          className="shrink-0 rounded bg-ink-3 px-1 font-mono text-micro text-ink-fg-3"
                          title={t('chat.composer.modelContext', {
                            tokens: option.contextWindow
                          })}
                        >
                          {formatTokens(option.contextWindow)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* 目录未命中 → catalogMeta 为 null → 整张卡不挂（静默降级，不摆一张空卡）。 */}
      {open && hovered && hoveredOption?.catalogMeta && (
        <ModelDetailCard
          meta={hoveredOption.catalogMeta}
          providerId={hoveredOption.providerId}
          protocol={hoveredOption.protocol}
          anchor={hovered.anchor}
        />
      )}
    </div>
  )
}
