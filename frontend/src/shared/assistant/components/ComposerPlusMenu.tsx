// 08-04 WP6 — composer 的「+」菜单，**两个 composer 共用一个组件**（owner 拍板「两面统一」）。
//
// 收编的前身（都已删除，不留双轨）：
//   - agent 面 `AgentComposer.AgentAttachmentButton` —— 「+」图标但点了**直接**弹文件选择器，
//     图标承诺的是「加点什么」，行为却只有一种，用户按图标去找外部连接必然扑空；
//   - 邮件面 `composer.ComposerAttachmentButton`（Paperclip）+ 平铺的 `ConnectorQuickPanel`
//     圆钮/方钮 —— 两面对同一件事给了两种入口形态；
//   - 08-05 WP-13/16b 起还收编了邮件面工具条上那颗独立的 `@`（AtSign）钮。
// 菜单**恒在**（哪怕只剩附件一项）—— 它是「加东西进这轮对话」的固定落点。
//
// 🔴 08-05 WP-13：**外部连接搬走了**，去了新的滑块菜单 `ComposerToolsMenu`。分工从此是
// 「`+` = 往这轮对话里加内容（附件 / 引用邮件）」 vs 「滑块 = 配置这轮对话能用哪些外部能力
// （connector / skill）」。连同那颗 coral 常驻点一起搬（点表达的是「外部连接接着东西」）。
//
// 双 variant 分工抄 ModelPicker / ApprovalModePicker 的先例：
//   'icon' = 邮件面 7×7 方角图标钮 · 'chip' = agent 面 7×7 圆钮。
//
// 布局红线：WP-13 之后「+」是左组**第 1 个**控件（左组 = + / 滑块 / 授权模式），
//   x = 12(px-3)；一级菜单 left-0 + w-[196px] → 右缘 208，320px 窄面（可视右缘 308）也不越界。
//   引用邮件弹层（MentionPopover，left-2 + 280px）→ 右缘 300 ≤ 308 ✓。
//
// 🔴 `mention` 是**可选**能力，只有邮件面给：agent 面的 @ 是 Lexical 的**行内** directive chip，
// 且它有一条「chip 被删就把对应 mention 从 controls 里摘掉」的对账 effect（AgentComposer 的
// 隐私护栏）。从菜单里走 MentionPopover 加进去的 mention 在正文里没有 chip，会被那条对账当场
// 删掉 —— 于是「点了没反应」。所以这一项不能无条件出现，两面语义本来就不同。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign, Paperclip, Plus } from 'lucide-react'
import { useAui } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { MentionPopover } from '@shared/components/chat/MentionPopover'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'

import { useChatComposerControls } from './composerControlsContext'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg'

// 阴影由 `.glass-pop` 自带的 `--pop-shadow` 提供 —— 这里**不能**再挂 `shadow-[…]`：
// authored 的 `.glass-pop` 排在 `@tailwind utilities` **之后**，同特异度下源码序后者胜，
// 挂了也是死类（editor-suggest.tsx:30 早把这条层叠规则写在案）。
const POPOVER_SHELL = 'absolute bottom-full z-50 mb-1.5 rounded-[var(--r-ctl)] py-1 glass-pop'

export function ComposerPlusMenu({
  variant,
  mention = false
}: {
  variant: 'icon' | 'chip'
  /** 出不出「引用邮件」项（→ MentionPopover）。默认 false，见文件头最后一段。 */
  mention?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const controls = useChatComposerControls()
  const [open, setOpen] = React.useState(false)
  // 「引用邮件」弹层的开关。与菜单互斥：点菜单项 = 收菜单 + 开弹层（两层同锚点叠着只会互相遮）。
  const [mentionOpen, setMentionOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 出入场（WP-03）：弹层锚在 composer 上方（bottom-full 向上展开），配方与同一条工具条上的
  // MentionPopover 逐字同款 —— transformOrigin 'bottom left'（left-0 锚定）。
  // scopeRef 挂在**弹层本体**上；外层 `ref` 仍是 outside-click 的容器（它含触发器，不能合并）。
  const { shouldRender, scopeRef: popRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom left' },
    enterDuration: DUR.fast
  })

  const close = React.useCallback((): void => {
    setOpen(false)
  }, [])

  const toggle = React.useCallback((): void => {
    if (open) {
      close()
    } else {
      setMentionOpen(false)
      setOpen(true)
    }
  }, [open, close])

  React.useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // issue #61 Lane 3 (A2) 的附件通路原样保留：选中的文件走 composer.addAttachment →
  // MailAgent AttachmentAdapter（图片 → 有界 file part；文本/二进制 → panel injectedContext），
  // 与 paste / drop 同一条管线。失败 toast 由 adapter 负责，这里吞掉重抛以免一个坏文件卡住其余。
  const onPick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      await aui
        .composer()
        .addAttachment(file)
        .catch(() => {
          /* adapter add() already toasted */
        })
    }
  }

  const label = t('chat.composer.plus')
  const mentionLabel = t('chat.mention.title')

  const triggerBody = (
    <>
      {/* 尺寸跟各自工具条的既有档：邮件面 13（与厂商图标同档）、agent 面 17（与被它取代的
          旧「+」圆钮同档，视觉不跳）。 */}
      <Plus size={variant === 'icon' ? 13 : 17} strokeWidth={2} />
    </>
  )

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          ICON_BTN,
          'relative',
          open
            ? 'bg-coral/10 text-coral active:scale-[0.96]'
            : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
        )}
      >
        {triggerBody}
      </button>
    ) : (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'relative grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-fast',
          open ? 'bg-coral/10 text-coral' : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
        )}
      >
        {triggerBody}
      </button>
    )

  return (
    <div className="relative" ref={ref}>
      <HoverTip text={label} side="top">
        {trigger}
      </HoverTip>
      {shouldRender && (
        <div
          ref={popRef}
          role="menu"
          aria-label={label}
          className={cn(POPOVER_SHELL, 'left-0 w-[196px]')}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // 先收菜单再拉文件选择器：input 挂在 wrapper 上（不在菜单里），关掉不影响它。
              close()
              inputRef.current?.click()
            }}
            className={MENU_ITEM}
          >
            <Paperclip size={13} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
            <span className="truncate">{t('chat.attachment.add')}</span>
          </button>
          {mention && controls && (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              onClick={() => {
                close()
                setMentionOpen(true)
              }}
              className={MENU_ITEM}
            >
              <AtSign size={13} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
              <span className="truncate">{mentionLabel}</span>
            </button>
          )}
        </div>
      )}
      {/* 引用邮件（原工具条上那颗独立 @ 钮的去处）：同一颗「+」上换出来的第二个弹层。
          它自带 outside-click / Escape / 搜索，锚定 left-2 —— 「+」现在是左组第一个控件
          （x=12），所以 280px 弹层右缘 300，320px 窄面也不越界。 */}
      {mention && controls && (
        <MentionPopover
          open={mentionOpen}
          onClose={() => setMentionOpen(false)}
          onSelect={(hit) => {
            controls.onAddMention(hit)
            setMentionOpen(false)
          }}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void onPick(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
