// 07-16 approval-mode switcher — composer chip for the OWNER-GLOBAL chat approval mode
// (Manual / Bypass Permissions, Claude Code permission-mode 参照).
// 08-05 WP-11 — 'acceptEdits' 已退役：三档 → 二档，Manual 档下弹不弹卡由 per-tool 审批档决定
// （设置 → AI → 工具审批档；原 acceptEdits 集合降级为那里的「编辑放行」一键预设）。菜单底部
// 加了指向该设置区的入口行。
//
// One shared component, two visual variants (双 composer 落点):
//   - 'icon' — 7×7 icon button, ThreadComposer's toolbar row (ComposerModelPicker 同款尺寸；弹层
//     锚定跟着控件位置走 —— 见下方 role="menu" 处的算式，08-05 WP-13 重排后 icon 面改回 left-0)
//   - 'chip' — rounded-full icon+label chip, AgentComposer's action row (AgentModelPicker 同款)
// The remote web renders the same component (shared tree, zero fork).
//
// State lives in useGlobalApprovalMode (backend agent_config.db via serve-api — global, persists
// across restarts, shared by desktop + remote web). 🔴 codex r1 P1-1/P1-2 semantics:
//   - mode===null (server truth unknown: read failed / not yet fetched / indeterminate PUT) →
//     the trigger renders an explicit WARNING state (--c-warn + ShieldQuestion), never "Manual".
//     The store retries + re-GETs on window focus; picking an item still works (an explicit PUT
//     resolves the unknown).
//   - selection is PESSIMISTIC: the chip keeps the confirmed mode until the PUT returns the
//     server-canonical value; while saving the menu is disabled (serialized mutations) and the
//     pending item shows 「切换中…」. Success closes the menu + toasts 「数秒内生效」 (gateway
//     hot-read TTL); failure keeps the menu open + toasts, and the store re-GETs to converge.
// Switching TO bypass always shows an inline warning confirm step in the menu (owner 拍板:
// 切换时一次警示确认), and an active bypass keeps the trigger in the persistent warning color
// (--c-fail) so 完全授权 is never ambient.
//
// 主题 v3 token 纪律: 弹层 glass-pop + rounded-[var(--r-ctl)]，active 态 coral，危险态 --c-fail,
// 未知态 --c-warn; 动效 = 触发器 duration-fast transition + active:scale，弹层 useExitAnimation
// 出入场（08-05 WP-03，与 MentionPopover 同配方；reduced-motion 下直切，无 spring/bounce）。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRouter } from '@tanstack/react-router'
import { ChevronDown, Settings2, Shield, ShieldAlert, ShieldQuestion } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useGlobalApprovalMode, type GlobalApprovalMode } from '@shared/lib/globalApprovalMode'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

const MODES: readonly GlobalApprovalMode[] = ['manual', 'bypass'] as const

function ModeIcon({
  mode,
  size = 13
}: {
  mode: GlobalApprovalMode | null
  size?: number
}): React.JSX.Element {
  if (mode === null) return <ShieldQuestion size={size} strokeWidth={2} className="shrink-0" />
  if (mode === 'bypass') return <ShieldAlert size={size} strokeWidth={2} className="shrink-0" />
  return <Shield size={size} strokeWidth={2} className="shrink-0" />
}

