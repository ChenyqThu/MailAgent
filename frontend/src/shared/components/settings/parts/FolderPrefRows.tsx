// per-folder 配置 (v62, `folder_pref` 表) — 「已同步文件夹」列表的行部件。
//
// 一行同时承载：拖拽手柄（DragReorderList 的壳给）· 图标（点开可换）· 文件夹名
// （hover 露 imap 原始名）· 通知开关 · AI 分类开关 · 序号。列宽常量被列头、拖拽行、
// 内建行三处共用，三段才竖着对齐。
//
// 🔴 两个开关的极性不是按直觉设计的，是从后端两个 gate 读出来的：
//   · `FOLDER_NOTIFY_ENABLED` 是**白名单** —— 自定义文件夹默认**不**通知，进名单才通知。
//     ⇒「通知」开关缺省 = 关，落库列 `notify_enabled` 与它**同向**。
//   · `FOLDER_LLM_DISABLED` 是**黑名单** —— 自定义文件夹默认**跑** LLM，进名单才跳过。
//     ⇒「AI 分类」开关缺省 = 开，落库列 `llm_disabled` 与它**反向**（翻译在前端做，
//     端点收发的都是列的原义）。
//   · 两个 gate 都先判 `is_custom_folder_mailbox()`，标准邮箱直接 return False
//     ⇒ 内建 5 行**不受**这两个开关约束，所以那 5 行的开关位画的是「—」不是「关」——
//     画成可关的开关，界面说的就跟实际行为反了。
//   🔴 但「存档」**不算**标准邮箱（`mailbox_semantics.STANDARD_MAILBOXES` 有意不含它），
//     所以它在「已同步文件夹」那段、拿真开关，不在内建段。
//
// 内建 5 行的图标读 `icons/mailboxIcons.ts` 的单源（侧边栏同一份），**不开放自定义**、
// 也不进 `folder_pref`。

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, Lock, RotateCcw } from 'lucide-react'

import {
  AnimatedIconActiveProvider,
  FOLDER_ICON_KEYS,
  FolderGlyph,
  MAILBOX_ICON_COMPONENT,
  type FolderIconKey
} from '@shared/components/icons'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { Switch } from '@shared/components/ui/switch'
import { cn } from '@shared/lib/cn'
import type { EmailView } from '@shared/state/email-filter'

/* ── 列宽 —— 列头、拖拽行、内建行共用这一份 ──────────────────────────────── */

/** DragReorderList 壳的左侧占位：`pl-2`(8) + grip `w-9`(36) + `gap-2.5`(10)。 */
const GRIP_GUTTER = 54
/** Switch 原尺寸 32px + 两侧各 4px 余量。 */
const COL_TOGGLE = 'w-[40px]'
const COL_INDEX = 'w-4'
const COL_ICON = 'w-7'

type PrefToggleKind = 'notify' | 'ai'

/* ── 单个开关 ────────────────────────────────────────────────────────────── */

export function PrefToggle({
  kind,
  on,
  folderName,
  globalOff,
  disabled,
  onChange
}: {
  kind: PrefToggleKind
  on: boolean
  folderName: string
  /** 对应总闸（FEISHU_NOTIFY_ENABLED / LLM_AGENT_ENABLED）关着 —— 这一列当前不生效。 */
  globalOff: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const state = t(`settings.folder.picker.pref.${kind}.${on ? 'on' : 'off'}`)
  const tip = globalOff
    ? t(`settings.folder.picker.pref.${kind}.globalOff`)
    : t('settings.folder.picker.pref.rowTip', { name: folderName, state })

  return (
    <HoverTip text={tip} className={cn(COL_TOGGLE, 'shrink-0 justify-center')}>
      {/* 行上 pointerdown 会起拖；开关自己吃掉，点开关不会误拖。 */}
      <span
        onPointerDown={(e) => e.stopPropagation()}
        className={globalOff ? 'opacity-45' : undefined}
      >
        <Switch
          checked={on}
          disabled={disabled}
          onCheckedChange={onChange}
          aria-label={`${folderName} ${t(`settings.folder.picker.pref.${kind}.head`)}`}
        />
      </span>
    </HoverTip>
  )
}

/** 内建行的开关位 —— 不是「关」，是「这两个 gate 根本不看它」。 */
function PrefNotApplicable({ kind }: { kind: PrefToggleKind }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <HoverTip
      text={t(`settings.folder.picker.pref.${kind}.notApplicable`)}
      className={cn(COL_TOGGLE, 'shrink-0 justify-center')}
    >
      <span
        className="grid h-[26px] w-[32px] place-items-center text-meta text-ink-fg-3"
        aria-label={t('settings.folder.picker.pref.notApplicable')}
      >
        —
      </span>
    </HoverTip>
  )
}

/* ── 列头 —— 结构与行逐字同构，靠同一套列宽对齐 ──────────────────────────── */

