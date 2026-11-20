// Phase 4 WP-4A — createToolCallFixMiddleware unit & end-to-end AI SDK streamText/generateText tests.

import { describe, expect, test } from 'vitest'
import { generateText, simulateReadableStream, stepCountIs, streamText, tool, wrapLanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { createToolCallFixMiddleware } from '../../src/ai-gateway/toolCallFixMiddleware'

function fakeUsage(): {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
  outputTokens: { total: number; text: number; reasoning: number }
} {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
  }
}

describe('createToolCallFixMiddleware', () => {
  const emailReadTool = tool({
    description: 'Read email by id',
    inputSchema: z.object({ id: z.number() }),
    execute: async ({ id }): Promise<{ id: number; subject: string }> => ({
      id,
      subject: `Email #${id}`
    })
  })

  test('wrapStream: intercepts chunked <tool_call> XML, executes tool, strips XML, and upgrades stop -> tool-calls', async () => {
    let callIdx = 0
    const baseModel = new MockLanguageModelV3({
      doStream: async () => {
        callIdx += 1
        if (callIdx === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Checking <to' },
                { type: 'text-delta', id: 't1', delta: 'ol_call>{"name":"email_' },
                { type: 'text-delta', id: 't1', delta: 'read","arguments":{"id":42}}</tool_call>' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: fakeUsage()
                }
              ]
            })
          }
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't2' },
              { type: 'text-delta', id: 't2', delta: 'Done reading Email #42.' },
              { type: 'text-end', id: 't2' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: fakeUsage()
              }
            ]
          })
        }
      }
    })

    const wrapped = wrapLanguageModel({
      model: baseModel,
      middleware: createToolCallFixMiddleware()
    })

    const res = streamText({
      model: wrapped,
      prompt: 'Read email 42',
      tools: { email_read: emailReadTool },
      stopWhen: stepCountIs(3)
    })

    const text = await res.text
    const steps = await res.steps
    expect(callIdx).toBe(2)
    expect(steps[0]?.toolCalls.map((tc) => ({ name: tc.toolName, input: tc.input }))).toEqual([
      { name: 'email_read', input: { id: 42 } }
    ])
    expect(steps[0]?.text).toBe('Checking ')
    expect(steps[0]?.finishReason).toBe('tool-calls')
    expect(text).toBe('Done reading Email #42.')
    expect(text).not.toContain('<tool_call>')
  })

  test('wrapStream: suppresses empty text-start/text-end when entire text block is <tool_call>', async () => {
    const baseModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            {
              type: 'text-delta',
              id: 't1',
              delta: '<tool_call>\n```json\n{"name":"email_read","arguments":{"id":7}}\n```\n</tool_call>'
            },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: fakeUsage()
            }
          ]
        })
      })
    })

    const wrapped = wrapLanguageModel({
      model: baseModel,
      middleware: createToolCallFixMiddleware()
    })

    const res = streamText({
      model: wrapped,
      prompt: 'Read 7',
      tools: { email_read: emailReadTool }
    })
    const steps = await res.steps
    expect(steps[0]?.text).toBe('')
    expect(steps[0]?.toolCalls).toHaveLength(1)
    expect(steps[0]?.toolCalls[0]?.input).toEqual({ id: 7 })
  })

  test('wrapStream: undeclared tool or unclosed/invalid XML flushes verbatim without data loss', async () => {
    const baseModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            {
              type: 'text-delta',
              id: 't1',
              delta:
                '<tool_call>{"name":"evil_undeclared","arguments":{}}</tool_call> and <tool_call>{"name":"email_read"'
            },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: fakeUsage()
            }
          ]
        })
      })
    })

    const wrapped = wrapLanguageModel({
      model: baseModel,
      middleware: createToolCallFixMiddleware()
    })

    const res = streamText({
      model: wrapped,
      prompt: 'test',
      tools: { email_read: emailReadTool }
    })
    const text = await res.text
    const steps = await res.steps
    expect(steps[0]?.toolCalls).toEqual([])
    expect(steps[0]?.finishReason).toBe('stop')
    expect(text).toBe(
      '<tool_call>{"name":"evil_undeclared","arguments":{}}</tool_call> and <tool_call>{"name":"email_read"'
    )
  })

  test('no declared tools -> pure passthrough even if output contains <tool_call>', async () => {
    const baseModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            {
              type: 'text-delta',
              id: 't1',
              delta: '<tool_call>{"name":"email_read","arguments":{"id":1}}</tool_call>'
            },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: fakeUsage()
            }
          ]
        })
      })
    })

    const wrapped = wrapLanguageModel({
      model: baseModel,
      middleware: createToolCallFixMiddleware()
    })

    const res = streamText({ model: wrapped, prompt: 'test' })
    expect(await res.text).toBe(
      '<tool_call>{"name":"email_read","arguments":{"id":1}}</tool_call>'
    )
  })

  test('wrapGenerate: repairs <tool_call> text in generateText too', async () => {
    const baseModel = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: 'text',
            text: '<tool_call>{"name":"email_read","input":{"id":99}}</tool_call>'
          }
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: fakeUsage(),
        warnings: []
      })
    })

    const wrapped = wrapLanguageModel({
      model: baseModel,
      middleware: createToolCallFixMiddleware()
    })

    const res = await generateText({
      model: wrapped,
      prompt: 'Read 99',
      tools: { email_read: emailReadTool }
    })
    expect(res.finishReason).toBe('tool-calls')
    expect(res.toolCalls[0]?.toolName).toBe('email_read')
    expect(res.toolCalls[0]?.input).toEqual({ id: 99 })
    expect(res.text).toBe('')
  })
})
