// 设置-邮箱「已同步文件夹配置」—— 顺序 + 图标 + per-folder 开关，合并验收 mockup。
//
// 复用的真东西（不是仿的）：
//   · 主仓 design token（直接 import src/electron/renderer/index.css）
//   · 主仓拖拽基座 @shared/components/ui/DragReorderList（FLIP 缺陷已修版，
//     commit 35fd6c11；走它的 renderItem 逃生舱塞富内容，壳与交互内核一行没动）
//   · 主仓 Switch primitive（@shared/components/ui/switch）
//   · 主仓动效图标外壳 IconShell + AnimatedIconActiveProvider（24 个 folder
//     图标的动效见 ./animated.tsx；开关用主仓现成的 BellIcon / BotIcon）
//   · 侧边栏行的 authored CSS（.app-nav / .row / .row-selected / .acc-select），
//     所以选中左光条、收起态 56px rail 的行为与真 App 一致
//
// mockup 里是假的：文件夹数据（真名假计数，见 data.ts）、保存链路（只打日志）。
//
// 🔴 两个开关的极性是从后端读出来的，不是按直觉设计的 —— 见页面底部「语义与出处」卡。

import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createRoot } from 'react-dom/client'
import { Check, RotateCcw } from 'lucide-react'

import '../../src/electron/renderer/index.css'
import './mockup.css'
import {
  AnimatedIconActiveProvider,
  FeatherIcon,
  FolderInputIcon,
  FoldersIcon,
  SendIcon,
  ZapIcon,
  type AnimatedIconProps
} from '@shared/components/icons'
import {
  DragReorderList,
  type ReorderItem,
  type ReorderMessages
} from '@shared/components/ui/DragReorderList'
import { FOLDER_ICON_KEYS, FOLDER_ICON_MOTION, folderIcon, type FolderIconKey } from './icons'
import { BUILTIN_ROWS, PREF_DEFAULTS, SYNCED_FOLDERS, type BuiltinRow } from './data'
import {
  BuiltinLockSlot,
  COL_COUNT,
  COL_ICON,
  COL_INDEX,
  PrefColumnHeader,
  PrefNotApplicable,
  PrefToggle,
  type ToggleStyle
} from './prefs'
import { Tip } from './tip'

/* ── 一行配置（= folder_pref 的一行） ───────────────────────────── */

interface Pref {
  icon: FolderIconKey | null
  notify: boolean
  ai: boolean
}

/** 内建 5 行用主仓现成的动效图标（= 真 Sidebar.tsx 的 MAILBOX_ICON）。 */
const BUILTIN_ICON: Record<string, (p: AnimatedIconProps) => React.ReactElement> = {
  'folder-input': FolderInputIcon,
  send: SendIcon,
  feather: FeatherIcon,
  zap: ZapIcon,
  folders: FoldersIcon
}

/** 内建行当前该用哪个图标组件：改过就用改的，没改过用 Sidebar 写死那个。 */
function builtinIconOf(
  row: BuiltinRow,
  override: FolderIconKey | null
): (p: AnimatedIconProps) => React.ReactElement {
  return override ? folderIcon(override) : BUILTIN_ICON[row.icon]!
}

/* ── 图标选择器 ─────────────────────────────────────────────────── */

interface PickerAnchor {
  key: string
  displayName: string
  rect: DOMRect
  /** builtin 行的「默认」= 回到 Sidebar 写死那个，不是回到通用 Folder。 */
  scope: 'folder' | 'builtin'
}

/** 24 格网格，一眼扫完；hover 任一格即播它自己的动效（预览）。
 *  position:fixed 挂在 App 根上 —— 不能放进拖拽行里，行上有 transform
 *  （motion y），fixed 会退化成相对该行定位。 */
