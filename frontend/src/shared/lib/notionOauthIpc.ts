// task 08-20 Notion OAuth — renderer 侧 IPC 包装（Lane 3）。
//
// 契约（channel 名 / 载荷形状）单源 = ./notionOauthContract；这里只负责「怎么调」：
//   * 探针姿势抄 ElectronApi.ts / consoleShared.ts —— 直接摸 window.electron.ipcRenderer，
//     preload 缺席（远程 web 构建 / 非 Electron 测试环境）不抛同步异常，而是
//     available() 返回 false、调用返回稳定失败，调用方据此隐藏入口。
//   * 订阅**必须**用 `on()` 返回的 disposer 反订阅（跨 contextBridge 二次传同一个
//     函数会生成新 proxy，removeListener 匹配不到 → listener 泄漏 → StrictMode
//     下事件投递两次）。同 ElectronApi.subscribe 的 CRITICAL 注释，一字不改地遵守。
//
// 🔴 这些通道的载荷里没有 token/code/state（main 侧保证），本文件也不落任何本地缓存。

import {
  NOTION_OAUTH_CANCEL_CHANNEL,
  NOTION_OAUTH_LIST_DATABASES_CHANNEL,
  NOTION_OAUTH_REMOVE_CONNECTION_CHANNEL,
  NOTION_OAUTH_SELECT_DATABASES_CHANNEL,
  NOTION_OAUTH_START_CHANNEL,
  NOTION_OAUTH_STATUS_CHANNEL,
  type NotionDbCandidate,
  type NotionOauthRemoveResult,
  type NotionOauthSelectResult,
  type NotionOauthStartResult,
  type NotionOauthStatusEvent
} from './notionOauthContract'

type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>
type IpcListener = (event: unknown, ...args: unknown[]) => void
type IpcOn = (channel: string, listener: IpcListener) => unknown

interface IpcBridge {
  invoke?: IpcInvoke
  on?: IpcOn
  removeListener?: (channel: string, listener: IpcListener) => void
  off?: (channel: string, listener: IpcListener) => void
}

function bridge(): IpcBridge | undefined {
  const w = window as unknown as { electron?: { ipcRenderer?: IpcBridge } }
  return w.electron?.ipcRenderer
}

/** OAuth 流是否可用：远程 web 构建 / preload 缺席时为 false（入口整体不渲染，
 *  而不是渲染一个点了必然报错的按钮）。 */
export function notionOauthAvailable(): boolean {
  try {
    return typeof bridge()?.invoke === 'function'
  } catch {
    return false
  }
}

function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const fn = bridge()?.invoke
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('notionOauth IPC: preload bridge missing'))
  }
  return arg === undefined ? fn(channel) : fn(channel, arg)
}

export function startNotionOauth(): Promise<NotionOauthStartResult> {
  return invoke(NOTION_OAUTH_START_CHANNEL) as Promise<NotionOauthStartResult>
}

export function cancelNotionOauth(attemptId: string): Promise<void> {
  return invoke(NOTION_OAUTH_CANCEL_CHANNEL, { attemptId }) as Promise<void>
}

export function listNotionDatabases(attemptId: string): Promise<NotionDbCandidate[]> {
  return invoke(NOTION_OAUTH_LIST_DATABASES_CHANNEL, { attemptId }) as Promise<NotionDbCandidate[]>
}

export function selectNotionDatabases(arg: {
  attemptId: string
  emailDbId: string
  calendarDbId: string
}): Promise<NotionOauthSelectResult> {
  return invoke(NOTION_OAUTH_SELECT_DATABASES_CHANNEL, arg) as Promise<NotionOauthSelectResult>
}

export function removeNotionConnection(): Promise<NotionOauthRemoveResult> {
  return invoke(NOTION_OAUTH_REMOVE_CONNECTION_CHANNEL) as Promise<NotionOauthRemoveResult>
}

/** 订阅 main → renderer 的授权状态推送。返回反订阅函数（preload 缺席时是 no-op）。 */
export function subscribeNotionOauthStatus(
  handler: (event: NotionOauthStatusEvent) => void
): () => void {
  const b = bridge()
  const onFn = b?.on
  if (typeof onFn !== 'function') return () => undefined
  const wrapped: IpcListener = (_event, ...args) => {
    const payload = args[0]
    if (payload && typeof payload === 'object') handler(payload as NotionOauthStatusEvent)
  }
  // 🔴 用 on() 返回的 disposer 反订阅（见文件头）；桥接实现没返回时才退回 removeListener。
  const dispose = onFn.call(b, NOTION_OAUTH_STATUS_CHANNEL, wrapped) as (() => void) | undefined
  if (typeof dispose === 'function') return dispose
  return () => {
    const removeFn = b?.removeListener ?? b?.off
    if (typeof removeFn === 'function') removeFn.call(b, NOTION_OAUTH_STATUS_CHANNEL, wrapped)
  }
}
