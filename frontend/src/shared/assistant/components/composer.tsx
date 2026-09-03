// chat-panel P4 Phase 01 + composer-parity — thread composer (assistant-ui ComposerPrimitive).
//
// MailAgent-token composer: 一个圆角框（ComposerFrame）里竖排三层 —— 附件/引用 chips 在最上、
// 文本输入居中、工具条在最下（左边入口菜单，右边 模型 / effort / 发送）。While the thread is
// running the Send swaps to a Cancel (stop generating) via ThreadPrimitive.If.
// ComposerPrimitive.Send is auto-disabled on empty input.
//
// 0813（owner 参照 Notion 输入框）：chips 从「悬在框外」搬进框内，框随 chips 行数长高 ——
// border/bg/圆角从 textarea 搬到 ComposerFrame 那一层，见该组件的注释。ComposerFrame 与
// chip 行是**两个 composer 共用的一份**（AgentComposer 的那份 wrapper 已删）。
//
// composer-parity: the model picker + @mention + attachment chips all read panel-owned state via
// useChatComposerControls(). When no provider is mounted (controls === null — the read-only
// notion-agent thread, or a bare test render) the toolbar shows only send/cancel, byte-identical in
// behaviour to the Phase 01 text-only composer.
//
// 08-05 WP-13+16b — 工具条重组（owner 参照 Notion composer，prd「composer 工具条布局」）：
//   左组 `[+（附件 / 引用邮件）] [滑块（connector / skill 快捷配置）] [授权模式]`
//   右组 `[context 环] [effort] [模型] [发送]`
// 两处删除：独立的 `@` 钮（并进「+」）、Brain 布尔开关（被 effort 档位菜单取代 —— 见
// EffortPicker 文件头；`body.thinking` 自此不再由任何 UI 发出，gateway 的 legacy 分支仍在，
// island resume 回放冻结的 originalBody 需要它）。

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArrowUp, AtSign, Paperclip, X } from 'lucide-react'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type Attachment
} from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { ImageLightbox } from '@shared/components/email/EmailBodyFrame'
import { formatAttachmentSize } from '@shared/lib/chat-attachments'

import { useChatComposerControls, type ChatComposerControls } from './composerControlsContext'
import { ApprovalModePicker } from './ApprovalModePicker'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { ComposerToolsMenu } from './ComposerToolsMenu'
import { ContextUsageRing } from './ContextUsageRing'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'

/** One pending-attachment chip. An image chip swaps the paperclip for a thumbnail of the file
 *  itself (objectURL over attachment.file — the adapter's prepared data URL isn't exposed here),
 *  clickable to open the shared lightbox; every other chip is the paperclip pill unchanged.
 *  The objectURL is owned per chip: created when the File lands, revoked on unmount / removal. */
function ComposerAttachmentChip({
  attachment,
  maxWidthClass,
  onPreview
}: {
  attachment: Attachment
  maxWidthClass: string
  onPreview: (src: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const file = attachment.type === 'image' ? attachment.file : undefined
  const thumbUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  // 拿到 URL 的那次 memo 之外没有别的持有者 —— chip 卸载/附件被移除/换了 File 时必须 revoke，
  // 否则每粘一张图都在 renderer 里留一份不会被 GC 的 blob。
  useEffect(() => {
    if (thumbUrl === null) return undefined
    return (): void => URL.revokeObjectURL(thumbUrl)
  }, [thumbUrl])
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1',
        maxWidthClass
      )}
    >
      {thumbUrl !== null ? (
        // 点击图本身放大（role/tabIndex，而不是外面套一层 <button>：chip 里已有 Remove 按钮，
        // 图再包一层会多一个嵌套的可聚焦盒子）。
        <img
          src={thumbUrl}
          alt=""
          role="button"
          tabIndex={0}
          aria-label={t('chat.attachment.preview', { defaultValue: 'Preview image' })}
          onClick={() => onPreview(thumbUrl)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onPreview(thumbUrl)
            }
          }}
          className="h-9 w-9 shrink-0 cursor-zoom-in rounded-md border border-ink-border bg-ink-1 object-cover"
        />
      ) : (
        <Paperclip size={11} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
      )}
      <span className="truncate">{attachment.name}</span>
      {attachment.file && (
        <span className="shrink-0 font-mono text-micro text-ink-fg-3">
          {formatAttachmentSize(attachment.file.size)}
        </span>
      )}
      <AttachmentPrimitive.Remove
        aria-label="remove"
        className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
      >
        <X size={11} strokeWidth={2.5} />
      </AttachmentPrimitive.Remove>
    </span>
  )
}

