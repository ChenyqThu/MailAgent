// P4b — AI 自然语言检索：用户自然语言 → LLM 翻译成搜索 DSL。
//
// 单次 (非流式) Anthropic Messages 调用，把一句自然语言（"找一下 echo 这几天
// 给我发的关于新人培训的邮件"）翻成现有搜索 DSL（"from:echo after:2026-06-15
// 新人培训"），前端再把 DSL 填回搜索框跑既有搜索路径。**本文件不碰 P4a 的
// email.ts 搜索/snippet/warm 逻辑** —— 它只产出一个 DSL 字符串。
//
// 调用风格刻意对齐 translate.ts（同一个 CRS /v1/messages 端点 + x-api-key +
// anthropic-version + CRS UA + 非流式 json 解析）——单次调用，不需要多轮
// chat 引擎。
//
// LLM 配置复用 llm_settings.ts 的主 LLM gateway（getLlmApiKey / getLlmBaseUrl
// / getLlmModel）。无 key → 返回结构化 error（前端提示「请先在设置配置 LLM」），
// 永不抛到 IPC 边界外。

import { ipcMain } from 'electron'
import { generateText } from 'ai'

import { isProviderCredentialsError } from '../../../ai-gateway/providerRef'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from '../llm_settings'
import {
  getLlmProviderModelResolver,
  isLlmProviderRegistryEnabled,
  sanitizedUpstreamErrorMessage
} from '../llm_provider_resolver'

export interface NlToDslResult {
  /** 翻译出的 DSL；error 非空时为 ''。 */
  dsl: string
  /** 结构化错误码（E_NO_LLM_KEY / E_EMPTY / E_UPSTREAM / E_QUOTA / E_TIMEOUT
   *  / E_NO_OUTPUT）。成功时省略。 */
  error?: string
  /** 给前端兜底展示的人类可读信息（i18n 仍以 error 码为准，message 仅 debug）。*/
  message?: string
}

// 项目 LLM 调用约定（memory feedback）：所有调用统一 1M 上下文 + 64k max output。
// 输入是一句话、输出是一行 DSL，实际 token 远小于此，但按约定设上限不省。
const MAX_OUTPUT_TOKENS = 64_000
const REQUEST_TIMEOUT_MS = 30_000
// CRS / Cloudflare 对 user-agent 挑剔（见 translate.ts 同处）—— 用桌面浏览器 UA。
const CRS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36'

/** 本地日期 YYYY-MM-DD（按主进程系统时区）——喂给 LLM 解析"今天/这几天/上周"。 */
function todayLocalIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** USER_EMAIL（bootstrapDotenv 已把 repo-root .env 注入 process.env）——解析
 *  "给我发的 / 我发的"。缺失则不注入该上下文（LLM 仍可工作，只是相对人称没锚点）。*/
function userEmail(): string | null {
  const v = process.env['USER_EMAIL']
  return v && v.includes('@') ? v.trim() : null
}

/** DSL 语法摘要（从 docs/reference/search/search-query-syntax.md 浓缩）+ 相对
 *  时间/人称锚点 + few-shot。要求 LLM **只输出一行 DSL**，无解释/markdown/代码块。*/
function buildSystemPrompt(): string {
  const today = todayLocalIso()
  const me = userEmail()
  const lines: string[] = [
    'You translate a natural-language email-search request (Chinese or English) into a',
    "single-line search DSL query for MailAgent's email search box. Output ONLY the DSL",
    'string — no explanation, no markdown, no code fences, no quotes around the whole line.',
    '',
    `Today's date is ${today} (local time). Resolve relative dates against it.`
  ]
  if (me) {
    lines.push(
      `The current user's own email address is ${me}. "给我发的 / 发给我的 / sent to me" →`,
      `the user is the recipient (to:${me}); "我发的 / 我发出的 / I sent" → the user is the`,
      `sender (from:${me}).`
    )
  }
  lines.push(
    '',
    '## DSL grammar (compile the intent into these, combine with spaces = implicit AND):',
    '- Field filters `field:value` (case-insensitive field; quote values with spaces):',
    '  - from: (sender addr/name) · to: · cc: · subject: (substring) · mailbox: (alias in:,',
    '    inbox/sent/archive/drafts → 收件箱/发件箱/存档/草稿箱)',
    '  - after: (alias since:) / before: (alias until:) / date: (alias on:) — date YYYY-MM-DD,',
    '    local time, before/date are "day-inclusive"',
    '  - newer_than:Nd / older_than:Nd — relative to now, unit d/w/m/y (e.g. newer_than:7d)',
    '  - is:read|unread|flagged|unflagged|pinned|important',
    '  - has:attachment',
    '  - priority:urgent|important|normal|low (Chinese 紧急/重要/一般/低 also OK)',
    '  - sort:relevance|date|oldest (date alias newest)',
    '- Column-level full-text (FTS): body: · subject~: · sender~: (relevance-ranked).',
    '- Recipient full-text (FTS, token match): to~: · cc~: · from~: (from~: = display name only).',
    '- Bare words = full-text search across body/subject/sender; multiple words AND together.',
    '  Keep meaningful Chinese/English topic words as bare words (e.g. 新人培训, contract).',
    '- Negation: prefix a token with `-` (e.g. -from:noreply, -is:read, -报告).',
    '- OR: capitalized OR between two same-class units.',
    '',
    '## Rules:',
    '- Prefer field filters for people/dates/state; keep the actual topic as bare words.',
    '- Use after:/before: for "这几天/最近/上周/今天" by computing concrete YYYY-MM-DD dates,',
    '  OR newer_than:Nd when a rolling window fits better ("近 7 天" → newer_than:7d).',
    '- For a person referenced by a name/handle (e.g. "echo", "张三"), use from: with that token.',
    '- Do NOT invent fields not listed above. If unsure, fall back to bare topic words.',
    '- Output a SINGLE line. If the request is empty or has no searchable intent, output an',
    '  empty line.',
    '',
    '## Examples:',
    `Input: 找一下 echo 这几天给我发的，关于新人培训的邮件`,
    `Output: from:echo${me ? ` to:${me}` : ''} newer_than:7d 新人培训`,
    `Input: 上周 alice 发来的带附件的合同，未读的`,
    `Output: from:alice has:attachment is:unread 合同`,
    `Input: emails about the redis timeout incident, most recent first`,
    `Output: redis timeout sort:date`
  )
  return lines.join('\n')
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>
  model?: string
}

