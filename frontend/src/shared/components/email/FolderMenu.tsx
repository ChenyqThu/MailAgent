// task 08-27 P1 Lane B —— 列表头文件夹选择器的下拉面板。
//
// 取代常驻的二级栏文件夹树（原 `layout/SidebarFolderTree.tsx` + DomainPanel 的
// MAILBOXES 段）：邮件域的二级栏现在就是邮件列表本身，切文件夹的入口收进列表头。
//
// 两段：MAILBOXES = registry 的五个内建视图行（单源仍是 `navigation/registry`，这里只
// 投影，不新增路径字面量）；FOLDERS = 已同步的自定义文件夹（whitelist × discover，
// 🔴 数组序 = 用户自定义显示顺序，不排序）。每行行尾一枚 pin，钉到列表头第一行。
//
// 为什么不用全 app 的弹层基座 `ui/Popmenu`：它的一行就是一个 `<button>`，而这里每行要
// 带一枚**独立可点**的 pin 按钮（button 套 button 是非法 DOM），改基座的行结构会动到它
// 的 morph 几何契约。故手写这一档 popover（useExitAnimation + outside-click/Esc 组合），
// 行内是普通按钮，Tab 可达。
//
// MAILBOXES 段按 `NAV_ENTRIES`（**未**经门控过滤）投影 —— 邮件五视图恒 `gate:'always'`，
// 与门控集等价；给哪条加了门控就得改这里，闸在 `tests/shared/navRegistry.test.ts`
// 「邮件五视图恒 gate:always」。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pin } from 'lucide-react'

import { AnimatedIconActiveProvider, FolderGlyph } from '@shared/components/icons'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFolderPrefMap } from '@shared/hooks/useFolderPrefs'
import { cn } from '@shared/lib/cn'
import { flattenFolderTree, type FolderNode } from '@shared/lib/folderTree'
import { DUR } from '@shared/lib/gsap'
import { NAV_ENTRIES, navDomainPanelEntries, navLabel } from '@shared/navigation/registry'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { samePinnedFolder, usePinnedFolders, type PinnedFolder } from '@shared/state/pinned-folders'

interface FolderMenuProps {
  open: boolean
  onClose(): void
  /** 触发器 —— 点它不触发 outside-click 关闭（它自己 toggle）。 */
  anchorRef: React.RefObject<HTMLElement | null>
  /** 已同步自定义文件夹树（调用方持有，pin 图标也要用同一棵）。 */
  tree: readonly FolderNode[]
  onSelectView(view: EmailView): void
  onSelectFolder(node: FolderNode): void
  /** pin 已满时的提示（i18n 在调用方，store 不认识 t）。 */
  onPinRejected(): void
}

