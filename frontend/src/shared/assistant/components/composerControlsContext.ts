// 从 composerControls.tsx 拆出（08-02 review F9）：react-refresh/only-export-components 要求一个
// 文件只导出组件。契约类型 + context 对象 + 读取 hook 都是纯逻辑（零 JSX），Provider 组件留在
// composerControls.tsx，并从这里再导出类型与 hook —— 既有导入点的路径因此不必改。

import { createContext, useContext } from 'react'

import type { ReportAgentConfig, SearchHit } from '@shared/api/types'
import type { ChatAttachment } from '@shared/lib/chat-attachments'
import type { ComposerEffortControl } from '@shared/hooks/useComposerEffort'
import type { ComposerModelOption } from '@shared/hooks/useComposerModels'
import type { LibraryMentionRef, MatterMentionRef } from '@shared/lib/mention-context'

export interface ChatComposerControls {
  /** WP-16b (task 08-05) — effort 档位控件的数据 + 选档回调（`useComposerEffort` 的产物）。
   *  取代了 C1-① 的 `thinkingSupported / thinkingEnabled / onToggleThinking` 三件套（Brain
   *  布尔开关随之从两个 composer 删除）。
   *  Optional —— 不供给（只读 notion-agent 线程 / 裸测试渲染）时 effort 菜单整个不渲染，
   *  与引入前逐字一致。 */
  effort?: ComposerEffortControl
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
  queuedInputEnabled?: boolean
  queueModeActive?: boolean
  onEnqueueQueuedInput?: (text: string) => void
  // C2-① @mention — referenced-email chips. The panel resolves each chip's body excerpt at SEND time
  // (buildMentionContext) and prepends an untrusted-framed block to the turn; chips clear after send.
  mentions: ReadonlyArray<SearchHit>
  onAddMention: (hit: SearchHit) => void
  onRemoveMention: (internalId: number) => void
  // @ custom-agent mentions are trusted local config metadata. Keep them separate from email mentions:
  // buildMentionContext resolves every SearchHit through email.body(), which is invalid for agent ids.
  agentMentions: ReadonlyArray<ReportAgentConfig>
  onAddAgentMention: (agent: ReportAgentConfig) => void
  onRemoveAgentMention: (agentId: string) => void
  /** S4 (task 08-18) — @ 事项提及。与 agentMentions 同类（可信本地元数据），但**只带标识**
   *  （public_id / title / status）：事项摘要是邮件正文的衍生物，注入正文等于给不可信内容开一条
   *  绕过邮件围栏的通路 —— 判据与代价写在 `mention-context.ts::MatterMentionRef`。
   *
   *  三件套**可选**：不供给 → 「事项」这一组整个不出现（`@` 仍是原来的邮件 + Agent 两组，与引入
   *  前逐字一致）。🔴 **事项对话必须不供给** —— 那场对话的「当前事项」是固定的（chip / 上下文
   *  快照 / 写入回执都锚在它上面），再 @ 另一件事会让「当前事项」语义分裂；判据在
   *  AgentConversation（`contextSource.kind`），不在 composer 里猜。 */
  matterMentions?: ReadonlyArray<MatterMentionRef>
  onAddMatterMention?: (matter: MatterMentionRef) => void
  onRemoveMatterMention?: (publicId: string) => void
  /** P2-L8（资料库 epic）— @ 资料库文件。与 matterMentions 同类（可信本地元数据），同样
   *  **只带标识**（file_id / path / name / size_bytes）：库里存着邮件附件的解析正文，把它当可信
   *  元数据注入等于给不可信内容开一条绕过邮件围栏的通路 —— 判据与代价写在
   *  `mention-context.ts::LibraryMentionRef`，正文由模型自己调 `library_read` 读（那条腿有
   *  UNTRUSTED_LIBRARY_FILE 围栏）。
   *
   *  三件套**可选**：不供给 → 「资料库」这一组整个不出现（`@` 仍是原来的三组，与引入前逐字
   *  一致）。资料库没有功能总闸，所以「供不供」就是这一组唯一的门。 */
  libraryMentions?: ReadonlyArray<LibraryMentionRef>
  onAddLibraryMention?: (file: LibraryMentionRef) => void
  onRemoveLibraryMention?: (fileId: number) => void
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
  /** 0813 dogfood 轮 3 #3 —— **场地**告诉 composer：这里横向余量紧张（浮窗 / 抽屉 dock），
   *  工具行的控件走紧凑变体。目前唯一消费者是 ContextUsageRing：只画环、不写「177k」那串数值
   *  （数值仍在 hover 明细里，一个字没少）。
   *
   *  🔴 由场地传入、**不做全局判断**：同一个 AgentComposer 也长在 /sessions 全页里，那里横向
   *  余量充足，数值该留着。不传（全页 / 邮件面 / 裸测试）→ 与引入前逐字一致。 */
  denseControls?: boolean
  compactEnabled?: boolean
  autoCompactEnabled?: boolean
  compactActive?: boolean
  onCompact?: () => void
  onCompactStop?: () => void
}

/** Provider 组件在 composerControls.tsx，故 context 对象需导出（仅这两个文件用）。 */
export const ChatComposerControlsContext = createContext<ChatComposerControls | null>(null)

/** Read the panel-supplied composer controls. null when no provider is mounted (the
 *  bare text-only composer path) — callers must handle null by hiding the extra chrome. */
export function useChatComposerControls(): ChatComposerControls | null {
  return useContext(ChatComposerControlsContext)
}
