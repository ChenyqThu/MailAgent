// Sprint 18 §PR E — sticky banner that surfaces "需要重启" after any
// EnvField writes a managed key.
//
// Flow:
//   1. EnvField onBlur → applyEnvPatch → env:set
//   2. result.restartRequired=true → markRestartRequired(changedKeys)
//   3. useRestartStore.required flips → this banner becomes visible
//   4. User clicks 立即重启 → confirm Dialog → services:restart('mail-sync')
//   5. wait 1500ms → services:status verifies online → clearRestart() + toast
//
// pm2 not found / non-zero exit / timeout → toast with the exact terminal
// fallbackCommand from the IPC envelope (services.ts §E_PM2_NOT_FOUND), so
// the user can copy-paste into Terminal without re-typing the path.
//
// 视觉走 mockup-settings.html save-bar pill 思路但位置改 sticky top (因为
// 它是一个 informative banner, 不是 user-action gating). bg-warn/10 +
// border-warn/30 跟 ALERT_LEVELS warning 同色, 提示"非阻塞但需要操作".

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, X } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'

const STATUS_PROBE_DELAY_MS = 1500
const STATUS_PROBE_TIMEOUT_MS = 5000

export function RestartBanner(): React.ReactElement | null {
  const { t } = useTranslation()
  const required = useRestartStore((s) => s.required)
  const changedKeys = useRestartStore((s) => s.changedKeys)
  const restarting = useRestartStore((s) => s.restarting)
  const setRestarting = useRestartStore((s) => s.setRestarting)
  const setRestartError = useRestartStore((s) => s.setRestartError)
  const setLastRestartAt = useRestartStore((s) => s.setLastRestartAt)
  const clearRestart = useRestartStore((s) => s.clearRestart)
  const api = useMailApi()
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  if (!required) return null

  async function performRestart(): Promise<void> {
    setRestarting(true)
    setRestartError(null)
    setConfirmOpen(false)
    try {
      const result = await api.services.restart('mail-sync')
      if (result.ok) {
        setLastRestartAt(Date.now())
        // Give pm2 a moment to bring the Python process back up before we
        // ask for status. Without the delay the jlist read often returns
        // 'stopping' for the entry that's mid-restart.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, STATUS_PROBE_DELAY_MS)
        })
        const statusList = await Promise.race([
          api.services.status(),
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), STATUS_PROBE_TIMEOUT_MS)
          })
        ])
        if (statusList === null) {
          // status probe didn't return — surface a softer warning and still
          // clear the restart-required flag (the restart itself succeeded
          // exit=0, the probe just couldn't confirm).
          toastSuccess(
            t('settings.restart.success', { defaultValue: '重启已触发' }),
            t('settings.restart.statusProbeSlow', {
              defaultValue: '服务状态确认超时, 请稍后在状态栏复核'
            })
          )
          clearRestart()
          return
        }
        const mailSync = statusList.find((s) => s.name === 'mail-sync')
        if (mailSync?.state === 'online') {
          toastSuccess(t('settings.restart.success', { defaultValue: '服务已重启' }))
          clearRestart()
        } else {
          const stateLabel = mailSync?.state ?? 'unknown'
          toastError(
            t('settings.restart.failed', { defaultValue: '重启验证失败' }),
            t('settings.restart.notOnline', {
              defaultValue: `mail-sync 当前状态: ${stateLabel}`,
              state: stateLabel
            })
          )
          setRestartError(`state=${stateLabel}`)
        }
      } else if (result.error?.code === 'E_PM2_NOT_FOUND') {
        toastError(
          t('settings.restart.pm2NotFound', { defaultValue: 'pm2 未找到' }),
          result.error.fallbackCommand ??
            t('settings.restart.pm2NotFoundHint', {
              defaultValue: '请在终端运行: pm2 restart mail-sync'
            })
        )
        setRestartError(result.error.message)
      } else {
        const message = result.error?.message ?? result.stderr ?? 'unknown'
        toastError(
          t('settings.restart.failed', { defaultValue: '重启失败' }),
          message.length > 200 ? message.slice(0, 200) + '…' : message
        )
        setRestartError(message)
      }
    } catch (err) {
      const message = (err as Error).message
      toastError(t('settings.restart.failed', { defaultValue: '重启失败' }), message)
      setRestartError(message)
    } finally {
      setRestarting(false)
    }
  }

  // First three keys go into the banner text; "+ N more" carries the
  // tail count to keep the banner one-line on a normal-width window.
  const previewKeys = changedKeys.slice(0, 3)
  const remaining = changedKeys.length - previewKeys.length

  return (
    <>
      {/* Sprint 18 review (round 5) — banner 沿用 EmailDetail sticky 标题区
          同款方案 (EmailDetail.tsx §line 544-554):
          - `sticky top-0 z-10` 在 section overflow-y-auto 内部锚顶
          - 背景 `bg-ink-3/[0.78] backdrop-blur-2xl backdrop-saturate-150` —
            既保持玻璃通透, 又厚到能挡住下方 content 滚到 banner 后面
          - 仅 `border-b` 不画顶/侧边, 避免 glass-pop 的 1px 白边
          - 左侧 4px coral 实线竖条 (跟 row-selected 同视觉语言)
          - position 走 tailwind class, 不再加 inline `position: sticky` 因为
            旧版 `relative` 冲突已经清除了 (`relative` 已删).
        */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'sticky top-0 z-10',
          'bg-ink-3/[0.78] backdrop-blur-2xl backdrop-saturate-150',
          'border-b border-ink-border-soft',
          'px-[var(--settings-content-px,2.5rem)] py-3',
          'flex items-center gap-3'
        )}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1 bg-coral"
        />
        <AlertTriangle className="size-4 shrink-0 text-coral" aria-hidden="true" />
        <div className="flex-1 min-w-0 text-aux text-ink-fg-1">
          <span className="font-medium text-ink-fg">
            {t('settings.restart.required', { defaultValue: '需要重启 mail-sync' })}
          </span>
          {previewKeys.length > 0 ? (
            <>
              <span className="mx-2 text-ink-fg-3">·</span>
              <span className="font-mono text-meta text-ink-fg-2">
                {previewKeys.join(', ')}
                {remaining > 0
                  ? t('settings.restart.moreKeys', {
                      defaultValue: ` 等 ${remaining} 项`,
                      count: remaining
                    })
                  : null}
              </span>
            </>
          ) : null}
        </div>
        <Button
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={restarting}
          // Button default variant 用 `text-accent-fg`, dark theme 下解析为
          // near-black (15 16 21), 在 coral 背景上视觉读起来"深字深底".
          // 这里强制 `text-white` 让 CTA 字色固定为浅色, 跨主题都对比强.
          className="shrink-0 text-white"
        >
          {restarting ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              {t('settings.restart.restarting', { defaultValue: '重启中…' })}
            </>
          ) : (
            t('settings.restart.cta', { defaultValue: '立即重启' })
          )}
        </Button>
        <button
          type="button"
          onClick={clearRestart}
          disabled={restarting}
          aria-label={t('settings.restart.dismiss', { defaultValue: '稍后' })}
          className={cn(
            'shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md',
            'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
            'transition-colors duration-fast ease-standard',
            'disabled:opacity-40 disabled:pointer-events-none'
          )}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings.restart.confirmTitle', { defaultValue: '确认重启 mail-sync?' })}
            </DialogTitle>
            <DialogDescription>
              {t('settings.restart.confirmBody', {
                defaultValue:
                  '重启会中断正在同步的批次, 通常 5-10 秒恢复. 已更改的字段重启后才生效.'
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('settings.restart.cancel', { defaultValue: '取消' })}
            </Button>
            <Button onClick={() => void performRestart()}>
              {t('settings.restart.cta', { defaultValue: '立即重启' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