/** issue #61 Lane 3 (A2) — attachment chips now render from the assistant-ui COMPOSER state (the
 *  adapter's pending attachments), so paperclip / paste / drop all get the same visible feedback.
 *  Styling is the former controls-driven chip, verbatim; the hand-rolled X becomes
 *  AttachmentPrimitive.Remove → composer.removeAttachment → adapter.remove → panel-state sync.
 *
 *  Internal since 0813: the two composers no longer mount this directly — they mount ComposerFrame,
 *  which owns the row (wrapper + empty gating) as well. The lightbox lives here so a chip thumbnail
 *  zooms on either surface. */
function ComposerAttachmentChips({
  chipMaxWidthClass = 'max-w-[200px]'
}: {
  chipMaxWidthClass?: string
} = {}): React.JSX.Element {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  return (
    <>
      <ComposerPrimitive.Attachments>
        {({ attachment }) => (
          <ComposerAttachmentChip
            attachment={attachment}
            maxWidthClass={chipMaxWidthClass}
            onPreview={setPreviewSrc}
          />
        )}
      </ComposerPrimitive.Attachments>
      {previewSrc !== null && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </>
  )
}

/** P2-L5（design §1.4）—— 对话附件「发送即入库」的一次性告知。
 *
 *  隐私语义变了（此前附件只活在 renderer 内存里，现在原件会落到资料库并长期留存），这种变化
 *  必须出现在用户看得见的地方，而不是只写在文档里。挂在附件 chips 那一行的**上方**，只在真有
 *  待发附件时出现，点 × 之后永不再来。
 *
 *  localStorage 读写都 try/catch —— storage 被禁时提示每次都出，方向是多提醒不是漏提醒
 *  （抄 `connectors/consoleShared.ts` 的两处一次性提示同款姿态）。 */
const CHAT_ATTACHMENT_LIBRARY_NOTICE_KEY = 'mailagent.chat.attachmentLibraryNotice.v1'

function readLibraryNoticeAck(): boolean {
  try {
    return window.localStorage.getItem(CHAT_ATTACHMENT_LIBRARY_NOTICE_KEY) === '1'
  } catch {
    return false
  }
}

function ChatAttachmentLibraryNotice(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [acked, setAcked] = useState(readLibraryNoticeAck)
  if (acked) return null
  return (
    // w-full：这是 flex-wrap 行里的一员，占满一行才不会和 chips 挤在一起（框跟着长高的
    // 结构因此保持不变，见下面 ComposerFrame 的注释）。
    <div className="flex w-full items-center gap-1.5 text-meta text-ink-fg-3">
      <Archive size={11} strokeWidth={2} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t('library.chip.composerNotice')}</span>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={() => {
          try {
            window.localStorage.setItem(CHAT_ATTACHMENT_LIBRARY_NOTICE_KEY, '1')
          } catch {
            /* storage 不可用 → 下次还会提示，可接受 */
          }
          setAcked(true)
        }}
        className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
      >
        <X size={11} strokeWidth={2.5} />
      </button>
    </div>
  )
}

/** C2 chip stack — referenced-email chips (panel state) + attachment chips (composer state) above
 *  the input. Nothing renders when both are empty (byte-identical to no chips). Mention chips stay
 *  controls-driven (their send-time excerpt resolution lives in the panel); attachment chips render
 *  even without controls so a pasted image is never an invisible send (issue #61's观感 root).
 *
 *  0813 — 这一层从「两处各一份 wrapper」收成一处（AgentComposer 的 AgentAttachmentChips 已删）：
 *  wrapper 的 flex/wrap/gap、空态门（全空 → 不渲染任何节点）、chip 上限，全在这儿一份。
 *
 *  0813 轮4批AE —— 第三类 chip 进场（`leadingChips`）：会话级的**上下文** chip（当前邮件 /
 *  当前事项，`ConversationContextChip`）。它此前是整个 composer 的**兄弟**、挂在框外，owner
 *  参照 Notion 要求它与附件同框同区。三类的数据路径**各不相同**（附件=composer 状态、引用
 *  邮件=controls 面板状态、上下文=宿主传下来的 ReactNode），但对本行而言只是「同一条 flex-wrap
 *  里的三种 chip」—— 故这里只收位置与换行，不碰任何一条数据路径。 */
