// 07-04 update-indicator — TitleBar 右簇「更新」icon 按钮.
//
// 检测到新版本时在右簇 (强调色配置左侧) 条件渲染一个 icon 按钮, 只读
// useUpdaterStore (main 状态机经 App.tsx 单订阅 broadcast 全程驱动), 与
// SystemAlertBadge 同款「无内容 return null」条件渲染范式:
//   available → Download icon, 点击触发 api.updater.download()
//   downloading → Loader2 旋转 (tooltip 带百分比), 不可点
//   downloaded → RotateCcw (仓内 install/重启语汇, 强调色点缀), 点击
//                api.updater.quitAndInstall() — 同时 UpdateReadyBanner 弹出
//   error → 回落 Download, 点击重试下载
//   idle / checking / not-available / dev-disabled → 不渲染
//
// notifyMode (未签名 / ad-hoc, enabled=false): 应用内装不上更新, 所有可点态改
// 开 GitHub Releases 手动覆盖装 (与 UpdateReadyBanner / IslandUpdatesTab 一致),
// 不装死。

import { useTranslation } from 'react-i18next'
import { Download, Loader2, RotateCcw } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { RELEASE_DOWNLOAD_URL } from '@shared/lib/appReleases'
import { useUpdaterStore } from '@shared/state/updater'

export function UpdateIndicator(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const status = useUpdaterStore((s) => s.status)
  const { state, latestVersion, downloadPercent, enabled } = status

  // 仅这四态出 icon (error 回落到可重试的 download 语汇); 其余全不渲染。
  if (
    state !== 'available' &&
    state !== 'downloading' &&
    state !== 'downloaded' &&
    state !== 'error'
  ) {
    return null
  }

  // notifyMode: enabled=false 时应用内 quitAndInstall/download 装不上, 改跳下载页。
  const notifyMode = !enabled
  const isDownloading = state === 'downloading'
  const isDownloaded = state === 'downloaded'
  const version = latestVersion ?? ''

  const label = isDownloading
    ? t('titleBar.update.downloading', { percent: downloadPercent ?? 0 })
    : isDownloaded
      ? t('titleBar.update.downloaded', { version })
      : state === 'error'
        ? t('titleBar.update.error')
        : t('titleBar.update.available', { version })

  const Icon = isDownloading ? Loader2 : isDownloaded ? RotateCcw : Download

  const handleClick = (): void => {
    if (notifyMode) {
      // main setWindowOpenHandler 拦截 → shell.openExternal 打开系统浏览器。
      window.open(RELEASE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')
      return
    }
    if (isDownloaded) {
      void api.updater.quitAndInstall()
      return
    }
    // available / error → (重新) 触发下载。
    void api.updater.download()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDownloading}
      title={label}
      aria-label={label}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={cn(
        'group flex items-center justify-center p-1.5 rounded transition-colors duration-fast',
        isDownloading && 'cursor-default text-ink-fg-2',
        // downloaded (可安装) 用强调色点缀提示可操作。
        isDownloaded && 'text-coral hover:bg-ink-3 active:bg-ink-4',
        !isDownloading &&
          !isDownloaded &&
          'text-ink-fg-2 hover:text-ink-fg-1 hover:bg-ink-3 active:bg-ink-4'
      )}
    >
      <Icon size={13} strokeWidth={2} className={cn(isDownloading && 'animate-spin')} aria-hidden />
    </button>
  )
}