/** 一行的公共外壳：主按钮（选中该文件夹）+ 行尾 pin 按钮。 */
function FolderRow({
  icon,
  label,
  title,
  count,
  depth,
  selected,
  pin,
  onSelect,
  onTogglePin
}: {
  icon: React.ReactNode
  label: string
  title: string
  count: number | null
  depth: number
  selected: boolean
  pin: PinnedFolder
  onSelect(): void
  onTogglePin(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const pinned = usePinnedFolders((s) => s.pinned.some((p) => samePinnedFolder(p, pin)))
  // 整行 hover/focus 经 AnimatedIconActiveProvider（zero-DOM Context）驱动行内图标
  // —— 同 DomainPanel.NavRow / 退役的文件夹树行，图标不必被直接 hover 才动。
  const [iconActive, setIconActive] = useState(false)
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onSelect}
        onPointerEnter={() => setIconActive(true)}
        onPointerLeave={() => setIconActive(false)}
        onFocus={() => setIconActive(true)}
        onBlur={() => setIconActive(false)}
        title={title}
        style={depth > 0 ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
        className={cn(
          'row relative flex-1 min-w-0 flex items-center gap-2 h-[30px] px-2 rounded-[var(--r-ctl)]',
          'text-body text-left transition-colors duration-fast',
          selected
            ? 'row-selected acc-select text-ink-fg font-medium'
            : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
        )}
      >
        <AnimatedIconActiveProvider active={iconActive}>{icon}</AnimatedIconActiveProvider>
        <span className="flex-1 truncate">{label}</span>
        {count !== null && count > 0 ? (
          <span className="shrink-0 text-meta font-mono text-ink-fg-2 tabular-nums">
            {count.toLocaleString('en-US')}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-pressed={pinned}
        title={pinned ? t('list.folder.unpin') : t('list.folder.pin')}
        aria-label={
          pinned
            ? t('list.folder.unpinNamed', { name: label })
            : t('list.folder.pinNamed', { name: label })
        }
        className={cn(
          'shrink-0 w-6 h-6 flex items-center justify-center rounded-[var(--r-ctl)]',
          'transition-colors duration-fast',
          pinned ? 'text-coral hover:bg-coral/15' : 'text-ink-fg-3 hover:text-ink-fg hover:bg-ink-3'
        )}
      >
        <Pin size={12} strokeWidth={2} fill={pinned ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

export function FolderMenu({
  open,
  onClose,
  anchorRef,
  tree,
  onSelectView,
  onSelectFolder,
  onPinRejected
}: FolderMenuProps): React.ReactElement | null {
  const { t } = useTranslation()
  const view = useEmailFilter((s) => s.view)
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const togglePin = usePinnedFolders((s) => s.toggle)
  // per-folder 图标 (v62 folder_pref) — 与设置页共用 ['folder','prefs'] 缓存。
  // 失败/缺行静默退回兜底图标（图标是观感，不该让整个面板跟着挂）。
  const prefMap = useFolderPrefMap()

  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: -6, scale: 0.97, transformOrigin: 'top left' },
    enterDuration: DUR.fast
  })

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (scopeRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchorRef, scopeRef])

  if (!shouldRender) return null

  const mailboxEntries = navDomainPanelEntries(NAV_ENTRIES, 'mail')
  const folderRows = flattenFolderTree(tree)

  const handlePin = (pin: PinnedFolder): void => {
    if (!togglePin(pin)) onPinRejected()
  }

  return (
    <div
      ref={scopeRef}
      // 不宣称 role=menu —— 每行是「选中」+「pin」两个独立按钮，menu 的键盘/角色契约
      // （单一 menuitem、方向键漫游）在这个形状下兑现不了；标一个可读的分组名即可，
      // 行本身是普通 button，Tab 可达。
      role="group"
      aria-label={t('list.folder.menuAria')}
      className={cn(
        'glass-pop absolute z-50 left-3 top-[calc(100%+0.375rem)] w-[292px]',
        'rounded-[var(--r-pop)] border border-ink-border p-1.5',
        'max-h-[420px] overflow-y-auto scrollbar-thin'
      )}
    >
      <h2 className="nav-panel-sechdr text-micro font-mono uppercase">
        {t('nav.section.mailboxes')}
      </h2>
      {mailboxEntries.map((entry) => {
        const entryView = entry.view
        if (entryView === undefined) return null
        return (
          <FolderRow
            key={entry.id}
            icon={entry.icon()}
            label={navLabel(entry, t)}
            title={navLabel(entry, t)}
            count={null}
            depth={0}
            selected={customMailbox === null && view === entryView}
            pin={{ kind: 'view', view: entryView }}
            onSelect={() => {
              onSelectView(entryView)
              onClose()
            }}
            onTogglePin={() => handlePin({ kind: 'view', view: entryView })}
          />
        )
      })}
      {folderRows.length > 0 ? (
        <>
          <h2 className="nav-panel-sechdr text-micro font-mono uppercase">
            {t('nav.section.folders')}
          </h2>
          {folderRows.map(({ node, depth }) => (
            <FolderRow
              key={node.imapName}
              icon={
                <FolderGlyph
                  iconKey={prefMap.get(node.imapName)?.icon}
                  size={15}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
              }
              label={node.displayName}
              title={node.fullDisplayName}
              count={node.count}
              depth={depth}
              selected={customMailbox === node.fullDisplayName}
              pin={{ kind: 'folder', mailbox: node.fullDisplayName }}
              onSelect={() => {
                onSelectFolder(node)
                onClose()
              }}
              onTogglePin={() => handlePin({ kind: 'folder', mailbox: node.fullDisplayName })}
            />
          ))}
        </>
      ) : null}
    </div>
  )
}
