// chat-panel P4 Phase 00 spike — assistant-ui 视觉 parity PoC（S0.1 + goal 交付物①）。
//
// 目的：证明 assistant-ui 的 **headless primitives**（ThreadPrimitive / MessagePrimitive /
// ComposerPrimitive）能直接套 MailAgent 的 token 系统（ink-* 表面 + c-accent 强调 + 主题三态），
// 达成与现有自研 MessageList/Composer 一致的视觉语言 —— 即「换视图层不换设计系统」可行。
//
// 🔴 本组件**不进默认渲染路径**：它只被独立的 poc/assistant-ui vite harness import 来截图
//    （src/electron/renderer/poc/** 受 tsconfig.web 类型检查，但默认 main.tsx 不 import →
//    默认 renderer bundle 字节不变）。runtime 用 useExternalStoreRuntime 喂**静态**消息，
//    不连后端，截图稳定。生产 Phase 01/02 会换成 @assistant-ui/react-ai-sdk 的 useChatRuntime
//    （AI SDK runtime）接 Gateway，见 architecture.md §8。
//
// 关键事实（写进 architecture.md S0.1）：assistant-ui 0.14 只发 headless primitives，无预制
// styled Thread；样式 100% 由消费方 className 决定 → MailAgent token 可零冲突注入，这正是
// 「视觉 parity」可达的根因（不是去覆盖它的默认皮肤，而是它本就没有皮肤）。

import { useState } from 'react'

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike
} from '@assistant-ui/react'

// 静态会话样本：一轮用户提问 + 一轮带「工具结果」叙述的助手回复，覆盖 user/assistant 两种气泡
// + markdown 段落，足以体现表面/强调/前景三组 token 的对比关系。
const SEED_MESSAGES: ThreadMessageLike[] = [
  {
    role: 'user',
    content: '这封来自 ACME 的邮件要我做什么？帮我同步到 Notion。'
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '这封邮件请你在本周五前确认 Q3 续约报价。我已读取正文与线程上下文：\n\n• 对方：ACME 采购部\n• 截止：本周五 18:00\n• 建议动作：同步到 Notion「待办」并起草确认回复\n\n要我现在把它同步到 Notion 吗？（高风险写操作会先弹确认卡）'
      }
    ]
  }
]

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-4 flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[rgb(var(--c-accent))] px-3.5 py-2 text-sm leading-relaxed text-[rgb(var(--c-accent-fg))] shadow-sm">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-4 flex justify-start">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-[var(--hairline)] bg-ink-3 px-3.5 py-2 text-sm leading-relaxed text-ink-fg">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

/** assistant-ui Thread/Composer，全程 MailAgent token 上色。 */
export function AssistantUiThreadPoc(): React.JSX.Element {
  // 本地消息态 —— 外部 store runtime 的 SSoT。onNew 追加一条占位回复，证明 composer→runtime
  // 回路通（截图主要看初始两条；交互态可手动验证）。
  const [messages, setMessages] = useState<ThreadMessageLike[]>(SEED_MESSAGES)

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    convertMessage: (m) => m,
    onNew: async (message) => {
      const text = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('')
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: [{ type: 'text', text: '（PoC 回声）已收到：' + text }] }
      ])
    }
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col bg-ink-1 text-ink-fg">
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>

        <ComposerPrimitive.Root className="flex items-end gap-2 border-t border-[var(--hairline)] bg-ink-2 px-3 py-2.5">
          <ComposerPrimitive.Input
            placeholder="问问 MailAgent…（assistant-ui Composer，MailAgent token）"
            className="max-h-32 flex-1 resize-none rounded-lg border border-[rgb(var(--ink-border))] bg-ink-3 px-3 py-2 text-sm text-ink-fg outline-none placeholder:text-ink-fg-3 focus-visible:border-[rgb(var(--c-accent))]"
            rows={1}
          />
          <ComposerPrimitive.Send className="shrink-0 rounded-lg bg-[rgb(var(--c-accent))] px-3.5 py-2 text-sm font-medium text-[rgb(var(--c-accent-fg))] transition-opacity hover:opacity-90 disabled:opacity-40">
            发送
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}
