// Typed IPC contract layer shared between Electron main and renderer.
// Keeps runtime dependencies minimal (leaf channel constants + TS types only).

import type {
  AIFields,
  AttachmentMeta,
  BodyOpts,
  CalendarExpandOpts,
  CreateDraftOpts,
  CreateDraftResult,
  EmailDetail,
  EmailMeta,
  EnrichedEmailMeta,
  EnvSetResult,
  EnvSnapshot,
  EventsStatus,
  FeedbackDiagnostics,
  FeedbackSubmitOpts,
  ListOpts,
  MailboxSummary,
  NlToDslResult,
  NotificationPermissionResult,
  NotificationSystemStatus,
  NotionAgentConfig,
  NotionAgentDoctorCheck,
  NotionAgentListItem,
  PersistentSettings,
  PingResult,
  RecurringDiscoverOpts,
  RecurringInviteItem,
  RecurringReplayOpts,
  SecretSlot,
  SecretsStatus,
  ServiceRestartResult,
  ServiceStatus,
  ServiceTarget,
  SseEvent,
  UpdaterStatus
} from '@shared/api/types'
import type { FeedbackLogEntry } from '@shared/feedback/contract'
import { COMPUTER_USE_IPC, type ComputerUseActivityState } from '@shared/computerUseOverlayContract'
import type { MailagentEmailBody } from '@shared/types/cli.gen'
import type { DeeplinkTarget } from '@shared/lib/deeplink_target'
import { API_READY_CHANNEL } from '@shared/lib/ipcChannels'
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
} from '@shared/lib/notionOauthContract'
import {
  LIBRARY_IPC,
  type LibraryOpenResult,
  type LibraryOpenTarget,
  type LibraryUsageResult
} from '@shared/libraryIpcContract'
import {
  SYSTEM_PERMISSIONS_IPC,
  type OpenSystemPermissionResult,
  type RequestSystemPermissionResult,
  type SystemPermissionsStatus
} from '@shared/systemPermissionsIpcContract'

type NotionEnvelope<T> = { ok: true; data: T } | { ok: false; code: string; message: string }
type WriteEnvelope<T> = { ok: true; data: T } | { ok: false; code: string; message: string; hint?: string }

