// 07-16 approval-mode switcher — composer chip for the OWNER-GLOBAL chat approval mode
// (Manual / Accept Edits / Bypass Permissions, Claude Code permission-mode 参照).
//
// One shared component, two visual variants (双 composer 落点):
//   - 'icon' — 7×7 icon button, ThreadComposer's toolbar row (ComposerModelPicker 同款尺寸；弹层
//     锚定**不同** —— 本入口排在左组最后，left-0 会越界，改居中，见下方 role="menu" 处的算式)
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
import { ChevronDown, Shield, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useGlobalApprovalMode, type GlobalApprovalMode } from '@shared/lib/globalApprovalMode'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

const MODES: readonly GlobalApprovalMode[] = ['manual', 'acceptEdits', 'bypass'] as const

function ModeIcon({
  mode,
  size = 13
}: {
  mode: GlobalApprovalMode | null
  size?: number
}): React.JSX.Element {
  if (mode === null) return <ShieldQuestion size={size} strokeWidth={2} className="shrink-0" />
  if (mode === 'bypass') return <ShieldAlert size={size} strokeWidth={2} className="shrink-0" />
  if (mode === 'acceptEdits')
    return <ShieldCheck size={size} strokeWidth={2} className="shrink-0" />
  return <Shield size={size} strokeWidth={2} className="shrink-0" />
}

export function ApprovalModePicker({ variant }: { variant: 'icon' | 'chip' }): React.JSX.Element {
  const { t } = useTranslation()
  const { mode, saving, setMode } = useGlobalApprovalMode()
  const [open, setOpen] = useState(false)
  // Switching TO bypass swaps the menu content for a warning confirm step (never applies直接).
  const [confirmingBypass, setConfirmingBypass] = useState(false)
  // The item a pessimistic PUT is confirming right now (renders 「切换中…」 on that row).
  const [pendingMode, setPendingMode] = useState<GlobalApprovalMode | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // 出入场（WP-03）：配方抄同一条工具条上的 MentionPopover（bottom-full 向上展开、无 backdrop、
  // 进场 DUR.fast）。🔴 唯一偏离：transformOrigin 用 'bottom center' 而非 'bottom left' ——
  // 本弹层是**居中锚定**的（见下方 role="menu" 处的算式），origin 的职责是「从触发器那点长出来」，
  // 照抄 left 会让它从触发器左侧 124px 处展开。
  const { shouldRender, scopeRef: menuRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom center' },
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
              : mode === 'acceptEdits' || open
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
              : mode === 'acceptEdits' || open
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
          // 🔴 08-04 WP6 修越界：本入口在邮件面是左组的**最后**一个控件（@ / + / 模型 / 思考 /
          // 授权模式），触发器 x = 12(px-3) + 4×28 + 4×4 = 140；left-0 锚定时 248px 的弹层右缘
          // = 388，而 360px 面板的可视右缘只有 348 —— 越界 40px（预存缺陷，check-WP2 实测）。
          // 改成以触发器为中心：中心 x = 140 + 14 = 154，两侧各 124 → [30, 278]，两端都在内。
          // （ConnectorQuickPanel 旧版同样的理由用过居中锚定；锚定方式跟触发器在行里的位置走。）
          //
          // `-translate-x-1/2`（Tailwind v3 = 写 `transform`）与本组件的 GSAP 出入场**可以共存**：
          // GSAP 补间前会解析元素已有的 transform 并保留不参与补间的分量，只叠自己的 y/scale
          // （实测逐帧对比过负 margin 版本，左缘每一帧都一致）。别为此把居中改写成负 margin。
          // 阴影走 `.glass-pop` 自带的 --pop-shadow（authored 规则排在 utilities 之后，同特异度
          // 源码序胜 —— 再挂 `shadow-[…]` 是死类）。
          className={cn(
            'absolute bottom-full left-1/2 z-50 mb-1.5 w-[248px] -translate-x-1/2',
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
