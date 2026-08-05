// 08-04 WP6 — composer 的「+」菜单，**两个 composer 共用一个组件**（owner 拍板「两面统一」）。
//
// 收编的前身（都已删除，不留双轨）：
//   - agent 面 `AgentComposer.AgentAttachmentButton` —— 「+」图标但点了**直接**弹文件选择器，
//     图标承诺的是「加点什么」，行为却只有一种，用户按图标去找外部连接必然扑空；
//   - 邮件面 `composer.ComposerAttachmentButton`（Paperclip）+ 平铺的 `ConnectorQuickPanel`
//     圆钮/方钮 —— 两面对同一件事给了两种入口形态。
// 现在两面都是同一颗「+」：一级菜单「附件 / 外部连接」，外部连接点进去是二级弹层（复用
// `ConnectorQuickContent`，内容逐字未动）。菜单**恒在**（哪怕只剩附件一项）—— 它是「加东西」
// 的固定落点，未来新增的入口往里加，不再往工具条上挤第 N 个钮。
//
// 双 variant 分工抄 ModelPicker / ApprovalModePicker 的先例：
//   'icon' = 邮件面 7×7 方角图标钮 · 'chip' = agent 面 7×7 圆钮。
//
// 布局红线（PRD，邮件面板 360px）：「+」是左组第 2 个控件，x = 12(px-3) + 28 + 4(gap-1) = 44。
//   一级菜单 left-0 + w-[196px] → 右缘 240 ≤ 348 ✓
//   二级弹层 left-0 + w-[268px] → 右缘 312 ≤ 348 ✓
// （这里**不能**抄 ConnectorQuickPanel 旧版的居中锚定：居中会让 268px 弹层的左缘落到
//  44 + 14 - 134 = -76，改成顶出左边界。锚定方式跟着触发器在行里的位置走，没有普适答案。）
//
// A2 语义迁移（原「入口常驻强调色」）：外部连接的常驻信号从「整枚圆钮染 coral」降级成「+」
// 右上角一颗 coral 小点 —— 「+」现在还管附件，把整颗按钮染成强调色会谎报「附件也是激活态」。
// 判据一个字没变：至少一个 connected 且 enabled 的 connector（`useConnectorQuickRows`）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Blocks, ChevronLeft, Paperclip, Plus } from 'lucide-react'
import { useAui } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useConnectorQuickRows } from '@shared/hooks/useConnectorQuickRows'

import { ConnectorQuickContent } from './ConnectorQuickPanel'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

const MENU_ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg'

const POPOVER_SHELL =
  'absolute bottom-full left-0 z-50 mb-1.5 rounded-[var(--r-ctl)] py-1 glass-pop shadow-[0_4px_12px_rgba(0,0,0,0.35)]'

export function ComposerPlusMenu({ variant }: { variant: 'icon' | 'chip' }): React.JSX.Element {
  const { t } = useTranslation()
  const aui = useAui()
  const [open, setOpen] = React.useState(false)
  // 二级视图：'root' = 菜单本体，'connectors' = 外部连接面板（同一锚点上换内容，360px 面板里
  // 放不下并排的两层弹层，且并排会让「点外关闭」的边界含糊）。
  const [view, setView] = React.useState<'root' | 'connectors'>('root')
  const ref = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const connectors = useConnectorQuickRows()

  const close = React.useCallback((): void => {
    setOpen(false)
    setView('root')
  }, [])

  // 🔴 关闭**一律**走 close()，包括再点一次触发器 —— 裸 `setOpen(v => !v)` 会把 view 留在
  // 'connectors'，下次点「+」直接弹出二级面板（用户看到的是「这颗钮有时候不是菜单」）。
  const toggle = React.useCallback((): void => {
    if (open) close()
    else setOpen(true)
  }, [open, close])

  React.useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    // Escape 收整个弹层（两级都收）；回上一级走面板里的「返回」钮 —— 兄弟 picker 全是
    // 「Escape = 关」，在这里独创「Escape = 回上一级」只会让肌肉记忆落空。
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
  const connectorsLabel = t('chat.connectors.label')
  const tipText = connectors.anyActive ? `${label} · ${t('chat.connectors.activeHint')}` : label

  const triggerBody = (
    <>
      {/* 尺寸跟各自工具条的既有档：邮件面 13（与 @ / Brain / 厂商图标同档）、agent 面 17
          （与被它取代的旧「+」圆钮同档，视觉不跳）。 */}
      <Plus size={variant === 'icon' ? 13 : 17} strokeWidth={2} />
      {/* A2：外部连接已启用的常驻信号 —— 克制到一颗点，不抢「+」本身的语义。 */}
      {connectors.anyActive && (
        <span
          aria-hidden="true"
          data-testid="plus-connector-dot"
          className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-coral/100"
        />
      )}
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
      <HoverTip text={tipText} side="top">
        {trigger}
      </HoverTip>
      {open && view === 'root' && (
        <div role="menu" aria-label={label} className={cn(POPOVER_SHELL, 'w-[196px]')}>
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
          {connectors.available && (
            <button
              type="button"
              role="menuitem"
              aria-haspopup="dialog"
              onClick={() => setView('connectors')}
              className={MENU_ITEM}
            >
              <Blocks size={13} strokeWidth={2} className="shrink-0 text-ink-fg-3" />
              <span className="truncate">{connectorsLabel}</span>
              {connectors.anyActive && (
                <span
                  aria-hidden="true"
                  className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-coral/100"
                />
              )}
            </button>
          )}
        </div>
      )}
      {open && view === 'connectors' && (
        <div role="dialog" aria-label={connectorsLabel} className={cn(POPOVER_SHELL, 'w-[268px]')}>
          {/* 二级标题条：返回 + 标题。下边框与底部审批提示的 border-t 同一档，
              让「头 / 行 / 提示」三段读起来是同一套分节。 */}
          <div className="mb-1 flex items-center gap-1 border-b border-ink-border-soft px-1.5 pb-1">
            <button
              type="button"
              onClick={() => setView('root')}
              aria-label={t('chat.composer.back')}
              className="grid size-5 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
            >
              <ChevronLeft size={13} strokeWidth={2} />
            </button>
            <span className="truncate text-meta font-medium text-ink-fg-1">{connectorsLabel}</span>
          </div>
          <ConnectorQuickContent rows={connectors.rows} onClose={close} />
        </div>
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
