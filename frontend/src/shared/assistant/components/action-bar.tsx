// chat-panel P4 Phase 01 — message action bars (assistant-ui ActionBarPrimitive).
//
// AssistantActionBar: Copy + Reload (regenerate). Copy rides the runtime's
// `unstable_capabilities.copy`; Reload calls the adapter `onReload` (legacy
// retryLast for the email surface). UserActionBar: Edit → flips the message into
// the EditComposer (message.tsx) which re-streams via the adapter `onEdit`.
// MailAgent tokens only; hover-revealed to stay quiet (legacy idiom).
// W5（B 波）回答完成收束：最新一条消息的 action row 在回合落地时做一次 380ms opacity 淡入
// （useCompletionReveal），完成前 opacity-0 + pointer-events-none；非最新的 hover 路径逐字不动。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookmarkPlus, Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { ActionBarPrimitive, MessagePrimitive, useAuiState, useMessage } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'

// composer-parity C1-③ — module-level kosAvailable cache: ONE IPC per session shared by every
// assistant message's KosSaveButton (parity with the legacy MessageList _kosAvailablePromise). Using
// a plain promise + useState (not react-query) keeps the action bar provider-free, so message-render
// tests don't need a QueryClientProvider. A failed probe resolves false (KOS-down hides the button).
let _kosAvailablePromise: Promise<boolean> | null = null
function fetchKosAvailable(mailApi: ReturnType<typeof useMailApi>): Promise<boolean> {
  if (!_kosAvailablePromise) {
    _kosAvailablePromise = mailApi.chat.kosAvailable().catch(() => false)
  }
  return _kosAvailablePromise
}
function useKosAvailable(mailApi: ReturnType<typeof useMailApi>): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void fetchKosAvailable(mailApi).then((v) => {
      if (!cancelled) setAvailable(v)
    })
    return (): void => {
      cancelled = true
    }
  }, [mailApi])
  return available
}

// W5 回答完成收束 —— action row 在「回答刚写完」这一刻做一次 opacity 0→1 淡入（§8 slow 380ms），
// 而不是硬生生地出现。判据 = `thread.isRunning`，与 ActionBarPrimitive.Root 自己的 `hideWhenRunning`
// 同一口真值：running 期间 Root 返回 null（本 hook 同步把 revealed 打回 false），落地那一帧 Root 挂上
// 但仍是 opacity-0，下一帧 rAF 翻 true → transition 才有得跑（直接 opacity-100 挂载不会触发过渡）。
// 只给 isLast 那条用：非最新消息的 bar 是 hover 才现的（email 面甚至是 hover 才挂载），套上 380ms
// 会把「悬停即现」拖成拖沓 —— 那条路径逐字不动。
function useCompletionReveal(): boolean {
  const running = useAuiState((s) => s.thread.isRunning)
  const [revealed, setRevealed] = useState(false)
  // Adjust-on-prop-change（react.dev，与 useStallLevel / ReasoningText 同范式）：复位写在 render 里，
  // 不写进 effect —— 免得 set-state-in-effect 的级联，也保证「新一轮开始」与「Root 消失」同一帧发生。
  const [prevRunning, setPrevRunning] = useState(running)
  if (prevRunning !== running) {
    setPrevRunning(running)
    if (running && revealed) setRevealed(false)
  }
  useEffect(() => {
    if (running) return
    const id = window.requestAnimationFrame(() => setRevealed(true))
    return (): void => window.cancelAnimationFrame(id)
  }, [running])
  return revealed
}

const ACTION_BTN = cn(
  'inline-flex h-6 w-6 items-center justify-center rounded p-1',
  'text-ink-fg-2 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg',
  'disabled:opacity-40 disabled:hover:bg-transparent'
)

