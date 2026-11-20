// Phase 5 WP-5A — 出站双向隐私占位符脱敏中间件（SDK-free）。
//
// 设计纪律：
//   - **SDK-free**：仅 type-import 'ai' / './providerRef' 中的类型（不破坏 provider_lazy_import 门禁）。
//   - **Fail-Closed**：任一正则编译失败、零宽死循环或脱敏期抛错 → 抛 PrivacyMaskError，绝不向
//     上游发出未脱敏请求；入口映射为 HTTP 503 E_PRIVACY_MASK_FAILED。
//   - **零明文落盘**：审计回调仅传类别命中计数（category -> count），绝不传命中明文或占位符映射。

import type { LanguageModelMiddleware } from 'ai'

import { PrivacyMaskError, type PrivacyMaskConfig } from './providerRef'

export interface CompiledPrivacyRule {
  category: string
  tag: string
  regex: RegExp
  validate?: (match: string) => boolean
}

interface PendingMatch {
  start: number
  end: number
  category: string
  tag: string
  value: string
}

const EXISTING_TOKEN_RE = /\[\[PII_[A-Z][A-Z0-9_]{0,23}_\d+\]\]/g
const MAX_CUSTOM_RULES = 32
const MAX_PATTERN_LEN = 256
const TAG_RE = /^[A-Z][A-Z0-9_]{0,23}$/
const REDOS_NESTED_RE = /\([^)]*[+*][^)]*\)[+*?{]/
const PARTIAL_TOKEN_SUFFIX_RE = /^\[(?:\[(?:P(?:I(?:I(?:_[A-Z0-9_]{0,32}(?:\])?)?)?)?)?)?$/
const MAX_PARTIAL_SUFFIX_LEN = 44

function isValidChinaId18(id: string): boolean {
  if (!/^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(id)) {
    return false
  }
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const codes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let i = 0; i < 17; i += 1) {
    sum += Number(id[i]) * weights[i]
  }
  const expected = codes[sum % 11]
  return id[17].toUpperCase() === expected
}

function isValidLuhnBankCard(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, '')
  if (digits.length < 16 || digits.length > 19 || !/^\d+$/.test(digits)) return false
  let sum = 0
  let doubleDigit = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i])
    if (doubleDigit) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    doubleDigit = !doubleDigit
  }
  return sum % 10 === 0
}

function cloneGlobalRegex(re: RegExp): RegExp {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  return new RegExp(re.source, flags)
}

