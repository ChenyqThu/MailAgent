// issue #61 前置判定（gateway 段）— composer 粘贴的图片以 FileUIPart 进 body.messages 之后，
// chatRun.ts:277 的 `await convertToModelMessages(rawMessages)` 会把它变成模型消息，且 streamText
// 会把它一路带到 LanguageModel 接口（= 模型真的看得见这张图）。
//
// 渲染端那一段（真实 ThreadComposer 上派发 paste → 真实 transport 组装出带 base64 data URL 的
// file part 进 POST body）在 tests/shared/assistant/composer_paste_image.test.tsx 里钉；两条合起来
// 覆盖「粘贴 → 模型」的完整链路。
//
// 用的是 chatRun.ts 同一个 `ai` 包导出的 convertToModelMessages / streamText（无 mock，只把模型
// 换成 MockLanguageModelV3 来读取它收到的 prompt），所以升 ai 版本导致转换语义变化时这里会红。

import { describe, expect, test } from 'vitest'
import { convertToModelMessages, streamText, type UIMessage } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'

import { applyApprovalResponseToMessages } from '../../src/ai-gateway/agui/interruptMapper'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

function pastedImageMessage(): UIMessage[] {
  return [
    {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: '这张图里写了什么' },
        { type: 'file', url: PNG_DATA_URL, mediaType: 'image/png', filename: 'screenshot.png' }
      ]
    }
  ]
}

describe('convertToModelMessages — 粘贴图片的 FileUIPart', () => {
  test('image/png 的 file part → 模型消息里保留 image 内容与 base64 字节', async () => {
    const modelMessages = await convertToModelMessages(pastedImageMessage())
    expect(modelMessages).toHaveLength(1)
    const content = modelMessages[0]!.content as Array<Record<string, unknown>>
    expect(Array.isArray(content)).toBe(true)

    // 文本 part 还在（图不是取代文本，是并列）
    expect(content.some((p) => p.type === 'text' && p.text === '这张图里写了什么')).toBe(true)

    // 🔴 图片 part 到了模型消息层。ai@7 保留 `type:'file'` + mediaType，data 包成 {type:'url',url}；
    // 断言按「形状可变、字节必须在」写：SDK 换归一形状不假红，图丢了一定红。
    const imagePart = content.find((p) => p.type === 'file' || p.type === 'image')
    expect(imagePart).toBeTruthy()
    expect(imagePart!.mediaType).toBe('image/png')
    expect(JSON.stringify(imagePart)).toContain(PNG_B64)
  })

  test('streamText 把它带到 LanguageModel 接口（模型端真的收到这张图）', async () => {
    let seenPrompt: unknown = null
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        seenPrompt = prompt
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'text-start', id: '0' })
              c.enqueue({ type: 'text-delta', id: '0', delta: 'ok' })
              c.enqueue({ type: 'text-end', id: '0' })
              c.enqueue({
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
              })
              c.close()
            }
          })
        }
      }
    })

    const res = streamText({ model, messages: await convertToModelMessages(pastedImageMessage()) })
    await res.consumeStream()

    // LanguageModelV3Prompt 是所有 provider 的共同入口 —— 图在这里就说明「发给模型了」，
    // 后面 anthropic/openai 各自的 wire 格式只是同一份字节的再编码。
    const serialized = JSON.stringify(seenPrompt)
    expect(serialized).toContain(PNG_B64)
    expect(serialized).toContain('image/png')
  })

  test('反向 — 纯文本消息不产生任何 image / file 内容', async () => {
    const modelMessages = await convertToModelMessages([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }
    ])
    const content = modelMessages[0]!.content
    const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
    expect(parts.every((p) => p.type !== 'image' && p.type !== 'file')).toBe(true)
  })
})

// issue #61 Lane 3 回归面 #7 — 审批 stash/resume 与图片 file part 的相互作用。
// approvalResume.ts 重建 resume body 时 strip 的是 injectedContext（文本附件的前缀块，首发时
// 已消费），messages 本身**原样保留** —— 用户消息里的图片 file part 会随 resume 自然重传，
// 这与 injectedContext 的「不重注入」语义不同，必须钉住：审批转换只动 approval part 的 state，
// 一个字节都不碰 file part。
describe('审批 resume 转换 — 图片 file part 原样保留', () => {
  test('applyApprovalResponseToMessages 只翻 approval part，file part 逐字节不动', () => {
    const history = [
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: '这张图里写了什么' },
          { type: 'file', url: PNG_DATA_URL, mediaType: 'image/png', filename: 'screenshot.png' }
        ]
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-email_flag',
            toolCallId: 'tc1',
            state: 'approval-requested',
            approval: { id: 'ap1' }
          }
        ]
      }
    ] as unknown as readonly UIMessage[]

    const { messages, applied } = applyApprovalResponseToMessages(history, {
      toolCallId: 'tc1',
      approvalId: 'ap1',
      decision: 'approved'
    })
    expect(applied).toBe(true)
    // 用户消息（含图片 file part）逐字节原样 —— resume 重放时图仍在。
    expect(messages[0]).toEqual(history[0])
    const filePart = (messages[0] as { parts: Array<Record<string, unknown>> }).parts.find(
      (p) => p.type === 'file'
    )
    expect(filePart?.url).toBe(PNG_DATA_URL)
    // approval part 翻到 approval-responded（resume 的第二次调用据此续跑）。
    const toolPart = (messages[1] as { parts: Array<Record<string, unknown>> }).parts[0]!
    expect(toolPart.state).toBe('approval-responded')
    expect((toolPart.approval as { approved?: boolean }).approved).toBe(true)
  })
})
