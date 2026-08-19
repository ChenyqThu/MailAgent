// 设置-邮箱「已同步文件夹」逐个选图标 + 侧边栏同序同图标 —— 验收 mockup。
//
// 复用的真东西（不是仿的）：
//   · 主仓 design token（直接 import src/electron/renderer/index.css）
//   · 主仓拖拽基座 @shared/components/ui/DragReorderList（走它的 renderItem
//     逃生舱塞图标按钮，壳与交互内核一行没动）
//   · 主仓动效图标外壳 IconShell + AnimatedIconActiveProvider
//     （@shared/components/icons）—— 24 个 folder 图标的动效见 ./animated.tsx
//   · 侧边栏行的 authored CSS（.app-nav / .row / .row-selected / .acc-select），
//     所以选中左光条、收起态 56px rail 的行为与真 App 一致
//   · 侧边栏内建 5 行用的就是主仓那 5 个动效图标（FolderInput / Send / Feather
//     / Zap / Folders），和真 Sidebar.tsx 逐字一致
//
// mockup 里是假的：文件夹数据（真名假计数，见 data.ts）、保存链路（只打日志）。

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
import { BUILTIN_ROWS, SYNCED_FOLDERS, type SyncedFolder } from './data'

/* ── 小工具 ─────────────────────────────────────────────────────── */

function Tip({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span className="mk-tip">
      {children}
      <span className="mk-tip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  )
}

/** 内建 5 行用主仓现成的动效图标（= 真 Sidebar.tsx 的 MAILBOX_ICON）。 */
const BUILTIN_ICON: Record<string, (p: AnimatedIconProps) => React.ReactElement> = {
  'folder-input': FolderInputIcon,
  send: SendIcon,
  feather: FeatherIcon,
  zap: ZapIcon,
  folders: FoldersIcon
}

/* ── 图标选择器 ─────────────────────────────────────────────────── */

interface PickerAnchor {
  imapName: string
  displayName: string
  rect: DOMRect
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
          <span className="shrink-0 font-mono text-meta text-ink-fg-2">{shown ?? 'folder'}</span>
          <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-3">
            {shown ? FOLDER_ICON_MOTION[shown] : '默认，未设置'}
          </span>
        </div>
      </div>
    </>
  )
}

/* ── 设置页：已同步文件夹顺序 + 图标 ─────────────────────────────── */

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

