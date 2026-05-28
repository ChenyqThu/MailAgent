// Notion Agent CLI config IPC adapter. Bridges the Settings page to the
// account-file service in ../notion_agent/config.ts.
//
// Channels:
//   notionAgent:getConfig   (invoke) → NotionAgentConfig          (pure read, never throws)
//   notionAgent:listModels  (invoke) → string[]                   (pure read)
//   notionAgent:doctor      (invoke) → { ok, data | code+message }  (spawns CLI)
//   notionAgent:listAgents  (invoke) → { ok, data | code+message }  (spawns CLI)
//   notionAgent:setAgent    (invoke) → { ok, data | code+message }  (writes account.json)
//   notionAgent:setModel    (invoke) → { ok, data | code+message }  (writes account.json)
//
// Write/CLI channels use the { ok, data | code, message } envelope (same as
// chat:start) because Electron IPC drops custom Error properties — the
// renderer recovers `code` from the envelope, not a thrown Error.

import { ipcMain } from 'electron'

import {
  listAgents,
  listModels,
  readNotionAgentConfig,
  runDoctor,
  setBoundAgent,
  setDefaultModel,
  type NotionAgentConfig,
  type NotionAgentDoctorCheck,
  type NotionAgentListItem
} from '../notion_agent/config'

type Envelope<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

function errEnvelope(err: unknown): { ok: false; code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const code =
    err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string'
      ? (err as Error & { code: string }).code
      : 'E_NOTION_AGENT_FAIL'
  return { ok: false, code, message }
}

export function registerNotionAgentHandlers(): void {
  // Pure local reads — no throw path, so no envelope. A missing/garbled
  // account file just yields configured:false / [].
  ipcMain.handle('notionAgent:getConfig', async (): Promise<NotionAgentConfig> => {
    return readNotionAgentConfig()
  })

  ipcMain.handle('notionAgent:listModels', async (): Promise<string[]> => {
    return listModels()
  })

  ipcMain.handle('notionAgent:doctor', async (): Promise<Envelope<NotionAgentDoctorCheck[]>> => {
    try {
      return { ok: true, data: await runDoctor() }
    } catch (err) {
      return errEnvelope(err)
    }
  })

  ipcMain.handle('notionAgent:listAgents', async (): Promise<Envelope<NotionAgentListItem[]>> => {
    try {
      return { ok: true, data: await listAgents() }
    } catch (err) {
      return errEnvelope(err)
    }
  })

  ipcMain.handle(
    'notionAgent:setAgent',
    async (
      _evt,
      input: { pageId?: unknown; name?: unknown; accessory?: unknown }
    ): Promise<Envelope<NotionAgentConfig>> => {
      const pageId = typeof input?.pageId === 'string' ? input.pageId.trim() : ''
      const name = typeof input?.name === 'string' ? input.name.trim() : ''
      const accessory = typeof input?.accessory === 'string' ? input.accessory : null
      if (pageId.length === 0) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'pageId required' }
      }
      if (name.length === 0) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'name required' }
      }
      try {
        return { ok: true, data: setBoundAgent(pageId, name, accessory) }
      } catch (err) {
        return errEnvelope(err)
      }
    }
  )

  ipcMain.handle(
    'notionAgent:setModel',
    async (_evt, input: { alias?: unknown }): Promise<Envelope<NotionAgentConfig>> => {
      const alias = typeof input?.alias === 'string' ? input.alias.trim() : ''
      if (alias.length === 0) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'alias required' }
      }
      try {
        return { ok: true, data: setDefaultModel(alias) }
      } catch (err) {
        return errEnvelope(err)
      }
    }
  )
}
