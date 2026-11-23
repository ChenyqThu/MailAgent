import { useEffect } from 'react'

import { COMPUTER_USE_IPC, type ComputerUseActivityState } from '@shared/computerUseOverlayContract'
import { onIpcEvent, tryInvokeIpc } from '@shared/ipc/client'
import { useManagedBrowserUi } from '@shared/state/managed-browser-ui'

export function useComputerUseActivityBridge(): void {
  useEffect(() => {
    let active = true
    void tryInvokeIpc(COMPUTER_USE_IPC.getState).then((res) => {
      if (active && res && typeof res === 'object' && 'active' in res) {
        useManagedBrowserUi.getState().setActivity(res as ComputerUseActivityState)
      }
    })

    const off = onIpcEvent(COMPUTER_USE_IPC.activityChanged, (candidate) => {
      if (candidate && typeof candidate === 'object' && 'active' in candidate) {
        useManagedBrowserUi.getState().setActivity(candidate)
      }
    })
    return () => {
      active = false
      off()
    }
  }, [])
}
