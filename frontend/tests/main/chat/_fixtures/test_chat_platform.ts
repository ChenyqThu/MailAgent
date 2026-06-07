// V2.1 阶段 3 — 3c-4 cutover 测试替身（test fixture platform）。
//
// cutover 删了生产 ElectronChatPlatform（renderer 改走 HttpChatPlatform → serve-api），
// 但 shared 引擎的两份深度回归测试（chat_dispatcher.test / harness.test）需要一个 platform
// 实现来跑：它们借真实临时 ai_chat.db 验证 dispatcher 编排 / harness 多轮的逐项语义
// （rapid-click guard、abort 时机、partial writes、priorTurns 构建、终态翻转 …）。
//
// 这个替身把那两份测试实际用到的能力收口在 tests/ 下，**解耦 shared 回归与任何端的生产
// platform 实现**——这本就是 shared 测试该有的样子（不耦合 electron / http）。它只实现：
//   - Infra 板：persist 转发真实 chat_db（写临时库）+ resolveConfig 读 env（测试设的
//     AGENT_MAX_ITER / AGENT_MAX_COST_USD / MAILAGENT_AGENT_HARNESS）+ loadEmailContext 返
//     null（测试不建 sync_store.db，生产实现对 mock emailId 也返 null，等价）+ prefetch no-op。
//   - 工具板：仅供 chat_dispatcher.test 的 createBuiltinTools(platform) 能构造（其 fakeBackend
//     不 emit tool_use → handler 永不触发）。kosConfig 返回 configured:false（不注册 9 KOS 工具，
//     测试不断言工具数）；读/写原语 throw（永不被调，触发即测试 bug）。
//   - Model 板（llmFetch / modelConfig / getCachedSenderDigest）：两份测试都用脚本化 backend
//     不打 LLM → 不实现（替身类型 = ChatInfraPlatform & ChatToolPlatform）。

import * as chatDb from '../../../../src/electron/main/chat_db'
import type {
  ChatInfraPlatform,
  ChatPersistPort,
  ChatRuntimeConfig,
  ChatToolKosConfig,
  ChatToolPlatform
} from '../../../../src/shared/chat/platform'

// ── env 读 helper：原 chat/main/config.ts 在 V2.1 3c-5 cutover 收尾删除（整文件仅本
//    替身引用——生产 resolveConfig 已下沉 serve-api/HttpChatPlatform GET /chat/config）。
//    这里内联复刻它的 readEnvBool/readEnvNumber，逐项对齐 resolveConfig 用到的 4 个 flag
//    默认值与边界：maxIter 默认 8 下限 1 / maxCostUsd 默认 0.5 取正 / harness 默认 ON / kosL1 默认 OFF。
function readEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  return raw === '1' || raw.toLowerCase() === 'true'
}

function readEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const n = Number(raw)
  return Number.isFinite(n) ? n : defaultValue
}

// ── 持久化端口：转发既有 chat_db（同步），包成 Promise 满足跨端异步接口（复刻
//    生产 ElectronChatPlatform.persist 逐法语义；零 this 依赖，解构调用安全）──────
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
  // 流式增量 = 同步直写（fire-and-forget void，与生产 electron 同步直写一致）。
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

function toolNotExercised(): never {
  throw new Error(
    'test fixture: ChatToolPlatform primitive invoked — these tests use scripted backends ' +
      'that never emit tool_use, so a real tool call means a test wiring bug.'
  )
}

/** chat_dispatcher.test / harness.test 注入的替身 platform。类型 =
 *  ChatInfraPlatform & ChatToolPlatform（dispatcher 取 Infra 子集，createBuiltinTools 取
 *  Tool 子集）。Model 板不实现（脚本化 backend 不打 LLM）。 */
export const testChatPlatform: ChatInfraPlatform & ChatToolPlatform = {
  persist,
  async loadEmailContext() {
    // 测试不建 sync_store.db；生产 ElectronChatPlatform 对 mock emailId 也走 catch 返 null。
    return null
  },
  async resolveConfig(): Promise<ChatRuntimeConfig> {
    const maxCostUsd = readEnvNumber('AGENT_MAX_COST_USD', 0.5)
    return {
      maxIter: Math.max(1, Math.floor(readEnvNumber('AGENT_MAX_ITER', 8))),
      maxCostUsd: maxCostUsd > 0 ? maxCostUsd : 0.5,
      kosL1HotBlockEnabled: readEnvBool('MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED', false),
      harnessEnabled: readEnvBool('MAILAGENT_AGENT_HARNESS', true)
    }
  },
  prefetchSenderDigest() {
    // no-op（kosL1 默认 OFF → harness 不调；接口要求实现）。
  },

  // ── 工具板 stub：仅供 createBuiltinTools(platform) 能构造；handler 永不触发 ──
  kosConfig(): ChatToolKosConfig {
    return { configured: false, timeDecayEnabled: false }
  },
  async listEmails() {
    return toolNotExercised()
  },
  async getEmail() {
    return toolNotExercised()
  },
  async getEmailBody() {
    return toolNotExercised()
  },
  async getAiFields() {
    return toolNotExercised()
  },
  async listEmailsByThread() {
    return toolNotExercised()
  },
  async searchEmailsFulltext() {
    return toolNotExercised()
  },
  async listAttachments() {
    return toolNotExercised()
  },
  async searchAttachments() {
    return toolNotExercised()
  },
  async flagEmail() {
    return toolNotExercised()
  },
  async draftReply() {
    return toolNotExercised()
  },
  async kosCallTool() {
    return toolNotExercised()
  },
  async saveToKos() {
    return toolNotExercised()
  }
}