/** 清洗 LLM 输出成单行 DSL：剥 code fence / 前后引号 / 多行只取首非空行。 */
function sanitizeDsl(raw: string): string {
  let s = raw.trim()
  // 去掉 ```...``` 围栏（含可选语言标记）。
  s = s
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
  // 只取第一非空行（防 LLM 多吐一行解释）。
  const firstLine = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  s = firstLine ?? ''
  // 整行被一对引号包裹时剥掉（DSL 内部的字段引号保留）。
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith('「') && s.endsWith('」') && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim()
  }
  return s
}

/** 核心：自然语言 → DSL。任何失败都返回 {dsl:'', error}，不抛。 */
export async function nlToDsl(nl: string): Promise<NlToDslResult> {
  const input = (nl ?? '').trim()
  if (input.length === 0) {
    return { dsl: '', error: 'E_EMPTY', message: 'empty natural-language query' }
  }

  const providerRegistryEnabled = isLlmProviderRegistryEnabled()
  const apiKey = (await getLlmApiKey()) ?? ''
  if (!providerRegistryEnabled && !apiKey) {
    return {
      dsl: '',
      error: 'E_NO_LLM_KEY',
      message: 'LLM API key not configured — set it in Settings or LLM_API_KEY env'
    }
  }
  const baseUrl = getLlmBaseUrl()
  const model = getLlmModel()

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    if (providerRegistryEnabled) {
      const resolver = await getLlmProviderModelResolver()
      const resolved = await resolver.resolve(model)
      const result = await generateText({
        model: resolved.model,
        maxOutputTokens: resolved.maxOutputTokens,
        system: buildSystemPrompt(),
        prompt: input,
        abortSignal: ac.signal
      })
      if (result.text.trim().length === 0) {
        return { dsl: '', error: 'E_NO_OUTPUT', message: 'LLM returned no text' }
      }
      const dsl = sanitizeDsl(result.text)
      if (dsl.length === 0) {
        return { dsl: '', error: 'E_NO_OUTPUT', message: 'LLM produced an empty DSL' }
      }
      return { dsl }
    }
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'user-agent': CRS_USER_AGENT
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: input }]
      }),
      signal: ac.signal
    })
    if (!response.ok) {
      // 不回传 body（上游 4xx/5xx 可能回显 Authorization header，见 custom_api.ts）。
      const code = response.status === 429 ? 'E_QUOTA' : 'E_UPSTREAM'
      return { dsl: '', error: code, message: `LLM API ${response.status}` }
    }
    const payload = (await response.json()) as MessagesResponse
    const text = payload.content?.find((b) => b.type === 'text')?.text ?? payload.content?.[0]?.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { dsl: '', error: 'E_NO_OUTPUT', message: 'LLM returned no text' }
    }
    const dsl = sanitizeDsl(text)
    if (dsl.length === 0) {
      return { dsl: '', error: 'E_NO_OUTPUT', message: 'LLM produced an empty DSL' }
    }
    return { dsl }
  } catch (err) {
    if (isProviderCredentialsError(err)) {
      return { dsl: '', error: 'E_NO_LLM_KEY', message: err.message }
    }
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      return { dsl: '', error: 'E_TIMEOUT', message: 'LLM request timed out' }
    }
    if (providerRegistryEnabled) {
      // AI SDK 路径：APICallError.message 可能含上游回显的凭证 → 固定形状脱敏
      // （批 2 review MEDIUM-4）。flag off 裸 fetch 路径的既有 message 形状不动。
      return { dsl: '', error: 'E_UPSTREAM', message: sanitizedUpstreamErrorMessage(err) }
    }
    return {
      dsl: '',
      error: 'E_UPSTREAM',
      message: `LLM fetch failed: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    clearTimeout(timer)
  }
}

export function registerNlSearchHandlers(): void {
  ipcMain.handle('email:nlToDsl', async (_evt, nl: unknown): Promise<NlToDslResult> => {
    return nlToDsl(typeof nl === 'string' ? nl : '')
  })
}