export function ApprovalModePicker({ variant }: { variant: 'icon' | 'chip' }): React.JSX.Element {
  const { t } = useTranslation()
  const { mode, saving, setMode } = useGlobalApprovalMode()
  // WP-11 — settings deep-link (per-tool 审批档). `useRouter({ warn: false })` 抄
  // ComposerToolsMenu：无 router 场地（隔离测试/无路由宿主）不渲染该行，不炸。
  const router = useRouter({ warn: false })
  const [open, setOpen] = useState(false)
  // Switching TO bypass swaps the menu content for a warning confirm step (never applies直接).
  const [confirmingBypass, setConfirmingBypass] = useState(false)
  // The item a pessimistic PUT is confirming right now (renders 「切换中…」 on that row).
  const [pendingMode, setPendingMode] = useState<GlobalApprovalMode | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // 出入场（WP-03）：配方抄同一条工具条上的 MentionPopover（bottom-full 向上展开、无 backdrop、
  // 进场 DUR.fast）。🔴 唯一偏离：transformOrigin 跟着**锚定方式**走（origin 的职责是「从触发器
  // 那点长出来」，照抄会让弹层从别处展开）——icon 面 left-0 → 'bottom left'；chip 面居中 →
  // 'bottom center'。两种锚定的算式见下方 role="menu" 处。
  const { shouldRender, scopeRef: menuRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: {
      autoAlpha: 0,
      y: 4,
      scale: 0.98,
      transformOrigin: variant === 'icon' ? 'bottom left' : 'bottom center'
    },
    enterDuration: DUR.fast
  })

  // 🔴 confirm 步骤的复位放在**开**的那一侧（`toggleMenu`），不在关的那一侧 —— 与
  // ComposerPlusMenu 的 view 复位同一条理由（WP-03 check 补）：接了退场动画之后，关闭时把
  // confirmingBypass 拨回 false，会让确认面板在淡出的 120ms 里当场变回三行模式列表，而列表
  // **更高**，弹层于是边淡出边长高。契约「重开不得停在陈旧的确认步骤」由开的一侧守住，且守得
  // 更严：本组件唯一的打开入口就是触发器，必经 toggleMenu。
  const closeMenu = (): void => {
    setOpen(false)
  }
  const toggleMenu = (): void => {
    setConfirmingBypass(false)
    setOpen((v) => !v)
  }

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

  // PESSIMISTIC apply (codex r1 P1-2): keep the menu open + the confirmed mode displayed until
  // the server confirms; only then close + toast (数秒内生效 — the gateway hot-read TTL).
  const apply = async (next: GlobalApprovalMode): Promise<void> => {
    if (saving) return
    setPendingMode(next)
    const ok = await setMode(next)
    setPendingMode(null)
    if (ok) {
      closeMenu()
      toastSuccess(
        t('chat.approvalMode.saved', { mode: t(`chat.approvalMode.${next}.title`) }),
        t('chat.approvalMode.savedDetail')
      )
    } else {
      toastError(t('chat.approvalMode.saveFailed'))
    }
  }

  const onPick = (next: GlobalApprovalMode): void => {
    if (saving) return
    if (next === 'bypass' && mode !== 'bypass') {
      setConfirmingBypass(true)
      return
    }
    void apply(next)
  }

  const isBypass = mode === 'bypass'
  const isUnknown = mode === null
  const label = t('chat.approvalMode.label')
  const activeTitle = isUnknown
    ? t('chat.approvalMode.unknown.title')
    : t(`chat.approvalMode.${mode}.title`)

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        onClick={toggleMenu}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-busy={saving || undefined}
        className={cn(
          ICON_BTN,
          isBypass
            ? 'bg-[rgb(var(--c-fail)/0.12)] text-[rgb(var(--c-fail))] active:scale-[0.96]'
            : isUnknown
              ? 'bg-[rgb(var(--c-warn)/0.15)] text-[rgb(var(--c-warn))] active:scale-[0.96]'
              : open
                ? 'bg-coral/10 text-coral active:scale-[0.96]'
                : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]',
          saving && 'opacity-70'
        )}
      >
        <ModeIcon mode={mode} />
      </button>
    ) : (
      <button
        type="button"
        onClick={toggleMenu}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-busy={saving || undefined}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full px-2 text-meta font-medium transition-colors duration-fast',
          isBypass
            ? 'bg-[rgb(var(--c-fail)/0.12)] text-[rgb(var(--c-fail))]'
            : isUnknown
              ? 'bg-[rgb(var(--c-warn)/0.15)] text-[rgb(var(--c-warn))]'
              : open
                ? 'bg-coral/10 text-coral'
                : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg',
          saving && 'opacity-70'
        )}
      >
        <ModeIcon mode={mode} size={14} />
        <span className="max-w-[104px] truncate">{activeTitle}</span>
        <ChevronDown size={13} strokeWidth={2} className="shrink-0 opacity-60" />
      </button>
    )

  return (
    <div className="relative" ref={ref}>
      <HoverTip text={`${label} · ${activeTitle}`} side="top">
        {trigger}
      </HoverTip>
      {shouldRender && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          // 🔴 锚定按 variant 分两套，因为**两面的触发器位置与可用宽度都不一样**（这不是
          // 「按 variant 分叉行为」，是同一条几何约束在两组坐标下的解）：
          //
          // · icon（邮件面）：08-05 WP-13 重排后本入口是左组第 3 个（+ / 滑块 / 授权模式），
          //   触发器 x = 12(px-3) + 2×28 + 2×4 = 76 → left-0 时 248px 弹层右缘 = 324 ≤ 348
          //   （360 - px-3）✓。而 WP6 那版的居中锚定在这个新位置会把左缘推到 76+14-124 = -34，
          //   顶出左边界 —— 所以这次是**从居中改回 left-0**，理由与当初改居中时同源。
          // · chip（agent 面）：触发器是变宽的胶囊、且窄侧栏只有 ~288px 可用，left-0 会越右
          //   边界 → 维持居中（中心两侧各 124，最坏情况仅贴边）。
          //
          // `-translate-x-1/2`（Tailwind v3 = 写 `transform`）与本组件的 GSAP 出入场**可以共存**：
          // GSAP 补间前会解析元素已有的 transform 并保留不参与补间的分量，只叠自己的 y/scale
          // （实测逐帧对比过负 margin 版本，左缘每一帧都一致）。别为此把居中改写成负 margin。
          // 阴影走 `.glass-pop` 自带的 --pop-shadow（authored 规则排在 utilities 之后，同特异度
          // 源码序胜 —— 再挂 `shadow-[…]` 是死类）。
          className={cn(
            'absolute bottom-full z-50 mb-1.5 w-[248px]',
            variant === 'icon' ? 'left-0' : 'left-1/2 -translate-x-1/2',
            'rounded-[var(--r-ctl)] py-1',
            'glass-pop'
          )}
        >
          {confirmingBypass ? (
            <div className="px-3 py-2">
              <div className="flex items-center gap-1.5 text-meta font-medium text-[rgb(var(--c-fail))]">
                <ShieldAlert size={13} strokeWidth={2} className="shrink-0" />
                {t('chat.approvalMode.bypassConfirmTitle')}
              </div>
              <p className="mt-1.5 text-micro leading-relaxed text-ink-fg-2">
                {t('chat.approvalMode.bypassConfirmBody')}
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  disabled={saving}
                  onClick={closeMenu}
                  className="rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg disabled:pointer-events-none disabled:opacity-50"
                >
                  {t('chat.approvalMode.cancel')}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void apply('bypass')}
                  className="rounded-[var(--r-ctl)] bg-[rgb(var(--c-fail)/0.15)] px-2 py-1 text-meta font-medium text-[rgb(var(--c-fail))] transition-colors duration-fast hover:bg-[rgb(var(--c-fail)/0.25)] disabled:pointer-events-none disabled:opacity-50"
                >
                  {saving && pendingMode === 'bypass'
                    ? t('chat.approvalMode.switching')
                    : t('chat.approvalMode.confirm')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {isUnknown && (
                <p className="px-3 pb-1 pt-1.5 text-micro leading-snug text-[rgb(var(--c-warn))]">
                  {t('chat.approvalMode.unknownHint')}
                </p>
              )}
              {MODES.map((m) => {
                const active = m === mode
                const danger = m === 'bypass'
                const isPending = saving && pendingMode === m
                return (
                  <button
                    key={m}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={saving}
                    onClick={() => onPick(m)}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors duration-fast',
                      'disabled:pointer-events-none',
                      saving && !isPending && 'opacity-50',
                      active
                        ? danger
                          ? 'bg-[rgb(var(--c-fail)/0.12)] text-[rgb(var(--c-fail))]'
                          : 'bg-coral/10 text-coral'
                        : danger
                          ? 'text-[rgb(var(--c-fail))] hover:bg-[rgb(var(--c-fail)/0.08)]'
                          : 'text-ink-fg-1 hover:bg-ink-4 hover:text-ink-fg'
                    )}
                  >
                    <span className="mt-0.5">
                      <ModeIcon mode={m} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-meta font-medium">
                        {t(`chat.approvalMode.${m}.title`)}
                      </span>
                      <span
                        className={cn(
                          'block text-micro leading-snug',
                          active ? 'opacity-80' : 'text-ink-fg-3'
                        )}
                      >
                        {isPending
                          ? t('chat.approvalMode.switching')
                          : t(`chat.approvalMode.${m}.desc`)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        active
                          ? danger
                            ? 'bg-[rgb(var(--c-fail))]'
                            : 'bg-coral/100'
                          : 'bg-ink-fg-3/40'
                      )}
                    />
                  </button>
                )
              })}
              {/* WP-11 — Manual 档的弹不弹卡由 per-tool 审批档决定：菜单底部给一条深链
                  （acceptEdits 三档退役后，「中间态」住进了档位数据）。
                  🔴 08-06 — 落点直达 Connectors 配置台的**内置工具**面：档位的唯一可写面已
                  搬过去，设置页那个区只剩一张指路卡；走老路等于让用户多点一次才到得了真正
                  能改的地方（与本批「同一份数据只有一个可写面」的立意自相矛盾）。 */}
              {router && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu()
                    void router.navigate({ to: '/connectors' })
                  }}
                  className="mt-1 flex w-full items-center gap-2 border-t border-ink-border-soft px-3 py-1.5 text-left text-micro text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
                >
                  <Settings2 size={12} strokeWidth={2} className="shrink-0" />
                  {t('chat.approvalMode.settingsLink')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
