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
// 相对旧版的三项升级（PRD W8 拍板）：
//   ① 按 provider 分组 + 每行厂商 mono logo（图标解析走 providerId/protocol 精确查表，
//      见 icons/providers/index.tsx；**不**按 model id 猜）；
//   ② 每行右侧 vision/tools/reasoning 能力 badge + maxOutput 药丸；
//   ③ 选中值仍是完整 providerRef（`providerId:modelId`），写面契约一个字节没变。
//
// 布局红线（PRD）：邮件面板 360px、左组已 6 控件 —— **升级现有控件、不新增第七个**；
// 弹层 left-0 锚在第 3 个控件（x≈76px）上，宽 264px → 右缘 ≈340 < 348，不越界。
// 不做搜索框（YAGNI 已拍板：lobe 的搜索是几百模型的规模方案，本仓十来个）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, ChevronDown, Eye, Wrench } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { ProviderBrandIcon } from '@shared/components/icons/providers'
import {
  DEFAULT_PROVIDER_ID,
  refProviderId,
  stripProviderPrefix
} from '@shared/hooks/useLlmProviders'
import { groupComposerModels, type ComposerModelOption } from '@shared/hooks/useComposerModels'

import type { ChatComposerControls } from './composerControlsContext'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

/** 能力位 → 图标 + i18n key。顺序固定（视觉 → 工具 → 推理），跟 Settings 的标签同一套词。
 *  reasoning 复用 Brain（composer 的 extended-thinking 开关同款符号，语义一致）。 */
const CAPABILITY_ROW = [
  { key: 'vision', Icon: Eye, labelKey: 'settings.providers.models.cap.vision' },
  { key: 'tools', Icon: Wrench, labelKey: 'settings.providers.models.cap.tools' },
  { key: 'reasoning', Icon: Brain, labelKey: 'settings.providers.models.cap.reasoning' }
] as const

/** maxOutput 药丸文案：64000 → '64K'。<1000 原样（手填小值）。
 *  有意不 export（react-refresh/only-export-components：本文件只出组件），
 *  行为由 model_picker.test.tsx 经渲染断言覆盖。 */
function formatMaxOutput(maxOutput: number): string {
  if (maxOutput >= 1000) return `${Math.round(maxOutput / 1000)}K`
  return String(maxOutput)
}

/** 🔴 capabilities === null = 上游未标注 → 整块不渲染（勿当全 false，prd §4.3b 注记②）。 */
function CapabilityBadges({ option }: { option: ComposerModelOption }): React.JSX.Element | null {
  const { t } = useTranslation()
  const caps = option.capabilities
  if (caps === null) return null
  const active = CAPABILITY_ROW.filter((c) => caps[c.key] === true)
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-ink-fg-3">
      {active.map(({ key, Icon, labelKey }) => (
        <span key={key} role="img" aria-label={t(labelKey)} title={t(labelKey)}>
          <Icon size={11} strokeWidth={2} className="shrink-0" />
        </span>
      ))}
    </span>
  )
}

/** 当前选中值不在启用列表里（Settings 里被取消勾选、或换了 provider）时，仍把它作为一行
 *  显示出来并标「（未启用）」—— 否则菜单里一个 checked 项都没有，用户看不出自己在用什么。
 *  同 provider 的兄弟行能提供 label/protocol 就借来（图标仍然对）。 */
function withCurrentModel(
  options: ComposerModelOption[],
  current: string | null
): { options: ComposerModelOption[]; orphanRef: string | null } {
  if (current === null || current === '') return { options, orphanRef: null }
  if (options.some((o) => o.ref === current)) return { options, orphanRef: null }
  const providerId = refProviderId(current)
  const sibling = options.find((o) => o.providerId === providerId)
  const orphan: ComposerModelOption = {
    ref: current,
    providerId,
    providerLabel: sibling?.providerLabel ?? null,
    protocol: sibling?.protocol ?? null,
    modelId: stripProviderPrefix(current),
    displayName: stripProviderPrefix(current),
    capabilities: null,
    maxOutput: null
  }
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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = controls.model
  const { options, orphanRef } = useMemo(
    () => withCurrentModel(controls.availableModels, current),
    [controls.availableModels, current]
  )
  const groups = useMemo(() => groupComposerModels(options), [options])
  const activeOption = options.find((o) => o.ref === current) ?? null

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

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        tabIndex={disabled ? -1 : 0}
        className={cn(
          ICON_BTN,
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : open
              ? 'bg-coral/10 text-coral active:scale-[0.96]'
              : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
        )}
      >
        <ProviderBrandIcon
          providerId={activeOption?.providerId ?? (current ? refProviderId(current) : null)}
          protocol={activeOption?.protocol}
          className="size-[13px]"
        />
      </button>
    ) : (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full px-2 text-meta font-medium transition-colors duration-fast',
          disabled
            ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
            : open
              ? 'bg-coral/10 text-coral'
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
      {open && (
        <div
          role="menu"
          aria-label={label}
          // 主题 v3 C8/批 4: 紧凑菜单档走 --r-ctl；宽度见文件头「布局红线」。
          className={cn(
            'absolute bottom-full left-0 z-50 mb-1.5 w-[264px] rounded-[var(--r-ctl)] py-1',
            'glass-pop shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
          )}
        >
          <div className="scrollbar-thin max-h-[320px] overflow-y-auto">
            {groups.map((group) => (
              <div key={group.providerId} role="group">
                {/* 只有一个 provider 时不摆组标题（flag-off 的裸 id 场景、单家用户都属此列）。 */}
                {groups.length > 1 && (
                  <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-micro font-medium text-ink-fg-3">
                    <ProviderBrandIcon
                      providerId={group.providerId}
                      protocol={group.options[0]?.protocol}
                      className="size-3"
                    />
                    <span className="truncate">
                      {groupLabel(group.providerId, group.providerLabel)}
                    </span>
                  </div>
                )}
                {group.options.map((option) => {
                  const active = option.ref === current
                  const isOrphan = option.ref === orphanRef
                  return (
                    <button
                      key={option.ref}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        controls.onModelChange(option.ref)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta',
                        'transition-colors duration-fast',
                        active
                          ? 'bg-coral/10 text-coral'
                          : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                      )}
                    >
                      <ProviderBrandIcon
                        providerId={option.providerId}
                        protocol={option.protocol}
                        className="size-[13px]"
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
                      {option.maxOutput !== null && (
                        <span
                          className="shrink-0 rounded bg-ink-3 px-1 font-mono text-micro text-ink-fg-3"
                          title={t('chat.composer.modelMaxOutput', {
                            tokens: option.maxOutput
                          })}
                        >
                          {formatMaxOutput(option.maxOutput)}
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
    </div>
  )
}
