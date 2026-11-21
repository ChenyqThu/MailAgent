import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  KeyRound,
  Maximize2,
  MoreVertical,
  PanelRight,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Square,
  X
} from 'lucide-react'

import type { ManagedBrowserTabInfo } from '@shared/api/types'
import { COMPUTER_USE_IPC } from '@shared/computerUseOverlayContract'
import { useMailApi } from '@shared/hooks/useMailApi'
import { resolveBrowserLiveWsUrl } from '@shared/lib/apiBaseUrl'
import { cn } from '@shared/lib/cn'
import { useManagedBrowserUi } from '@shared/state/managed-browser-ui'
import { toastError } from '@shared/state/toast'

import { BrowserCookieManagerPanel } from './BrowserCookieManagerPanel'

export interface ManagedBrowserPaneProps {
  mode: 'sidebar' | 'tab'
  onClose?: () => void
  onPopOutTab?: () => void
  onReturnToSidebar?: () => void
  onActiveTitleChange?: (title: string) => void
  onOpenConnectors?: () => void
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface DrawGeometry {
  dx: number
  dy: number
  dw: number
  dh: number
  rw: number
  rh: number
}

interface ElectronIpcInvoker {
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
}

const CONTROL_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown'
])

function modifiersFromEvent(e: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

function mouseButtonName(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

export function ManagedBrowserPane({
  mode,
  onClose,
  onPopOutTab,
  onReturnToSidebar,
  onActiveTitleChange,
  onOpenConnectors
}: ManagedBrowserPaneProps): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const activity = useManagedBrowserUi((s) => s.activity)
  const pendingUrl = useManagedBrowserUi((s) => s.pendingUrl)
  const consumePendingUrl = useManagedBrowserUi((s) => s.consumePendingUrl)

  const [connStatus, setConnStatus] = useState<ConnectionStatus>('connecting')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [tabs, setTabs] = useState<ManagedBrowserTabInfo[]>([])
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null)
  const [currentUrl, setCurrentUrl] = useState<string>('about:blank')
  const [urlInput, setUrlInput] = useState<string>('')
  const [hasFrame, setHasFrame] = useState<boolean>(false)
  const [reconnectNonce, setReconnectNonce] = useState<number>(0)
  const [stoppingAgent, setStoppingAgent] = useState<boolean>(false)
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [cookiePanelOpen, setCookiePanelOpen] = useState<boolean>(false)

  const menuRef = useRef<HTMLDivElement | null>(null)
  const currentUrlRef = useRef<string>(currentUrl)
  useEffect(() => {
    currentUrlRef.current = currentUrl
  }, [currentUrl])

  const wsRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportBoxRef = useRef<HTMLDivElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const imeInputRef = useRef<HTMLInputElement | null>(null)
  const composingRef = useRef<boolean>(false)
  const lastMoveAtRef = useRef<number>(0)
  const lastImageRef = useRef<HTMLImageElement | null>(null)
  const drawGeomRef = useRef<DrawGeometry>({
    dx: 0,
    dy: 0,
    dw: 1280,
    dh: 900,
    rw: 1280,
    rh: 900
  })
  const remoteSizeRef = useRef<{ rw: number; rh: number }>({ rw: 1280, rh: 900 })
  const onActiveTitleChangeRef = useRef(onActiveTitleChange)
  useEffect(() => {
    onActiveTitleChangeRef.current = onActiveTitleChange
  }, [onActiveTitleChange])
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const sendCmd = useCallback((payload: Record<string, unknown>): void => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: globalThis.MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (connStatus !== 'connected' || !pendingUrl) return
    const url = consumePendingUrl()
    if (!url) return
    const cur = currentUrlRef.current
    if (!cur || cur === 'about:blank') {
      sendCmd({ type: 'navigate', url })
    } else {
      sendCmd({ type: 'new_tab', url })
    }
  }, [connStatus, pendingUrl, consumePendingUrl, sendCmd])

  const drawImageToCanvas = useCallback((img: HTMLImageElement, rw: number, rh: number): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const box = viewportBoxRef.current
    const targetW = Math.max(1, Math.round(box?.clientWidth || canvas.clientWidth || rw))
    const targetH = Math.max(1, Math.round(box?.clientHeight || canvas.clientHeight || rh))
    if (canvas.width !== targetW) canvas.width = targetW
    if (canvas.height !== targetH) canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, targetW, targetH)
    const scale = Math.min(targetW / rw, targetH / rh)
    const dw = rw * scale
    const dh = rh * scale
    const dx = (targetW - dw) / 2
    const dy = (targetH - dh) / 2
    ctx.drawImage(img, dx, dy, dw, dh)
    drawGeomRef.current = { dx, dy, dw, dh, rw, rh }
  }, [])

  useEffect(() => {
    const box = viewportBoxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (lastImageRef.current) {
        drawImageToCanvas(lastImageRef.current, remoteSizeRef.current.rw, remoteSizeRef.current.rh)
      }
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [drawImageToCanvas])

  useEffect(() => {
    let disposed = false
    const wsUrl = resolveBrowserLiveWsUrl()
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      if (disposed) return
      setConnStatus('connected')
      setErrorCode(null)
      setErrorMessage(null)
    }

    ws.onmessage = (evt: MessageEvent) => {
      if (disposed || typeof evt.data !== 'string') return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(evt.data) as Record<string, unknown>
      } catch {
        return
      }
      const kind = msg.type
      if (kind === 'state') {
        const rawTabs = Array.isArray(msg.tabs) ? (msg.tabs as ManagedBrowserTabInfo[]) : []
        const activeId = typeof msg.activeTargetId === 'string' ? msg.activeTargetId : null
        const url = typeof msg.url === 'string' ? msg.url : 'about:blank'
        const title = typeof msg.title === 'string' ? msg.title : ''
        setTabs(rawTabs)
        setActiveTargetId(activeId)
        setCurrentUrl(url)
        if (document.activeElement !== urlInputRef.current) {
          setUrlInput(url === 'about:blank' ? '' : url)
        }
        const displayTitle = title.trim() || (url !== 'about:blank' ? url : '')
        if (displayTitle) {
          onActiveTitleChangeRef.current?.(displayTitle)
        }
      } else if (kind === 'frame') {
        const b64 = typeof msg.data === 'string' ? msg.data : ''
        if (!b64) return
        const meta =
          (msg.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined) ?? {}
        const img = new Image()
        img.onload = () => {
          if (disposed) return
          const rw = Number(meta.deviceWidth) || img.naturalWidth || 1280
          const rh = Number(meta.deviceHeight) || img.naturalHeight || 900
          remoteSizeRef.current = { rw, rh }
          lastImageRef.current = img
          drawImageToCanvas(img, rw, rh)
          setHasFrame(true)
        }
        img.src = `data:image/jpeg;base64,${b64}`
      } else if (kind === 'error') {
        const code = typeof msg.code === 'string' ? msg.code : null
        const message =
          typeof msg.message === 'string' ? msg.message : tRef.current('browserPane.disconnected')
        setErrorCode(code)
        setErrorMessage(message)
        if (code === 'E_RUNTIME_NOT_INSTALLED' || code === 'E_MODE_NOT_LIVE_VIEWABLE') {
          setConnStatus('error')
        }
      }
    }

    ws.onerror = () => {
      if (disposed) return
      setConnStatus((prev) => (prev === 'error' ? prev : 'error'))
    }

    ws.onclose = () => {
      if (disposed) return
      if (wsRef.current === ws) wsRef.current = null
      setConnStatus((prev) => (prev === 'error' ? prev : 'disconnected'))
    }

    return () => {
      disposed = true
      if (wsRef.current === ws) wsRef.current = null
      ws.close()
    }
  }, [reconnectNonce, drawImageToCanvas])

  const clientToRemote = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const canvas = canvasRef.current
      const geom = drawGeomRef.current
      if (!canvas) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || geom.dw <= 0 || geom.dh <= 0) {
        return {
          x: Math.max(0, Math.min(geom.rw, clientX - rect.left)),
          y: Math.max(0, Math.min(geom.rh, clientY - rect.top))
        }
      }
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      const canvasX = (clientX - rect.left) * scaleX
      const canvasY = (clientY - rect.top) * scaleY
      const rx = ((canvasX - geom.dx) / geom.dw) * geom.rw
      const ry = ((canvasY - geom.dy) / geom.dh) * geom.rh
      return {
        x: Math.round(Math.max(0, Math.min(geom.rw, rx))),
        y: Math.round(Math.max(0, Math.min(geom.rh, ry)))
      }
    },
    []
  )

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    imeInputRef.current?.focus({ preventScroll: true })
    const { x, y } = clientToRemote(e.clientX, e.clientY)
    sendCmd({
      type: 'mouse',
      action: 'mousePressed',
      x,
      y,
      button: mouseButtonName(e.button),
      buttons: e.buttons || 1,
      clickCount: Math.max(1, e.detail || 1),
      modifiers: modifiersFromEvent(e)
    })
  }

  const handlePointerUp = (e: PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = clientToRemote(e.clientX, e.clientY)
    sendCmd({
      type: 'mouse',
      action: 'mouseReleased',
      x,
      y,
      button: mouseButtonName(e.button),
      buttons: e.buttons,
      clickCount: 1,
      modifiers: modifiersFromEvent(e)
    })
  }

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    const now = performance.now()
    if (now - lastMoveAtRef.current < 30) return
    lastMoveAtRef.current = now
    const { x, y } = clientToRemote(e.clientX, e.clientY)
    sendCmd({
      type: 'mouse',
      action: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: e.buttons,
      modifiers: modifiersFromEvent(e)
    })
  }

  const handleWheel = (e: WheelEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const { x, y } = clientToRemote(e.clientX, e.clientY)
    sendCmd({
      type: 'mouse',
      action: 'wheel',
      x,
      y,
      deltaX: Math.round(e.deltaX),
      deltaY: Math.round(e.deltaY)
    })
  }

  const handleCompositionStart = (): void => {
    composingRef.current = true
  }

  const handleCompositionEnd = (e: CompositionEvent<HTMLInputElement>): void => {
    composingRef.current = false
    const text = e.data || e.currentTarget.value
    e.currentTarget.value = ''
    if (text) sendCmd({ type: 'insert_text', text })
  }

  const handleImeInput = (e: FormEvent<HTMLInputElement>): void => {
    if (composingRef.current) return
    const text = e.currentTarget.value
    if (text) {
      e.currentTarget.value = ''
      sendCmd({ type: 'insert_text', text })
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData?.getData('text/plain')
    if (text) {
      e.preventDefault()
      sendCmd({ type: 'insert_text', text })
    }
  }

  const handleImeKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || composingRef.current || e.key === 'Process') return
    const hasChord = e.ctrlKey || e.metaKey || e.altKey
    if (CONTROL_KEYS.has(e.key) || hasChord) {
      e.preventDefault()
      sendCmd({
        type: 'key',
        action: 'keyDown',
        key: e.key,
        code: e.code,
        ...(e.key === 'Enter' ? { text: '\r' } : {}),
        windowsVirtualKeyCode: e.keyCode || 0,
        modifiers: modifiersFromEvent(e)
      })
    }
  }

  const handleImeKeyUp = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || composingRef.current || e.key === 'Process') return
    const hasChord = e.ctrlKey || e.metaKey || e.altKey
    if (CONTROL_KEYS.has(e.key) || hasChord) {
      e.preventDefault()
      sendCmd({
        type: 'key',
        action: 'keyUp',
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode || 0,
        modifiers: modifiersFromEvent(e)
      })
    }
  }

  const handleNavigateSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return
    sendCmd({ type: 'navigate', url: trimmed })
  }

  const handleReconnect = (): void => {
    setConnStatus('connecting')
    setErrorCode(null)
    setErrorMessage(null)
    setReconnectNonce((n) => n + 1)
  }

  const handleLaunchExternalChrome = (): void => {
    const fn = mailApi.connector.launchBrowserWindow
    if (!fn) return
    void fn(currentUrl && currentUrl !== 'about:blank' ? { url: currentUrl } : undefined).catch(
      (err: unknown) => {
        toastError(err instanceof Error ? err.message : String(err))
      }
    )
  }

  const handleStopKernel = (): void => {
    const fn = mailApi.connector.stopBrowserLive
    if (!fn) return
    void fn()
      .then(() => {
        setConnStatus('disconnected')
        setHasFrame(false)
      })
      .catch((err: unknown) => {
        toastError(err instanceof Error ? err.message : String(err))
      })
  }

  const handleStopAgent = (): void => {
    const ipc = (window as unknown as { electron?: { ipcRenderer?: ElectronIpcInvoker } }).electron
      ?.ipcRenderer
    if (!ipc?.invoke || stoppingAgent) return
    setStoppingAgent(true)
    void ipc.invoke(COMPUTER_USE_IPC.stopActive).finally(() => {
      setStoppingAgent(false)
    })
  }

  const agentActiveOnBrowser = activity.active && activity.surface === 'browser'
  const showSetupCard =
    errorCode === 'E_RUNTIME_NOT_INSTALLED' || errorCode === 'E_MODE_NOT_LIVE_VIEWABLE'

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-1 text-ink-fg">
      {/* Top tab bar + window controls */}
      <div className="flex items-center gap-1 border-b border-ink-border-soft bg-ink-2 px-2 py-1.5">
        <Globe size={15} strokeWidth={1.75} className="mr-1 shrink-0 text-coral" />
        <div
          role="tablist"
          aria-label={t('browserPane.title')}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {tabs.length === 0 ? (
            <span className="truncate px-2 py-1 text-aux font-medium text-ink-fg-1">
              {t('browserPane.title')}
            </span>
          ) : (
            tabs.map((tab) => {
              const selected = tab.id === activeTargetId
              const label =
                tab.title.trim() ||
                (tab.url !== 'about:blank' ? tab.url : t('browserPane.untitledTab'))
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={selected}
                  tabIndex={0}
                  onClick={() => sendCmd({ type: 'switch_tab', targetId: tab.id })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      sendCmd({ type: 'switch_tab', targetId: tab.id })
                    }
                  }}
                  title={tab.url}
                  className={cn(
                    'group flex max-w-[168px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-aux transition-colors duration-fast',
                    selected
                      ? 'bg-ink-4 font-medium text-ink-fg'
                      : 'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg'
                  )}
                >
                  <span className="truncate">{label}</span>
                  <button
                    type="button"
                    aria-label={t('browserPane.closeTab')}
                    title={t('browserPane.closeTab')}
                    onClick={(e) => {
                      e.stopPropagation()
                      sendCmd({ type: 'close_tab', targetId: tab.id })
                    }}
                    className="grid size-4 shrink-0 place-items-center rounded text-ink-fg-3 hover:bg-ink-5 hover:text-ink-fg"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </div>
              )
            })
          )}
          <button
            type="button"
            aria-label={t('browserPane.newTab')}
            title={t('browserPane.newTab')}
            onClick={() => sendCmd({ type: 'new_tab', url: 'about:blank' })}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 pl-1">
          {mode === 'sidebar' && onPopOutTab && (
            <button
              type="button"
              aria-label={t('browserPane.popOutTab')}
              title={t('browserPane.popOutTab')}
              onClick={onPopOutTab}
              className="grid size-7 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <Maximize2 size={14} strokeWidth={1.75} />
            </button>
          )}
          {mode === 'tab' && onReturnToSidebar && (
            <button
              type="button"
              aria-label={t('browserPane.returnToSidebar')}
              title={t('browserPane.returnToSidebar')}
              onClick={onReturnToSidebar}
              className="grid size-7 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <PanelRight size={14} strokeWidth={1.75} />
            </button>
          )}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              aria-label={t('browserPane.moreMenu')}
              title={t('browserPane.moreMenu')}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((prev) => !prev)}
              className="grid size-7 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <MoreVertical size={14} strokeWidth={1.75} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-8 z-40 min-w-[200px] rounded-lg border border-ink-border bg-ink-2 py-1 shadow-md"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setCookiePanelOpen((prev) => !prev)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-aux text-ink-fg transition-colors hover:bg-ink-3"
                >
                  <KeyRound size={14} strokeWidth={1.75} className="shrink-0 text-coral" />
                  <span>{t('browserPane.manageCookies')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    handleLaunchExternalChrome()
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-aux text-ink-fg transition-colors hover:bg-ink-3"
                >
                  <ExternalLink size={14} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
                  <span>{t('browserPane.openExternalChrome')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    handleStopKernel()
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-aux text-fail transition-colors hover:bg-ink-3"
                >
                  <Power size={14} strokeWidth={1.75} className="shrink-0" />
                  <span>{t('browserPane.stopKernel')}</span>
                </button>
              </div>
            )}
          </div>
          {mode === 'sidebar' && onClose && (
            <button
              type="button"
              aria-label={t('browserPane.closeSidebar')}
              title={t('browserPane.closeSidebar')}
              onClick={onClose}
              className="grid size-7 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <X size={15} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* Agent controlling status banner */}
      {agentActiveOnBrowser && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-2 border-b border-coral/30 bg-coral/10 px-3 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-coral/100" />
            <span className="truncate text-aux font-medium text-ink-fg">
              {t('browserPane.agentControlling')}
            </span>
            {activity.actionLabel && activity.actionLabel !== 'starting' && (
              <span className="truncate text-aux text-ink-fg-2">{activity.actionLabel}</span>
            )}
          </div>
          <button
            type="button"
            disabled={stoppingAgent}
            onClick={handleStopAgent}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-coral/100 px-2.5 py-0.5 text-aux font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <Square size={11} fill="currentColor" strokeWidth={2} />
            <span>{t('browserPane.stopTakeover')}</span>
          </button>
        </div>
      )}

      {/* Navigation bar */}
      <form
        onSubmit={handleNavigateSubmit}
        className="flex items-center gap-1 border-b border-ink-border-soft bg-ink-1 px-2 py-1.5"
      >
        <button
          type="button"
          aria-label={t('browserPane.back')}
          title={t('browserPane.back')}
          onClick={() => sendCmd({ type: 'back' })}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <ArrowLeft size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label={t('browserPane.forward')}
          title={t('browserPane.forward')}
          onClick={() => sendCmd({ type: 'forward' })}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <ArrowRight size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label={t('browserPane.reload')}
          title={t('browserPane.reload')}
          onClick={() => sendCmd({ type: 'reload' })}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <RotateCw size={14} strokeWidth={1.75} />
        </button>
        <input
          ref={urlInputRef}
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder={t('browserPane.urlPlaceholder')}
          aria-label={t('browserPane.urlPlaceholder')}
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 text-aux text-ink-fg placeholder:text-ink-fg-3 focus:border-coral focus:outline-none"
        />
      </form>

      {/* Live interactive screencast canvas */}
      <div
        ref={viewportBoxRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-ink-0"
      >
        <input
          ref={imeInputRef}
          type="text"
          aria-hidden="true"
          tabIndex={-1}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleImeInput}
          onPaste={handlePaste}
          onKeyDown={handleImeKeyDown}
          onKeyUp={handleImeKeyUp}
          className="sr-only"
        />
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerMove={handlePointerMove}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          className="h-full w-full cursor-default select-none object-contain"
        />

        {cookiePanelOpen ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-ink-1">
            <BrowserCookieManagerPanel
              initialTab="stored"
              onClose={() => setCookiePanelOpen(false)}
            />
          </div>
        ) : showSetupCard ? (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-0/90 p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-ink-border bg-ink-2 p-5 text-center">
              <Globe size={28} strokeWidth={1.5} className="text-coral" />
              <div className="text-body font-medium text-ink-fg">
                {errorCode === 'E_RUNTIME_NOT_INSTALLED'
                  ? t('browserPane.notInstalledTitle')
                  : t('browserPane.modeUnsupportedTitle')}
              </div>
              <p className="text-aux text-ink-fg-2">
                {errorMessage ||
                  (errorCode === 'E_RUNTIME_NOT_INSTALLED'
                    ? t('browserPane.notInstalledHint')
                    : t('browserPane.modeUnsupportedHint'))}
              </p>
              {onOpenConnectors && (
                <button
                  type="button"
                  onClick={onOpenConnectors}
                  className="rounded-lg bg-coral/100 px-3.5 py-1.5 text-aux font-medium text-accent-fg transition-opacity hover:opacity-90"
                >
                  {t('browserPane.openConnectors')}
                </button>
              )}
            </div>
          </div>
        ) : connStatus === 'disconnected' || connStatus === 'error' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-0/85 p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-ink-border bg-ink-2 p-5 text-center">
              <div className="text-aux font-medium text-ink-fg">
                {errorMessage || t('browserPane.disconnected')}
              </div>
              <button
                type="button"
                onClick={handleReconnect}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-border bg-ink-3 px-3.5 py-1.5 text-aux font-medium text-ink-fg transition-colors hover:bg-ink-4"
              >
                <RefreshCw size={14} strokeWidth={1.75} />
                <span>{t('browserPane.reconnect')}</span>
              </button>
            </div>
          </div>
        ) : !hasFrame ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-lg border border-ink-border-soft bg-ink-2/90 px-4 py-2 text-aux text-ink-fg-2">
              <RefreshCw size={14} strokeWidth={1.75} className="animate-spin text-coral" />
              <span>{t('browserPane.connecting')}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
