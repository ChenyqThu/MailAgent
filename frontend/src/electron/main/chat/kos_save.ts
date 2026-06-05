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
import { getDb } from '../db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from '../llm_settings'
import { KOSClient, KOSError } from '../kos/client'

const SLUG_PREFIX = 'chat-history/mailagent'

// One-shot summarize call deadline. Generous vs the chat stream's 60s
// because this runs synchronously inside the save IPC (user waits on the
// toast); too short risks a needless fallback to raw transcript. Failure
// here is non-fatal — fallback body keeps the save working.
const SUMMARIZE_DEADLINE_MS = 45_000
const SUMMARIZE_MAX_TOKENS = 64000
const CRS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'

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

// ── LLM summarize (③) ─────────────────────────────────────────────
//
// Replaces the raw User/Assistant transcript with an LLM-distilled
// structured Chinese summary. Per Lucien's brain-mechanics review: raw
// chat is half "好的/明白了" filler with poor embedding / entity-extraction
// quality, and KOS's extract-conversation-facts skips one-off chat-saves —
// so a structured summary is a first-class input. Email body is NOT
// restated (it already lives in KOS at `sources/email/<id>`); the summary
// references it and focuses on the conversation's own takeaways.

/** Signature of the one-shot summarizer so tests can inject a mock LLM and
 *  exercise both the success (structured body) and failure (raw transcript
 *  fallback) paths without burning tokens or hitting the network. */
export type ConversationSummarizer = (opts: {
  userContent: string
  assistantContent: string
  emailSubject: string | null
  emailId: number
}) => Promise<string>

let _summarizer: ConversationSummarizer | null = null

/** Tests: inject a mock summarizer; pass null to reset to the real LLM call. */
export function __setSummarizerForTests(fn: ConversationSummarizer | null): void {
  _summarizer = fn
}

function getSummarizer(): ConversationSummarizer {
  return _summarizer ?? summarizeConversation
}

/** Read the email subject from the SQLite SSoT for the summarize prompt, so
 *  the LLM knows which email the conversation is about without us restating
 *  the body. Returns null on miss / unreachable DB (summary still works,
 *  just without the subject anchor). */
function getEmailSubject(emailId: number): string | null {
  try {
    const row = getDb()
      .prepare('SELECT subject FROM email_metadata WHERE internal_id = ?')
      .get(emailId) as { subject: string | null } | undefined
    return row?.subject ?? null
  } catch {
    return null
  }
}

const SUMMARIZE_SYSTEM_PROMPT = [
  '你是 MailAgent 的对话归档助手。用户刚和 AI 助手就一封邮件进行了一轮问答,',
  '现在要把这轮对话提炼成结构化的中文总结, 存入知识库 (KOS) 供日后跨会话检索。',
  '',
  '硬性要求:',
  '- 输出简体中文。',
  '- 禁止复述邮件正文 —— 邮件原文已单独存在知识库里, 只需引用, 不要重复内容。',
  '- 聚焦【这轮对话本身】的提炼: 用户真正想解决什么、得到了什么结论、牵涉哪些实体与待办。',
  '- 跳过寒暄与 "好的/明白了" 这类无信息量的内容。',
  '- 只输出 markdown 正文, 不要输出 YAML frontmatter, 不要用代码块包裹整段输出。',
  '',
  '严格按以下结构输出 (三段, 标题用中文原文):',
  '# {一句话主题作为标题}',
  '## 关键结论 / 决策',
  '- (逐条列出对话得出的结论或决策; 没有就写 "- (本轮无明确结论)")',
  '## 涉及实体 / 待办',
  '- (逐条显式列出涉及的人名 / 项目 / 产品 / 公司 / 具体动作, 供知识库实体识别使用;',
  '  没有就写 "- (无)")'
].join('\n')

