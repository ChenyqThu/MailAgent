// Phase 4 WP-4A — 流式/非流式 <tool_call> 脏文本修复中间件 + finishReason 纠正。
//
// 部分 OpenAI-compatible 中转 / 开源模型会把本应走原生 tool_calls 的调用以文本形式吐出：
//   <tool_call>{"name":"email_search_fulltext","arguments":{"query":"..."}}</tool_call>
// 且上游 finishReason 常标为 'stop'。若不拦截：
//   1. 用户界面直接看到裸露 XML；
//   2. streamText / generateText 不会触发工具执行闭环。
//
// 设计纪律：
//   - **SDK-free**：只 type-import '@ai-sdk/provider' / 'ai'（不破坏 provider_lazy_import 门禁）。
//   - **零副作用激活门禁**：未声明任何工具（params.tools 为空）→ 纯透传，不缓冲一字节文本。
//   - **Fail-safe 原样透传**：<tool_call> 内非合法 JSON、toolName 不在声明表、或至流结束未闭合 →
//     按原文当 text-delta 吐出，绝不吞字，finishReason 保持原样。

import { randomUUID } from 'node:crypto'

import type { LanguageModelMiddleware } from 'ai'

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'
const MAX_UNCLOSED_TAG_CHARS = 32_768

interface SynthesizedToolCall {
  toolName: string
  inputJson: string
}

