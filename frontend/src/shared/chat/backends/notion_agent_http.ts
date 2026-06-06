// V2.1 阶段 3 — 3b-5：notion-agent http backend factory。
//
// custom-api backend 下沉时已是注入式 factory（createCustomApiBackend(ChatModelPlatform)），
// http 端直接复用（传 HttpChatPlatform）。notion-agent 则按后端性质分（D2）：electron =
// execa 子进程留 main（NotionAgentBackend，浏览器跑不了），http = serve-api asyncio spawn
// 复刻（3b-2 src/chat/notion_agent.py）。本文件把注入的 ChatNotionAgentPlatform.notionAgentStream
// （fetch POST /api/chat/notion-agent + parseSse，见 http_platform.ts）薄包成 ChatBackend，
// 供 3c renderer 的 getBackend('notion-agent') 注入 —— 与 custom-api backend 在 UI 进程产出的
// event 同形，harness/dispatcher 无差别消费。
//
// 🔴 不变式 1：零 Electron import（pnpm build:web 验）。

import type { ChatNotionAgentPlatform } from '../platform'
import type { ChatBackend, ChatStreamEvent, ChatStreamRequest } from '../types'

/** 把注入的 ChatNotionAgentPlatform 包成 notion-agent ChatBackend。stream 直接委托
 *  platform.notionAgentStream（async generator）—— backend kind 是 dispatcher 的
 *  harness-vs-legacy gate 唯一信号（notion-agent 不支持 tool_use → 走 legacy 单遍）。 */
export function createHttpNotionAgentBackend(platform: ChatNotionAgentPlatform): ChatBackend {
  return {
    kind: 'notion-agent',
    stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      return platform.notionAgentStream(req)
    }
  }
}
