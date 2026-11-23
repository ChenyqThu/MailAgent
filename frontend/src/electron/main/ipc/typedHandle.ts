// Typed IPC registration helpers for Electron main process.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

import type { IpcInvokeContract, IpcSendContract } from '@shared/ipc/contract'

/** Register a typed `ipcMain.handle` handler checked against `IpcInvokeContract`. */
export function typedIpcHandle<C extends keyof IpcInvokeContract>(
  channel: C,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcInvokeContract[C]['args']
  ) => IpcInvokeContract[C]['result'] | Promise<IpcInvokeContract[C]['result']>
): void {
  ipcMain.handle(channel as string, (event, ...args) =>
    handler(event, ...(args as IpcInvokeContract[C]['args']))
  )
}

/** Register a typed `ipcMain.on` listener checked against `IpcSendContract`. */
export function typedIpcOn<C extends keyof IpcSendContract>(
  channel: C,
  handler: (event: IpcMainEvent, ...args: IpcSendContract[C]) => void
): void {
  ipcMain.on(channel as string, (event, ...args) =>
    handler(event, ...(args as IpcSendContract[C]))
  )
}
