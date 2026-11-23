// Single renderer-side Electron IPC client boundary.
// Reads `window.electron` dynamically at call time so test mocks remain drop-in compatible
// and web builds degrade gracefully without throwing.

import type { IpcEventContract, IpcInvokeContract, IpcSendContract } from './contract'

type RawInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>
type RawSend = (channel: string, ...args: unknown[]) => void
type RawOn = (channel: string, listener: (...args: unknown[]) => void) => unknown
type RawRemove = (channel: string, listener: (...args: unknown[]) => void) => void

interface ElectronIpcBridge {
  invoke?: RawInvoke
  send?: RawSend
  on?: RawOn
  removeListener?: RawRemove
  off?: RawRemove
}

interface ElectronGlobalShape {
  electron?: {
    ipcRenderer?: ElectronIpcBridge
    process?: { platform?: string }
  }
}

function getElectronGlobal(): ElectronGlobalShape['electron'] | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as ElectronGlobalShape).electron
}

function getIpcBridge(): ElectronIpcBridge | undefined {
  return getElectronGlobal()?.ipcRenderer
}

/** True when Electron's preload `ipcRenderer` bridge is present. */
export function isElectronIpcAvailable(): boolean {
  return Boolean(getIpcBridge())
}

/** True when two-way `ipcRenderer.invoke` is available. */
export function canInvokeElectronIpc(): boolean {
  return typeof getIpcBridge()?.invoke === 'function'
}

/** True when one-way `ipcRenderer.send` is available. */
export function canSendElectronIpc(): boolean {
  return typeof getIpcBridge()?.send === 'function'
}

/** Read preload-exposed platform string (`darwin` / `win32` / ...), or undefined outside Electron. */
export function getElectronPlatform(): string | undefined {
  return getElectronGlobal()?.process?.platform
}

/** Typed `ipcRenderer.invoke` wrapper; rejects if preload bridge is absent. */
export function invokeIpc<C extends keyof IpcInvokeContract>(
  channel: C,
  ...args: IpcInvokeContract[C]['args']
): Promise<IpcInvokeContract[C]['result']> {
  const bridge = getIpcBridge()
  const fn = bridge?.invoke
  if (typeof fn !== 'function') {
    return Promise.reject(new Error(`IPC invoke unavailable for channel "${String(channel)}"`))
  }
  return fn.apply(bridge, [channel as string, ...args]) as Promise<IpcInvokeContract[C]['result']>
}

/** Typed `ipcRenderer.invoke` that returns `null` when IPC is unavailable (web / tests). */
export async function tryInvokeIpc<C extends keyof IpcInvokeContract>(
  channel: C,
  ...args: IpcInvokeContract[C]['args']
): Promise<IpcInvokeContract[C]['result'] | null> {
  if (!canInvokeElectronIpc()) return null
  return invokeIpc(channel, ...args)
}

/** Typed fire-and-forget `ipcRenderer.send`; no-op outside Electron. */
export function sendIpc<C extends keyof IpcSendContract>(
  channel: C,
  ...args: IpcSendContract[C]
): void {
  const bridge = getIpcBridge()
  const fn = bridge?.send
  if (typeof fn === 'function') {
    fn.apply(bridge, [channel as string, ...args])
  }
}

/** Typed `ipcRenderer.on` subscription stripping Electron's leading `event` arg. Returns disposer. */
export function onIpcEvent<C extends keyof IpcEventContract>(
  channel: C,
  listener: (...args: IpcEventContract[C]) => void
): () => void {
  const bridge = getIpcBridge()
  const onFn = bridge?.on
  if (typeof onFn !== 'function') return () => undefined

  const wrapped = (...rawArgs: unknown[]): void => {
    const payloadArgs = rawArgs.slice(1) as IpcEventContract[C]
    listener(...payloadArgs)
  }
  const maybeDispose = onFn.call(bridge, channel as string, wrapped)
  if (typeof maybeDispose === 'function') return maybeDispose as () => void
  return () => {
    const removeFn = bridge?.removeListener ?? bridge?.off
    if (typeof removeFn === 'function') {
      removeFn.call(bridge, channel as string, wrapped)
    }
  }
}

/** Open an external URL: desktop delegates to main `shell:openExternal`; web uses `window.open`. */
export function openExternalUrl(url: string, webFallbackUrl?: string): void {
  if (canInvokeElectronIpc()) {
    void invokeIpc('shell:openExternal', url)
    return
  }
  if (typeof window !== 'undefined') {
    window.open(webFallbackUrl ?? url, '_blank', 'noopener')
  }
}
