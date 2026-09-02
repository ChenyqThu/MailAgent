// L4 群聊 — 发送框。T2 起换成与 AI Chat 同一套内胆：本组件自己挂一个只包住 composer 段 DOM 的
// `useExternalStoreRuntime`（`messages` 恒空、时间线仍由 GroupThread 渲染），于是 `ComposerFrame`
// 的 chips 行 / 长高 / 拖入、`ComposerPrimitive.Input` 内置的粘贴附件、`ComposerPlusMenu` 的「+」
// 三个附件入口与 AI Chat 逐字同源。**不挂** `ChatComposerControlsProvider` —— 模型 / skill / 授权 /
// effort / 上下文环整组随 `controls === null` 消失（composer.tsx 文件头写明的「裸 composer」契约）。
//
// 群独有三件保留：@ 弹层（`detectMentionDraft` 在 Input 的 value 上跑，采纳时 `aui.composer().setText()`
// 写回；🔴 弹层开着时 Enter 是「采纳」不是「发送」——靠 onKeyDown 里 preventDefault 让 radix
// composeEventHandlers 跳过 primitive 的提交）、「将唤醒 N 位」、「排队在后」。@ 判据仍是裸文本显示名。
//
// 🔴 `isRunning` 有意**不**接 runAlive：assistant-ui 在 isRunning 时把 Send 禁用、把 Enter 吞掉
//    （useComposerSend：`isRunning && !capabilities.queue`），而群里成员在说话时用户本来就能发、消息排在
//    后面（「排队在后」提示说的就是这件事）。停止本轮的按钮在 GroupHeader，这里不再放一个 Cancel。
//
// 附件（落法 β）：复用 `createMailAgentAttachmentAdapter`（图片护栏 + 文本 / office 读取），非图片的
// 读取结果经 bridge 落在本组件的 map 里，发送时映射成 `GroupAttachment[]`（图片 `text=null` 只留档）随
// body 走；条数上限 `GROUP_ATTACHMENTS_MAX` 在 add 前拦，超出 toast。

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Users } from 'lucide-react'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type AttachmentAdapter,
  type CompleteAttachment,
  type ExternalStoreAdapter,
  type ThreadMessage
} from '@assistant-ui/react'

import type { AgentAvatarConfig } from '@shared/api/types'
import {
  GROUP_ATTACHMENTS_MAX,
  GROUP_ATTACHMENT_TEXT_MAX_CHARS,
  type GroupAttachment
} from '@shared/chat_model'
import i18n from '@shared/i18n'
import { cn } from '@shared/lib/cn'
import type { ChatAttachment } from '@shared/lib/chat-attachments'
import { toastError } from '@shared/state/toast'
import { Loader } from '@shared/components/ui/loader'
import { ComposerFrame } from '@shared/assistant/components/composer'
import { ComposerPlusMenu } from '@shared/assistant/components/ComposerPlusMenu'
import { createMailAgentAttachmentAdapter } from '@shared/assistant/runtime/chatAttachmentAdapter'

import { GROUP_MENTION_ALL_TOKENS } from '../../../../ai-gateway/groupChat'
import type { GroupResponseMode } from '../../../../ai-gateway/groupFloors'
import { AgentAvatar } from '../AgentAvatar'
import { detectMentionDraft, parseGroupMentions } from './mentions'

const MAX_MENTION_ITEMS = 8
/** 稳定引用：每次 render 新造 `[]` 会让 external store 重新走一遍消息转换（虽然是空的）。 */
const EMPTY_MESSAGES: readonly ThreadMessage[] = []

export interface GroupComposerMember {
  agentId: string
  title: string
  avatar?: AgentAvatarConfig | null
}

export interface GroupComposerProps {
  /** 发送：正文 + 已读出的附件。附件正文由 renderer 读好，服务端只校验形状与上限。 */
  onSend: (text: string, attachments: readonly GroupAttachment[]) => Promise<void>
  sending: boolean
  disabled: boolean
  members: readonly GroupComposerMember[]
  /** labs on 才有：缺行 = mention。null = 未加载 / labs off（不显角标）。 */
  modes: Record<string, GroupResponseMode> | null
  labsOn: boolean
  labsLoading: boolean
  /** labs on 的 realtime 成员数（无 @ 时的唤醒人数）；null = 群配置未到。 */
  realtimeCount: number | null
  runAlive: boolean
}

type MentionItem = { kind: 'all' } | { kind: 'member'; member: GroupComposerMember }

/** 条数上限包在 adapter 外面：三个入口（粘贴 / 拖入 / 「+」）都经 `composer.addAttachment` →
 *  adapter.add，拦这一处就够。计数 = composer 里已有的 + 本 adapter 还在 add 中的：core 要等 add
 *  resolve 才把附件 upsert 进 state，而同一次粘贴的多份文件是同步连续起 add 的，只看 state 会全部
 *  放行。服务端编码时还有一刀尾部截断兜底。 */