export function compilePrivacyRules(config?: PrivacyMaskConfig): CompiledPrivacyRule[] {
  const builtIn = {
    secret: true,
    id_card: true,
    phone: true,
    email: true,
    bank_card: true,
    ...(config?.builtIn ?? {})
  }
  const rules: CompiledPrivacyRule[] = []

  if (builtIn.secret) {
    rules.push({
      category: 'secret',
      tag: 'SECRET',
      regex:
        /\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|mak_[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g
    })
  }
  if (builtIn.id_card) {
    rules.push({
      category: 'id_card',
      tag: 'ID_CARD',
      regex: /(?<!\d)[1-9]\d{16}[\dXx](?!\d)/g,
      validate: isValidChinaId18
    })
  }
  if (builtIn.bank_card) {
    rules.push({
      category: 'bank_card',
      tag: 'BANK_CARD',
      regex: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g,
      validate: isValidLuhnBankCard
    })
  }
  if (builtIn.phone) {
    rules.push({
      category: 'phone',
      tag: 'PHONE',
      regex: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g
    })
  }
  if (builtIn.email) {
    rules.push({
      category: 'email',
      tag: 'EMAIL',
      regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    })
  }

  const customRules = config?.customRules ?? []
  if (!Array.isArray(customRules) || customRules.length > MAX_CUSTOM_RULES) {
    throw new PrivacyMaskError('privacy customRules exceeds limit or is invalid')
  }
  for (const r of customRules) {
    if (!r || !r.enabled) continue
    if (typeof r.pattern !== 'string' || r.pattern.length === 0 || r.pattern.length > MAX_PATTERN_LEN) {
      throw new PrivacyMaskError(`invalid custom privacy rule pattern: ${String(r.id ?? '')}`)
    }
    if (REDOS_NESTED_RE.test(r.pattern)) {
      throw new PrivacyMaskError(`unsafe nested quantifier in privacy rule: ${r.id}`)
    }
    const tag = typeof r.tag === 'string' ? r.tag.trim().toUpperCase() : ''
    if (!TAG_RE.test(tag)) {
      throw new PrivacyMaskError(`invalid custom privacy rule tag: ${String(r.tag ?? '')}`)
    }
    let regex: RegExp
    try {
      regex = new RegExp(r.pattern, 'g')
    } catch (err) {
      throw new PrivacyMaskError(
        `failed to compile privacy rule '${r.id}': ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (regex.test('')) {
      throw new PrivacyMaskError(`privacy rule '${r.id}' matches empty string`)
    }
    rules.push({
      category: `custom:${r.id}`,
      tag,
      regex
    })
  }
  return rules
}

class MaskVault {
  private readonly valueToToken = new Map<string, string>()
  private readonly tokenToValue = new Map<string, string>()
  private readonly tagCounters = new Map<string, number>()
  private readonly categoryHits = new Map<string, number>()

  constructor(private readonly rules: readonly CompiledPrivacyRule[]) {}

  private intern(value: string, category: string, tag: string): string {
    const existing = this.valueToToken.get(value)
    if (existing !== undefined) {
      this.categoryHits.set(category, (this.categoryHits.get(category) ?? 0) + 1)
      return existing
    }
    const nextNum = (this.tagCounters.get(tag) ?? 0) + 1
    this.tagCounters.set(tag, nextNum)
    const token = `[[PII_${tag}_${nextNum}]]`
    this.valueToToken.set(value, token)
    this.tokenToValue.set(token, value)
    this.categoryHits.set(category, (this.categoryHits.get(category) ?? 0) + 1)
    return token
  }

  maskString(text: string): string {
    if (!text || this.rules.length === 0) return text
    const protectedRanges: Array<{ start: number; end: number }> = []
    const tokenScan = cloneGlobalRegex(EXISTING_TOKEN_RE)
    let tokMatch: RegExpExecArray | null
    while ((tokMatch = tokenScan.exec(text)) !== null) {
      protectedRanges.push({
        start: tokMatch.index,
        end: tokMatch.index + tokMatch[0].length
      })
    }

    const candidates: PendingMatch[] = []
    for (const rule of this.rules) {
      const re = cloneGlobalRegex(rule.regex)
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const value = m[0]
        if (value.length === 0) {
          throw new PrivacyMaskError(`privacy rule '${rule.category}' matched empty text`)
        }
        const start = m.index
        const end = start + value.length
        const overlapsExisting = protectedRanges.some((r) => start < r.end && end > r.start)
        if (overlapsExisting) continue
        if (rule.validate && !rule.validate(value)) continue
        candidates.push({ start, end, category: rule.category, tag: rule.tag, value })
      }
    }
    if (candidates.length === 0) return text

    candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
    let out = ''
    let cursor = 0
    for (const item of candidates) {
      if (item.start < cursor) continue
      if (item.start > cursor) out += text.slice(cursor, item.start)
      out += this.intern(item.value, item.category, item.tag)
      cursor = item.end
    }
    if (cursor < text.length) out += text.slice(cursor)
    return out
  }

  maskJsonValue(value: unknown): unknown {
    if (typeof value === 'string') return this.maskString(value)
    if (Array.isArray(value)) return value.map((item) => this.maskJsonValue(item))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.maskJsonValue(v)
      }
      return out
    }
    return value
  }

  unmaskString(text: string, jsonEscape = false): string {
    if (!text || this.tokenToValue.size === 0) return text
    return text.replace(EXISTING_TOKEN_RE, (tok) => {
      const raw = this.tokenToValue.get(tok)
      if (raw === undefined) return tok
      if (!jsonEscape) return raw
      const encoded = JSON.stringify(raw)
      return encoded.slice(1, -1)
    })
  }

  unmaskJsonValue(value: unknown): unknown {
    if (typeof value === 'string') return this.unmaskString(value, false)
    if (Array.isArray(value)) return value.map((item) => this.unmaskJsonValue(item))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.unmaskJsonValue(v)
      }
      return out
    }
    return value
  }

  hitsObject(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of this.categoryHits.entries()) {
      if (v > 0) out[k] = v
    }
    return out
  }
}

export function trailingPlaceholderPrefixLength(buf: string): number {
  const searchFrom = Math.max(0, buf.length - MAX_PARTIAL_SUFFIX_LEN)
  for (let idx = buf.length - 1; idx >= searchFrom; idx -= 1) {
    if (buf[idx] === '[' && PARTIAL_TOKEN_SUFFIX_RE.test(buf.slice(idx))) {
      return buf.length - idx
    }
  }
  return 0
}

function maskPromptMessages(
  prompt: unknown,
  vault: MaskVault
): unknown {
  if (!Array.isArray(prompt)) return prompt
  return prompt.map((msg) => {
    if (msg == null || typeof msg !== 'object') return msg
    const m = msg as Record<string, unknown>
    if (m.role === 'system' && typeof m.content === 'string') {
      return { ...m, content: vault.maskString(m.content) }
    }
    if (!Array.isArray(m.content)) return m
    const nextParts = m.content.map((part) => {
      if (part == null || typeof part !== 'object') return part
      const p = part as Record<string, unknown>
      if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string') {
        return { ...p, text: vault.maskString(p.text) }
      }
      if (p.type === 'tool-call') {
        return {
          ...p,
          input:
            typeof p.input === 'string'
              ? vault.maskJsonValue(p.input)
              : vault.maskJsonValue(p.input)
        }
      }
      if (p.type === 'tool-result' && p.output != null && typeof p.output === 'object') {
        const out = p.output as Record<string, unknown>
        if ((out.type === 'text' || out.type === 'error-text') && typeof out.value === 'string') {
          return { ...p, output: { ...out, value: vault.maskString(out.value) } }
        }
        if (out.type === 'json' || out.type === 'error-json') {
          return { ...p, output: { ...out, value: vault.maskJsonValue(out.value) } }
        }
        if (out.type === 'content' && Array.isArray(out.value)) {
          const maskedContent = out.value.map((sub) => {
            if (sub != null && typeof sub === 'object') {
              const s = sub as Record<string, unknown>
              if (s.type === 'text' && typeof s.text === 'string') {
                return { ...s, text: vault.maskString(s.text) }
              }
            }
            return sub
          })
          return { ...p, output: { ...out, value: maskedContent } }
        }
      }
      return p
    })
    return { ...m, content: nextParts }
  })
}

export function createPrivacyMaskMiddleware(
  config?: PrivacyMaskConfig,
  opts?: { onHits?: (counts: Record<string, number>) => void }
): LanguageModelMiddleware {
  // Eagerly compile rules at resolve time so invalid custom regex fails closed immediately (HTTP 503).
  const compiledRules = compilePrivacyRules(config)
  const vaultByPrompt = new WeakMap<object, MaskVault>()

  const prepareVault = (prompt: unknown): { maskedPrompt: unknown; vault: MaskVault } => {
    try {
      const vault = new MaskVault(compiledRules)
      const maskedPrompt = maskPromptMessages(prompt, vault)
      if (maskedPrompt != null && typeof maskedPrompt === 'object') {
        vaultByPrompt.set(maskedPrompt, vault)
      }
      const hits = vault.hitsObject()
      if (Object.keys(hits).length > 0) {
        try {
          opts?.onHits?.(hits)
        } catch {
          /* hit counters are strictly best-effort */
        }
      }
      return { maskedPrompt, vault }
    } catch (err) {
      if (err instanceof PrivacyMaskError) throw err
      throw new PrivacyMaskError(
        `outbound privacy masking failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return {
    specificationVersion: 'v4',

    transformParams: async ({ params }) => {
      const { maskedPrompt } = prepareVault(params.prompt)
      return {
        ...params,
        prompt: maskedPrompt as typeof params.prompt
      }
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate()
      const vault =
        params.prompt != null && typeof params.prompt === 'object'
          ? vaultByPrompt.get(params.prompt)
          : undefined
      if (!vault || !Array.isArray(result.content)) return result

      const nextContent = result.content.map((part) => {
        if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
          return { ...part, text: vault.unmaskString(part.text) }
        }
        if (part.type === 'tool-call') {
          if (typeof part.input === 'string') {
            return { ...part, input: vault.unmaskString(part.input, true) }
          }
          return { ...part, input: vault.unmaskJsonValue(part.input) as typeof part.input }
        }
        return part
      })
      return {
        ...result,
        content: nextContent as typeof result.content
      }
    },

    wrapStream: async ({ doStream, params }) => {
      const streamResult = await doStream()
      const vault =
        params.prompt != null && typeof params.prompt === 'object'
          ? vaultByPrompt.get(params.prompt)
          : undefined
      if (!vault) return streamResult

      type StreamChunk =
        typeof streamResult extends { stream: ReadableStream<infer C> } ? C : never

      type DeltaChannelType = 'text-delta' | 'reasoning-delta' | 'tool-input-delta'
      interface ChannelBuffer {
        type: DeltaChannelType
        buffer: string
        jsonEscape: boolean
      }
      const buffers = new Map<string, ChannelBuffer>()

      const channelKey = (type: DeltaChannelType, id: string): string => `${type}:${id}`

      const flushBuffer = (
        controller: TransformStreamDefaultController<StreamChunk>,
        id: string,
        type: DeltaChannelType,
        forceAll: boolean
      ): void => {
        const key = channelKey(type, id)
        const state = buffers.get(key)
        if (!state || state.buffer.length === 0) {
          if (forceAll) buffers.delete(key)
          return
        }
        const holdLen = forceAll ? 0 : trailingPlaceholderPrefixLength(state.buffer)
        const emitLen = state.buffer.length - holdLen
        if (emitLen > 0) {
          const slice = state.buffer.slice(0, emitLen)
          state.buffer = state.buffer.slice(emitLen)
          const restored = vault.unmaskString(slice, state.jsonEscape)
          if (restored.length > 0) {
            controller.enqueue({ type, id, delta: restored } as StreamChunk)
          }
        }
        if (forceAll && state.buffer.length === 0) {
          buffers.delete(key)
        }
      }

      const flushAllChannels = (controller: TransformStreamDefaultController<StreamChunk>): void => {
        for (const [key, state] of [...buffers.entries()]) {
          const id = key.slice(state.type.length + 1)
          flushBuffer(controller, id, state.type, true)
        }
      }

      const transform = new TransformStream<StreamChunk, StreamChunk>({
        transform: (chunk, controller): void => {
          if (
            chunk.type === 'text-delta' ||
            chunk.type === 'reasoning-delta' ||
            chunk.type === 'tool-input-delta'
          ) {
            const key = channelKey(chunk.type, chunk.id)
            let state = buffers.get(key)
            if (!state) {
              state = {
                type: chunk.type,
                buffer: '',
                jsonEscape: chunk.type === 'tool-input-delta'
              }
              buffers.set(key, state)
            }
            state.buffer += chunk.delta
            flushBuffer(controller, chunk.id, chunk.type, false)
            return
          }
          if (chunk.type === 'text-end') {
            flushBuffer(controller, chunk.id, 'text-delta', true)
            controller.enqueue(chunk)
            return
          }
          if (chunk.type === 'reasoning-end') {
            flushBuffer(controller, chunk.id, 'reasoning-delta', true)
            controller.enqueue(chunk)
            return
          }
          if (chunk.type === 'tool-input-end') {
            flushBuffer(controller, chunk.id, 'tool-input-delta', true)
            controller.enqueue(chunk)
            return
          }
          if (chunk.type === 'tool-call') {
            const c = chunk as { type: 'tool-call'; input: unknown }
            const restoredInput =
              typeof c.input === 'string'
                ? vault.unmaskString(c.input, true)
                : vault.unmaskJsonValue(c.input)
            controller.enqueue({
              ...chunk,
              input: restoredInput
            } as StreamChunk)
            return
          }
          if (chunk.type === 'finish') {
            flushAllChannels(controller)
            controller.enqueue(chunk)
            return
          }
          controller.enqueue(chunk)
        },
        flush: (controller): void => {
          flushAllChannels(controller)
        }
      })

      return {
        ...streamResult,
        stream: streamResult.stream.pipeThrough(transform)
      }
    }
  }
}
