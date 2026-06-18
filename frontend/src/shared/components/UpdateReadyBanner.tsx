// Auto-update — proactive 新版本浮层卡片. 两种模式:
//   installMode (已签名 + 自动更新开, status.enabled && state==='downloaded'):
//     "新版本已就绪" → 应用内「重启并更新」(quitAndInstall)。
//   notifyMode (ad-hoc / 未签名, !status.enabled && state==='available'):
//     "新版本 vX 已发布" → 「前往下载」跳 GitHub Releases 手动覆盖装
//     (ad-hoc quitAndInstall 装不上更新, 故只通知 + 开浏览器)。
// 其它状态 (idle / checking / downloading / error / dev-disabled) → null
// (Settings 内仍展示)。dismiss 按版本号 keyed, 关掉本会话不再弹, 重启若仍落后再弹。
//
// Mounts once at App root next to <ToastContainer/> (router-agnostic, 必须全局
// 可见, 不只在 Settings 内)。
//
// 视觉沿用 RestartBanner 语言 (coral 竖条 + 玻璃底 + CTA text-white + dismiss X)。
// 位置 fixed 右上角 (top-titlebar right-4, 用户要求常驻右上)。ToastContainer 同占
// 右上 (z-50), 本卡 z-40 在其下 —— 短暂 toast 可临时盖住, 散后即露 (本卡持久仅手动
// 关、toast 瞬态, 可接受的权衡)。不挤压页面布局 (no layout shift)。
//
// Motion: 入场 = slide-down (y:-12) + autoAlpha (DUR.base, 顶部锚自上而下滑入),
// reduced-motion 直接清掉 inline style 不做 tween。

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, X } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { RELEASE_DOWNLOAD_URL } from '@shared/lib/appReleases'
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
  //
  // 两种触发模式:
  //  - installMode (已签名 + 自动更新开, enabled=true): 'downloaded' → 应用内重启安装。
  //  - notifyMode  (ad-hoc / 未签名, enabled=false): 'available' → 跳转 GitHub Releases
  //    手动下载、覆盖安装。ad-hoc 下 quitAndInstall 装不上更新, 所以只通知 + 开浏览器。
  const installMode =
    status.enabled && status.state === 'downloaded' && status.latestVersion != null
  const notifyMode = !status.enabled && status.state === 'available' && status.latestVersion != null
  const visible = installMode || notifyMode
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
      gsap.from(el, { autoAlpha: 0, y: -12, duration: DUR.base, clearProps: 'transform' })
    },
    { dependencies: [visible && !dismissed, reduce], scope: rootRef }
  )

  if (!visible || dismissed) return null

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      // 右上角常驻浮层 (用户要求): fixed top-right (titlebar 下方), z-40 低于
      // toast(z-50) — 短暂 toast 可临时盖其上, 本卡常驻仅手动关。pointer-events
      // 默认 auto (要可点 CTA / dismiss)。不占文档流 → 无布局位移。
      className={cn(
        'fixed top-titlebar right-4 mt-2 z-40 w-[320px]',
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
        {installMode
          ? t('updater.banner.title', {
              defaultValue: `新版本 v${status.latestVersion ?? ''} 已就绪`,
              version: status.latestVersion ?? ''
            })
          : t('updater.banner.availableTitle', {
              defaultValue: `新版本 v${status.latestVersion ?? ''} 已发布`,
              version: status.latestVersion ?? ''
            })}
      </div>
      {installMode ? (
        <Button
          size="sm"
          onClick={() => void api.updater.quitAndInstall()}
          // 同 RestartBanner: coral 背景上强制 text-white 保跨主题对比。
          className="shrink-0 text-white"
        >
          {t('updater.banner.restartCta', { defaultValue: '重启并更新' })}
        </Button>
      ) : (
        // notifyMode: ad-hoc 不在应用内安装, 跳转下载页手动覆盖安装。<a target=_blank>
        // 由 main setWindowOpenHandler 拦截 → shell.openExternal 打开系统浏览器。
        <Button asChild size="sm" className="shrink-0 text-white">
          <a href={RELEASE_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
            {t('updater.banner.openCta', { defaultValue: '前往下载' })}
          </a>
        </Button>
      )}
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
