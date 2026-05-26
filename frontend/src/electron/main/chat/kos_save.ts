// Sprint 19 P1-C — chat 内一键保存到 KOS 服务.
//
// Todo 1 design doc §3.2 方案 A (user-explicit save, D2-approved): chat
// panel message bubble 上挂一个 [✨ 保存到 KOS] 按钮, 把 (user 提问 +
// assistant 回答) 一对 message 包成 markdown page push 到 KOS, 让用户
// 在 chat 里讨论的关键信息进图谱跨 session 检索. 不强制 (不 auto-push),
// 私密对话 user 不点就不进 KOS — 隐私第一.
//
// Architecture:
//   handlers/chat.ts chat:saveToKos IPC → saveConversationToKos(input)
//   → getMessage 取 assistant + 前 user → buildConversationPageContent
//   → buildConversationSlug → kosClient.putPage(slug, content)
//
// D3 (KOS slug namespace) — Lucien (gbrain KOS 维护者) 2026-05-23 回复
// 确认: gbrain 没有 dedicated chat-conversation namespace, 但建议改用
// `chat-history/<source>/...` 上位 namespace + source segment 模式,
// 给未来 OpenClaw chat-save (Sprint 21 路线图 [LATER P3]) / Feishu 对话
// 等同类需求预留空间避免冲突. MailAgent 占第一个坑 source=mailagent.
//
// slug format: `chat-history/mailagent/<email_id>/<session_id>/<message_id>`
// (路径分层用 / 而非 -, 方便 bulk operation 如清理 90 天前对话).
//
// frontmatter 也换成 Lucien 推荐的嵌套形式: `mailagent: { email_id,
// session_id, message_id }`(原 flat `mailagent_email_id` 等被替换),
// `tags: [chat-history, mailagent, conversation]` 让 source-narrow query
// 用 source: mailagent-chat 快速 narrow + chat-history/ prefix 做 bulk.

import {
  getMessage,
  getSession,
  listMessages,
  type ChatMessage,
  type ChatSession
} from '../chat_db'
import { KOSClient, KOSError } from '../kos/client'

const SLUG_PREFIX = 'chat-history/mailagent'

// ── Lazy singleton — 复用 token cache 不每次重 fetch ───────────────

let _client: KOSClient | null = null

export function getKosClientForSave(): KOSClient {
  if (_client === null) {
    _client = new KOSClient()
  }
  return _client
}

/** Tests: inject mock; pass null to reset to default lazy ctor. */
export function __setKosClientForSaveTests(c: KOSClient | null): void {
  _client = c
}

// ── 输入 + 输出契约 ────────────────────────────────────────────────

export interface SaveConversationInput {
  /** assistant message 的 id. service 自己向前找最近的 user message
   *  作为 context (因为 conversation 都是 user/assistant 交替). */
  messageId: number
  /** Optional override — 不传走 default `chat-history/mailagent/<email>/<sess>/<msg>`. */
  slug?: string
  /** Optional override title — 不传从 user message 首句生成 (<= 50 字符). */
  title?: string
}

export interface SaveConversationResult {
  /** Final slug pushed (default or user override). */
  slug: string
  /** KOS server-side status: 'created' / 'updated' / 'unknown'. */
  status: string
  /** Bytes of markdown content actually pushed (debug / size budget). */
  contentBytes: number
}

export interface SaveConversationError {
  code: string
  message: string
}

// ── 纯函数 helpers (好测) ─────────────────────────────────────────

/** Default slug from (email_id, session_id, message_id). Path-segmented
 *  with `/` (Lucien KOS namespace convention: chat-history/<source>/<email>/
 *  <session>/<message>). All segments are non-negative integers, so no
 *  escape/lowercase normalization needed. */
export function buildConversationSlug(opts: {
  emailId: number
  sessionId: number
  messageId: number
  prefix?: string
}): string {
  const prefix = opts.prefix ?? SLUG_PREFIX
  return `${prefix}/${opts.emailId}/${opts.sessionId}/${opts.messageId}`
}

/** Generate auto title from first user message: first sentence / line,
 *  capped 50 chars. Used when caller doesn't override. */
export function buildAutoTitle(userContent: string): string {
  const firstLine = userContent.split(/\r?\n/)[0]?.trim() ?? ''
  const firstSentence = firstLine.split(/[.。!?!?]/)[0]?.trim() ?? firstLine
  const sliced = firstSentence.slice(0, 50)
  return sliced.length > 0 ? sliced : 'Conversation excerpt'
}

/** Build the markdown page content (frontmatter + body) that goes to
 *  KOS put_page. Mirrors src/kos/producer.py:build_kos_page_payload
 *  shape but for conversation source (vs email source). */