function withGroupAttachmentCap(
  base: AttachmentAdapter,
  pendingCount: () => number
): AttachmentAdapter {
  let adding = 0
  return {
    ...base,
    add(state) {
      if (pendingCount() + adding >= GROUP_ATTACHMENTS_MAX) {
        const message = i18n.t('groupChat.composer.attachTooMany', { max: GROUP_ATTACHMENTS_MAX })
        toastError(message)
        return Promise.reject(new Error(message))
      }
      const result = base.add(state)
      // generator 形态（分段上传进度）本仓的 adapter 不产，原样放行不计数。
      if (Symbol.asyncIterator in result) return result
      adding += 1
      return result.finally(() => {
        adding -= 1
      })
    }
  }
}

function appendedText(message: AppendMessage): string {
  let text = ''
  for (const part of message.content) if (part.type === 'text') text += part.text
  return text
}

/** assistant-ui 的已发附件 → 群附件载体。非图片的正文来自 bridge 落下的读取结果（`readAttachment`
 *  已按 ATTACHMENT_MAX_CONTENT_CHARS 截过，这里再按契约常量截一刀）；图片没有读取结果 → `text=null`。 */
function toGroupAttachments(
  attachments: readonly CompleteAttachment[],
  read: ReadonlyMap<string, ChatAttachment>
): GroupAttachment[] {
  return attachments.map((a) => {
    const entry = read.get(a.id)
    return {
      filename: a.name,
      size: a.file?.size ?? entry?.sizeBytes ?? 0,
      mimeType: a.contentType ?? entry?.mimeType ?? '',
      text: entry?.content != null ? entry.content.slice(0, GROUP_ATTACHMENT_TEXT_MAX_CHARS) : null
    }
  })
}

export function GroupComposer(props: GroupComposerProps): React.ReactElement {
  const { onSend, sending, disabled } = props
  // 非图片附件的读取结果（adapter 经 bridge 写入，chip 移除 / 发送后删除）。
  const readRef = useRef(new Map<string, ChatAttachment>())
  const runtimeRef = useRef<AssistantRuntime | null>(null)
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  const [adapter] = useState(() =>
    withGroupAttachmentCap(
      createMailAgentAttachmentAdapter(() => ({
        onAdd: (a) => {
          readRef.current.set(a.id, a)
        },
        onRemove: (id) => {
          readRef.current.delete(id)
        }
      })),
      () => runtimeRef.current?.thread.composer.getState().attachments.length ?? 0
    )
  )
  const store = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      messages: EMPTY_MESSAGES,
      // canSend 的真门：Enter 与 Send 钮都经它，disabled / 发送中一律 no-op。
      isSendDisabled: disabled || sending,
      adapters: { attachments: adapter },
      onNew: async (message) => {
        const attached = message.attachments ?? []
        const attachments = toGroupAttachments(attached, readRef.current)
        for (const a of attached) readRef.current.delete(a.id)
        await onSendRef.current(appendedText(message).trim(), attachments)
      }
    }),
    [disabled, sending, adapter]
  )
  const runtime = useExternalStoreRuntime(store)
  runtimeRef.current = runtime
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <GroupComposerBody {...props} />
    </AssistantRuntimeProvider>
  )
}

