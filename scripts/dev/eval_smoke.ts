// Smoke test — run 1 scenario end-to-end against real LLM.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const PROJECT_ROOT = '/Users/chenyuanquan/Documents/MailAgent'
const envPath = join(PROJECT_ROOT, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
process.env.MAILAGENT_AGENT_HARNESS = '1'
process.env.AI_CHAT_DB_PATH = ':memory:'
process.env.AGENT_MAX_ITER = '5'
process.env.AGENT_MAX_COST_USD = '0.2'

console.log('LLM_API_KEY:', process.env.LLM_API_KEY ? `(set, ${process.env.LLM_API_KEY.slice(0,6)}…)` : 'MISSING')
console.log('LLM_API_BASE:', process.env.LLM_API_BASE)
console.log('LLM_MODEL:', process.env.LLM_MODEL)

import { runHarness } from './src/electron/main/chat/harness'
import { appendMessage, getOrCreateSession, closeChatDb } from './src/electron/main/chat_db'
import { defaultToolRegistry } from './src/electron/main/chat/tools/registry'
import { resolveConfirmation } from './src/electron/main/chat/tools/confirmation'
import { registerBuiltinTools } from './src/electron/main/chat/tools/builtin'
import { CustomApiBackend } from './src/electron/main/chat/backends/custom_api'

registerBuiltinTools(defaultToolRegistry)
console.log('Tools registered:', defaultToolRegistry.names().sort().join(', '))

const session = getOrCreateSession({ emailId: 1000000024, backendKind: 'custom-api', backendModel: 'claude-sonnet-4-6' })
appendMessage({ sessionId: session.id, role: 'user', content: '这封邮件主要说什么？给我一个三句话摘要。', status: 'complete' })
const a = appendMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming' })

const DB_PATH = '/Users/chenyuanquan/Documents/MailAgent/data/sync_store.db'
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
const row = db.prepare(`SELECT m.internal_id, m.subject, m.sender_name, m.sender, m.date_received, m.notion_page_id, m.ai_priority, m.ai_action, m.processing_status, b.body_markdown FROM email_metadata m LEFT JOIN email_body b ON b.internal_id=m.internal_id WHERE m.internal_id=?`).get(1000000024) as any
db.close()
const emailCtx = row ? {
  internalId: row.internal_id, subject: row.subject, senderName: row.sender_name, senderAddr: row.sender,
  dateIso: row.date_received,
  bodyMarkdown: row.body_markdown ? row.body_markdown.slice(0, 12000) : null,
  notionPageId: row.notion_page_id, aiPriority: row.ai_priority, aiAction: row.ai_action, processingStatus: row.processing_status
} : null
console.log('Email ctx:', emailCtx ? `${emailCtx.subject} (from ${emailCtx.senderName}, body=${emailCtx.bodyMarkdown ? emailCtx.bodyMarkdown.length+'chars' : 'null'})` : '(none)')

let finalText = ''
const toolNames: string[] = []
let errorEvt: string | null = null
const ac = new AbortController()
setTimeout(() => ac.abort(), 60_000)

const sink = {
  send(env: any) {
    const e = env.event
    if (e.type === 'chunk') finalText += e.delta
    else if (e.type === 'tool_use') { toolNames.push(e.name); console.log('  tool_use:', e.name, JSON.stringify(e.input).slice(0,100)) }
    else if (e.type === 'usage') console.log('  usage:', e.inputTokens, 'in/', e.outputTokens, 'out, $', e.costUsd)
    else if (e.type === 'done') console.log('  done, stop=', e.stopReason)
    else if (e.type === 'error') { errorEvt = e.code; console.log('  ERROR:', e.code, e.message) }
    else if (e.type === 'pending_confirmation') {
      console.log('  pending_confirmation:', e.toolName)
      setImmediate(() => resolveConfirmation(e.toolUseId, { approved: true }))
    }
  }
}
const backend = new CustomApiBackend()
const t0 = Date.now()
runHarness({
  sessionId: session.id, assistantMessageId: a.id, backend, initialHistory: [],
  model: 'claude-sonnet-4-6', agentPageId: null, emailContext: emailCtx, ac, sink
}).then(() => {
  console.log('Runtime:', Date.now()-t0, 'ms')
  console.log('Tools called:', toolNames)
  console.log('Final text (300 chars):', finalText.slice(0,300))
  console.log('Error:', errorEvt)
  closeChatDb()
}).catch(e => { console.error('FATAL:', e); process.exit(1) })
