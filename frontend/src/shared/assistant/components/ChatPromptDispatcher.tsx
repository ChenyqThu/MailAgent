// 0812 dogfood —— 把一条来自别的界面的指令递进当前 thread（邮件工具栏「创建事项」）。
//
// 住在 runtime provider **里面**（同 ThreadRunningBridge）：append / setText 都要 thread 上下文。
// 渲染 null，纯副作用。
//
// 🔴 三条纪律：
//   1. 指令是一条**普通用户消息**，邮件引用仍由 AgentConversation 的 email context chip
//      （→ buildInjectedContext → body.injectedContext）承载 —— 不新造第五条注入路径。这也让它
//      天然扛得住 approvalResume 剥 injectedContext：指令活在消息里，不在那个信封里。
//   2. **不硬发**：run 在途 / composer 被审批闸禁用时 append 会撞 409 或被吞，此时退回「预填
//      composer 等用户回车」。两条路都会 onDispatched（不留悬挂的待发指令）。
//   3. **「调用返回」不是「已发出」**（codex #4）：`thread.append()` 不返回 send Promise，内部异步
//      执行。检查与真正拿到服务端 run lease 之间若被别的发送 / approval resume 抢先（409
//      E_RUN_ACTIVE），或 transport 构造请求失败，旧实现已经把 nonce 消费掉、也没回填 composer
//      —— 用户这一次点击**静默消失**。现在改成：append 之后盯 thread，直到那条用户消息真的落进
//      messages 才算发出；有界窗口内没落地就把文本交还 composer（用户回车即可重试）。
//
// autoSend 与否是**一次性判定**：判定完就把这条指令消费掉，不做「等它空闲再发」的排队 ——
// 那需要一套自己的生命周期（切会话 / 关面板 / 用户改主意），远超这个入口该有的复杂度。

import { useEffect, useRef, useState } from 'react'
import { useAui, useAuiState } from '@assistant-ui/react'

import type { LibraryMentionRef } from '@shared/lib/mention-context'

import { useChatComposerControls } from './composerControlsContext'

export interface ChatPromptRequest {
  /** 单调递增的请求号 —— 同一条指令连点两次也算两次。 */
  nonce: number
  text: string
  /** 父组件已经判定这条指令在本宿主里发不出去（引用的邮件不是当前这封）：只预填、不发送。
   *  🔴 它存在的理由是「决不把待发指令悬在 store 里」—— 悬着的那条会在之后某次重挂时突然发出去。 */
  prefillOnly?: boolean
  /** 09-03（资料库 P2-L14）—— 这条指令随身带的库文件提及（资料库页「对话」按钮预置的那一枚）。
   *
   *  🔴 **顺序是硬的**：`text` 里已经含这枚提及的 directive，而 AgentComposer 那条「chip 被删就
   *  摘掉 mention」的对账**只认 composer 正文** —— 正文还没落地就先把引用记进 controls，下一拍
   *  就会被当成「chip 已被删」摘掉（实测如此，不是保险起见）。所以记引用这件事挪到这里：
   *  setText 之后**盯着 composer 正文**，等它真的等于这条指令了再记。
   *  只在预填这条路上成立 —— 带提及的指令由调用方恒设 `prefillOnly`（直接 append 的话 composer
   *  正文是空的，那枚 chip 根本不存在）。 */
  library?: LibraryMentionRef
}

/** append 之后等这条用户消息落进 thread 的上限。到点仍没落地 = 这次发送没被接受（run 互斥 409 /
 *  transport 构造失败 / 引擎侧丢弃），把文本交还 composer。取几秒而不是几百毫秒：正常路径下
 *  optimistic 落地是同一批渲染的事，这个窗口只用来兜住失败，宁可等久一点也别误判成失败重复写入。 */
const PROMPT_ACCEPT_TIMEOUT_MS = 4000

function threadHasUserText(
  messages: ReadonlyArray<{ role: string; content: ReadonlyArray<unknown> }>,
  fromIndex: number,
  text: string
): boolean {
  // 🔴 只看 append 之后新增的那一段：按全文匹配会被**历史上**同样内容的用户消息误判成"已发出"。
  return messages.slice(fromIndex).some(
    (message) =>
      message.role === 'user' &&
      message.content.some((part) => {
        const candidate = part as { type?: unknown; text?: unknown }
        return candidate.type === 'text' && candidate.text === text
      })
  )
}

export function ChatPromptDispatcher({
  request,
  onDispatched
}: {
  /** null = 没有待派发的指令（门由父组件把：邮件 chip 就位了吗？会话是空的吗？）。 */
  request: ChatPromptRequest | null
  onDispatched: (nonce: number, sent: boolean) => void
}): null {
  const aui = useAui()
  const controls = useChatComposerControls()
  const sendDisabled = controls?.sendDisabled === true
  const dispatchedRef = useRef<number | null>(null)
  /** 已经预填、但还在等正文落地的那枚提及（见 `ChatPromptRequest.library` 的红字）。 */
  const [pendingMention, setPendingMention] = useState<{
    text: string
    ref: LibraryMentionRef
  } | null>(null)
  /** 已交给 thread、但还没看见那条用户消息落地的一次派发。 */
  const [awaiting, setAwaiting] = useState<{
    nonce: number
    text: string
    fromIndex: number
  } | null>(null)
  // 观测面：消息数变化驱动重渲染（send 是 void 且内部异步，"调用返回"不是判据）。
  const messageCount = useAuiState((state) => state.thread.messages.length)

  useEffect(() => {
    if (request === null) return
    if (dispatchedRef.current === request.nonce) return
    dispatchedRef.current = request.nonce
    const thread = aui.thread()
    const busy = sendDisabled || thread.getState().isRunning
    if (busy || request.prefillOnly === true) {
      // 预填：用户自己按回车。这里不清空已有草稿之外的东西 —— setText 覆盖的是 composer 内容，
      // 与用户点「创建事项」的意图一致。
      aui.composer().setText(request.text)
      if (request.library) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPendingMention({ text: request.text, ref: request.library })
      }
      onDispatched(request.nonce, false)
      return
    }
    const fromIndex = thread.getState().messages.length
    try {
      thread.append({
        content: [{ type: 'text', text: request.text }],
        runConfig: aui.composer().getState().runConfig
      })
    } catch {
      // 同步就炸了（transport 构造失败等）—— 文本交还 composer，别让这次点击凭空消失。
      aui.composer().setText(request.text)
      onDispatched(request.nonce, false)
      return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAwaiting({ nonce: request.nonce, text: request.text, fromIndex })
  }, [request, aui, sendDisabled, onDispatched])

  // 正文真的落进 composer 了 → 这时候记引用才不会被对账当成「chip 已被删」摘掉。
  const composerText = useAuiState((state) => state.composer.text)
  useEffect(() => {
    if (pendingMention === null) return
    if (composerText !== pendingMention.text) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingMention(null)
    controls?.onAddLibraryMention?.(pendingMention.ref)
  }, [composerText, controls, pendingMention])

  // 确认（或超时回退）。messageCount 入 deps = 每次 thread 变动都重判一次。
  useEffect(() => {
    if (awaiting === null) return undefined
    if (threadHasUserText(aui.thread().getState().messages, awaiting.fromIndex, awaiting.text)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAwaiting(null)
      onDispatched(awaiting.nonce, true)
      return undefined
    }
    const timer = setTimeout(() => {
      setAwaiting(null)
      aui.composer().setText(awaiting.text)
      onDispatched(awaiting.nonce, false)
    }, PROMPT_ACCEPT_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [awaiting, messageCount, aui, onDispatched])

  return null
}