function makeToolCallId(): string {
  return `tc_fix_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function extractDeclaredToolNames(tools: unknown): Set<string> {
  const names = new Set<string>()
  if (!Array.isArray(tools)) return names
  for (const item of tools) {
    if (item == null || typeof item !== 'object') continue
    const name = (item as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) names.add(name)
  }
  return names
}

function stripOptionalCodeFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

export function parseToolCallXmlPayload(
  inner: string,
  declaredTools: ReadonlySet<string>
): SynthesizedToolCall | null {
  const cleaned = stripOptionalCodeFence(inner)
  if (!cleaned.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || !declaredTools.has(name)) return null

  const rawArgs =
    record.arguments !== undefined
      ? record.arguments
      : record.input !== undefined
        ? record.input
        : record.parameters !== undefined
          ? record.parameters
          : {}

  if (typeof rawArgs === 'string') {
    const trimmedArgs = rawArgs.trim()
    if (trimmedArgs.length === 0) return { toolName: name, inputJson: '{}' }
    try {
      const argsObj = JSON.parse(trimmedArgs)
      if (argsObj == null || typeof argsObj !== 'object' || Array.isArray(argsObj)) return null
      return { toolName: name, inputJson: JSON.stringify(argsObj) }
    } catch {
      return null
    }
  }
  if (rawArgs != null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return { toolName: name, inputJson: JSON.stringify(rawArgs) }
  }
  return null
}

function upgradeStopFinishReason<T>(finishReason: T): T {
  if ((finishReason as unknown) === 'stop') {
    return 'tool-calls' as unknown as T
  }
  if (
    finishReason != null &&
    typeof finishReason === 'object' &&
    (finishReason as { unified?: unknown }).unified === 'stop'
  ) {
    return {
      ...(finishReason as Record<string, unknown>),
      unified: 'tool-calls'
    } as T
  }
  return finishReason
}

function trailingOpenTagPrefixLength(buf: string): number {
  const maxCheck = Math.min(buf.length, OPEN_TAG.length - 1)
  for (let len = maxCheck; len >= 1; len -= 1) {
    if (buf.endsWith(OPEN_TAG.slice(0, len))) return len
  }
  return 0
}

export function createToolCallFixMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate()
      const declaredTools = extractDeclaredToolNames(params.tools)
      if (declaredTools.size === 0 || !Array.isArray(result.content)) return result

      let synthesizedAny = false
      const nextContent: typeof result.content = []

      for (const part of result.content) {
        if (part.type !== 'text' || !part.text.includes(OPEN_TAG)) {
          nextContent.push(part)
          continue
        }
        const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
        let lastIndex = 0
        let textBuf = ''
        const addedCalls: Array<{ toolName: string; inputJson: string }> = []
        let match: RegExpExecArray | null
        while ((match = tagRe.exec(part.text)) !== null) {
          const parsed = parseToolCallXmlPayload(match[1], declaredTools)
          if (parsed) {
            textBuf += part.text.slice(lastIndex, match.index)
            addedCalls.push(parsed)
            lastIndex = match.index + match[0].length
          }
        }
        if (addedCalls.length === 0) {
          nextContent.push(part)
          continue
        }
        synthesizedAny = true
        textBuf += part.text.slice(lastIndex)
        if (textBuf.trim().length > 0) {
          nextContent.push({ ...part, text: textBuf })
        }
        for (const call of addedCalls) {
          nextContent.push({
            type: 'tool-call',
            toolCallId: makeToolCallId(),
            toolName: call.toolName,
            input: call.inputJson
          })
        }
      }

      if (!synthesizedAny) return result
      return {
        ...result,
        content: nextContent,
        finishReason: upgradeStopFinishReason(result.finishReason)
      }
    },

    wrapStream: async ({ doStream, params }) => {
      const streamResult = await doStream()
      const declaredTools = extractDeclaredToolNames(params.tools)
      if (declaredTools.size === 0) return streamResult

      type StreamChunk =
        typeof streamResult extends { stream: ReadableStream<infer C> } ? C : never
      type StartChunk = Extract<StreamChunk, { type: 'text-start' }>

      interface TextBufferState {
        id: string
        buffer: string
        delayedStart: StartChunk | null
        startEmitted: boolean
        emittedText: boolean
      }

      const textStates = new Map<string, TextBufferState>()
      let synthesizedAny = false

      const getState = (id: string): TextBufferState => {
        let state = textStates.get(id)
        if (!state) {
          state = {
            id,
            buffer: '',
            delayedStart: null,
            startEmitted: false,
            emittedText: false
          }
          textStates.set(id, state)
        }
        return state
      }

      const emitText = (
        controller: TransformStreamDefaultController<StreamChunk>,
        state: TextBufferState,
        delta: string
      ): void => {
        if (delta.length === 0) return
        if (!state.startEmitted && state.delayedStart != null) {
          controller.enqueue(state.delayedStart as StreamChunk)
          state.delayedStart = null
          state.startEmitted = true
        }
        state.emittedText = true
        controller.enqueue({
          type: 'text-delta',
          id: state.id,
          delta
        } as StreamChunk)
      }

      const drainBuffer = (
        controller: TransformStreamDefaultController<StreamChunk>,
        state: TextBufferState,
        flushAll: boolean
      ): void => {
        while (state.buffer.length > 0) {
          const openIdx = state.buffer.indexOf(OPEN_TAG)
          if (openIdx === -1) {
            const holdLen = flushAll ? 0 : trailingOpenTagPrefixLength(state.buffer)
            const emitLen = state.buffer.length - holdLen
            if (emitLen > 0) {
              emitText(controller, state, state.buffer.slice(0, emitLen))
              state.buffer = state.buffer.slice(emitLen)
            }
            break
          }
          if (openIdx > 0) {
            emitText(controller, state, state.buffer.slice(0, openIdx))
            state.buffer = state.buffer.slice(openIdx)
          }
          const closeIdx = state.buffer.indexOf(CLOSE_TAG, OPEN_TAG.length)
          if (closeIdx === -1) {
            if (flushAll || state.buffer.length > MAX_UNCLOSED_TAG_CHARS) {
              emitText(controller, state, state.buffer)
              state.buffer = ''
            }
            break
          }
          const fullEnd = closeIdx + CLOSE_TAG.length
          const inner = state.buffer.slice(OPEN_TAG.length, closeIdx)
          const parsed = parseToolCallXmlPayload(inner, declaredTools)
          if (parsed) {
            synthesizedAny = true
            controller.enqueue({
              type: 'tool-call',
              toolCallId: makeToolCallId(),
              toolName: parsed.toolName,
              input: parsed.inputJson
            } as StreamChunk)
            let rest = state.buffer.slice(fullEnd)
            if (!state.emittedText && rest.startsWith('\n')) {
              rest = rest.slice(1)
            }
            state.buffer = rest
          } else {
            emitText(controller, state, state.buffer.slice(0, fullEnd))
            state.buffer = state.buffer.slice(fullEnd)
          }
        }
      }

      const transform = new TransformStream<StreamChunk, StreamChunk>({
        transform: (chunk, controller): void => {
          if (chunk.type === 'text-start') {
            const state = getState(chunk.id)
            state.delayedStart = chunk as StartChunk
            return
          }
          if (chunk.type === 'text-delta') {
            const state = getState(chunk.id)
            state.buffer += chunk.delta
            drainBuffer(controller, state, false)
            return
          }
          if (chunk.type === 'text-end') {
            const state = textStates.get(chunk.id)
            if (state) {
              drainBuffer(controller, state, true)
              if (state.startEmitted) {
                controller.enqueue(chunk)
              } else if (state.delayedStart == null && state.emittedText) {
                controller.enqueue(chunk)
              }
              textStates.delete(chunk.id)
              return
            }
            controller.enqueue(chunk)
            return
          }
          if (chunk.type === 'finish') {
            for (const state of textStates.values()) {
              drainBuffer(controller, state, true)
              if (state.startEmitted) {
                controller.enqueue({ type: 'text-end', id: state.id } as StreamChunk)
              }
            }
            textStates.clear()
            if (synthesizedAny) {
              controller.enqueue({
                ...chunk,
                finishReason: upgradeStopFinishReason(chunk.finishReason)
              } as StreamChunk)
              return
            }
          }
          controller.enqueue(chunk)
        }
      })

      return {
        ...streamResult,
        stream: streamResult.stream.pipeThrough(transform)
      }
    }
  }
}
