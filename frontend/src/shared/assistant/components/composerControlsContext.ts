// 从 composerControls.tsx 拆出（08-02 review F9）：react-refresh/only-export-components 要求一个
// 文件只导出组件。契约类型 + context 对象 + 读取 hook 都是纯逻辑（零 JSX），Provider 组件留在
// composerControls.tsx，并从这里再导出类型与 hook —— 既有导入点的路径因此不必改。

import { createContext, useContext } from 'react'

import type { SearchHit } from '@shared/api/types'
import type { ChatAttachment } from '@shared/lib/chat-attachments'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'

export interface ChatComposerControls {
  // C1-① extended thinking. `supported` gates visibility (Claude-only); `enabled` is
  // the current toggle; onToggle flips + persists (panel owns the localStorage pref).
  thinkingSupported: boolean
  thinkingEnabled: boolean
  onToggleThinking: () => void
  // C1-② model picker. `model` is the active providerRef (`providerId:modelId`; a bare legacy
  // id means the 'default' provider — null → backend default); onModelChange re-scopes the panel
  // backend with the SAME ref vocabulary (unchanged since C1-②).
  //
  // W8 (task 08-04) — availableModels 从 `string[]` 升为富对象数组：ref 之外还带 provider 归属
  // 与 displayName / capabilities / maxOutput，供 ModelPicker 分组 + 徽标。构造单源 =
  // `useComposerModels()`（enabledModels × /llm/providers 元数据），两个 panel 各调一次；
  // 🔴 有意不留 `string[]` 兼容重载 —— 双轨正是两个 composer 当初漂移成两份的起点。
  model: string | null
  availableModels: ComposerModelOption[]
  onModelChange: (model: string) => void
  /** Disable the picker (e.g. a turn is streaming) — mirror of legacy modelPickerDisabled. */
  modelPickerDisabled: boolean
  /** P1-2 (07-15 codex r1) — hard-disable SENDING while an approval decide → server-side resume
   *  holds this session's run lease (a send would 409 E_RUN_ACTIVE). codex r2 [D] — consumed as
   *  the composer's real submit gate, not just the Send button: Input disabled + Root submit
   *  preventDefault (ThreadComposer), Lexical submitMode 'none' + slash execute guard
   *  (AgentComposer), quick-action Suggestion disabled (AgentQuickActions). codex r2 [E] — the
   *  value is session-scoped by useApprovalDecideBusy (only the deciding session is fenced).
   *  Optional: absent/undefined → byte-identical to the pre-P1-2 composer. */
  sendDisabled?: boolean
  // C2-① @mention — referenced-email chips. The panel resolves each chip's body excerpt at SEND time
  // (buildMentionContext) and prepends an untrusted-framed block to the turn; chips clear after send.
  mentions: ReadonlyArray<SearchHit>
  onAddMention: (hit: SearchHit) => void
  onRemoveMention: (internalId: number) => void
  // C2-② attachments — local text/binary chips. Text content (≤5k chars) is prepended as an untrusted
  // block; binary chips are metadata-only (the model acknowledges but can't read them).
  attachments: ReadonlyArray<ChatAttachment>
  onAddAttachment: (attachment: ChatAttachment) => void
  onRemoveAttachment: (id: string) => void
  /** WP-15 (context 环, task 08-05) — 当前会话 id（null = 还没开会话）。ContextUsageRing 用它读
   *  `chat.listMessages` 里最新一轮的 `context_tokens`。放在这里而不是新开一个 context：面板才
   *  知道 activeSessionId，而这个 context 的定位就是「把面板持有的 chat 状态桥进 composer」。
   *  Optional —— 不供给（旧测试 / 只读 notion-agent 线程）时环整个不渲染，与引入前逐字一致。 */
  sessionId?: number | null
}

/** Provider 组件在 composerControls.tsx，故 context 对象需导出（仅这两个文件用）。 */
export const ChatComposerControlsContext = createContext<ChatComposerControls | null>(null)

/** Read the panel-supplied composer controls. null when no provider is mounted (the
 *  bare text-only composer path) — callers must handle null by hiding the extra chrome. */
export function useChatComposerControls(): ChatComposerControls | null {
  return useContext(ChatComposerControlsContext)
}