function ComposerChipRow({
  controls,
  mentions = false,
  leadingChips,
  chipMaxWidthClass,
  className
}: {
  controls: ChatComposerControls | null
  /** 渲染「引用邮件」chips。通用面（AgentComposer）的 @ 提及是**正文里的 Lexical directive
   *  chip**，不走这条 chip 行 —— 故默认 false，只有邮件面显式打开。 */
  mentions?: boolean
  /** 宿主给的会话上下文 chips（邮件 / 事项），排在最前。🔴 必须是**直接子节点**而不是再包一层
   *  div：包一层的话它们会自成一个换行上下文，与附件 chips 各自换各自的行；平铺才是 owner 要的
   *  「多个时一起换行、框跟着长高」。空态由宿主保证（没 chip 时传 null，不是传空容器）。 */
  leadingChips?: React.ReactNode
  chipMaxWidthClass?: string
  /** 🔴 唯一的正当用途：把 chips 的左缘对齐到**本场地输入区**的文字内缩。两个输入组件
   *  （textarea vs Lexical contenteditable）的水平 padding 本来就不同，这一个值是它俩剩下的
   *  全部差异 —— 别拿它塞别的样式，否则两面又会漂开。 */
  className?: string
}): React.JSX.Element | null {
  const attachmentCount = useAuiState((s) => s.composer.attachments.length)
  const mentionList = mentions ? (controls?.mentions ?? []) : []
  if (leadingChips == null && mentionList.length === 0 && attachmentCount === 0) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {attachmentCount > 0 && <ChatAttachmentLibraryNotice />}
      {leadingChips}
      {controls &&
        mentionList.map((m) => (
          <span
            key={`m-${m.internal_id}`}
            className="inline-flex max-w-[200px] items-center gap-1 rounded-md border border-ink-border bg-ink-3 px-2 py-1 text-meta text-ink-fg-1"
          >
            <AtSign size={11} strokeWidth={2} className="shrink-0 text-coral" />
            <span className="truncate">{m.subject || `#${m.internal_id}`}</span>
            <button
              type="button"
              onClick={() => controls.onRemoveMention(m.internal_id)}
              aria-label="remove"
              className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
      <ComposerAttachmentChips chipMaxWidthClass={chipMaxWidthClass} />
    </div>
  )
}

/** 0813 owner（参照 Notion 输入框）：附件 chips 要在**对话框的边框之内**、位于输入区上方，
 *  而且框的高度随 chips 行数长高。这一层就是那个「框的内胆」，两个 composer 共用：
 *
 *      ┌─ 皮肤（border / bg / 圆角）由调用方给 ─────────┐
 *      │  chips（上下文 → 引用邮件 → 附件；换行、可多行）│  ← ComposerChipRow
 *      │  输入区                                       │  ← children
 *      │  工具条                                       │  ← children
 *      └──────────────────────────────────────────────┘
 *
 *  三层是**同一个 flex-col 的兄弟节点**且容器不设任何 `h-*` —— 所以 chips 多一行框就高一行，
 *  而不是在固定高度里挤压输入区；chips 区也**不单独滚动**（不设 max-h / overflow：附件条数的
 *  真实上限来自 gateway 的 8MiB body 与 adapter 的逐份护栏，界面这层再加一个数字只会是猜的）。
 *  输入区自己的 `max-h-32` 是文本溢出的老行为，与本层无关、原样保留。
 *
 *  这一层同时是**文件入口**：AttachmentDropzone 拥有 drag handlers + `data-dragging` 高亮属性
 *  （粘贴另有两条既有通路：邮件面在 ComposerPrimitive.Input 内置、通用面把 onPaste 挂在这个
 *  dropzone 上经 rest 透传 —— 两条都不经过本层的布局，改框不动数据路径）。
 *
 *  🔴 皮肤留给调用方而不是收进来：通用面外面套的是 reactbits BorderGlow（彩虹边框卡，皮肤在
 *  那张卡上，这里只出内边距），邮件面自己画一张 v3 token 卡。把 BorderGlow 收进本层 == 给邮件
 *  面强加彩虹边框，那是另一件事。 */
export function ComposerFrame({
  className,
  controls,
  mentions,
  leadingChips,
  chipMaxWidthClass,
  chipRowClassName,
  children,
  ...dropzone
}: React.ComponentPropsWithoutRef<typeof ComposerPrimitive.AttachmentDropzone> & {
  controls: ChatComposerControls | null
  mentions?: boolean
  leadingChips?: React.ReactNode
  chipMaxWidthClass?: string
  chipRowClassName?: string
}): React.JSX.Element {
  return (
    <ComposerPrimitive.AttachmentDropzone
      {...dropzone}
      className={cn(
        'flex w-full flex-col gap-1.5 p-2 transition-colors duration-fast data-[dragging=true]:bg-coral/5',
        className
      )}
    >
      <ComposerChipRow
        controls={controls}
        mentions={mentions}
        leadingChips={leadingChips}
        chipMaxWidthClass={chipMaxWidthClass}
        className={chipRowClassName}
      />
      {children}
    </ComposerPrimitive.AttachmentDropzone>
  )
}

export function ThreadComposer(): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const controls = useChatComposerControls()
  // codex r2 [D] — sendDisabled must gate the REAL submit path, not just the Send button: the
  // assistant-ui Input's Enter requestSubmit()s the Root form, whose composed handler calls send()
  // unless the user handler prevented default (radix composeEventHandlers checks defaultPrevented).
  // The Input itself is disabled too (typing fenced while the approval resume holds the lease).
  const sendDisabled = controls?.sendDisabled === true
  const queueModeActive = controls?.queuedInputEnabled === true && controls.queueModeActive === true
  const composerText = useAuiState((state) => state.composer.text)
  return (
    <ComposerPrimitive.Root
      onSubmit={(e) => {
        if (sendDisabled) {
          e.preventDefault()
          return
        }
        if (composerText.trim() === '/compact' && controls?.compactEnabled === true) {
          e.preventDefault()
          aui.composer().setText('')
          controls.onCompact?.()
          return
        }
        if (queueModeActive) {
          e.preventDefault()
          const text = composerText.trim()
          if (!text) return
          controls?.onEnqueueQueuedInput?.(text)
          aui.composer().setText('')
        }
      }}
      // 0813 — 底色从 ink-2 降到 ink-1（= 消息区 ThreadPrimitive.Root 的底色）：ink-2 让给了
      // 里面那张 ComposerFrame 卡，于是「卡浮在对话底色上」与通用面（BorderGlow 卡 = ink-2
      // 浮在 glass-3 上）同构；顶部 hairline 保留，窄侧栏里仍需要这条结构线。
      className="border-t border-[var(--hairline)] bg-ink-1 px-3 py-2.5"
    >
      {/* issue #61 Lane 3 (A2) — drag&drop lands files on the same adapter pipeline as paste /
          the "+" menu's attachment item. The primitive owns the drag handlers + a data-dragging
          attribute for the highlight wash; the document-level fileDropGuard only blocks the
          file:// navigation default and doesn't consume the drop. Layout classes moved off Root
          so the wash paints.
          0813 — 它同时是**可见的那个对话框**：border/bg/圆角从 textarea 搬到这一层，于是
          chips 与工具条都进了框内（此前 textarea 自带 border，chips 悬在框外）。框不设高度，
          chips 换行即整框长高；焦点态用 `has-[textarea:focus]` 精确复刻旧的
          `focus-visible:border-accent`（换 focus-within 会让点一下工具条按钮也整框变色）。 */}
      <ComposerFrame
        controls={controls}
        mentions
        disabled={sendDisabled || queueModeActive}
        aria-disabled={sendDisabled || queueModeActive}
        chipRowClassName="px-1.5"
        className={cn(
          // 🔴 底色必须是 ink-2 而不是原 textarea 的 ink-3：chip 自己就是 `bg-ink-3`，卡也用
          // ink-3 的话 chip 在卡上没有填充差（亮色下双双是纯白），只剩一圈描边 —— 而通用面的
          // chip 是浮在 ink-2 卡上的实心块。两面同一个 chip 组件，底色也必须同一档。
          // 圆角走 v3 --r-card(12)：本面是 320px 侧栏，比通用面 44rem 卡的 16px 小一档。
          'rounded-[var(--r-card)] border border-[rgb(var(--ink-border))] bg-ink-2',
          'has-[textarea:focus]:border-[rgb(var(--c-accent))]'
        )}
      >
        <ComposerPrimitive.Input
          placeholder={t('chat.composer.placeholder')}
          aria-label={t('chat.composer.placeholder')}
          disabled={sendDisabled}
          className={cn(
            'scrollbar-thin max-h-32 w-full resize-none border-0 bg-transparent px-1.5 py-1',
            'text-body leading-snug text-ink-fg outline-none placeholder:text-ink-fg-3',
            sendDisabled && 'opacity-60'
          )}
          rows={1}
          autoFocus
        />
        {/* 🔴 `relative` 是 WP-22 的 context 明细弹层的包含块（那颗环在右组第一位，按它自己的
            右缘锚会在 320px 窄面里被 overflow-hidden 裁掉 —— 算式见 ContextUsageRing 的注释）。
            其余弹层（+/滑块/授权/effort/模型）各自有 `div.relative` 包裹，不受这层影响。 */}
        <div className="relative flex items-center gap-1">
          {controls && (
            <>
              {/* 08-05 WP-13 — 「+」= 往这轮对话里加内容：附件 + 引用邮件（原独立 @ 钮）。 */}
              <ComposerPlusMenu variant="icon" mention />
              {/* 08-05 WP-13 — 滑块 = 配置这轮能用哪些外部能力（外部连接 / 技能 / 去 AI 设置）。 */}
              <ComposerToolsMenu variant="icon" />
              {/* 07-16 — owner-global 授权模式切换（Manual/Accept Edits/Bypass；backend 持久化，
                双 composer + 远程 web 同组件）。08-05 owner 拍板：保留为独立控件，不并进滑块。 */}
              <ApprovalModePicker variant="icon" />
            </>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {/* WP-15 — 上下文占用（环 / 中性药丸 / 不渲染，见 ContextUsageRing 文件头）。 */}
            <ContextUsageRing />
            {/* 08-05 WP-16b — effort 档位（取代 Brain 布尔）。controls.effort 缺席（旧测试 /
                只读线程）→ 整个不渲染，与引入前逐字一致。 */}
            {controls?.effort && <EffortPicker control={controls.effort} variant="icon" />}
            {/* 08-04 W8 — 两个 composer 共用的模型选择器（icon variant）。 */}
            {controls && <ModelPicker controls={controls} variant="icon" />}
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                aria-label={t('chat.composer.send', { defaultValue: 'Send' })}
                title={`${t('chat.composer.send', { defaultValue: 'Send' })} (⌘↩)`}
                // P1-2 — an approval decide holds the session's run lease; sending would 409.
                disabled={sendDisabled}
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                  'bg-[rgb(var(--c-accent))] text-[rgb(var(--c-accent-fg))]',
                  'transition-opacity duration-fast hover:opacity-90 disabled:opacity-40'
                )}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                aria-label={t('chat.composer.cancel', { defaultValue: 'Stop' })}
                title={t('chat.composer.cancel', { defaultValue: 'Stop' })}
                className={cn(
                  'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                  'bg-ink-4 text-ink-fg-1',
                  'transition-colors duration-fast hover:bg-[rgb(var(--c-accent))] hover:text-[rgb(var(--c-accent-fg))]'
                )}
              >
                <X size={15} strokeWidth={2.5} />
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </div>
        </div>
      </ComposerFrame>
    </ComposerPrimitive.Root>
  )
}