/** 列表行里的当前图标按钮 —— hover 播动效，点开选择器。 */
function FolderIconButton({
  folder,
  open,
  onOpen
}: {
  folder: SyncedFolder
  open: boolean
  onOpen: (e: React.MouseEvent<HTMLButtonElement>, f: SyncedFolder) => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  const Icon = folderIcon(folder.icon)
  return (
    <Tip label="更换图标">
      <button
        type="button"
        aria-label={`更换「${folder.displayName}」的图标`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // 行上 pointerdown 会起拖；按钮自己吃掉，点图标不会误拖。
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => onOpen(e, folder)}
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

/* ── 侧边栏预览 ─────────────────────────────────────────────────── */

function NavRow({
  Icon,
  label,
  count,
  selected,
  onClick
}: {
  Icon: (p: AnimatedIconProps) => React.ReactElement
  label: string
  count?: number
  selected?: boolean
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
      <AnimatedIconActiveProvider active={iconActive}>
        <Icon size={15} strokeWidth={1.75} trigger="parent" />
      </AnimatedIconActiveProvider>
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

function SidebarPreview({
  folders,
  collapsed,
  active,
  onSelect
}: {
  folders: readonly SyncedFolder[]
  collapsed: boolean
  active: string | null
  onSelect: (imapName: string) => void
}): React.ReactElement {
  return (
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
          <NavRow key={row.id} Icon={BUILTIN_ICON[row.icon]!} label={row.label} count={row.count} />
        ))}
        {/* 自定义文件夹 —— 顺序与图标都跟左边设置页联动。 */}
        {folders.map((f) => (
          <NavRow
            key={f.imapName}
            Icon={folderIcon(f.icon)}
            label={f.displayName}
            count={f.count}
            selected={active === f.imapName}
            onClick={() => onSelect(f.imapName)}
          />
        ))}
      </nav>
    </div>
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

/* ── 页面 ───────────────────────────────────────────────────────── */

function App(): React.ReactElement {
  const [order, setOrder] = useState<string[]>(() => SYNCED_FOLDERS.map((f) => f.imapName))
  const [icons, setIcons] = useState<Record<string, FolderIconKey | null>>(() =>
    Object.fromEntries(SYNCED_FOLDERS.map((f) => [f.imapName, f.icon]))
  )
  const [picker, setPicker] = useState<PickerAnchor | null>(null)
  const [active, setActive] = useState<string | null>('DMS&VvpO9lPRXgM-')
  const [collapsed, setCollapsed] = useState(false)
  const [light, setLight] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', light ? 'light' : 'dark')
    root.classList.toggle('dark', !light)
  }, [light])

  const byImap = useMemo(() => new Map(SYNCED_FOLDERS.map((f) => [f.imapName, f])), [])

  /** 侧边栏取的就是这一份：order 的数组序 + icons 的每项取值。 */
  const ordered = useMemo<SyncedFolder[]>(
    () =>
      order.map((imapName) => {
        const base = byImap.get(imapName)!
        return { ...base, icon: icons[imapName] ?? null }
      }),
    [order, icons, byImap]
  )

  const items = useMemo<ReorderItem[]>(
    () => ordered.map((f) => ({ id: f.imapName, label: f.displayName })),
    [ordered]
  )

  const handleReorder = useCallback((list: ReorderItem[]): void => {
    setOrder(list.map((i) => i.id))
    setDirty(true)
  }, [])

  const openPicker = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>, f: SyncedFolder): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      setPicker((cur) =>
        cur?.imapName === f.imapName
          ? null
          : { imapName: f.imapName, displayName: f.displayName, rect }
      )
    },
    []
  )

  const reset = (): void => {
    setOrder(SYNCED_FOLDERS.map((f) => f.imapName))
    setIcons(Object.fromEntries(SYNCED_FOLDERS.map((f) => [f.imapName, f.icon])))
    setDirty(false)
    setPicker(null)
  }

  return (
    <div className="min-h-screen bg-ink-1 px-8 py-7 text-ink-fg">
      <div className="mx-auto max-w-[1180px] space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">已同步文件夹 · 每个文件夹选图标 — mockup</h1>
          <p className="text-meta text-ink-fg-3">
            左边是设置-邮箱的「已同步文件夹顺序」区（拖拽排序已上线，本次新增图标），右边是侧边栏按同序同图标渲染。
            拖一行、换一个图标，看右边同步变。24 个图标都是动效版：hover
            列表行、侧边栏行、选择器格子都会播各自的动作。
          </p>
        </header>

        {/* 控制条 —— mockup 自己的开关，不是产品 UI。 */}
        <section className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[var(--r-card)] border border-ink-border bg-ink-2 px-4 py-3 text-meta">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={light} onChange={(e) => setLight(e.target.checked)} />
            <span>亮色主题</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={collapsed}
              onChange={(e) => setCollapsed(e.target.checked)}
            />
            <span>侧边栏收起态（56px rail）</span>
          </label>
          <span className="text-ink-fg-3">
            收起态只剩图标 —— 这是本需求最实的收益：五个自定义文件夹现在全长一个样。
          </span>
          <button
            type="button"
            onClick={reset}
            className="ml-auto rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 transition-colors duration-fast hover:bg-ink-3"
          >
            重置
          </button>
        </section>

        <div className="flex flex-wrap items-start gap-6">
          {/* 设置页一侧 —— 复刻 FolderPicker 底部的顺序区 */}
          <section className="min-w-[520px] flex-1 rounded-lg border border-ink-border-soft">
            <div className="border-b border-ink-border-soft px-3 py-2">
              <span className="text-meta text-ink-fg-2">
                设置 › 邮箱 › 自定义文件夹同步
                <span className="text-ink-fg-3">{' · 共 18 个文件夹'}</span>
              </span>
            </div>

            <div className="border-b border-ink-border-soft px-3 py-2.5">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-aux font-medium text-ink-fg">已同步文件夹顺序</span>
                <span className="text-meta text-ink-fg-2">
                  拖拽调整，点图标可更换；侧边栏按此顺序与图标显示
                </span>
              </div>

              <DragReorderList
                items={items}
                onReorder={handleReorder}
                messages={REORDER_MESSAGES}
                rowClassName="py-2 pr-3"
                renderItem={(item, index) => {
                  const f = ordered[index]!
                  return (
                    <span className="flex min-w-0 items-center gap-2.5">
                      <FolderIconButton
                        folder={f}
                        open={picker?.imapName === f.imapName}
                        onOpen={openPicker}
                      />

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-ink-fg">{item.label}</span>
                        <span className="block truncate font-mono text-meta text-ink-fg-3">
                          {f.imapName}
                        </span>
                      </span>

                      <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-2">
                        {f.count.toLocaleString('en-US')}
                      </span>
                      <span
                        className="w-4 shrink-0 text-right text-meta tabular-nums text-ink-fg-3"
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                    </span>
                  )
                }}
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 px-3 py-2.5">
              {dirty ? (
                <span className="mr-auto text-meta text-ink-fg-2">
                  仅调整显示顺序与图标，保存后立即生效
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
            <SidebarPreview
              folders={ordered}
              collapsed={collapsed}
              active={active}
              onSelect={setActive}
            />
            <div className="max-w-[240px] text-meta leading-relaxed text-ink-fg-3">
              上面 5
              行是内建邮箱（收件箱…所有邮件），用的就是主仓现成的动效图标，本次不动。「归档」起的 6
              行才是 SYNC_FOLDERS 里的自定义文件夹，顺序与图标都由左边那份配置决定。
            </div>
          </section>
        </div>

        {/* 24 个候选一览 —— owner 挑得动，也当作动效验收表 */}
        <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-5">
          <h2 className="mb-1 text-body font-semibold">候选图标 · 24 个（全部有动效）</h2>
          <p className="mb-3 text-meta leading-relaxed text-ink-fg-3">
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
          value={icons[picker.imapName] ?? null}
          onPick={(key) => {
            setIcons((cur) => ({ ...cur, [picker.imapName]: key }))
            setDirty(true)
            setPicker(null)
          }}
          onReset={() => {
            setIcons((cur) => ({ ...cur, [picker.imapName]: null }))
            setDirty(true)
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