export function PrefColumnHeader({
  globalNotify,
  globalAi
}: {
  globalNotify: boolean
  globalAi: boolean
}): React.ReactElement {
  const { t } = useTranslation()

  const head = (kind: PrefToggleKind, globalOn: boolean): React.ReactElement => (
    <HoverTip
      text={
        globalOn
          ? t(`settings.folder.picker.pref.${kind}.headTip`)
          : t(`settings.folder.picker.pref.${kind}.globalOff`)
      }
      className={cn(COL_TOGGLE, 'shrink-0 justify-center')}
    >
      <span
        className={cn(
          'text-meta',
          globalOn ? 'text-ink-fg-2' : 'text-ink-fg-3 line-through decoration-ink-fg-3/60'
        )}
      >
        {t(`settings.folder.picker.pref.${kind}.head`)}
      </span>
    </HoverTip>
  )

  return (
    <div
      className="flex items-center gap-2.5 pb-1 pr-3 text-meta text-ink-fg-3"
      style={{ paddingLeft: GRIP_GUTTER }}
      aria-hidden="true"
    >
      <span className="min-w-0 flex-1">{t('settings.folder.picker.pref.columnName')}</span>
      {head('notify', globalNotify)}
      {head('ai', globalAi)}
      <span className={cn(COL_INDEX, 'shrink-0')} />
    </div>
  )
}

/* ── 行内当前图标按钮 + 图标选择器 ───────────────────────────────────────── */

export interface IconPickerAnchor {
  /** = imap_name，`folder_pref` 的主键。 */
  key: string
  displayName: string
  rect: DOMRect
}

export function FolderIconButton({
  icon,
  name,
  open,
  onOpen
}: {
  icon: string | null
  name: string
  open: boolean
  onOpen: (e: React.MouseEvent<HTMLButtonElement>) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [hover, setHover] = React.useState(false)
  return (
    <HoverTip text={t('settings.folder.picker.icon.change')} className={cn(COL_ICON, 'shrink-0')}>
      <button
        type="button"
        aria-label={t('settings.folder.picker.icon.changeFor', { name })}
        aria-haspopup="dialog"
        aria-expanded={open}
        // 行上 pointerdown 会起拖；按钮自己吃掉，点图标不会误拖。
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpen}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className={cn(
          'grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-ctl)] border transition-colors duration-fast',
          open
            ? 'border-coral/45 bg-coral/15 text-ink-fg'
            : 'border-ink-border bg-ink-1 text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
        )}
      >
        <FolderGlyph iconKey={icon} size={15} strokeWidth={1.75} active={hover || open} />
      </button>
    </HoverTip>
  )
}

/** 24 格网格，一眼扫完；hover 任一格即播它自己的动效（选之前就看得见它怎么动）。
 *
 *  🔴 `position: fixed` + portal 到 body —— **不能**放进拖拽行里：行上有 motion 的
 *  transform，fixed 会退化成相对该行定位，弹层跟着拖拽跑。 */
export function FolderIconPicker({
  anchor,
  value,
  onPick,
  onReset,
  onClose
}: {
  anchor: IconPickerAnchor
  value: string | null
  onPick: (key: FolderIconKey) => void
  onReset: () => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const boxRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ top: number; left: number }>({
    top: anchor.rect.bottom + 6,
    left: anchor.rect.left
  })
  const [hover, setHover] = React.useState<FolderIconKey | null>(null)

  // 贴按钮左下角展开；右侧/底部越界时回拉进视口。
  React.useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const w = box.offsetWidth
    const h = box.offsetHeight
    let left = anchor.rect.left
    let top = anchor.rect.bottom + 6
    if (left + w > window.innerWidth - 12) left = window.innerWidth - 12 - w
    if (top + h > window.innerHeight - 12) top = Math.max(12, anchor.rect.top - 6 - h)
    setPos({ top, left })
  }, [anchor])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = hover ?? value

  return createPortal(
    <>
      <div className="fixed inset-0 z-[90]" aria-hidden="true" onClick={onClose} />
      <div
        ref={boxRef}
        role="dialog"
        aria-label={t('settings.folder.picker.icon.dialogLabel', { name: anchor.displayName })}
        style={{ top: pos.top, left: pos.left }}
        className="glass-pop fixed z-[95] w-[280px] rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-2.5"
      >
        <div className="mb-2 flex items-baseline gap-2 px-0.5">
          <span className="text-meta font-medium text-ink-fg">
            {t('settings.folder.picker.icon.title')}
          </span>
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
            {anchor.displayName}
          </span>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-meta text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <RotateCcw size={11} strokeWidth={2} aria-hidden="true" />
            {t('settings.folder.picker.icon.reset')}
          </button>
        </div>

        <div
          className="grid grid-cols-6 gap-1"
          role="listbox"
          aria-label={t('settings.folder.picker.icon.listLabel')}
        >
          {FOLDER_ICON_KEYS.map((key) => {
            const selected = value === key
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`${key} · ${t(`settings.folder.picker.icon.motion.${key}`)}`}
                onMouseEnter={() => setHover(key)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(key)}
                onBlur={() => setHover(null)}
                onClick={() => onPick(key)}
                className={cn(
                  'relative grid h-[40px] place-items-center rounded-[var(--r-ctl)] transition-colors duration-fast',
                  selected
                    ? 'bg-coral/15 text-ink-fg ring-1 ring-coral/45'
                    : 'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg'
                )}
              >
                {/* hover 即播自己的动效 —— 选之前就能看清它动起来什么样。 */}
                <FolderGlyph iconKey={key} size={18} strokeWidth={1.75} active={hover === key} />
                {selected ? (
                  <Check
                    size={9}
                    strokeWidth={3}
                    className="absolute right-1 top-1 text-coral"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            )
          })}
        </div>

        {/* 落库存的就是左边这个 key，右边是它的动效说明。 */}
        <div className="mt-2 flex items-baseline gap-2 px-0.5">
          <span className="shrink-0 font-mono text-meta text-ink-fg-2">{shown ?? 'folder'}</span>
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
            {shown
              ? t(`settings.folder.picker.icon.motion.${shown}`)
              : t('settings.folder.picker.icon.unset')}
          </span>
        </div>
      </div>
    </>,
    document.body
  )
}