function IconPicker({
  anchor,
  value,
  onPick,
  onReset,
  onClose
}: {
  anchor: PickerAnchor
  value: FolderIconKey | null
  onPick: (key: FolderIconKey) => void
  onReset: () => void
  onClose: () => void
}): React.ReactElement {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: anchor.rect.bottom + 6,
    left: anchor.rect.left
  })
  const [hover, setHover] = useState<FolderIconKey | null>(null)

  // 贴按钮左下角展开；右侧/底部越界时回拉进视口。
  useLayoutEffect(() => {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = hover ?? value

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div
        ref={boxRef}
        role="dialog"
        aria-label={`为「${anchor.displayName}」选择图标`}
        style={{ top: pos.top, left: pos.left }}
        className="mk-popover fixed z-50 w-[280px] rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-2.5"
      >
        <div className="mb-2 flex items-baseline gap-2 px-0.5">
          <span className="text-meta font-medium text-ink-fg">文件夹图标</span>
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
            {anchor.displayName}
          </span>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-meta text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <RotateCcw size={11} strokeWidth={2} />
            默认
          </button>
        </div>

        <div className="grid grid-cols-6 gap-1" role="listbox" aria-label="图标候选">
          {FOLDER_ICON_KEYS.map((key) => {
            const Icon = folderIcon(key)
            const selected = value === key
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={`${key}（${FOLDER_ICON_MOTION[key]}）`}
                onMouseEnter={() => setHover(key)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(key)}
                onBlur={() => setHover(null)}
                onClick={() => onPick(key)}
                className={[
                  'relative grid h-[40px] place-items-center rounded-[var(--r-ctl)] transition-colors duration-fast',
                  selected
                    ? 'bg-coral/15 text-ink-fg ring-1 ring-coral/45'
                    : 'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg'
                ].join(' ')}
              >
                {/* hover 即播自己的动效 —— 选之前就能看清它动起来什么样。 */}
                <Icon size={18} strokeWidth={1.75} active={hover === key} />
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

        {/* 落库存的就是这个 key，右边是它的动效说明。 */}
        <div className="mt-2 flex items-baseline gap-2 px-0.5">
          <span className="shrink-0 font-mono text-meta text-ink-fg-2">
            {shown ?? (anchor.scope === 'builtin' ? '（内建默认）' : 'folder')}
          </span>
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
            {shown ? FOLDER_ICON_MOTION[shown] : '未设置，用写死的那个'}
          </span>
        </div>
      </div>
    </>
  )
}

/* ── 行内当前图标按钮 ───────────────────────────────────────────── */

function FolderIconButton({
  Icon,
  name,
  open,
  onOpen
}: {
  Icon: (p: AnimatedIconProps) => React.ReactElement
  name: string
  open: boolean
  onOpen: (e: React.MouseEvent<HTMLButtonElement>) => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <Tip label="更换图标" className={`${COL_ICON} shrink-0`}>
      <button
        type="button"
        aria-label={`更换「${name}」的图标`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // 行上 pointerdown 会起拖；按钮自己吃掉，点图标不会误拖。
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpen}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className={[
          'grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-ctl)] border transition-colors duration-fast',
          open
            ? 'border-coral/45 bg-coral/15 text-ink-fg'
            : 'border-ink-border bg-ink-1 text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
        ].join(' ')}
      >
        <Icon size={15} strokeWidth={1.75} active={hover || open} />
      </button>
    </Tip>
  )
}

/** 行右侧的名字块：常态只显示显示名，hover 才淡出 imap 原始名（不占额外行高、不抖）。 */
function RowName({
  label,
  imapName
}: {
  label: string
  imapName: string | null
}): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 truncate text-body text-ink-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink-fg-3 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100">
        {imapName ?? '本地视图，无 IMAP 名'}
      </span>
    </span>
  )
}

function RowCount({ count }: { count?: number }): React.ReactElement {
  return (
    <span
      className={`${COL_COUNT} shrink-0 text-right font-mono text-meta tabular-nums text-ink-fg-2`}
    >
      {count && count > 0 ? count.toLocaleString('en-US') : ''}
    </span>
  )
}

/* ── 侧边栏预览 ─────────────────────────────────────────────────── */

function NavRow({
  Icon,
  label,
  count,
  selected,
  collapsed,
  pushDot,
  onClick
}: {
  Icon: (p: AnimatedIconProps) => React.ReactElement
  label: string
  count?: number
  selected?: boolean
  collapsed: boolean
  /** 「这个文件夹会推飞书」的可选标记（待定项，控制条里可关）。 */
  pushDot?: boolean
  onClick?: () => void
}): React.ReactElement {
  // 整行 hover 驱动图标动效 —— 与真 Sidebar.NavRow 同一套 Context 通道。
  const [iconActive, setIconActive] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={() => setIconActive(true)}
      onPointerLeave={() => setIconActive(false)}
      onFocus={() => setIconActive(true)}
      onBlur={() => setIconActive(false)}
      title={label}
      className={[
        'row relative flex w-full items-center gap-2.5 rounded-[var(--r-ctl)] px-2 py-1',
        'text-left text-body transition-colors duration-fast',
        selected
          ? 'row-selected acc-select font-medium text-ink-fg'
          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
      ].join(' ')}
    >
      {/* svg 必须是 button 的直接子节点 —— 收起态 19px 放大规则选的就是 `button > svg`。 */}
      <AnimatedIconActiveProvider active={iconActive}>
        <Icon size={15} strokeWidth={1.75} trigger="parent" />
      </AnimatedIconActiveProvider>
      {pushDot ? (
        // app-nav-keep = 收起态不隐藏（其余 button > span 会被 display:none）。
        <span
          className={[
            'app-nav-keep pointer-events-none absolute h-[5px] w-[5px] rounded-full bg-coral',
            collapsed ? 'left-1/2 top-[9px] ml-[5px]' : 'left-[19px] top-[3px]'
          ].join(' ')}
          aria-hidden="true"
        />
      ) : null}
      <span className="flex-1 truncate">{label}</span>
      {count && count > 0 ? (
        selected ? (
          <span className="rounded-[3px] border border-coral/30 bg-coral/15 px-1 py-px font-mono text-[10px] leading-none tabular-nums text-ink-fg">
            {count.toLocaleString('en-US')}
          </span>
        ) : (
          <span className="font-mono text-meta tabular-nums text-ink-fg-2">
            {count.toLocaleString('en-US')}
          </span>
        )
      ) : null}
    </button>
  )
}