export function buildConversationPageContent(opts: {
  userContent: string
  assistantContent: string
  emailId: number
  sessionId: number
  messageId: number
  title: string
  savedAtIso: string
  backendModel: string | null
}): string {
  // YAML frontmatter — top-level keys alphabetical for diff stability.
  // mailagent.* nested per Lucien 2026-05-23 spec (gbrain namespace
  // convention groups source-specific fields under a single key, leaving
  // top-level for cross-source filters like `source` / `tags`). Nested
  // sub-keys also alphabetical (email_id / message_id / session_id).
  const fm = [
    '---',
    'mailagent:',
    `  email_id: ${opts.emailId}`,
    `  message_id: ${opts.messageId}`,
    `  session_id: ${opts.sessionId}`,
    `model: ${opts.backendModel ?? 'unknown'}`,
    `saved_at: ${opts.savedAtIso}`,
    `source: mailagent-chat`,
    `tags: [chat-history, mailagent, conversation]`,
    `title: ${JSON.stringify(opts.title)}`,
    `type: conversation`,
    '---'
  ].join('\n')
  // 2026-05-25 polish — drop `# {title}` H1 per Lucien spec strict;
  // frontmatter `title:` already carries the title, body H1 was a
  // duplicate that KOS renderer treats as a phantom heading.
  const sections: string[] = ['']
  if (opts.userContent.trim().length > 0) {
    sections.push('## User', '', opts.userContent.trim(), '')
  }
  sections.push('## Assistant', '', opts.assistantContent.trim(), '')
  return fm + sections.join('\n')
}

// ── 主入口 ────────────────────────────────────────────────────────

/**
 * Save the (user → assistant) pair around `messageId` to KOS as a
 * single page. Throws Error & { code } on validation / KOS errors
 * (caller IPC handler wraps in envelope).
 *
 * Algorithm:
 *   1. Load assistant message by id; reject if role != 'assistant' or
 *      content empty.
 *   2. Load session for email_id + backend_model + lookup user message
 *      with highest id < messageId in same session (most recent user
 *      message before this assistant turn — standard chat pairing).
 *   3. Compose default slug + title if caller didn't override.
 *   4. Build markdown content.
 *   5. kosClient.putPage(slug, content) — KOS 不可达自然 throw KOSError.
 *   6. Return { slug, status, contentBytes } envelope-ready.
 */
export async function saveConversationToKos(
  input: SaveConversationInput
): Promise<SaveConversationResult> {
  if (!Number.isInteger(input.messageId) || input.messageId < 0) {
    const err = new Error(
      `saveConversationToKos: invalid messageId ${input.messageId}`
    ) as Error & { code: string }
    err.code = 'E_INVALID_ARG'
    throw err
  }

  const assistantMsg = getMessage(input.messageId)
  if (!assistantMsg) {
    const err = new Error(`message ${input.messageId} not found`) as Error & { code: string }
    err.code = 'E_NOT_FOUND'
    throw err
  }
  if (assistantMsg.role !== 'assistant') {
    const err = new Error(
      `saveConversationToKos: messageId ${input.messageId} is role=${assistantMsg.role}, not 'assistant'`
    ) as Error & { code: string }
    err.code = 'E_INVALID_ARG'
    throw err
  }
  if (assistantMsg.content.trim().length === 0) {
    const err = new Error(
      `saveConversationToKos: assistant message ${input.messageId} content is empty`
    ) as Error & { code: string }
    err.code = 'E_INVALID_ARG'
    throw err
  }

  const session: ChatSession | null = getSession(assistantMsg.session_id)
  if (!session) {
    const err = new Error(
      `saveConversationToKos: session ${assistantMsg.session_id} not found`
    ) as Error & { code: string }
    err.code = 'E_NOT_FOUND'
    throw err
  }

  // Find the user message immediately before this assistant turn. Standard
  // chat conversations alternate user → assistant; pair them. listMessages
  // returns chronological; walk backwards from assistant for the most
  // recent user with id < assistantMsg.id.
  const allMessages: ChatMessage[] = listMessages(session.id)
  let userMsg: ChatMessage | null = null
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i]
    if (m.id >= assistantMsg.id) continue
    if (m.role === 'user' && m.content.trim().length > 0) {
      userMsg = m
      break
    }
  }
  // No preceding user message is a real edge — session seeded only by
  // automation, or assistant message at index 0. Save the assistant
  // turn alone in those cases (KOS page valid without User section).
  // Caller UI should usually only surface the [✨ 保存到 KOS] button on
  // assistant turns that have a preceding user message, so this path
  // is rare and intentional rather than a silent default.
  const userContent = userMsg?.content ?? ''

  const slug =
    input.slug ??
    buildConversationSlug({
      emailId: session.email_id,
      sessionId: session.id,
      messageId: assistantMsg.id
    })
  const title = input.title ?? buildAutoTitle(userContent)
  const content = buildConversationPageContent({
    userContent,
    assistantContent: assistantMsg.content,
    emailId: session.email_id,
    sessionId: session.id,
    messageId: assistantMsg.id,
    title,
    savedAtIso: new Date().toISOString(),
    backendModel: assistantMsg.model ?? session.backend_model
  })
  const contentBytes = Buffer.byteLength(content, 'utf8')

  try {
    const result = await getKosClientForSave().putPage(slug, content)
    return {
      slug: result.slug ?? slug,
      status: typeof result.status === 'string' ? result.status : 'unknown',
      contentBytes
    }
  } catch (e) {
    if (e instanceof KOSError) {
      const err = new Error(e.message) as Error & { code: string }
      err.code = e.code
      throw err
    }
    throw e
  }
}