function GroupComposerBody({
  sending,
  disabled,
  members,
  modes,
  labsOn,
  labsLoading,
  realtimeCount,
  runAlive
}: GroupComposerProps): React.ReactElement {
  const { t } = useTranslation()
  const aui = useAui()
  const text = useAuiState((s) => s.composer.text)
  const hasImage = useAuiState((s) => s.composer.attachments.some((a) => a.type === 'image'))
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const listId = useId()
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // 发送后 composer 自己把 text 清空（不经 onChange），弹层状态跟着清，否则会悬在空框上。
  useEffect(() => {
    if (text.length === 0) setMention(null)
  }, [text])

  const query = mention?.query.toLowerCase() ?? ''
  const allLabel = t('groupChat.mentionAll')
  const items: MentionItem[] = mention
    ? [
        ...(query.length === 0 || allLabel.toLowerCase().includes(query) || 'all'.includes(query)
          ? [{ kind: 'all' } as const]
          : []),
        ...members
          .filter((m) => m.title.toLowerCase().includes(query))
          .slice(0, MAX_MENTION_ITEMS)
          .map((member) => ({ kind: 'member', member }) as const)
      ]
    : []
  const open = mention != null && items.length > 0
  const active = open ? Math.min(activeIndex, items.length - 1) : 0

  const refreshMention = (value: string, caret: number | null): void => {
    setMention(caret == null ? null : detectMentionDraft(value, caret))
    setActiveIndex(0)
  }
  const pick = (item: MentionItem): void => {
    if (!mention) return
    const label = item.kind === 'all' ? GROUP_MENTION_ALL_TOKENS[0] : `@${item.member.title}`
    const caret = inputRef.current?.selectionStart ?? text.length
    aui.composer().setText(`${text.slice(0, mention.start)}${label} ${text.slice(caret)}`)
    setMention(null)
    inputRef.current?.focus()
  }

  // 弹层开着时接管方向键 / Enter · Tab / Esc；每条都 preventDefault，radix composeEventHandlers
  // 据此跳过 primitive 的 Enter 提交。弹层关着时 Enter 归 primitive（requestSubmit → Root）。
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!open) {
      if (e.key === 'Escape') setMention(null)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((active + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((active - 1 + items.length) % items.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(items[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
    }
  }

  const textEmpty = text.trim().length === 0
  const mentionCount = textEmpty ? 0 : parseGroupMentions(text, members).length
  const wakeCount = labsOn && !textEmpty ? (mentionCount > 0 ? mentionCount : realtimeCount) : null
  const hint = labsLoading
    ? { text: t('groupChat.labsLoading'), warn: false }
    : labsOn && wakeCount != null
      ? wakeCount > 0
        ? { text: t('groupChat.wakeCount', { count: wakeCount }), warn: false }
        : { text: t('groupChat.wakeNone'), warn: true }
      : null

  return (
    <div className="relative shrink-0 border-t border-ink-border px-4 py-3">
      {open && (
        <div
          id={listId}
          role="listbox"
          className="glass-pop absolute bottom-full left-4 z-10 mb-1 w-64 rounded-[var(--r-ctl)] border border-ink-border-soft p-1"
        >
          {items.map((item, i) => {
            const selected = i === active
            const id = `${listId}-${i}`
            return (
              <button
                key={item.kind === 'all' ? '__all__' : item.member.agentId}
                id={id}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux text-ink-fg-1 transition-colors duration-fast',
                  selected && 'bg-ink-3'
                )}
              >
                {item.kind === 'all' ? (
                  <>
                    <span className="grid size-5 shrink-0 place-items-center text-ink-fg-2">
                      <Users size={15} strokeWidth={2} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{allLabel}</span>
                    <span className="truncate text-micro text-ink-fg-3">
                      {t('groupChat.mentionAllHint')}
                    </span>
                  </>
                ) : (
                  <>
                    <AgentAvatar
                      agentId={item.member.agentId}
                      config={item.member.avatar}
                      size={20}
                      title={item.member.title}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.member.title}</span>
                    {labsOn && modes != null && (
                      <span className="rounded-full bg-ink-3 px-1.5 text-micro text-ink-fg-3">
                        {t(
                          (modes[item.member.agentId] ?? 'mention') === 'realtime'
                            ? 'groupChat.mentionModeRealtime'
                            : 'groupChat.mentionModeMention'
                        )}
                      </span>
                    )}
                  </>
                )}
              </button>
            )
          })}
        </div>
      )}
      {(hint != null || runAlive || hasImage) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-3 text-micro text-ink-fg-3">
          {hint != null && <span className={cn(hint.warn && 'text-warn')}>{hint.text}</span>}
          {runAlive && <span>{t('groupChat.queuedBehind')}</span>}
          {hasImage && <span>{t('groupChat.composer.attachImageNote')}</span>}
        </div>
      )}
      {/* Root 的 onSubmit 先于 primitive 的 send 跑：空正文 / 禁用 / 发送中一律 preventDefault
          （服务端要求 userText 非空，只带附件不算一条消息）。 */}
      <ComposerPrimitive.Root
        onSubmit={(e) => {
          if (disabled || sending || textEmpty) e.preventDefault()
        }}
      >
        <ComposerFrame
          controls={null}
          disabled={disabled}
          aria-disabled={disabled}
          chipRowClassName="px-1.5"
          className={cn(
            'rounded-[var(--r-card)] border border-[rgb(var(--ink-border))] bg-ink-2',
            'has-[textarea:focus]:border-[rgb(var(--c-accent))]'
          )}
        >
          <ComposerPrimitive.Input
            ref={inputRef}
            placeholder={t('groupChat.composerPlaceholder')}
            rows={1}
            disabled={disabled}
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${active}` : undefined}
            onChange={(e) => refreshMention(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            className={cn(
              'scrollbar-thin max-h-32 w-full resize-none border-0 bg-transparent px-1.5 py-1',
              'text-body leading-snug text-ink-fg outline-none placeholder:text-ink-fg-3',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          />
          <div className="flex items-center gap-1">
            {/* 「+」= 附件入口（不给 mention 项：群的 @ 在正文里）。 */}
            <ComposerPlusMenu variant="icon" />
            <ComposerPrimitive.Send
              aria-label={t('groupChat.send')}
              title={t('groupChat.send')}
              disabled={disabled || sending || textEmpty}
              className={cn(
                'ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                'bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))]',
                'transition-opacity duration-fast hover:opacity-90 disabled:opacity-40'
              )}
            >
              {sending ? (
                <Loader variant="spinner" size={15} label={t('chat.composer.sending')} />
              ) : (
                <ArrowUp size={16} strokeWidth={2.5} />
              )}
            </ComposerPrimitive.Send>
          </div>
        </ComposerFrame>
      </ComposerPrimitive.Root>
    </div>
  )
}