export function AssistantActionBar({
  className,
  inlineOnHover = false,
  trailing
}: {
  className?: string
  /** dogfood round-6 — agent view: the bar ALWAYS renders (no autohide mount/unmount) and reveals via
   *  OPACITY, so its geometry never changes → zero layout shift on hover (round-5 still used assistant-ui
   *  autohide which mounts/unmounts the element → the "布局位置跳变" the user reported). The last message's
   *  bar is always visible; a non-last message's bar is opacity-0 until the message row is hovered. SAME
   *  inline style for both (no floating pill). The email panel omits this prop → the legacy autohide +
   *  float-pill path (byte-identical to before). */
  inlineOnHover?: boolean
  /** dogfood round-7 — extra node rendered INSIDE the bar's Root after the buttons (the agent view passes
   *  the MessageTiming badge). Sharing the Root gives it the SAME items-center alignment AND the SAME
   *  opacity gating (non-last → hover-reveal, last → always) as Copy/Reload — the user's "放进 action bar
   *  的 div 里一起,免得对不齐 + hover 效果一致". Omitted (email panel) → nothing extra. */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  // isLast drives the always-visible-vs-hover-reveal split (inlineOnHover path only). Called
  // unconditionally to satisfy the hooks rule; the legacy path simply ignores it.
  const isLast = useMessage().isLast
  const revealed = useCompletionReveal()
  // W5 —— 两条路径共用这一段：完成前不可见且 pointer-events-none，完成后一次 380ms 淡入；
  // 之后 hover 行为各自维持现状（agent 面非最新仍是 duration-fast 的 hover-reveal）。
  const revealClass = cn(
    'transition-opacity duration-slow motion-reduce:transition-none',
    revealed ? 'opacity-100' : 'opacity-0 pointer-events-none'
  )
  const buttons = (
    <>
      <ActionBarPrimitive.Copy
        className={ACTION_BTN}
        aria-label={t('chat.messageActions.copy', { defaultValue: 'Copy' })}
      >
        <MessagePrimitive.If copied>
          <Check size={13} strokeWidth={2} className="text-ok" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <Copy size={13} strokeWidth={2} />
        </MessagePrimitive.If>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload
        className={ACTION_BTN}
        aria-label={t('chat.draftReply.regenerate', { defaultValue: 'Regenerate' })}
      >
        <RotateCcw size={13} strokeWidth={2} />
      </ActionBarPrimitive.Reload>
      {/* KOS save — kept only on the legacy email panel (!inlineOnHover); the agent view drops it per the
          dogfood round-7 feedback ("保存到 kos 的按钮移除吧"). */}
      {!inlineOnHover && <KosSaveButton />}
      {trailing}
    </>
  )
  if (inlineOnHover) {
    return (
      <ActionBarPrimitive.Root
        hideWhenRunning
        className={cn(
          'flex items-center gap-1 pt-1 text-ink-fg-2',
          isLast
            ? revealClass
            : 'transition-opacity duration-fast opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          className
        )}
      >
        {buttons}
      </ActionBarPrimitive.Root>
    )
  }
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className={cn(
        'flex items-center gap-1 pt-1 text-ink-fg-2',
        // 非最新消息在这条路径上是 hover 才挂载（autohide="not-last"）→ 不套淡入，逐字维持现状。
        isLast && revealClass,
        className
      )}
    >
      {buttons}
    </ActionBarPrimitive.Root>
  )
}

/** composer-parity C1-③ — "save this assistant reply to KOS" action (parity with the legacy
 *  AssistantMessageFooter). Visible only when (a) KOS is configured (kosAvailable) and (b) the
 *  message has a PERSISTED chat_db id — reload stamps String(row.id), so an existing/historical
 *  assistant message is saveable; a freshly streamed turn carries the ai-sdk 'asst-…' id (non-numeric)
 *  and becomes saveable only after the session reloads (its row id lands). saveToKos summarizes + writes
 *  a KOS page; failures surface as a toast (KOS-down is non-fatal, never auto-retries). Same button for
 *  the legacy ExternalStore path (its messages already carry the numeric chat_db id). */
function KosSaveButton(): React.JSX.Element | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const message = useMessage()
  const kosAvailable = useKosAvailable(mailApi)
  const numericId = /^\d+$/.test(message.id) ? Number.parseInt(message.id, 10) : null
  if (message.role !== 'assistant' || numericId === null || !kosAvailable) return null
  const onSave = async (): Promise<void> => {
    try {
      await mailApi.chat.saveToKos({ messageId: numericId })
      toastSuccess(t('chat.kos.saved', { defaultValue: 'Saved to KOS' }))
    } catch {
      toastError(t('chat.kos.saveFailed', { defaultValue: 'Save to KOS failed' }))
    }
  }
  return (
    <button
      type="button"
      onClick={() => void onSave()}
      className={ACTION_BTN}
      aria-label={t('chat.kos.save', { defaultValue: 'Save to KOS' })}
      title={t('chat.kos.save', { defaultValue: 'Save to KOS' })}
    >
      <BookmarkPlus size={13} strokeWidth={2} />
    </button>
  )
}

export function UserActionBar(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="mt-1 flex items-center justify-end"
    >
      <ActionBarPrimitive.Edit
        className={ACTION_BTN}
        aria-label={t('chat.message.edit', { defaultValue: 'Edit' })}
      >
        <Pencil size={13} strokeWidth={2} />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  )
}
