// WP-16b（task 08-05 P1）—— composer 右下的 **effort（思考强度）菜单**，取代旧的 Brain 布尔
// 开关（owner 参照 Notion composer 的信号图标；档位阶梯由 owner 2026-08-05 逐家拍板）。
//
// 数据全部来自 `useComposerEffort`（→ 16a 的 `effortOptionsForModel`）：
//   · 菜单项 = **当前模型**的可选档（切模型档位子集跟着变，manual 族 Claude 有「不思考」、
//     adaptive 族没有 —— 因为那类模型不带 thinking 参数也会自发思考，给 none 是撒谎）；
//   · `applicable === false`（模型没有 reasoning 能力）→ **灰掉**触发器 + 请求体不带 effort 键。
//     🔴 选「灰掉」而不是「隐藏」的两条理由：① 与被它取代的 Brain 开关同款处置（`composer.tsx`
//     旧 ComposerThinkingToggle 也是 disabled + 「不支持」tooltip），肌肉记忆不断；② 隐藏会让
//     工具条在切模型时长度跳变，而 disabled 还能把「为什么没有」讲出来。两者都不撒谎，取前者。
//   · `passthroughUnknown === true`（目录未命中 / 中转方言与协议原生方言错配）→ 菜单底部一句
//     hedge。不说「一定生效」是这个功能的诚实底线：我们只负责把参数按协议发对，上游透不透传
//     不归我们管（crs 双腿已实测透传，见 research/crs-effort-passthrough.md，但那不是全称命题）。
//
// 双 variant 分工抄 ModelPicker / ApprovalModePicker 的先例：'icon' = 邮件面 7×7 方角图标钮 ·
// 'chip' = agent 面 7×7 圆钮。
//
// 🔴 弹层锚定 **right-0**（不是兄弟们的 left-0）：本控件在工具条**右组**（环 / effort / 模型 /
// 发送），左锚会把 200px 弹层推出右边界。origin 同步改 'bottom right'，否则会从右缘外 200px
// 处长出来。出入场配方其余部分与 MentionPopover 逐字同款（WP-03 体系）。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SignalHigh, SignalLow, SignalMedium, SignalZero } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import type { ComposerEffortControl } from '@shared/hooks/useComposerEffort'
import type { EffortTier } from '@shared/modelCatalog/effortTiers'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

/** 档位 → 信号格数。high/xhigh/max 共用满格（图标只有四档形状，硬造第五第六格反而读不出来；
 *  具体是哪一档由菜单里的选中行负责表达）。 */
function TierIcon({ tier, size = 13 }: { tier: EffortTier; size?: number }): React.JSX.Element {
  const props = { size, strokeWidth: 2, className: 'shrink-0' }
  if (tier === 'none') return <SignalZero {...props} />
  if (tier === 'low') return <SignalLow {...props} />
  if (tier === 'medium') return <SignalMedium {...props} />
  return <SignalHigh {...props} />
}

export function EffortPicker({
  control,
  variant
}: {
  control: ComposerEffortControl
  variant: 'icon' | 'chip'
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { shouldRender, scopeRef: menuRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom right' },
    enterDuration: DUR.fast
  })

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

  const disabled = !control.applicable
  const label = t('chat.effort.label')
  const tierLabel = (tier: EffortTier): string => t(`chat.effort.tier.${tier}`)
  const activeText = tierLabel(control.selected)

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => !disabled && setOpen((v) => !v)}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="menu"
      tabIndex={disabled ? -1 : 0}
      className={cn(
        variant === 'icon'
          ? ICON_BTN
          : 'grid size-7 shrink-0 place-items-center rounded-full transition-[color,background-color,transform] duration-fast',
        disabled
          ? 'cursor-not-allowed text-ink-fg-3 opacity-50'
          : open
            ? 'bg-coral/10 text-coral active:scale-[0.96]'
            : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
      )}
    >
      {/* 不适用时恒画空格信号（不拿上一个模型的档位当装饰）。 */}
      <TierIcon tier={disabled ? 'none' : control.selected} size={variant === 'icon' ? 13 : 15} />
    </button>
  )

  return (
    <div className="relative" ref={ref}>
      <HoverTip
        text={disabled ? t('chat.effort.unsupported') : `${label} · ${activeText}`}
        side="top"
      >
        {trigger}
      </HoverTip>
      {shouldRender && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          // 右组控件 → right-0（见文件头）。宽度 200：档位名 + 「默认」标注 + 选中点，够用且
          // 在 320px 窄面里从右缘往左量也不越界。阴影走 `.glass-pop` 自带的 --pop-shadow。
          className={cn(
            'absolute bottom-full right-0 z-50 mb-1.5 w-[200px] rounded-[var(--r-ctl)] py-1',
            'glass-pop'
          )}
        >
          {control.options.map((tier) => {
            const active = tier === control.selected
            return (
              <button
                key={tier}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  control.onSelect(tier)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta',
                  'transition-colors duration-fast',
                  active
                    ? 'bg-coral/10 font-medium text-coral'
                    : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                )}
              >
                <TierIcon tier={tier} />
                <span className="min-w-0 flex-1 truncate">{tierLabel(tier)}</span>
                {tier === control.defaultTier && (
                  <span className="shrink-0 text-micro text-ink-fg-3">
                    {t('chat.effort.default')}
                  </span>
                )}
              </button>
            )
          })}
          {control.passthroughUnknown && (
            <p className="mt-1 border-t border-ink-border-soft px-3 pb-0.5 pt-1.5 text-micro leading-snug text-ink-fg-3">
              {t('chat.effort.hedge')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
