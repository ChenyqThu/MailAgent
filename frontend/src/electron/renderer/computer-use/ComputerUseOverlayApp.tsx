import '@shared/i18n'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'

import {
  COMPUTER_USE_IPC,
  IDLE_COMPUTER_USE_ACTIVITY,
  type ComputerUseActivityState
} from '@shared/computerUseOverlayContract'
import { bootAppearance } from '@shared/state/appearance'

interface ElectronIpcBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => (() => void) | void
  removeListener?: (channel: string, listener: (...args: unknown[]) => void) => void
}

function getIpcRenderer(): ElectronIpcBridge | undefined {
  return (window as unknown as { electron?: { ipcRenderer?: ElectronIpcBridge } }).electron
    ?.ipcRenderer
}

export default function ComputerUseOverlayApp(): React.ReactElement | null {
  const { t } = useTranslation()
  const [activity, setActivity] = useState<ComputerUseActivityState>(IDLE_COMPUTER_USE_ACTIVITY)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-cu-overlay', '1')
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    bootAppearance()
  }, [])

  useEffect(() => {
    const ipc = getIpcRenderer()
    if (!ipc) return
    let mounted = true
    void ipc.invoke(COMPUTER_USE_IPC.getState).then((res) => {
      if (mounted && res && typeof res === 'object') {
        setActivity(res as ComputerUseActivityState)
      }
    })
    const handler = (...args: unknown[]): void => {
      const candidate = args.length > 1 ? args[1] : args[0]
      if (candidate && typeof candidate === 'object' && 'active' in candidate) {
        const next = candidate as ComputerUseActivityState
        setActivity(next)
        if (!next.active) setStopping(false)
      }
    }
    const maybeUnsub = ipc.on(COMPUTER_USE_IPC.activityChanged, handler)
    return () => {
      mounted = false
      if (typeof maybeUnsub === 'function') maybeUnsub()
      else ipc.removeListener?.(COMPUTER_USE_IPC.activityChanged, handler)
    }
  }, [])

  const visible = activity.active && activity.surface === 'desktop'

  useEffect(() => {
    if (!visible) {
      getIpcRenderer()?.send(COMPUTER_USE_IPC.overlaySetInteractive, false)
    }
    return () => {
      getIpcRenderer()?.send(COMPUTER_USE_IPC.overlaySetInteractive, false)
    }
  }, [visible])

  if (!visible) return null

  const detailParts: string[] = []
  if (activity.actionLabel && activity.actionLabel !== 'starting') {
    detailParts.push(activity.actionLabel)
  }
  if (activity.currentTarget) {
    detailParts.push(activity.currentTarget)
  }
  if (activity.stepCount > 0) {
    detailParts.push(t('computerUseOverlay.stepLabel', { step: activity.stepCount }))
  }

  const handleStop = (): void => {
    const ipc = getIpcRenderer()
    if (!ipc || stopping) return
    setStopping(true)
    void ipc.invoke(COMPUTER_USE_IPC.stopActive).finally(() => {
      ipc.send(COMPUTER_USE_IPC.overlaySetInteractive, false)
    })
  }

  return (
    <div
      className="pointer-events-none fixed inset-0 select-none overflow-hidden"
      style={{
        boxShadow:
          'inset 0 0 0 3px rgb(var(--c-accent) / 0.85), inset 0 0 28px 6px rgb(var(--c-accent) / 0.30)'
      }}
    >
      <div className="flex justify-center pt-3">
        <div
          role="status"
          aria-live="polite"
          onMouseEnter={() => getIpcRenderer()?.send(COMPUTER_USE_IPC.overlaySetInteractive, true)}
          onMouseLeave={() => getIpcRenderer()?.send(COMPUTER_USE_IPC.overlaySetInteractive, false)}
          className="pointer-events-auto flex max-w-[90vw] items-center gap-3 rounded-full border border-coral/50 bg-ink-1/95 px-4 py-2 text-ink-fg shadow-sm backdrop-blur-md"
        >
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-coral/100" />
          <span className="shrink-0 text-aux font-medium text-ink-fg">
            {t('computerUseOverlay.activeTitle')}
          </span>
          {detailParts.length > 0 && (
            <span className="max-w-[38vw] truncate text-aux text-ink-fg-2">
              {detailParts.join(' · ')}
            </span>
          )}
          <button
            type="button"
            disabled={stopping}
            onClick={handleStop}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-coral/100 px-3 py-1 text-aux font-medium text-accent-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-60"
          >
            <Square size={12} fill="currentColor" strokeWidth={2} />
            <span>
              {stopping ? t('computerUseOverlay.stopping') : t('computerUseOverlay.stopTakeover')}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