function buildSummarizeUserPrompt(opts: {
  userContent: string
  assistantContent: string
  emailSubject: string | null
}): string {
  const parts: string[] = []
  parts.push(
    opts.emailSubject
      ? `这轮对话讨论的邮件主题是:《${opts.emailSubject}》`
      : '这轮对话讨论的是用户当前打开的一封邮件 (主题未知)。'
  )
  parts.push('')
  parts.push('用户提问:')
  parts.push(opts.userContent.trim().length > 0 ? opts.userContent.trim() : '(无)')
  parts.push('')
  parts.push('AI 助手回答:')
  parts.push(opts.assistantContent.trim())
  return parts.join('\n')
}

/** Extract assistant text from a non-streaming response of either protocol.
 *  Anthropic `/v1/messages` → `content: [{type:'text', text}]`; OpenAI
 *  `/v1/chat/completions` → `choices: [{message: {content}}]`. Returns ''
 *  when neither shape yields text (caller treats empty as failure). */
function extractSummaryText(parsed: unknown): string {
  const obj = parsed as Record<string, unknown>
  // Anthropic shape.
  const content = obj?.content
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const block = b as { type?: string; text?: string }
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .join('')
    if (text.trim().length > 0) return text.trim()
  }
  // OpenAI shape.
  const choices = obj?.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as { message?: { content?: unknown } })?.message
    if (msg && typeof msg.content === 'string' && msg.content.trim().length > 0) {
      return msg.content.trim()
    }
  }
  return ''
}

/** Real one-shot summarize call. Reuses custom_api's credential / baseUrl /
 *  model resolution (getLlmApiKey + getLlmBaseUrl + getLlmModel). Issues a
 *  NON-streaming request — this is an independent one-shot call, not part of
 *  the multi-turn streaming harness. Anthropic models hit `/v1/messages`;
 *  other (OpenAI-protocol) models hit `/v1/chat/completions`. Throws on any
 *  failure (no key / HTTP error / empty output) so the caller falls back to
 *  the raw transcript body. */
