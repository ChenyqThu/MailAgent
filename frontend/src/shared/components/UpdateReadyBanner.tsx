// Auto-update §6 (gap B) — proactive "新版本已就绪" floating card.
//
// Mounts once at App root next to <ToastContainer/> (router-agnostic, must be
// globally visible — not only inside Settings). Surfaces ONLY when the updater
// is actually usable AND a build is staged:
//   status.enabled === true   (master flag on + not dev-disabled + bound)
//   status.state === 'downloaded'
// Anything else → renders null (idle / checking / downloading / error /
// dev-disabled / flag-off all stay silent here; Settings still shows them).
//
// 视觉沿用 RestartBanner 的语言 (coral 竖条 + 玻璃底 + CTA text-white + dismiss
// X), 但位置改 fixed 右下角浮层 —— 因为它是一个全局 informative 卡片, 不是
// settings 内部锚顶的 sticky banner. ToastContainer 占 `fixed top-titlebar
// right-4` (右上), 这里取右下角避免碰撞, 且不挤压页面布局 (no layout shift).
//
// Motion (跟 Toast.tsx 一致): 入场 = slide-up + autoAlpha (DUR.base), reduced-
// motion 直接清掉 inline style 不做 tween。

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, X } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { useUpdaterStore } from '@shared/state/updater'

export function UpdateReadyBanner(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const status = useUpdaterStore((s) => s.status)
  const rootRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()

  // Dismiss is local + keyed on latestVersion: dismissing hides THIS version,
  // but a newer latestVersion arriving (next downloaded build) resets the flag
  // so the card re-shows. We store the dismissed version string rather than a
  // bool (React docs "adjust state on prop change" pattern — compare during
  // render, no effect).
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  // Require a concrete latestVersion: the card renders the version string, and
  // a null version would make the version-keyed dismiss compare (null === null)
  // self-suppress the banner on first render (correctness review, LOW).
  const visible = status.enabled && status.state === 'downloaded' && status.latestVersion != null
  const dismissed = visible && dismissedVersion === status.latestVersion

  // Entry tween — slide-up + fade. reduced-motion clears the inline style so
  // the card just appears. Re-runs when the card transitions into view (and
  // when reduce changes). useGSAP auto-reverts on unmount / dep change.
  useGSAP(
    () => {
      const el = rootRef.current
      if (!el) return
      if (reduce) {
        gsap.set(el, { clearProps: 'opacity,visibility,transform' })
        return
      }
      gsap.from(el, { autoAlpha: 0, y: 12, duration: DUR.base, clearProps: 'transform' })
    },
    { dependencies: [visible && !dismissed, reduce], scope: rootRef }
  )

  if (!visible || dismissed) return null

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      // 右下角浮层: fixed bottom-right, 高 z 但低于 toast(z-50) 避免抢占;
      // pointer-events 默认 auto (要可点 CTA / dismiss)。不占文档流 → 无布局位移。
      className={cn(
        'fixed bottom-4 right-4 z-40 w-[320px]',
        'flex items-center gap-3 overflow-hidden rounded-md',
        'bg-ink-3/[0.92] backdrop-blur-2xl backdrop-saturate-150',
        'border border-ink-border-soft',
        'shadow-[0_8px_24px_rgba(0,0,0,0.35)]',
        'pl-4 pr-2.5 py-3'
      )}
    >
      {/* 左侧 4px coral 实线竖条 — 跟 RestartBanner / row-selected 同视觉语言。 */}
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-coral/100" />
      <RotateCcw className="size-4 shrink-0 text-coral" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-aux text-ink-fg">
        {t('updater.banner.title', {
          defaultValue: `新版本 v${status.latestVersion ?? ''} 已就绪`,
          version: status.latestVersion ?? ''
        })}
      </div>
      <Button
        size="sm"
        onClick={() => void api.updater.quitAndInstall()}
        // 同 RestartBanner: coral 背景上强制 text-white 保跨主题对比。
        className="shrink-0 text-white"
      >
        {t('updater.banner.restartCta', { defaultValue: '重启并更新' })}
      </Button>
      <button
        type="button"
        onClick={() => setDismissedVersion(status.latestVersion)}
        aria-label={t('updater.banner.dismiss', { defaultValue: '稍后' })}
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
          'transition-colors duration-fast ease-standard'
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