/** Request/response (`ipcRenderer.invoke` / `ipcMain.handle`) channel contract. */
export interface IpcInvokeContract {
  'shell:openExternal': { args: [url: string]; result: void }
  [LIBRARY_IPC.openPath]: { args: [target: LibraryOpenTarget]; result: LibraryOpenResult }
  [LIBRARY_IPC.showInFolder]: { args: [target: LibraryOpenTarget]; result: LibraryOpenResult }
  [LIBRARY_IPC.trashItem]: { args: [target: LibraryOpenTarget]; result: LibraryOpenResult }
  [LIBRARY_IPC.usage]: { args: []; result: LibraryUsageResult }
  [SYSTEM_PERMISSIONS_IPC.check]: { args: []; result: SystemPermissionsStatus }
  [SYSTEM_PERMISSIONS_IPC.open]: { args: [kind: unknown]; result: OpenSystemPermissionResult }
  [SYSTEM_PERMISSIONS_IPC.request]: { args: [kind: unknown]; result: RequestSystemPermissionResult }
  [COMPUTER_USE_IPC.getState]: { args: []; result: ComputerUseActivityState }
  [COMPUTER_USE_IPC.stopActive]: { args: []; result: boolean | void }
  [NOTION_OAUTH_START_CHANNEL]: { args: []; result: NotionOauthStartResult }
  [NOTION_OAUTH_CANCEL_CHANNEL]: { args: [arg: { attemptId: string }]; result: void }
  [NOTION_OAUTH_LIST_DATABASES_CHANNEL]: {
    args: [arg: { attemptId: string }]
    result: NotionDbCandidate[]
  }
  [NOTION_OAUTH_SELECT_DATABASES_CHANNEL]: {
    args: [arg: { attemptId: string; emailDbId: string; calendarDbId: string }]
    result: NotionOauthSelectResult
  }
  [NOTION_OAUTH_REMOVE_CONNECTION_CHANNEL]: { args: []; result: NotionOauthRemoveResult }
  'notifications:systemStatus': { args: []; result: NotificationSystemStatus }
  'notifications:sendTest': { args: []; result: { ok: boolean; detail?: string } }
  'notifications:requestPermission': { args: []; result: NotificationPermissionResult }
  'notifications:openSystemSettings': { args: []; result: { ok: boolean } }
  'events:status': { args: []; result: EventsStatus }
  'events:reconnect': { args: []; result: EventsStatus }
  'chat:group-foreground': {
    args: [payload: { groupId: number | null; threadId: number | null }]
    result: void
  }
  'admin:dbPath': { args: []; result: string }
  'admin:exportDiagnostics': { args: []; result: { saved: boolean; path?: string } }
  'email:list': { args: [opts?: ListOpts]; result: EmailMeta[] }
  'email:listEnriched': { args: [opts?: ListOpts]; result: EnrichedEmailMeta[] }
  'email:listMailboxes': { args: []; result: MailboxSummary[] }
  'email:aiFields': { args: [internalId: number]; result: AIFields | null }
  'email:get': { args: [internalId: number]; result: EmailDetail | null }
  'email:body': {
    args: [internalId: number, opts?: BodyOpts]
    result: MailagentEmailBody['data'] | null
  }
  'email:listByThread': { args: [threadId: string | null]; result: EmailMeta[] }
  'email:listByThreads': { args: [threadIds: string[] | null]; result: Record<string, EmailMeta[]> }
  'email:listPinnedIds': { args: []; result: number[] }
  'email:nlToDsl': { args: [nl: string]; result: NlToDslResult }
  'email:createDraft': { args: [opts: CreateDraftOpts]; result: WriteEnvelope<CreateDraftResult> }
  'attachment:list': { args: [internalId: number]; result: AttachmentMeta[] }
  'attachment:localPath': { args: [attachmentId: number]; result: string | null }
  'attachment:readDataUrl': { args: [attachmentId: number]; result: string | null }
  'attachment:download': { args: [attachmentId: number]; result: string | null }
  'calendar:recurringDiscover': {
    args: [opts?: RecurringDiscoverOpts]
    result: RecurringInviteItem[]
  }
  'calendar:recurringReplay': {
    args: [opts: RecurringReplayOpts]
    result: WriteEnvelope<unknown>
  }
  'calendar:expand': { args: [opts?: CalendarExpandOpts]; result: WriteEnvelope<unknown> }
  'settings:secrets:status': { args: []; result: SecretsStatus }
  'settings:secrets:set': {
    args: [req: { secret: SecretSlot; value: string }]
    result: SecretsStatus
  }
  'settings:secrets:clear': { args: [slot: SecretSlot]; result: SecretsStatus }
  'settings:get': { args: []; result: PersistentSettings }
  'settings:set': { args: [partial: Partial<PersistentSettings>]; result: PersistentSettings }
  'settings:pickFolder': { args: [title?: string]; result: string | null }
  'settings:test:llm': { args: []; result: PingResult }
  'settings:test:customApi': { args: []; result: PingResult }
  'env:get': { args: []; result: EnvSnapshot }
  'env:set': { args: [patch: Record<string, string | null>]; result: EnvSetResult }
  'services:restart': { args: [target?: ServiceTarget]; result: ServiceRestartResult }
  'services:status': { args: []; result: ServiceStatus[] }
  'feedback:context': { args: [route?: string]; result: string }
  'feedback:diagnostics': { args: []; result: FeedbackDiagnostics }
  'feedback:submit': { args: [opts: FeedbackSubmitOpts]; result: { submissionBlockId: string } }
  'feedback:recent': { args: []; result: FeedbackLogEntry[] }
  'feedback:openForm': { args: []; result: void }
  'updater:status': { args: []; result: UpdaterStatus }
  'updater:check': { args: []; result: UpdaterStatus }
  'updater:download': { args: []; result: UpdaterStatus }
  'updater:quitAndInstall': { args: []; result: void }
  'notionAgent:getConfig': { args: []; result: NotionAgentConfig }
  'notionAgent:listModels': { args: []; result: string[] }
  'notionAgent:doctor': { args: []; result: NotionEnvelope<NotionAgentDoctorCheck[]> }
  'notionAgent:listAgents': { args: []; result: NotionEnvelope<NotionAgentListItem[]> }
  'notionAgent:setAgent': {
    args: [input: { pageId?: unknown; name?: unknown; accessory?: unknown }]
    result: NotionEnvelope<NotionAgentConfig>
  }
  'notionAgent:setModel': {
    args: [input: { alias?: unknown }]
    result: NotionEnvelope<NotionAgentConfig>
  }
}

/** Fire-and-forget renderer -> main (`ipcRenderer.send` / `ipcMain.on`) channel contract. */
export interface IpcSendContract {
  ping: []
  'appearance:theme': [resolvedTheme: 'dark' | 'light']
  'appearance:nativeTheme': [mode: 'system' | 'dark' | 'light']
  'appearance:accent': [accent: string]
  'appearance:surface': [surface: 'frosted' | 'solid']
  'window:openChatPopout': [emailId: number]
  'window:openDetached': [kind: 'email' | 'report', id: string]
  [COMPUTER_USE_IPC.overlaySetInteractive]: [interactive: boolean]
}

/** Main -> renderer push event (`webContents.send` / `ipcRenderer.on`) channel contract. */
export interface IpcEventContract {
  [API_READY_CHANNEL]: []
  'mailagent:deeplink': [target: DeeplinkTarget]
  'mailagent:open-general-agent': [payload?: { prompt?: unknown }]
  'mailagent:tray-open-today': []
  'mailagent:tray-compose-new': []
  'appearance:vibrancyState': [active: unknown]
  [COMPUTER_USE_IPC.activityChanged]: [state: ComputerUseActivityState]
  [NOTION_OAUTH_STATUS_CHANNEL]: [event: NotionOauthStatusEvent]
  'events:received': [event: SseEvent]
  'events:status': [status: EventsStatus]
  'updater:event': [status: UpdaterStatus]
  'tray:opened': []
}
