// Compose rich-text editor — TipTap v3 + classic 分组格式工具栏（epic T2）。
//
// 工具栏分组（对齐 design/editor.jsx 的 classic Toolbar）：
//   [正文/H1-3 下拉][字体][字号] | [B I U S][文字颜色][高亮] | [列表×2][引用][代码块]
//   | [链接][行内代码][图片][分割线][@] … [撤销][重做]
// 弹层：颜色/高亮 = 设计稿 swatch 色板（radix Popover, glass-pop）；链接/图片 =
// 内联输入框（Electron renderer 禁 window.prompt）。
//
// 兼容纪律（契约 D4）：ComposeEditor / ComposeFormatToolbar 导出名与 props 不变，
// ComposePanel 未切新装配（editor-extensions.ts 的 buildComposeExtensions）前也可
// 正常工作 —— 高亮按钮在无 Highlight 扩展的旧装配上回退 textStyle backgroundColor。
// The parent owns the Editor instance (so it can read getHTML() on send/save).

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, useEditorState, type Editor } from '@tiptap/react'
import {
  ALargeSmall,
  AlignVerticalSpaceAround,
  AtSign,
  Ban,
  Baseline,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  Check,
  ChevronDown,
  Code,
  Columns3,
  Highlighter,
  ImagePlus,
  ImageUp,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  PanelTop,
  Pilcrow,
  Redo2,
  Rows3,
  SquareCode,
  Strikethrough,
  Table2,
  TableCellsMerge,
  TableCellsSplit,
  TextQuote,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  Unlink
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { toastError } from '@shared/state/toast'
import { useAppearance } from '@shared/state/appearance'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import { MAX_INLINE_IMAGE_BYTES } from './editor-extensions'

function FmtBtn({
  icon,
  label,
  active,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    // 提示走 HoverTip 而不是原生 title= —— Electron `hiddenInset` 下 OS tooltip
    // 有的面根本不触发、有的延迟到没用（HoverTip.tsx 头注释），这正是 dogfood
    // 「hover 也没说明」的根因。portal 模式让提示不被 ComposePanel 根节点的
    // overflow-hidden 裁掉（工具栏最右侧的撤销/重做尤其明显）。
    <HoverTip text={label} portal>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        // onMouseDown preventDefault keeps the editor selection from being
        // stolen by the toolbar button focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn(
          'folder-editor-btn',
          active && 'is-on',
          disabled && 'opacity-40 pointer-events-none'
        )}
      >
        {icon}
      </button>
    </HoverTip>
  )
}

/** 分组分隔线。 */
function FmtSep(): React.ReactElement {
  return <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />
}

// Outlook 式预设色板（dogfood 反馈: 原设计稿 6 色太少）—— 内容色常量，非 UI
// token（写进邮件正文 inline style 的颜色值）。6 hue 列 × 浅→深 4 行 + 末行
// 中性色（清除格 + 灰阶）。
/* eslint-disable mailagent/no-raw-hex -- swatch 色板是邮件内容色常量（随正文发出），非 theme token。 */
const TEXT_COLORS: readonly string[] = [
  // 蓝        绿        黄        橙        红        紫  (浅 → 深)
  '#4DA6F0',
  '#5EC26A',
  '#F2D440',
  '#F2913D',
  '#EE6B60',
  '#B76BE0',
  '#1667C2',
  '#188A3C',
  '#D4B016',
  '#DB6B10',
  '#CC2F24',
  '#8833B8',
  '#10498C',
  '#0F6129',
  '#9C8010',
  '#A34F0C',
  '#941F17',
  '#622585',
  '#0A2B57',
  '#093D1B',
  '#6B570B',
  '#6E3508',
  '#611410',
  '#3F1857'
]
/** 末行中性色（首格是「清除」，随后 5 格）。 */
const TEXT_NEUTRALS: readonly string[] = ['#D9D9D9', '#A6A6A6', '#737373', '#404040', '#000000']
const HL_COLORS: readonly string[] = [
  // 黄        绿        蓝        粉        橙        青  (淡 → 艳)
  '#FCE7A2',
  '#C6EBCB',
  '#C9E0FB',
  '#F7CFE0',
  '#FBDCB6',
  '#C9EFEF',
  '#F8D866',
  '#9FDCAA',
  '#9CC7F7',
  '#F2A8C8',
  '#F7BE7E',
  '#9FE3E3',
  '#F5E342',
  '#6FD383',
  '#6FAEF2',
  '#EE7FB2',
  '#F5A44A',
  '#5ED3D3'
]
const HL_NEUTRALS: readonly string[] = ['#FFFFFF', '#EBEBEB', '#D6D6D6', '#BFBFBF', '#A8A8A8']
const DEFAULT_CUSTOM_COLOR = '#000000'
/* eslint-enable mailagent/no-raw-hex */

