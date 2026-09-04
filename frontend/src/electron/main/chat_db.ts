// Compat barrel — chat_db was split into chat_db/{connection,sessions,messages,
// tool_calls}.ts (E4 §6.3, task 07-11) to unmix the 780-line migrate() ladder
// from the CRUD surfaces. This file preserves the `from '../chat_db'` import path
// for all existing consumers (ai_gateway_lifecycle.ts / index.ts) + the 4 test
// files: it re-exports the type shim (below) verbatim + forwards every runtime
// function from its new home. Behavior is unchanged — pure mechanical move.

// ── types ───────────────────────────────────────────────────────────────
// V2.1 阶段 3 / S3：数据模型类型在 shared/chat_model.ts（renderer 读面 +
// 本文件签名共用，不能引 better-sqlite3；S3 删 legacy 引擎时从 shared/chat/
// model.ts 原样迁出）。下方 import 供本文件函数签名使用；re-export 保既有
// importer 的 `from '../chat_db'` 路径不变。
import type {
  AnchorType,
  AppendMessageInput,
  AppendToolCallInput,
  BackendKind,
  ChatMessage,
  ChatSession,
  ChatSessionOriginFilter,
  ChatSessionSummary,
  ChatToolCall,
  ConfirmationTier,
  MessageRole,
  MessageStatus,
  OpenSessionInput,
  ToolCallStatus,
  UpdateMessagePatch,
  UpdateToolCallPatch
} from '@shared/chat_model'

export type {
  AnchorType,
  AppendMessageInput,
  AppendToolCallInput,
  BackendKind,
  ChatMessage,
  ChatSession,
  ChatSessionOriginFilter,
  ChatSessionSummary,
  ChatToolCall,
  ConfirmationTier,
  MessageRole,
  MessageStatus,
  OpenSessionInput,
  ToolCallStatus,
  UpdateMessagePatch,
  UpdateToolCallPatch
}

// ── runtime re-exports (values forwarded from the split modules) ─────────

export { closeChatDb, getChatDb, resolveChatDbPath } from './chat_db/connection'

export {
  createAgentSession,
  createImSession,
  findSessionByParentToolCall,
  setAgentSessionJobId,
  createNewSession,
  deleteSession,
  getFirstUserText,
  getOrCreateSession,
  getSession,
  listAllSessions,
  listGeneralSessions,
  listSessionsForEmail,
  listSessionsForItem,
  listSessionsForMatter,
  updateSessionArchived,
  updateSessionPausedMarker,
  updateSessionPinned,
  updateSessionStarred,
  updateSessionTitle
} from './chat_db/sessions'

export { markToolCallApprovalExpired } from './chat_db/tool_calls'

export type { QueuedInput, QueuedInputMode, QueuedInputStatus } from './chat_db/queuedInput'
export {
  cancelQueuedInput,
  claimQueuedInput,
  confirmQueuedInput,
  enqueueQueuedInput,
  getQueuedInput,
  listDispatchableQueuedInput,
  listQueuedInput,
  markSent,
  restoreAllStale,
  restoreClaimedForSession,
  restoreForSession,
  revertClaimed,
  updateQueuedInput
} from './chat_db/queuedInput'

export {
  abortStreamingMessages,
  appendMessage,
  deleteMessagesFromId,
  findAssistantMessageRowIdByUiId,
  findUserMessageRowIdByUiId,
  getMessage,
  listLastNMessages,
  listMessages,
  markCompactInvalid,
  updateMessage
} from './chat_db/messages'

export {
  appendToolCall,
  getToolCallByUseId,
  listToolCallsForMessage,
  updateToolCall
} from './chat_db/tool_calls'
