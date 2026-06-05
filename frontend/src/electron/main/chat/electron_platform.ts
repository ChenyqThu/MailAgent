// V2.1 阶段 3 — ElectronChatPlatform：ChatPlatform 的桌面端实现（main 进程）。
//
// 实现分层接线板的基础设施板（ChatInfraPlatform）：直调既有 chat_db / db /
// config / kos —— streamContent = 同步 updateMessage，字节级零回归。shared 的
// harness（step 4）/ dispatcher（step 5）经此访问外部能力；3c 远程对应
// HttpChatPlatform（shared/web，fetch serve-api）。
//
// 非 shared（在 main）：可自由引 better-sqlite3 链路的 chat_db/db + config env 读。
// 单例 electronChatPlatform 由 dispatcher（step 4）/ handlers/chat（step 5）注入给
// shared harness/dispatcher；模型板/工具板原语 3b 扩展到本对象（或拆独立实现）。

import * as chatDb from '../chat_db'
import { getDb } from '../db'
import { getMaxCostUsd, getMaxIter, isHarnessEnabled, isKosL1HotBlockEnabled } from './config'
import { prefetchSenderDigest as kosPrefetchSenderDigest } from '../kos/sender_digest_cache'
import type { ChatInfraPlatform, ChatPersistPort, ChatRuntimeConfig } from '@shared/chat/platform'
import type { EmailContext } from '@shared/chat/types'

// Sprint 4 review (Opus H-1)：cap email body to model（从 dispatcher.loadEmailContext
// 移入，单一真源）。Matches Sprint 3 translate.ts limit + backend LLM_BODY_MAX_CHARS。
const MAX_BODY_CHARS = 12_000

// ── 持久化端口：转发既有 chat_db（同步），包成 Promise 满足跨端异步接口 ──────
// 对象方法零 this 依赖（全调 import 的 chatDb.*），解构调用安全。
const persist: ChatPersistPort = {
  async getOrCreateSession(input) {
    return chatDb.getOrCreateSession(input)
  },
  async createNewSession(input) {
    return chatDb.createNewSession(input)
  },
  async getSession(sessionId) {
    return chatDb.getSession(sessionId)
  },
  async getMessage(messageId) {
    return chatDb.getMessage(messageId)
  },
  async listLastNMessages(sessionId, limit) {
    return chatDb.listLastNMessages(sessionId, limit)
  },
  async appendMessage(input) {
    return chatDb.appendMessage(input)
  },
  // 流式增量 = 同步直写（字节级零回归，fire-and-forget void）。
  streamContent(messageId, content) {
    chatDb.updateMessage(messageId, { content })
  },
  async finalizeMessage(messageId, patch) {
    chatDb.updateMessage(messageId, patch)
  },
  async deleteMessagesFromId(sessionId, fromMessageId) {
    return chatDb.deleteMessagesFromId(sessionId, fromMessageId)
  },
  async abortStreamingMessages(sessionId) {
    return chatDb.abortStreamingMessages(sessionId)
  },
  async appendToolCall(input) {
    return chatDb.appendToolCall(input)
  },
  async updateToolCall(toolCallId, patch) {
    chatDb.updateToolCall(toolCallId, patch)
  },
  async getToolCallByUseId(messageId, toolUseId) {
    return chatDb.getToolCallByUseId(messageId, toolUseId)
  }
}

/** 从 SQLite SSoT 读邮件元数据 + markdown 正文（从 dispatcher 移入，单一真源）。
 *  行缺失 / DB 不可达 → null（chat 仍可跑，模型看不到邮件正文）。 */
function queryEmailContext(emailId: number): EmailContext | null {
  try {
    const db = getDb()
    // PR-2g dogfood fix：加 ai_priority / ai_action / processing_status 进 ctx,
    // 让 chat agent system prompt 直接看到 'AI 已标 🟡 重要 + 需要决策' 不必先
    // query 一轮。字段从 email_metadata v14 主表读。
    const row = db
      .prepare(
        `SELECT m.internal_id, m.subject, m.sender_name, m.sender, m.date_received,
                m.notion_page_id, m.ai_priority, m.ai_action, m.processing_status,
                b.body_markdown
           FROM email_metadata m
           LEFT JOIN email_body b ON b.internal_id = m.internal_id
          WHERE m.internal_id = ?`
      )
      .get(emailId) as
      | {
          internal_id: number
          subject: string | null
          sender_name: string | null
          sender: string | null
          date_received: string | null
          notion_page_id: string | null
          ai_priority: string | null
          ai_action: string | null
          processing_status: string | null
          body_markdown: string | null
        }
      | undefined
    if (!row) return null
    const body =
      typeof row.body_markdown === 'string' ? row.body_markdown.slice(0, MAX_BODY_CHARS) : null
    return {
      internalId: row.internal_id,
      subject: row.subject,
      senderName: row.sender_name,
      senderAddr: row.sender,
      dateIso: row.date_received,
      bodyMarkdown: body && body.length > 0 ? body : null,
      notionPageId: row.notion_page_id,
      aiPriority: row.ai_priority,
      aiAction: row.ai_action,
      processingStatus: row.processing_status
    }
  } catch {
    return null
  }
}

/** 桌面端 ChatPlatform 单例（实现基础设施板；模型/工具板原语 3b 扩展同一对象
 *  或拆 ElectronModelPlatform/…，按 3b 决策）。 */
export const electronChatPlatform: ChatInfraPlatform = {
  persist,
  async loadEmailContext(emailId) {
    return queryEmailContext(emailId)
  },
  async resolveConfig(): Promise<ChatRuntimeConfig> {
    return {
      maxIter: getMaxIter(),
      maxCostUsd: getMaxCostUsd(),
      kosL1HotBlockEnabled: isKosL1HotBlockEnabled(),
      harnessEnabled: isHarnessEnabled()
    }
  },
  prefetchSenderDigest(senderAddr) {
    void kosPrefetchSenderDigest(senderAddr)
  }
}