/** swatch 色板按钮：6 列网格（hue 列 × 浅→深行）+ 末行「清除」格 + 中性色；
 *  「更多颜色」触发原生取色器。取色 input 挂在 Popover 外 —— 系统取色面板
 *  打开会让 popover 关闭, input 若在 PopoverContent 里会随之卸载, onChange
 *  永远收不到（dogfood「更多颜色点击没反应」的根因）。 */
function SwatchPopoverButton({
  icon,
  title,
  colors,
  neutrals,
  current,
  onPick,
  clearTitle,
  moreLabel
}: {
  icon: React.ReactNode
  title: string
  /** 主网格色板（6 的倍数, 按 hue 列排布）。 */
  colors: readonly string[]
  /** 末行中性色（跟在「清除」格后, ≤5 个）。 */
  neutrals: readonly string[]
  /** 当前应用色（'' = 未设置）。 */
  current: string
  /** null = 清除。 */
  onPick: (color: string | null) => void
  clearTitle: string
  moreLabel: string
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const moreInputRef = useRef<HTMLInputElement>(null)
  const pick = (c: string | null): void => {
    onPick(c)
    setOpen(false)
  }
  const swatch = (c: string): React.ReactElement => (
    <button
      key={c}
      type="button"
      title={c}
      aria-label={c}
      onClick={() => pick(c)}
      className={cn(
        'size-5 rounded-full border transition-transform duration-fast hover:scale-110',
        current.toLowerCase() === c.toLowerCase()
          ? 'border-coral ring-1 ring-coral'
          : 'border-ink-border/40'
      )}
      style={{ background: c }}
    />
  )
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <HoverTip text={title} portal>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={title}
              onMouseDown={(e) => e.preventDefault()}
              className={cn('folder-editor-btn', current && 'is-on')}
            >
              {icon}
            </button>
          </PopoverTrigger>
        </HoverTip>
        <PopoverContent
          align="start"
          sideOffset={6}
          onMouseDown={(e) => e.preventDefault()}
          className="w-auto p-2"
        >
          <div className="grid grid-cols-6 gap-1.5">
            {colors.map(swatch)}
            <button
              type="button"
              title={clearTitle}
              aria-label={clearTitle}
              onClick={() => pick(null)}
              className="size-5 rounded-full border border-ink-border/60 grid place-items-center text-ink-fg-3 transition-transform duration-fast hover:scale-110"
            >
              <Ban size={13} strokeWidth={1.8} />
            </button>
            {neutrals.map(swatch)}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              moreInputRef.current?.click()
            }}
            className="mt-2 flex w-full cursor-pointer items-center justify-center rounded-md border border-ink-border/60 py-1 text-meta text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3"
          >
            {moreLabel}
          </button>
        </PopoverContent>
      </Popover>
      {/* 原生取色器载体 — 常驻挂载 (见组件头注释), sr-only 不可见但可编程 click。 */}
      <input
        ref={moreInputRef}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        defaultValue={DEFAULT_CUSTOM_COLOR}
        className="sr-only"
        onChange={(e) => onPick(e.target.value)}
      />
    </>
  )
}

/** 下拉选项按钮: radix Popover 选项列表 (取代原生 <select> — 它的系统下拉在 Electron modal
 *  里关闭时会误关 backdrop, dogfood 反馈)。
 *
 *  按钮上恒显示「控件图标 + 当前生效值」—— dogfood 反馈「字体/字号/行距三个下拉全写
 *  『默认』，用户分不出哪个是哪个」：图标负责「这是什么控件」，文案负责「当前值是多少」
 *  (字号/行距在未显式设置时显示的是**实际生效的数值**而不是「默认」二字)。值来自默认
 *  设置时以 dim 前景色 + hover 提示补一行说明来表达「跟随默认」的继承语义。 */