/* ── 行内的名字块 / 序号 ─────────────────────────────────────────────────── */

/** 常态只显示显示名，hover 才淡出 imap 原始名（不占额外行高、不抖）。 */
export function PrefRowName({
  label,
  imapName,
  badge
}: {
  label: string
  imapName: string
  /** 可选小标记（目前只有「存档」用，标它是 canonical mailbox 名）。 */
  badge?: React.ReactNode
}): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 truncate text-body text-ink-fg">{label}</span>
      {badge}
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink-fg-3 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100">
        {imapName}
      </span>
    </span>
  )
}

export function PrefRowIndex({ index }: { index: number }): React.ReactElement {
  return (
    <span
      className={cn(COL_INDEX, 'shrink-0 text-right text-meta tabular-nums text-ink-fg-3')}
      aria-hidden="true"
    >
      {index + 1}
    </span>
  )
}

/* ── 内建邮箱行 —— 不可拖、不可移除、图标不可换 ──────────────────────────── */

/** 侧边栏 MAILBOXES 段的 5 个内建入口，顺序与 Sidebar.tsx 逐行同构。
 *  🔴「存档」**不在**这份表里：后端把它当自定义文件夹（见文件头）。 */
const BUILTIN_VIEWS: readonly { view: EmailView; labelKey: string }[] = [
  { view: 'inbox', labelKey: 'nav.inbox' },
  { view: 'outbox', labelKey: 'nav.outbox' },
  { view: 'drafts', labelKey: 'nav.drafts' },
  { view: 'flagged', labelKey: 'nav.flagged' },
  { view: 'all', labelKey: 'nav.allMail' }
]

/** 内建邮箱的一行 —— 与拖拽行同一套内边距/列宽，两段列才竖着对齐。
 *  整行 hover 驱动图标动效（和 Sidebar.NavRow 同一个 Context 通道）。 */
function BuiltinPrefRow({
  view,
  labelKey
}: {
  view: EmailView
  labelKey: string
}): React.ReactElement {
  const { t } = useTranslation()
  const [hover, setHover] = React.useState(false)
  const Icon = MAILBOX_ICON_COMPONENT[view]
  return (
    <li
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="group/row flex items-center gap-2.5 rounded-xl py-2 pl-2 pr-3 transition-colors duration-fast hover:bg-ink-2"
    >
      <HoverTip text={t('settings.folder.picker.pref.builtinLockTip')} className="shrink-0">
        <span className="grid h-7 w-9 place-items-center text-ink-fg-3">
          <Lock size={13} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </HoverTip>
      <HoverTip
        text={t('settings.folder.picker.pref.builtinIconTip')}
        className={cn(COL_ICON, 'shrink-0')}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center text-ink-fg-1">
          <AnimatedIconActiveProvider active={hover}>
            <Icon size={15} strokeWidth={1.75} trigger="parent" />
          </AnimatedIconActiveProvider>
        </span>
      </HoverTip>
      <span className="min-w-0 flex-1 truncate text-body text-ink-fg">{t(labelKey)}</span>
      <PrefNotApplicable kind="notify" />
      <PrefNotApplicable kind="ai" />
      <span className={cn(COL_INDEX, 'shrink-0')} aria-hidden="true" />
    </li>
  )
}

export function BuiltinPrefRows(): React.ReactElement {
  return (
    <ul className="space-y-px">
      {BUILTIN_VIEWS.map((row) => (
        <BuiltinPrefRow key={row.view} view={row.view} labelKey={row.labelKey} />
      ))}
    </ul>
  )
}