async function summarizeConversation(opts: {
  userContent: string
  assistantContent: string
  emailSubject: string | null
  emailId: number
}): Promise<string> {
  const apiKey = await getLlmApiKey()
  if (!apiKey) {
    const err = new Error('LLM API key not configured') as Error & { code: string }
    err.code = 'E_NO_LLM_KEY'
    throw err
  }
  const baseUrl = getLlmBaseUrl()
  const model = getLlmModel()
  const userPrompt = buildSummarizeUserPrompt(opts)
  const isAnthropic = model.startsWith('claude-') || model.startsWith('claude:')

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SUMMARIZE_DEADLINE_MS)
  try {
    let url: string
    let headers: Record<string, string>
    let body: Record<string, unknown>
    if (isAnthropic) {
      url = `${baseUrl}/v1/messages`
      headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'user-agent': CRS_USER_AGENT
      }
      body = {
        model,
        max_tokens: SUMMARIZE_MAX_TOKENS,
        system: SUMMARIZE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        stream: false
      }
    } else {
      url = `${baseUrl}/v1/chat/completions`
      headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      }
      body = {
        model,
        max_tokens: SUMMARIZE_MAX_TOKENS,
        messages: [
          { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      }
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal
    })
    if (!resp.ok) {
      const err = new Error(`summarize LLM HTTP ${resp.status}`) as Error & { code: string }
      err.code = resp.status === 429 ? 'E_QUOTA' : 'E_UPSTREAM'
      throw err
    }
    const parsed = (await resp.json()) as unknown
    const text = extractSummaryText(parsed)
    if (text.length === 0) {
      const err = new Error('summarize LLM returned empty content') as Error & { code: string }
      err.code = 'E_UPSTREAM'
      throw err
    }
    return text
  } finally {
    clearTimeout(timer)
  }
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
  /** ③ LLM-distilled structured summary markdown (body only, no
   *  frontmatter). When present + non-empty, replaces the raw
   *  User/Assistant transcript as the page body. Null → fall back to the
   *  raw transcript (LLM unavailable / failed). */
  summaryBody?: string | null
  /** Email subject for the summary's reference line. Null → omit subject
   *  from the reference. Only used when `summaryBody` is present. */
  emailSubject?: string | null
}): string {
  // YAML frontmatter — top-level keys alphabetical for diff stability.
  // mailagent.* nested per Lucien 2026-05-23 spec (gbrain namespace
  // convention groups source-specific fields under a single key, leaving
  // top-level for cross-source filters like `source` / `tags`). Nested
  // sub-keys also alphabetical (email_id / message_id / session_id).
  //
  // source_refs (②): block-list pointing at the bulk-ingested email page.
  // The slug MUST byte-match the bulk ingest's `sources/email/<internal_id>`
  // (email_id == internal_id) so KOS's dream-cycle backlinks phase resolves
  // the target and builds the chat→email graph edge (Lucien hard constraint).
  const fm = [
    '---',
    'mailagent:',
    `  email_id: ${opts.emailId}`,
    `  message_id: ${opts.messageId}`,
    `  session_id: ${opts.sessionId}`,
    `model: ${opts.backendModel ?? 'unknown'}`,
    `saved_at: ${opts.savedAtIso}`,
    `source: mailagent-chat`,
    'source_refs:',
    `  - 'sources/email/${opts.emailId}'`,
    `tags: [chat-history, mailagent, conversation]`,
    `title: ${JSON.stringify(opts.title)}`,
    `type: conversation`,
    '---'
  ].join('\n')

  const summary = opts.summaryBody?.trim() ?? ''
  if (summary.length > 0) {
    // ③ Structured-summary body. The LLM already produced the H1 +
    // sectioned markdown per SUMMARIZE_SYSTEM_PROMPT; we prepend a
    // reference line pointing at the email page (no body restated). No
    // <details>, no raw transcript — the original turns stay in chat_db
    // SQLite; the brain only needs the distilled form (Lucien).
    const refSubject = opts.emailSubject?.trim()
    const refLine = refSubject
      ? `> 关于邮件《${refSubject}》的讨论 · 关联 sources/email/${opts.emailId}`
      : `> 关于邮件的讨论 · 关联 sources/email/${opts.emailId}`
    // Inject the reference line right after the LLM's H1 so it reads as a
    // subtitle. If the summary doesn't start with an H1 (defensive), just
    // prepend the reference line.
    const lines = summary.split('\n')
    if (lines[0]?.startsWith('# ')) {
      const rest = lines.slice(1).join('\n').replace(/^\n+/, '')
      return `${fm}\n\n${lines[0]}\n${refLine}\n\n${rest}`
    }
    return `${fm}\n\n${refLine}\n\n${summary}`
  }

  // Fallback body — raw User/Assistant transcript (LLM unavailable). Same
  // shape as before ③: 2026-05-25 polish dropped `# {title}` H1 (frontmatter
  // title already carries it).
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

  // ③ Summarize the turn into a structured markdown body. LLM failure
  // (no key / network / timeout / empty) is non-fatal: we log a warning and
  // fall back to the raw transcript so KOS save never hard-depends on the
  // LLM (Lucien ④). emailSubject anchors the summary's reference line.
  const emailSubject = getEmailSubject(session.email_id)
  let summaryBody: string | null = null
  try {
    summaryBody = await getSummarizer()({
      userContent,
      assistantContent: assistantMsg.content,
      emailSubject,
      emailId: session.email_id
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    console.warn(
      `[kos_save] summarize failed for message ${assistantMsg.id} (${reason}); ` +
        'falling back to raw transcript body'
    )
    summaryBody = null
  }

  const content = buildConversationPageContent({
    userContent,
    assistantContent: assistantMsg.content,
    emailId: session.email_id,
    sessionId: session.id,
    messageId: assistantMsg.id,
    title,
    savedAtIso: new Date().toISOString(),
    backendModel: assistantMsg.model ?? session.backend_model,
    summaryBody,
    emailSubject
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