function OptionPopoverButton({
  title,
  icon,
  currentLabel,
  inherited = false,
  options,
  value,
  onSelect
}: {
  title: string
  /** 控件标识图标 —— 四个下拉互不相同, 不点开也能分辨。 */
  icon: React.ReactNode
  currentLabel: string
  /** 当前值来自默认设置而非本封显式选择 (显示上 dim + hover 说明)。 */
  inherited?: boolean
  options: ReadonlyArray<{ value: string; label: string }>
  value: string
  onSelect: (value: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <HoverTip text={inherited ? `${title}\n${t('compose.editor.defaultHint')}` : title} portal>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={title}
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-7 max-w-[104px] items-center gap-1 rounded-md border border-ink-border/60 bg-ink-2/50 px-1.5 text-[11px] text-ink-fg-2 transition-colors duration-fast hover:bg-ink-2"
          >
            <span className="shrink-0 opacity-70">{icon}</span>
            <span className={cn('truncate', inherited && 'text-ink-fg-3')}>{currentLabel}</span>
            <ChevronDown size={12} strokeWidth={2} className="shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
      </HoverTip>
      <PopoverContent
        align="start"
        sideOffset={6}
        onMouseDown={(e) => e.preventDefault()}
        className="w-40 p-1"
        role="listbox"
        aria-label={title}
      >
        {options.map((o) => (
          <button
            key={o.value || 'default'}
            type="button"
            role="option"
            aria-selected={o.value === value}
            onClick={() => {
              onSelect(o.value)
              setOpen(false)
            }}
            className={cn(
              'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-aux transition-colors duration-fast hover:bg-ink-3',
              o.value === value ? 'text-coral' : 'text-ink-fg-1'
            )}
          >
            <span className="truncate">{o.label}</span>
            {o.value === value && <Check size={13} strokeWidth={2.5} className="shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** 内联输入弹框（链接/图片共用）— 浮在工具栏上方，Enter 应用 / Esc 关闭。 */
function InlineInputBox({
  value,
  placeholder,
  applyLabel,
  onChange,
  onApply,
  onClose,
  extra
}: {
  value: string
  placeholder: string
  applyLabel: string
  onChange: (v: string) => void
  onApply: () => void
  onClose: () => void
  extra?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="absolute bottom-full left-3 mb-1.5 z-20 flex items-center gap-1 rounded-lg border border-ink-border bg-ink-1 p-1.5 shadow-md">
      <input
        autoFocus
        type="url"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // stopPropagation: 否则 Esc/Enter 冒泡到 ComposePanel 的 window 级 keydown
          // (Escape 会关掉整个撰写框) —— codex review MEDIUM。
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            onApply()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        className="h-7 w-60 rounded-md bg-ink-2/60 border border-ink-border/60 px-2 text-xs text-ink-fg-1 focus:outline-none focus:border-accent/60"
      />
      <FmtBtn icon={<Check size={13} strokeWidth={2.5} />} label={applyLabel} onClick={onApply} />
      {extra}
    </div>
  )
}

const TABLE_GRID_SIZE = 8

function TableInsertPopover({ editor }: { editor: Editor }): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [hoveredSize, setHoveredSize] = useState({ rows: 2, cols: 2 })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <HoverTip text={t('compose.editor.tableInsert')} portal>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('compose.editor.table')}
            onMouseDown={(event) => event.preventDefault()}
            className="folder-editor-btn"
          >
            <Table2 size={13} strokeWidth={2} />
          </button>
        </PopoverTrigger>
      </HoverTip>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="glass-pop z-[70] w-[300px] rounded-[var(--r-pop)] border border-ink-border p-3"
      >
        <div className="text-meta font-mono uppercase tracking-wider text-ink-fg-2 mb-2">
          {t('compose.editor.tableInsert')}
        </div>
        <div
          className="grid grid-cols-8 gap-1"
          onMouseLeave={() => setHoveredSize({ rows: 2, cols: 2 })}
        >
          {Array.from({ length: TABLE_GRID_SIZE * TABLE_GRID_SIZE }, (_, index) => {
            const rows = Math.floor(index / TABLE_GRID_SIZE) + 1
            const cols = (index % TABLE_GRID_SIZE) + 1
            const selected = rows <= hoveredSize.rows && cols <= hoveredSize.cols
            const label = t('compose.editor.tableSize', { rows, cols })
            return (
              <button
                key={`${rows}-${cols}`}
                type="button"
                title={label}
                aria-label={label}
                onMouseEnter={() => setHoveredSize({ rows, cols })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  editor.chain().focus().insertTable({ rows, cols, withHeaderRow: false }).run()
                  setOpen(false)
                }}
                className={cn(
                  'h-6 rounded-[3px] border transition-colors duration-fast',
                  selected
                    ? 'border-coral/70 bg-coral/20'
                    : 'border-ink-border bg-ink-2 hover:border-coral/50'
                )}
              />
            )
          })}
        </div>
        <div className="mt-2 text-center text-meta font-mono text-ink-fg-2">
          {t('compose.editor.tableSize', hoveredSize)}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 光标落在表格里时的表格操作菜单。
 *
 *  dogfood 反馈「增加行/删除行根本分不出来，hover 也没说明」：原先是 10 个并排的
 *  纯图标按钮，其中 Rows3 复用了 3 次（上方插入/下方插入/删除行）、Columns3 复用了
 *  3 次，光看图标不可能分辨；再加上前面 20 个按钮，整条工具栏折行成一片灰疙瘩。
 *  改成单个「表格」下拉分组：每项**带文字标签**，"这个按钮干什么" 由文字直说，
 *  不再依赖 hover 才能猜；插入/单元格/删除三组分区，删除组走 fail 色。 */
function TableOpsPopover({
  editor,
  canMergeCells,
  canSplitCell
}: {
  editor: Editor
  canMergeCells: boolean
  canSplitCell: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const iconProps = { size: 13, strokeWidth: 2 } as const
  const groups: Array<{
    label: string
    danger?: boolean
    items: Array<{ label: string; icon: React.ReactNode; run: () => void; disabled?: boolean }>
  }> = [
    {
      label: t('compose.editor.tableGroupInsert'),
      items: [
        {
          label: t('compose.editor.tableRowBefore'),
          icon: <BetweenHorizontalStart {...iconProps} />,
          run: () => editor.chain().focus().addRowBefore().run()
        },
        {
          label: t('compose.editor.tableRowAfter'),
          icon: <BetweenHorizontalEnd {...iconProps} />,
          run: () => editor.chain().focus().addRowAfter().run()
        },
        {
          label: t('compose.editor.tableColumnBefore'),
          icon: <BetweenVerticalStart {...iconProps} />,
          run: () => editor.chain().focus().addColumnBefore().run()
        },
        {
          label: t('compose.editor.tableColumnAfter'),
          icon: <BetweenVerticalEnd {...iconProps} />,
          run: () => editor.chain().focus().addColumnAfter().run()
        }
      ]
    },
    {
      label: t('compose.editor.tableGroupCell'),
      items: [
        {
          label: t('compose.editor.tableHeaderRow'),
          icon: <PanelTop {...iconProps} />,
          run: () => editor.chain().focus().toggleHeaderRow().run()
        },
        {
          label: t('compose.editor.tableMergeCells'),
          icon: <TableCellsMerge {...iconProps} />,
          disabled: !canMergeCells,
          run: () => editor.chain().focus().mergeCells().run()
        },
        {
          label: t('compose.editor.tableSplitCell'),
          icon: <TableCellsSplit {...iconProps} />,
          disabled: !canSplitCell,
          run: () => editor.chain().focus().splitCell().run()
        }
      ]
    },
    {
      label: t('compose.editor.tableGroupDelete'),
      danger: true,
      items: [
        {
          label: t('compose.editor.tableDeleteRow'),
          icon: <Rows3 {...iconProps} />,
          run: () => editor.chain().focus().deleteRow().run()
        },
        {
          label: t('compose.editor.tableDeleteColumn'),
          icon: <Columns3 {...iconProps} />,
          run: () => editor.chain().focus().deleteColumn().run()
        },
        {
          label: t('compose.editor.tableDelete'),
          icon: <Trash2 {...iconProps} />,
          run: () => editor.chain().focus().deleteTable().run()
        }
      ]
    }
  ]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <HoverTip text={t('compose.editor.tableTools')} portal>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('compose.editor.tableTools')}
            onMouseDown={(event) => event.preventDefault()}
            className="flex h-7 items-center gap-1 rounded-md border border-ink-border/60 bg-ink-2/50 px-1.5 text-[11px] text-ink-fg-2 transition-colors duration-fast hover:bg-ink-2"
          >
            <Table2 size={13} strokeWidth={2} className="shrink-0 opacity-70" />
            <span className="truncate">{t('compose.editor.table')}</span>
            <ChevronDown size={12} strokeWidth={2} className="shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
      </HoverTip>
      <PopoverContent
        align="start"
        sideOffset={6}
        onMouseDown={(event) => event.preventDefault()}
        className="w-44 p-1"
      >
        {groups.map((group, index) => (
          <div
            key={group.label}
            className={index > 0 ? 'mt-1 border-t border-ink-border-soft pt-1' : undefined}
          >
            <div className="px-2 py-1 text-meta font-mono uppercase tracking-wider text-ink-fg-3">
              {group.label}
            </div>
            {group.items.map((item) => (
              <button
                key={item.label}
                type="button"
                aria-label={item.label}
                disabled={item.disabled}
                onClick={() => {
                  item.run()
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux transition-colors duration-fast',
                  item.disabled
                    ? 'pointer-events-none text-ink-fg-3 opacity-40'
                    : group.danger
                      ? 'text-fail hover:bg-fail/10'
                      : 'text-ink-fg-1 hover:bg-ink-3'
                )}
              >
                <span className="shrink-0 opacity-80">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

const HEADING_LEVELS = [1, 2, 3] as const

/** 行距档位 ('' = 跟随设置里的撰写行距默认, 语义同字号控件的「默认」)。整封级生效
 *  —— 不做段落级/选区级 (出站是整段 wrapper 一个 line-height, 段落级表达不了)。 */
const LINE_HEIGHTS = ['', '1.15', '1.3', '1.5', '1.75', '2.0'] as const

/** 撰写区默认字号 (px) —— `index.css` 的 `.folder-draft-editor .ProseMirror { font-size }`
 *  在 TS 侧的镜像：字号下拉未显式设置时要显示这个**实际生效**的数字，而不是「默认」二字。
 *  🔴 跨构件手抄 (CSS ↔ TS)，一致性闸见 tests/components/ComposeEditor.test.tsx
 *  「默认字号镜像 index.css」——改 CSS 忘了改这里会红。 */
export const COMPOSE_FONT_SIZE_DEFAULT_PX = 14

/** 行距数值 → 显示文案（去掉浮点尾巴：1.5 → "1.5"、1.15 → "1.15"）。 */
function formatLineHeight(value: number): string {
  return String(Math.round(value * 100) / 100)
}

export function ComposeFormatToolbar({
  editor,
  lineHeight = '',
  onLineHeightChange
}: {
  editor: Editor
  /** 本封的行距覆写 ('' = 跟随设置默认)。 */
  lineHeight?: string
  onLineHeightChange?: (value: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  // 链接/图片受控内联弹框 (window.prompt 在 Electron renderer 被禁用)。
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [imageOpen, setImageOpen] = useState(false)
  const [imageValue, setImageValue] = useState('')
  // 行距的「跟随默认」档要显示实际生效值 → 读设置里的撰写行距 (ComposePanel 同源)。
  const composeLineHeightDefault = useAppearance((s) => s.composeLineHeight)
  // 字体/字号选项 (value = CSS; '' = 清除回默认)。label 走 i18n。
  const fontFamilies: Array<{ key: string; value: string }> = [
    { key: 'fontFamilyDefault', value: '' },
    { key: 'fontSystem', value: 'system-ui, -apple-system, sans-serif' },
    { key: 'fontSerif', value: "Georgia, 'Times New Roman', serif" },
    { key: 'fontMono', value: "ui-monospace, 'SF Mono', monospace" }
  ]
  // 12-30px（design/editor.jsx FONT_SIZES），'' = 默认。
  const fontSizes = ['', '12px', '13px', '14px', '16px', '18px', '24px', '30px']
  // 兼容闸：旧装配（ComposePanel 未切 buildComposeExtensions 前）无 Highlight 扩展，
  // 高亮按钮回退 textStyle backgroundColor（#9 dogfood 旧行为），T5 切换后走真高亮 mark。
  const hasHighlight = editor.extensionManager.extensions.some((ext) => ext.name === 'highlight')
  const hasTable = editor.extensionManager.extensions.some((ext) => ext.name === 'table')

  // TipTap v3: useEditor 默认不每 transaction 重渲染 → editor.isActive/getAttributes 非
  // 响应式, 工具栏高亮/当前值不跟随光标。useEditorState 订阅快照。
  const fmt = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      underline: e?.isActive('underline') ?? false,
      strike: e?.isActive('strike') ?? false,
      bulletList: e?.isActive('bulletList') ?? false,
      orderedList: e?.isActive('orderedList') ?? false,
      blockquote: e?.isActive('blockquote') ?? false,
      codeBlock: e?.isActive('codeBlock') ?? false,
      link: e?.isActive('link') ?? false,
      code: e?.isActive('code') ?? false,
      table: hasTable && (e?.isActive('table') ?? false),
      canMergeCells: hasTable && (e?.can().mergeCells() ?? false),
      canSplitCell: hasTable && (e?.can().splitCell() ?? false),
      heading: (HEADING_LEVELS.find((l) => e?.isActive('heading', { level: l })) ?? 0) as
        | 0
        | 1
        | 2
        | 3,
      fontFamily: (e?.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      fontSize: (e?.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      color: (e?.getAttributes('textStyle').color as string | undefined) ?? '',
      highlight:
        (e?.getAttributes('highlight').color as string | undefined) ??
        (e?.getAttributes('textStyle').backgroundColor as string | undefined) ??
        '',
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false
    })
  }) ?? {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    bulletList: false,
    orderedList: false,
    blockquote: false,
    codeBlock: false,
    link: false,
    code: false,
    table: false,
    canMergeCells: false,
    canSplitCell: false,
    heading: 0 as const,
    fontFamily: '',
    fontSize: '',
    color: '',
    highlight: '',
    canUndo: false,
    canRedo: false
  }

  const openLinkDialog = useCallback(() => {
    // 不预填 https:// — 输入框里用户输入什么就是什么 (dogfood: 不许强改输入);
    // 无 scheme 的温和补全放在 applyLink 提交时。已有链接仍回填当前 href。
    const prev = editor.getAttributes('link').href as string | undefined
    setLinkValue(prev ?? '')
    setLinkOpen(true)
  }, [editor])
  const applyLink = useCallback(() => {
    const url = linkValue.trim()
    setLinkOpen(false)
    // 空 / 光杆 scheme → 视作清除 (给选中文本去链)。
    if (url === '' || url === 'https://') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    // 无 scheme 时提交才补全 https:// (example.com:8080 这类「域名:端口」不算
    // scheme, 判据是 :// 或 mailto/tel)。输入框内容始终不被改写。
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(?:mailto|tel):/i.test(url)
    const href = hasScheme ? url : `https://${url}`
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }, [editor, linkValue])
  const removeLink = useCallback(() => {
    setLinkOpen(false)
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
  }, [editor])

  const applyImage = useCallback(() => {
    const url = imageValue.trim()
    setImageOpen(false)
    setImageValue('')
    if (url === '' || url === 'https://') return
    editor.chain().focus().setImage({ src: url }).run()
  }, [editor, imageValue])

  // 从文件插入内联图 — FileReader → data URL → setImage。与粘贴图片同一
  // 下游 (data: 直嵌正文 HTML), 超上限提示走附件。
  const imageFileRef = useRef<HTMLInputElement>(null)
  const insertImageFile = useCallback(
    (file: File | undefined) => {
      setImageOpen(false)
      setImageValue('')
      if (!file) return
      if (file.size > MAX_INLINE_IMAGE_BYTES) {
        toastError(t('compose.editor.imageTooLarge', { name: file.name, max: 4 }))
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : ''
        if (src) editor.chain().focus().setImage({ src }).run()
      }
      reader.readAsDataURL(file)
    },
    [editor, t]
  )

  /** 高亮（multicolor）— 无 Highlight 扩展时回退 textStyle backgroundColor。 */
  const applyHighlight = useCallback(
    (color: string | null) => {
      const chain = editor.chain().focus()
      if (hasHighlight) {
        ;(color ? chain.setHighlight({ color }) : chain.unsetHighlight()).run()
      } else {
        ;(color ? chain.setBackgroundColor(color) : chain.unsetBackgroundColor()).run()
      }
    },
    [editor, hasHighlight]
  )

  /** @ 按钮 — 光标前是非空白字符时补一个空格（Suggestion 默认只认空白前缀触发）。 */
  const insertMentionTrigger = useCallback(() => {
    const { from } = editor.state.selection
    const before = from > 0 ? editor.state.doc.textBetween(Math.max(0, from - 1), from) : ''
    const needsSpace = before.length > 0 && !/\s/.test(before)
    editor
      .chain()
      .focus()
      .insertContent(needsSpace ? ' @' : '@')
      .run()
  }, [editor])

  return (
    <div className="relative border-t border-ink-border/60 bg-ink-2/40 px-3 py-2 flex items-center gap-1.5 shrink-0 flex-wrap">
      {/* ── 组 1: 正文/标题 + 字体 + 字号 ─────────────────────────── */}
      <OptionPopoverButton
        title={t('compose.editor.headingStyle')}
        icon={<Pilcrow size={12} strokeWidth={2} />}
        value={fmt.heading === 0 ? '' : String(fmt.heading)}
        currentLabel={
          fmt.heading === 0
            ? t('compose.editor.paragraph')
            : t(`compose.editor.heading${fmt.heading}`)
        }
        options={[
          { value: '', label: t('compose.editor.paragraph') },
          ...HEADING_LEVELS.map((l) => ({
            value: String(l),
            label: t(`compose.editor.heading${l}`)
          }))
        ]}
        onSelect={(v) => {
          if (v === '') editor.chain().focus().setParagraph().run()
          else
            editor
              .chain()
              .focus()
              .setHeading({ level: Number(v) as 1 | 2 | 3 })
              .run()
        }}
      />
      <OptionPopoverButton
        title={t('compose.editor.fontFamily')}
        icon={<Type size={12} strokeWidth={2} />}
        value={fmt.fontFamily}
        inherited={!fmt.fontFamily}
        currentLabel={t(
          `compose.editor.${fontFamilies.find((f) => f.value === fmt.fontFamily)?.key ?? 'fontFamilyDefault'}`
        )}
        options={fontFamilies.map((f) => ({
          value: f.value,
          label: t(`compose.editor.${f.key}`)
        }))}
        onSelect={(v) => {
          if (v) editor.chain().focus().setFontFamily(v).run()
          else editor.chain().focus().unsetFontFamily().run()
        }}
      />
      <OptionPopoverButton
        title={t('compose.editor.fontSize')}
        icon={<ALargeSmall size={13} strokeWidth={2} />}
        value={fmt.fontSize}
        inherited={!fmt.fontSize}
        currentLabel={
          fmt.fontSize ? fmt.fontSize.replace('px', '') : String(COMPOSE_FONT_SIZE_DEFAULT_PX)
        }
        options={fontSizes.map((s) => ({
          value: s,
          label: s
            ? s.replace('px', '')
            : t('compose.editor.fontSizeDefaultOption', { size: COMPOSE_FONT_SIZE_DEFAULT_PX })
        }))}
        onSelect={(v) => {
          if (v) editor.chain().focus().setFontSize(v).run()
          else editor.chain().focus().unsetFontSize().run()
        }}
      />
      <OptionPopoverButton
        title={t('compose.editor.lineHeight')}
        icon={<AlignVerticalSpaceAround size={12} strokeWidth={2} />}
        value={lineHeight}
        inherited={!lineHeight}
        currentLabel={lineHeight || formatLineHeight(composeLineHeightDefault)}
        options={LINE_HEIGHTS.map((v) => ({
          value: v,
          label:
            v ||
            t('compose.editor.lineHeightDefaultOption', {
              value: formatLineHeight(composeLineHeightDefault)
            })
        }))}
        onSelect={(v) => onLineHeightChange?.(v)}
      />
      <FmtSep />
      {/* ── 组 2: B/I/U/S + 颜色 + 高亮 ──────────────────────────── */}
      <FmtBtn
        icon={<Bold size={13} strokeWidth={2.5} />}
        label={t('compose.editor.bold')}
        active={fmt.bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <FmtBtn
        icon={<Italic size={13} strokeWidth={2} />}
        label={t('compose.editor.italic')}
        active={fmt.italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <FmtBtn
        icon={<UnderlineIcon size={13} strokeWidth={2} />}
        label={t('compose.editor.underline')}
        active={fmt.underline}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <FmtBtn
        icon={<Strikethrough size={13} strokeWidth={2} />}
        label={t('compose.editor.strike')}
        active={fmt.strike}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <SwatchPopoverButton
        title={t('compose.editor.textColor')}
        icon={<Baseline size={13} strokeWidth={2} style={{ color: fmt.color || undefined }} />}
        colors={TEXT_COLORS}
        neutrals={TEXT_NEUTRALS}
        current={fmt.color}
        clearTitle={t('compose.editor.colorDefault')}
        moreLabel={t('compose.editor.moreColor')}
        onPick={(c) => {
          if (c) editor.chain().focus().setColor(c).run()
          else editor.chain().focus().unsetColor().run()
        }}
      />
      <SwatchPopoverButton
        title={t('compose.editor.highlight')}
        icon={
          <Highlighter size={13} strokeWidth={2} style={{ color: fmt.highlight || undefined }} />
        }
        colors={HL_COLORS}
        neutrals={HL_NEUTRALS}
        current={fmt.highlight}
        clearTitle={t('compose.editor.highlightNone')}
        moreLabel={t('compose.editor.moreColor')}
        onPick={applyHighlight}
      />
      <FmtSep />
      {/* ── 组 3: 列表 + 引用 + 代码块 ───────────────────────────── */}
      <FmtBtn
        icon={<List size={13} strokeWidth={2} />}
        label={t('compose.editor.bulletList')}
        active={fmt.bulletList}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <FmtBtn
        icon={<ListOrdered size={13} strokeWidth={2} />}
        label={t('compose.editor.orderedList')}
        active={fmt.orderedList}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <FmtBtn
        icon={<TextQuote size={13} strokeWidth={2} />}
        label={t('compose.editor.blockquote')}
        active={fmt.blockquote}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <FmtBtn
        icon={<SquareCode size={13} strokeWidth={2} />}
        label={t('compose.editor.codeBlock')}
        active={fmt.codeBlock}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      />
      <FmtBtn
        icon={<Code size={13} strokeWidth={2} />}
        label={t('compose.editor.code')}
        active={fmt.code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <FmtSep />
      {/* ── 组 4: 链接 + 图片 + 分割线 + @ ───────────────────────── */}
      <FmtBtn
        icon={<Link2 size={13} strokeWidth={2} />}
        label={t('compose.editor.link')}
        active={fmt.link || linkOpen}
        onClick={() => (linkOpen ? setLinkOpen(false) : openLinkDialog())}
      />
      <FmtBtn
        icon={<ImagePlus size={13} strokeWidth={2} />}
        label={t('compose.editor.image')}
        active={imageOpen}
        onClick={() => {
          setLinkOpen(false)
          setImageOpen((v) => !v)
        }}
      />
      <FmtBtn
        icon={<Minus size={13} strokeWidth={2} />}
        label={t('compose.editor.divider')}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      />
      <FmtBtn
        icon={<AtSign size={13} strokeWidth={2} />}
        label={t('compose.editor.mention')}
        onClick={insertMentionTrigger}
      />
      {hasTable && !fmt.table && <TableInsertPopover editor={editor} />}
      {hasTable && fmt.table && (
        <TableOpsPopover
          editor={editor}
          canMergeCells={fmt.canMergeCells}
          canSplitCell={fmt.canSplitCell}
        />
      )}
      <div className="flex-1" aria-hidden />
      {/* ── 组 5: 撤销/重做 ──────────────────────────────────────── */}
      <FmtBtn
        icon={<Undo2 size={13} strokeWidth={2} />}
        label={t('compose.editor.undo')}
        disabled={!fmt.canUndo}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <FmtBtn
        icon={<Redo2 size={13} strokeWidth={2} />}
        label={t('compose.editor.redo')}
        disabled={!fmt.canRedo}
        onClick={() => editor.chain().focus().redo().run()}
      />

      {/* 链接输入弹框 — Enter 应用 / Esc 取消; 有链接时显移除。 */}
      {linkOpen && (
        <InlineInputBox
          value={linkValue}
          placeholder={t('compose.editor.linkUrl')}
          applyLabel={t('compose.editor.linkApply')}
          onChange={setLinkValue}
          onApply={applyLink}
          onClose={() => setLinkOpen(false)}
          extra={
            fmt.link ? (
              <FmtBtn
                icon={<Unlink size={13} strokeWidth={2} />}
                label={t('compose.editor.linkRemove')}
                onClick={removeLink}
              />
            ) : undefined
          }
        />
      )}
      {/* 图片 URL 输入弹框 — 插入内联图（上传附件走附件条，不在此处）;
          extra 按钮 = 从本地文件选图 (data URL 内联, 与粘贴同下游)。 */}
      {imageOpen && (
        <InlineInputBox
          value={imageValue}
          placeholder={t('compose.editor.imageUrl')}
          applyLabel={t('compose.editor.imageApply')}
          onChange={setImageValue}
          onApply={applyImage}
          onClose={() => setImageOpen(false)}
          extra={
            <FmtBtn
              icon={<ImageUp size={13} strokeWidth={2} />}
              label={t('compose.editor.imageFromFile')}
              onClick={() => imageFileRef.current?.click()}
            />
          }
        />
      )}
      {/* 从文件插图的载体 input — 常驻挂载 (弹框关掉后系统文件对话框的 onChange
          仍要能送达), 选完清 value 让同一文件可重复选择。 */}
      <input
        ref={imageFileRef}
        type="file"
        accept="image/*"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          insertImageFile(e.currentTarget.files?.[0])
          e.currentTarget.value = ''
        }}
      />
    </div>
  )
}

export function ComposeEditor({
  editor,
  lineHeight
}: {
  editor: Editor | null
  /** 生效行距 (本封覆写 ?? 设置默认)。注入 --ma-compose-lh, 由 index.css 的
   *  `.folder-draft-editor .ProseMirror` 消费; 缺省时走 CSS fallback。 */
  lineHeight?: number
}): React.ReactElement {
  const { t } = useTranslation()
  // TipTap v3: editor.isEmpty 非响应式 (useEditor 默认不每 transaction 重渲染) →
  // 输入后 placeholder 不消失。useEditorState 订阅, isEmpty 变化时重渲染。
  const isEmpty =
    useEditorState({ editor, selector: ({ editor: e }) => e?.isEmpty ?? true }) ?? true
  return (
    // grow shrink-0 (flex-basis 保持默认 auto) — 本块在 ComposePanel 的单一滚动区里,
    // 高度必须等于正文内容高度。曾用 flex-1 (= flex:1 1 0%): basis:0 让盒高只由剩余
    // 空间决定、且显式 min-height 又顶掉了 flex 的 min-height:auto 内容下限, 于是长正文
    // 溢出盒外 (overflow 默认 visible) 直接画到下方引用块上 — 实测 40 行正文交叠 1239px。
    // grow 保留"正文短时撑满可视区"的手感, shrink-0 保证盒高永不低于内容。
    <div
      data-testid="compose-editor-block"
      className="grow shrink-0 min-h-[240px]"
      style={
        lineHeight != null
          ? ({ '--ma-compose-lh': String(lineHeight) } as React.CSSProperties)
          : undefined
      }
    >
      {/* 正文用满宽 + 24px 内边距 (旧 px-10=40px + max-w-760 居中导致大段留白, 观感
          像"缩进很多"); 去掉宽度上限让正文铺满 compose 列, 与 Outlook 撰写区一致。 */}
      <div className="relative px-6 pt-6 pb-10">
        {isEmpty && (
          <div
            aria-hidden
            className="pointer-events-none absolute left-6 top-6 text-body text-ink-fg-3"
          >
            {t('compose.editor.bodyPlaceholder')}
          </div>
        )}
        <EditorContent
          editor={editor}
          className="folder-draft-editor text-ink-fg-1 text-body leading-relaxed"
        />
      </div>
    </div>
  )
}