/* ── 24 个候选一览（含动效说明，当验收清单用）───────────────────── */

function IconGallery(): React.ReactElement {
  const [hover, setHover] = useState<FolderIconKey | null>(null)
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
      {FOLDER_ICON_KEYS.map((key) => {
        const Icon = folderIcon(key)
        return (
          <div
            key={key}
            onMouseEnter={() => setHover(key)}
            onMouseLeave={() => setHover(null)}
            className="flex items-center gap-2.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 py-2 transition-colors duration-fast hover:bg-ink-3"
          >
            <Icon size={17} strokeWidth={1.75} active={hover === key} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-meta text-ink-fg-2">{key}</span>
              <span className="block truncate text-meta text-ink-fg-3">
                {FOLDER_ICON_MOTION[key]}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* ── mockup 控制条上的小开关 ────────────────────────────────────── */

function MkCheck({
  checked,
  onChange,
  children
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

/* ── 页面 ───────────────────────────────────────────────────────── */

const REORDER_MESSAGES: ReorderMessages = {
  listLabel: '已同步文件夹顺序，可重排',
  grip: (label, pos, count, grabbed) =>
    `调整「${label}」的顺序，第 ${pos} 位，共 ${count} 项${grabbed ? '，已抓起' : ''}`,
  grabbed: (label, pos, count) =>
    `已抓起「${label}」，第 ${pos} 位，共 ${count} 项。方向键移动，空格放下，Esc 取消。`,
  dropped: (label, pos, count) => `「${label}」已放至第 ${pos} 位，共 ${count} 项。`,
  moved: (label, pos, count) => `「${label}」已移至第 ${pos} 位，共 ${count} 项。`,
  cancelled: (label) => `已取消调序，「${label}」回到原位。`
}

const initialPrefs = (): Record<string, Pref> =>
  Object.fromEntries(
    SYNCED_FOLDERS.map((f) => [f.imapName, { icon: f.icon, notify: f.notify, ai: f.ai }])
  )

function App(): React.ReactElement {
  const [order, setOrder] = useState<string[]>(() => SYNCED_FOLDERS.map((f) => f.imapName))
  const [prefs, setPrefs] = useState<Record<string, Pref>>(initialPrefs)
  const [builtinIcons, setBuiltinIcons] = useState<Record<string, FolderIconKey | null>>({})
  const [picker, setPicker] = useState<PickerAnchor | null>(null)
  const [active, setActive] = useState<string | null>('DMS&VvpO9lPRXgM-')

  // mockup 自己的观察开关，不是产品 UI。
  const [collapsed, setCollapsed] = useState(false)
  const [light, setLight] = useState(false)
  const [toggleStyle, setToggleStyle] = useState<ToggleStyle>('icon')
  const [globalNotify, setGlobalNotify] = useState(true)
  const [globalAi, setGlobalAi] = useState(true)
  const [pushDot, setPushDot] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', light ? 'light' : 'dark')
    root.classList.toggle('dark', !light)
  }, [light])

  const byImap = useMemo(() => new Map(SYNCED_FOLDERS.map((f) => [f.imapName, f])), [])

  /** 侧边栏取的就是这一份：order 的数组序 + prefs 的每项取值。 */
  const ordered = useMemo(
    () =>
      order.map((imapName) => {
        const base = byImap.get(imapName)!
        const p = prefs[imapName] ?? PREF_DEFAULTS
        return { ...base, ...p }
      }),
    [order, prefs, byImap]
  )

  const items = useMemo<ReorderItem[]>(
    () => ordered.map((f) => ({ id: f.imapName, label: f.displayName })),
    [ordered]
  )

  const handleReorder = useCallback((list: ReorderItem[]): void => {
    setOrder(list.map((i) => i.id))
    setDirty(true)
  }, [])

  const setPref = useCallback((key: string, patch: Partial<Pref>): void => {
    setPrefs((cur) => ({ ...cur, [key]: { ...(cur[key] ?? PREF_DEFAULTS), ...patch } }))
    setDirty(true)
  }, [])

  const openPicker = useCallback(
    (
      e: React.MouseEvent<HTMLButtonElement>,
      key: string,
      displayName: string,
      scope: 'folder' | 'builtin'
    ): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      setPicker((cur) => (cur?.key === key ? null : { key, displayName, rect, scope }))
    },
    []
  )

  const reset = (): void => {
    setOrder(SYNCED_FOLDERS.map((f) => f.imapName))
    setPrefs(initialPrefs())
    setBuiltinIcons({})
    setDirty(false)
    setPicker(null)
  }

  const pickerValue = picker
    ? picker.scope === 'builtin'
      ? (builtinIcons[picker.key] ?? null)
      : (prefs[picker.key]?.icon ?? null)
    : null

  return (
    <div className="min-h-screen bg-ink-1 px-8 py-7 text-ink-fg">
      <div className="mx-auto max-w-[1240px] space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">已同步文件夹配置 — 合并 mockup</h1>
          <p className="max-w-[860px] text-meta leading-relaxed text-ink-fg-3">
            一行同时承载：拖拽手柄 · 图标（点开可换）· 文件夹名（hover 露 imap 原始名）· 通知开关 ·
            AI 分类开关 · 邮件计数。右边侧边栏按同序同图标实时联动。 这份 mockup 是{' '}
            <code className="text-ink-fg-2">folder_pref</code>{' '}
            落地前的验收面，页面最底部有落库预览与两个开关的语义出处。
          </p>
        </header>

        {/* 控制条 —— mockup 自己的观察开关，不是产品 UI。 */}
        <section className="space-y-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-4 py-3 text-meta">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
            <span className="font-mono text-micro uppercase tracking-wider text-ink-fg-3">
              观察开关
            </span>
            <MkCheck checked={light} onChange={setLight}>
              亮色主题
            </MkCheck>
            <MkCheck checked={collapsed} onChange={setCollapsed}>
              侧边栏收起态（56px rail）
            </MkCheck>
            <MkCheck checked={pushDot} onChange={setPushDot}>
              侧边栏标出「会推送」的文件夹
              <span className="ml-1 rounded-[3px] border border-warn/40 px-1 text-micro text-warn">
                待定
              </span>
            </MkCheck>
            <span className="flex items-center gap-1.5">
              <span className="text-ink-fg-3">开关控件：</span>
              {(
                [
                  ['icon', '图标钮'],
                  ['switch', 'Switch']
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setToggleStyle(v)}
                  className={[
                    'rounded-[var(--r-ctl)] border px-2 py-0.5 transition-colors duration-fast',
                    toggleStyle === v
                      ? 'border-coral/45 bg-coral/12 text-ink-fg'
                      : 'border-ink-border text-ink-fg-2 hover:bg-ink-3'
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
              <span className="text-ink-fg-3">
                （二选一，等你拍：图标钮一眼看出「是哪个开关」，Switch 一眼看出「开没开」）
              </span>
            </span>
            <button
              type="button"
              onClick={reset}
              className="ml-auto rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 transition-colors duration-fast hover:bg-ink-3"
            >
              重置
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-border-soft pt-2.5">
            <span className="font-mono text-micro uppercase tracking-wider text-ink-fg-3">
              上游总闸
            </span>
            <MkCheck checked={globalNotify} onChange={setGlobalNotify}>
              <code className="text-ink-fg-2">FEISHU_NOTIFY_ENABLED</code>
            </MkCheck>
            <MkCheck checked={globalAi} onChange={setGlobalAi}>
              <code className="text-ink-fg-2">LLM_AGENT_ENABLED</code>
            </MkCheck>
            <span className="text-ink-fg-3">
              关掉任一个，对应那一列整体变灰划掉 —— per-folder 开关只在总闸开着时才有意义，
              这两个总闸代码默认都是 <code className="text-ink-fg-2">false</code>。
            </span>
          </div>
        </section>

        <div className="flex flex-wrap items-start gap-6">
          {/* 设置页一侧 */}
          <section className="min-w-[600px] flex-1 rounded-lg border border-ink-border-soft bg-ink-1">
            <div className="border-b border-ink-border-soft px-3 py-2">
              <span className="text-meta text-ink-fg-2">
                设置 › 邮箱 › 自定义文件夹同步
                <span className="text-ink-fg-3">{' · 共 18 个文件夹'}</span>
              </span>
            </div>

            {/* ── 内建邮箱（不可拖、不可移除；图标是否开放待定）─────────── */}
            <div className="border-b border-ink-border-soft px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-body font-medium text-ink-fg">内建邮箱</span>
                <span className="rounded-[3px] border border-warn/40 px-1 py-px text-micro text-warn">
                  这块待你拍板
                </span>
                <span className="text-meta text-ink-fg-2">
                  顺序固定、不能移除；图标这里做成可换的，你看着实物决定要不要开放
                </span>
              </div>

              <PrefColumnHeader globalNotify={globalNotify} globalAi={globalAi} />

              <ul className="space-y-px">
                {BUILTIN_ROWS.map((row) => {
                  const override = builtinIcons[row.id] ?? null
                  const Icon = builtinIconOf(row, override)
                  return (
                    <li
                      key={row.id}
                      // 与拖拽行同一套内边距/间距，两段列才竖着对齐。
                      className="group/row flex items-center gap-2.5 rounded-xl py-2 pl-2 pr-3 transition-colors duration-fast hover:bg-ink-2"
                    >
                      <BuiltinLockSlot />
                      <FolderIconButton
                        Icon={Icon}
                        name={row.label}
                        open={picker?.key === row.id}
                        onOpen={(e) => openPicker(e, row.id, row.label, 'builtin')}
                      />
                      <RowName label={row.label} imapName={row.imapName} />
                      <PrefNotApplicable kind="notify" />
                      <PrefNotApplicable kind="ai" />
                      <RowCount count={row.count} />
                      <span className={`${COL_INDEX} shrink-0`} aria-hidden="true" />
                    </li>
                  )
                })}
              </ul>

              <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-3">
                两个开关这里画的是「—」而不是「关」：后端两个 gate 都先判
                <code className="mx-1 text-ink-fg-2">is_custom_folder_mailbox()</code>
                ，标准邮箱直接跳过 —— 内建行 <b className="font-medium text-ink-fg-2">不受</b>{' '}
                per-folder 开关约束，画成可关会骗人。
              </p>
            </div>

            {/* ── 自定义文件夹（拖拽 + 逐行配置）────────────────────── */}
            <div className="border-b border-ink-border-soft px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-body font-medium text-ink-fg">已同步文件夹</span>
                <span className="text-meta text-ink-fg-2">
                  拖拽调顺序，点图标换图标，两个开关逐个文件夹配；侧边栏按此顺序显示
                </span>
              </div>

              <PrefColumnHeader globalNotify={globalNotify} globalAi={globalAi} />

              <DragReorderList
                items={items}
                onReorder={handleReorder}
                messages={REORDER_MESSAGES}
                rowClassName="py-2 pr-3"
                renderItem={(item, index) => {
                  const f = ordered[index]!
                  return (
                    <span className="group/row flex min-w-0 items-center gap-2.5">
                      <FolderIconButton
                        Icon={folderIcon(f.icon)}
                        name={f.displayName}
                        open={picker?.key === f.imapName}
                        onOpen={(e) => openPicker(e, f.imapName, f.displayName, 'folder')}
                      />
                      <RowName label={item.label} imapName={f.imapName} />
                      <PrefToggle
                        kind="notify"
                        on={f.notify}
                        folderName={f.displayName}
                        style={toggleStyle}
                        globalOff={!globalNotify}
                        onChange={(v) => setPref(f.imapName, { notify: v })}
                      />
                      <PrefToggle
                        kind="ai"
                        on={f.ai}
                        folderName={f.displayName}
                        style={toggleStyle}
                        globalOff={!globalAi}
                        onChange={(v) => setPref(f.imapName, { ai: v })}
                      />
                      <RowCount count={f.count} />
                      <span
                        className={`${COL_INDEX} shrink-0 text-right text-meta tabular-nums text-ink-fg-3`}
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                    </span>
                  )
                }}
              />

              <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-3">
                新加入 SYNC_FOLDERS 的文件夹落地时长这样：
                <span className="mx-1 rounded-[3px] border border-ink-border px-1 font-mono text-ink-fg-2">
                  通知 关 · AI 开
                </span>
                —— 与后端两个 gate 的缺省行为逐字一致（不是我挑的默认值）。
              </p>
            </div>

            <div className="flex items-center justify-end gap-2.5 px-3 py-2.5">
              {dirty ? (
                <span className="mr-auto text-meta text-ink-fg-2">
                  顺序 / 图标即时生效；两个开关改完需要重启同步进程才对新邮件生效
                </span>
              ) : null}
              <button
                type="button"
                disabled={!dirty}
                onClick={() => setDirty(false)}
                className="inline-flex items-center gap-1.5 rounded-md bg-coral/100 px-3 py-1 text-aux text-accent-fg transition-colors duration-fast hover:bg-coral-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-coral/100"
              >
                保存
              </button>
            </div>
          </section>

          {/* 侧边栏一侧 */}
          <section className="space-y-2">
            <div className="text-meta text-ink-fg-2">侧边栏（实时联动）</div>
            <div
              className="app-nav shrink-0 overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 py-2.5"
              data-collapsed={collapsed ? 'true' : undefined}
            >
              <div className="app-nav-section-header px-3 pb-1">
                <h2
                  className="px-2 py-1 font-mono text-micro uppercase text-ink-fg-2"
                  style={{ letterSpacing: '0.08em' }}
                >
                  Mailboxes
                </h2>
              </div>
              <nav className="space-y-px px-2">
                {BUILTIN_ROWS.map((row) => (
                  <NavRow
                    key={row.id}
                    Icon={builtinIconOf(row, builtinIcons[row.id] ?? null)}
                    label={row.label}
                    count={row.count}
                    collapsed={collapsed}
                  />
                ))}
                {/* 自定义文件夹 —— 顺序、图标、推送标记都跟左边设置页联动。 */}
                {ordered.map((f) => (
                  <NavRow
                    key={f.imapName}
                    Icon={folderIcon(f.icon)}
                    label={f.displayName}
                    count={f.count}
                    selected={active === f.imapName}
                    collapsed={collapsed}
                    pushDot={pushDot && f.notify && globalNotify}
                    onClick={() => setActive(f.imapName)}
                  />
                ))}
              </nav>
            </div>
            <div className="max-w-[248px] space-y-2 text-meta leading-relaxed text-ink-fg-3">
              <p>上面 5 行是内建邮箱，「归档」起的 6 行才是 SYNC_FOLDERS 里的自定义文件夹。</p>
              <p>
                <b className="font-medium text-ink-fg-2">收起成 56px rail 时</b>
                ：两个开关在侧边栏本来没有任何视觉体现（它们只改后台处理，不改外观）， rail
                上的全部辨识收益来自图标 ——
                这正是图标功能最实的地方。要不要额外加个「会推送」小红点，
                用控制条那个待定开关看效果。
              </p>
            </div>
          </section>
        </div>

        {/* ── folder_pref 落库预览 ─────────────────────────────────── */}
        <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
          <h2 className="mb-1 text-body font-semibold">
            落库预览 · <code className="font-mono text-ink-fg-2">folder_pref</code>（方案 C）
          </h2>
          <p className="mb-3 max-w-[900px] text-meta leading-relaxed text-ink-fg-3">
            上面那一行配置，存进 <code className="text-ink-fg-2">sync_store.db</code> 就是下面这样。
            🔴 注意第四列：UI 上写的是「AI 分类（开=跑）」，列名却是{' '}
            <code className="text-ink-fg-2">llm_disabled</code>，两者
            <b className="font-medium text-ink-fg-2">反向</b> —— 这是跟 FOLDER_LLM_DISABLED
            的黑名单语义对齐，落地时最容易写反的一处。
          </p>
          <div className="overflow-x-auto rounded-[var(--r-ctl)] border border-ink-border">
            <table className="w-full min-w-[680px] border-collapse text-meta">
              <thead>
                <tr className="border-b border-ink-border bg-ink-1 text-left text-ink-fg-2">
                  <th className="px-3 py-1.5 font-mono font-normal">imap_name (PK)</th>
                  <th className="px-3 py-1.5 font-mono font-normal">sort_order</th>
                  <th className="px-3 py-1.5 font-mono font-normal">icon</th>
                  <th className="px-3 py-1.5 font-mono font-normal">notify_enabled</th>
                  <th className="px-3 py-1.5 font-mono font-normal">llm_disabled</th>
                </tr>
              </thead>
              <tbody className="font-mono text-ink-fg-1">
                {ordered.map((f, i) => (
                  <tr key={f.imapName} className="border-b border-ink-border-soft last:border-0">
                    <td className="px-3 py-1 text-ink-fg">{f.imapName}</td>
                    <td className="px-3 py-1 tabular-nums text-ink-fg-2">{i}</td>
                    <td className="px-3 py-1">
                      {f.icon ?? <span className="text-ink-fg-3">NULL</span>}
                    </td>
                    <td className={`px-3 py-1 ${f.notify ? 'text-coral' : 'text-ink-fg-3'}`}>
                      {String(f.notify)}
                    </td>
                    <td className={`px-3 py-1 ${!f.ai ? 'text-ai' : 'text-ink-fg-3'}`}>
                      {String(!f.ai)}
                    </td>
                  </tr>
                ))}
                {BUILTIN_ROWS.map((row) => (
                  <tr key={row.id} className="border-t border-ink-border bg-ink-1/60">
                    <td className="px-3 py-1 text-ink-fg-3">
                      {row.imapName ?? (
                        <span className="text-warn">？（本地视图，没有 IMAP 名）</span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-ink-fg-3">固定</td>
                    <td className="px-3 py-1">
                      {builtinIcons[row.id] ?? <span className="text-ink-fg-3">NULL</span>}
                    </td>
                    <td className="px-3 py-1 text-ink-fg-3">n/a</td>
                    <td className="px-3 py-1 text-ink-fg-3">n/a</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 max-w-[900px] text-meta leading-relaxed text-ink-fg-3">
            🔴 <b className="font-medium text-warn">sort_order 这一列要先拍</b>：上周刚把
            SYNC_FOLDERS 的<b className="font-medium text-ink-fg-2">数组序升格成显示顺序</b>
            （commit 7ec4b554），folder_pref 再存一列 sort_order
            就是同一个事实存两处、迟早对不上。二选一：顺序继续归 SYNC_FOLDERS 数组序（folder_pref
            只管 icon / 两个开关），或者顺序整个搬进 folder_pref、SYNC_FOLDERS 退回纯白名单。
          </p>
          <p className="mt-2 max-w-[900px] text-meta leading-relaxed text-ink-fg-3">
            表格下半段是内建 5 行。若你决定开放内建图标自定义：收件箱 / 发件箱 / 草稿箱还能借 IMAP
            名当主键，但
            <b className="font-medium text-warn">
              「已标旗」「所有邮件」是本地视图、 压根没有 IMAP 文件夹
            </b>
            ，得另给合成主键（例如 <code className="text-ink-fg-2">__view:flagged</code>
            ）。这是落地时要先拍的一件事。
          </p>
        </section>

        {/* ── 两个开关的语义与出处 ────────────────────────────────── */}
        <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
          <h2 className="mb-1 text-body font-semibold">
            两个开关的真实语义（从源码读的，不是猜的）
          </h2>
          <p className="mb-3 max-w-[900px] text-meta leading-relaxed text-ink-fg-3">
            这两个键现在是 .env 里的 JSON 数组，极性一个是白名单、一个是黑名单， 缺省行为正好相反 ——
            UI 如果按直觉做成两个同向开关就会骗人，所以照下面的事实做。
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              {
                key: 'FOLDER_NOTIFY_ENABLED',
                head: '通知',
                kind: '白名单（opt-in）',
                tone: 'coral' as const,
                fact: '自定义文件夹默认不推飞书；只有名字进了这个数组的才推。空数组 = 一个都不推。',
                impl: 'should_skip_feishu_for_folder() → `return mailbox not in notify_enabled`',
                where: 'src/mail/new_watcher.py:115-122（调用点 :2345-2351）',
                dflt: '缺省 = 关'
              },
              {
                key: 'FOLDER_LLM_DISABLED',
                head: 'AI 分类',
                kind: '黑名单（opt-out）',
                tone: 'ai' as const,
                fact: '自定义文件夹默认就跑 LLM 分类；只有名字进了这个数组的才跳过（省成本去噪）。空数组 = 全都跑。',
                impl: 'should_skip_llm_for_folder() → `return mailbox in llm_disabled`',
                where: 'src/mail/new_watcher.py:125-132（调用点 :1993-1999、:2414-2425）',
                dflt: '缺省 = 开'
              }
            ].map((row) => (
              <div
                key={row.key}
                className="space-y-1.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 p-3"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <code className="text-meta text-ink-fg">{row.key}</code>
                  <span
                    className={[
                      'rounded-[3px] border px-1 py-px text-micro',
                      row.tone === 'coral' ? 'border-coral/40 text-coral' : 'border-ai/40 text-ai'
                    ].join(' ')}
                  >
                    {row.kind}
                  </span>
                  <span className="text-micro text-ink-fg-3">{row.dflt}</span>
                </div>
                <p className="text-meta leading-relaxed text-ink-fg-2">{row.fact}</p>
                <p className="font-mono text-meta leading-relaxed text-ink-fg-3">{row.impl}</p>
                <p className="font-mono text-micro text-ink-fg-3">{row.where}</p>
              </div>
            ))}
          </div>
          <ul className="mt-3 max-w-[900px] space-y-1 text-meta leading-relaxed text-ink-fg-3">
            <li>
              · <b className="font-medium text-ink-fg-2">只管自定义文件夹</b>：两个函数第一句都是
              <code className="mx-1 text-ink-fg-2">if not is_custom_folder_mailbox(mailbox)</code>→
              直接 return False。收件箱 / 发件箱 / 草稿箱不受影响。
              （注意「存档」在后端按自定义文件夹算，见
              <code className="mx-1 text-ink-fg-2">mailbox_semantics.py:72-77</code>。）
            </li>
            <li>
              · <b className="font-medium text-ink-fg-2">上面还有总闸</b>：通知那列要
              <code className="mx-1 text-ink-fg-2">FEISHU_NOTIFY_ENABLED=true</code>
              才有意义，AI 那列要
              <code className="mx-1 text-ink-fg-2">LLM_AGENT_ENABLED=true</code>；两者代码默认都是
              false。控制条里可以关掉看效果。
            </li>
            <li>
              · <b className="font-medium text-warn">两个键匹配的是 mailbox 显示名</b>
              （如「Teams」），而 SYNC_FOLDERS 和方案 C 的{' '}
              <code className="mx-1 text-ink-fg-2">folder_pref</code> 主键存的是 imap 原始名（如{' '}
              <code className="text-ink-fg-2">DMS&VvpO9lPRXgM-</code>
              ）。落地时得定死一头，并处理已有 .env 值的迁移。
            </li>
            <li>
              · 现状这两个键
              <b className="font-medium text-ink-fg-2">有意没进前端 env 白名单</b>（
              <code className="mx-1 text-ink-fg-2">env-keys.ts:102-104</code>、
              <code className="mx-1 text-ink-fg-2">api/routers/settings.py:105-107</code>
              ，原话「JSON 裸文本框手写必错，正解 = 文件夹选择 UI 里 per-folder 两个勾」）——
              也就是说本 mockup 就是那两处注释预定的落点。
            </li>
          </ul>
        </section>

        {/* 24 个候选一览 —— owner 挑得动，也当作动效验收表 */}
        <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
          <h2 className="mb-1 text-body font-semibold">候选图标 · 24 个（全部有动效）</h2>
          <p className="mb-3 max-w-[900px] text-meta leading-relaxed text-ink-fg-3">
            lucide-react@1.16.0 实测 24 个导出名全部存在，无缺项。动效不是统一套一个 transform ——
            每个都是拆开 lucide 内部 path 后按自身语义单做的（描线 / 位移 / 旋转 / 缩放 / 分层
            五类原型，逐个说明见下）。外壳复用主仓 <code className="text-ink-fg-2">IconShell</code>
            ，因此 <code className="text-ink-fg-2">prefers-reduced-motion</code>{' '}
            打开时全部定格静态、不挂 hover 监听。鼠标划过下面任一格即可预览。
          </p>
          <IconGallery />
        </section>
      </div>

      {picker ? (
        <IconPicker
          anchor={picker}
          value={pickerValue}
          onPick={(key) => {
            if (picker.scope === 'builtin') {
              setBuiltinIcons((cur) => ({ ...cur, [picker.key]: key }))
              setDirty(true)
            } else {
              setPref(picker.key, { icon: key })
            }
            setPicker(null)
          }}
          onReset={() => {
            if (picker.scope === 'builtin') {
              setBuiltinIcons((cur) => ({ ...cur, [picker.key]: null }))
              setDirty(true)
            } else {
              setPref(picker.key, { icon: null })
            }
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
