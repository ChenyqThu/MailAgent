// P2-L5 前提闸 —— **`data-*` part 不进模型消息**。
//
// design §1.4 的「模型看到的内容不变」整条都挂在这一条上：对话附件入库后，用户消息上会多出
// 一个 `data-library` part（`{fileId, path, name}`）。如果 AI SDK 的 `convertToModelMessages`
// 把它带进 ModelMessage，那模型每一轮都会白读一段库路径 JSON，而且 `prependInjectedContext`
// 之后的 user content 形状也会变。
//
// 🔴 这条是**实测**出来的，不是照文档写的：ai@7 的 `convertToModelMessages` 对 user part 只认
// text / file / (reasoning|tool)，其余一律不落 content —— 一个只有 data part 的用户消息转出来
// 是 `content: []`。断言写成「转换结果里一个 data 都没有」而不是「等于某个快照」，这样上游哪天
// 改成保留 data part，红的是这条，而不是某处莫名其妙的 token 账。
//
// 若这条闸变红（上游开始保留 data part）：在 `chatRun.ts` 的 `prependInjectedContext` **之前**
// 把 `data-*` 从 modelMessages 里 strip 掉，别去改 part 的形状。

import { describe, expect, test } from 'vitest'
import { convertToModelMessages, type UIMessage } from 'ai'

const LIBRARY_DATA = {
  fileId: 42,
  path: 'chat-attachments/2026-09/report.docx',
  name: 'report.docx'
}

function userMessage(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'user', parts } as unknown as UIMessage
}

describe('convertToModelMessages 与 data-library part', () => {
  test('text + data-library → 模型只看到 text，data part 整条被丢弃', async () => {
    const model = await convertToModelMessages([
      userMessage([
        { type: 'text', text: '看看这个' },
        { type: 'data-library', data: LIBRARY_DATA }
      ])
    ])
    expect(model).toHaveLength(1)
    expect(model[0].content).toEqual([{ type: 'text', text: '看看这个' }])
  })

  test('只有 data-library 的消息 → content 为空数组（没有任何残留）', async () => {
    const model = await convertToModelMessages([
      userMessage([{ type: 'data-library', data: LIBRARY_DATA }])
    ])
    expect(model[0].content).toEqual([])
  })

  test('data part 的字段一个都没漏进序列化后的模型消息', async () => {
    const model = await convertToModelMessages([
      userMessage([
        { type: 'text', text: 'hi' },
        { type: 'data-library', data: LIBRARY_DATA }
      ])
    ])
    const wire = JSON.stringify(model)
    expect(wire).not.toContain('data-library')
    expect(wire).not.toContain('chat-attachments')
    expect(wire).not.toContain('report.docx')
  })

  test('assistant 侧同样不带 data part（compact 卡片走的是同一条规则）', async () => {
    const model = await convertToModelMessages([
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'text', text: '好' },
          { type: 'data-library', data: LIBRARY_DATA }
        ]
      } as unknown as UIMessage
    ])
    expect(model[0].content).toEqual([{ type: 'text', text: '好' }])
  })
})
