import { useEffect } from 'react'

import { COMPUTER_USE_IPC, type ComputerUseActivityState } from '@shared/computerUseOverlayContract'
import { useManagedBrowserUi } from '@shared/state/managed-browser-ui'

interface ElectronIpcBridge {
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
  on?: (channel: string, listener: (...args: unknown[]) => void) => (() => void) | void
  removeListener?: (channel: string, listener: (...args: unknown[]) => void) => void
}

export function useComputerUseActivityBridge(): void {
  useEffect(() => {
    const ipc = (window as unknown as { electron?: { ipcRenderer?: ElectronIpcBridge } }).electron
      ?.ipcRenderer
    if (!ipc) return

    let active = true
    if (typeof ipc.invoke === 'function') {
      void ipc.invoke(COMPUTER_USE_IPC.getState).then((res) => {
        if (active && res && typeof res === 'object' && 'active' in res) {
          useManagedBrowserUi.getState().setActivity(res as ComputerUseActivityState)
        }
      })
    }

    if (typeof ipc.on !== 'function')
      return () => {
        active = false
      }

    const handler = (...args: unknown[]): void => {
      const candidate = args.length > 1 ? args[1] : args[0]
      if (candidate && typeof candidate === 'object' && 'active' in candidate) {
        useManagedBrowserUi.getState().setActivity(candidate as ComputerUseActivityState)
      }
    }
    const maybeUnsub = ipc.on(COMPUTER_USE_IPC.activityChanged, handler)
    return () => {
      active = false
      if (typeof maybeUnsub === 'function') maybeUnsub()
      else ipc.removeListener?.(COMPUTER_USE_IPC.activityChanged, handler)
    }
  }, [])
}
