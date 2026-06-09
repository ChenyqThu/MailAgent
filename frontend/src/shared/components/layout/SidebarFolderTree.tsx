// 多文件夹同步 (P3) — Sidebar MAILBOXES 段的「自定义文件夹树」(界面③)。
//
// 照 mockup ③(docs/mockups/multi-folder-sync/index.html §s3): 在「收件箱/发件箱/
// 存档/草稿箱/已标旗/所有邮件」之后追加已勾选(whitelist)文件夹, 树形缩进 + 展开
// 收起 chevron, 点击 setCustomMailbox(display_name) 过滤列表, 选中态 coral pill,
// 过长时「展开更多/折叠」。🔴 三段铁律: 文件夹挂 MAILBOXES 段内, 绝不新增 header。
//
// 数据源: getWhitelist (imap 原始名) + discover (display_name/count/parent)。只渲染
// whitelist ⊆ 的文件夹; 用 parent 链还原层级 (父未勾但子勾 → 子升顶层, 不丢)。
// 收起态(56px)由全局 .app-nav[data-collapsed] CSS 接管 (label/chevron span 自动
// 隐藏, 只剩 folder 图标 + title tooltip), 本组件不特判收起态。
//
// 隔离不变量: whitelist 空 → 整段不渲染任何行 (= 现状, 不破坏既有 Sidebar 行)。

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Folder } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { useEmailFilter } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'

import { buildSidebarFolderTree, type SidebarFolderNode } from './sidebarFolderTree.helpers'

// 顶层默认显示上限, 超出折成「展开更多 (+N)」(照 mockup nav-more)。
const COLLAPSE_THRESHOLD = 5

/** 收起态(56px)给文件夹行补 HoverTip — 临摹 Sidebar.maybeWrapTip: 内建行收起态
 *  靠 HoverTip(side="right" portal) 浮现名称 (Electron 原生 title= 不可靠)。仅在
 *  collapsed 时包裹 (展开态 label 已可见, 不包 = 不变); portal 让 chip 升到
 *  document.body, 不被 56px 窄 <aside> + overflow 裁剪。 */
function maybeWrapFolderTip(
  collapsed: boolean,
  title: string,
  child: React.ReactElement
): React.ReactElement {
  if (!collapsed) return child
  return (
    <HoverTip text={title} side="right" portal className="w-full">
      {child}
    </HoverTip>
  )
}

interface SidebarFolderRowProps {
  node: SidebarFolderNode
  depth: number
  activeMailbox: string | null
  collapsed: boolean
  expanded: ReadonlySet<string>
  onSelect: (node: SidebarFolderNode) => void
  onToggleExpand: (imapName: string) => void
}

/** 单行 NavRow 风格 + 递归子节点。临摹 Sidebar.NavRow / CountRight 的视觉语言。 */
function SidebarFolderRow({
  node,
  depth,
  activeMailbox,
  collapsed,
  expanded,
  onSelect,
  onToggleExpand
}: SidebarFolderRowProps): React.ReactElement {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imapName)
  const selected = activeMailbox === node.fullDisplayName
  const count = node.count ?? 0

  const isDisabled = node.isDisabled === true

  // 收起态时 HoverTip 接管名称浮现 → 不再设原生 title= (避免双 tooltip, 同
  // Sidebar.maybeWrapTip 语义)。展开态保留原生 title (含 disabled 提示)。
  const nativeTitle = collapsed
    ? undefined
    : isDisabled
      ? t('nav.folderTree.disabledTip', {
          defaultValue: '等待文件夹信息加载后可点击',
          context: node.imapName
        })
      : node.fullDisplayName

  // 收起态 tooltip 文案: 禁用行用 disabledTip, 否则用叶子全路径名 (= 原 title)。
  const collapsedTip = isDisabled
    ? t('nav.folderTree.disabledTip', {
        defaultValue: '等待文件夹信息加载后可点击',
        context: node.imapName
      })
    : node.fullDisplayName

  return (
    <>
      {maybeWrapFolderTip(
        collapsed,
        collapsedTip,
        <button
          type="button"
          onClick={() => {
            if (!isDisabled) onSelect(node)
          }}
          disabled={isDisabled}
          title={nativeTitle}
          // 缩进用 paddingLeft (depth*14); 收起态 CSS 用 padding-inline 覆盖, 缩进自然消失。
          style={depth > 0 ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
          className={cn(
            'row relative w-full flex items-center gap-2.5 px-2 py-1 rounded-md',
            'text-body text-left transition-colors duration-fast',
            isDisabled
              ? 'opacity-50 cursor-not-allowed text-ink-fg-2'
              : selected
                ? 'row-selected bg-ink-4 text-ink-fg font-medium'
                : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg'
          )}
        >
          {/* expand chevron — 仅父节点; <span> 非 app-nav-keep, 收起态自动隐藏。 */}
          {hasChildren ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label={
                isOpen
                  ? t('nav.folderTree.collapse', { defaultValue: '收起' })
                  : t('nav.folderTree.expand', { defaultValue: '展开' })
              }
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand(node.imapName)
              }}
              className="shrink-0 -ml-1 inline-flex items-center justify-center w-4 h-4 rounded text-ink-fg-2 hover:text-ink-fg"
            >
              {isOpen ? (
                <ChevronDown size={12} strokeWidth={2} />
              ) : (
                <ChevronRight size={12} strokeWidth={2} />
              )}
            </span>
          ) : depth > 0 ? (
            <span className="shrink-0 w-4 h-4" aria-hidden="true" />
          ) : null}

          <Folder size={15} strokeWidth={1.75} className="shrink-0" />
          <span className="flex-1 truncate">{node.displayName}</span>
          {count > 0 ? (
            selected ? (
              <span className="text-[10px] leading-none font-mono tabular-nums px-1 py-px rounded-[3px] border border-coral/30 bg-coral/15 text-ink-fg">
                {count.toLocaleString('en-US')}
              </span>
            ) : (
              <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
                {count.toLocaleString('en-US')}
              </span>
            )
          ) : null}
        </button>
      )}

      {hasChildren && isOpen
        ? node.children.map((child) => (
            <SidebarFolderRow
              key={child.imapName}
              node={child}
              depth={depth + 1}
              activeMailbox={activeMailbox}
              collapsed={collapsed}
              expanded={expanded}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
            />
          ))
        : null}
    </>
  )
}

/** MAILBOXES 段内的自定义文件夹树。whitelist 空 → 渲染 null (隔离不变量)。 */
export function SidebarFolderTree(): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const setCustomMailbox = useEmailFilter((s) => s.setCustomMailbox)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // 收起态 — 内建行收起态 hover 出 tooltip; 文件夹行对齐 (Fix: 自定义文件夹收起无 tip)。
  const collapsed = useNavCollapsed((s) => s.collapsed)

  const pollingInterval = usePollingFallback()

  // whitelist — 轻量 (.env 读), 常拉。空 → 不发 discover (省 IMAP LIST/STATUS)。
  const { data: whitelistData } = useQuery({
    queryKey: ['folder', 'whitelist'],
    queryFn: () => mailApi.folder.getWhitelist(),
    staleTime: 30_000,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false
  })
  const whitelist = React.useMemo(() => new Set(whitelistData?.folders ?? []), [whitelistData])
  const hasWhitelist = whitelist.size > 0

  // discover — 重 (IMAP LIST + STATUS), 仅在有白名单时拉, 长缓存。失败/门控静默
  // (folder 名仍可从 whitelist 兜底, 但无 display_name/count → 退化用 imap_name)。
  const { data: discoverData } = useQuery({
    queryKey: ['folder', 'discover'],
    queryFn: () => mailApi.folder.discover({ counts: true }),
    enabled: hasWhitelist,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: false
  })

  const tree = React.useMemo<SidebarFolderNode[]>(() => {
    if (!hasWhitelist) return []
    const folders = discoverData?.folders
    if (folders && folders.length > 0) {
      return buildSidebarFolderTree(folders, whitelist)
    }
    // discover 未就绪/失败 — 退化平铺显示 imap_name; display_name 未解码所以禁用
    // 点击 (用 imap_name 过滤永不匹配解码后 mailbox → 空列表, 比不响应更糟)。
    return Array.from(whitelist).map((imapName) => ({
      imapName,
      displayName: imapName,
      fullDisplayName: imapName,
      count: null,
      path: [imapName],
      children: [],
      isDisabled: true
    }))
  }, [hasWhitelist, discoverData, whitelist])

  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const [showAll, setShowAll] = React.useState(false)

  const toggleExpand = React.useCallback((imapName: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })
  }, [])

  const handleSelect = React.useCallback(
    (node: SidebarFolderNode): void => {
      // 过滤 key 必须用完整 display_name (后端 email_metadata.mailbox = 完整解码路径)。
      // path 末段用叶子名 (面包屑显示); fullDisplayName 是 WHERE mailbox= 匹配值。
      setCustomMailbox(node.fullDisplayName, node.path)
      // StatusBar mailbox 段保持同步 (仿 Sidebar.handleViewClick)。
      setActiveMailbox(node.fullDisplayName)
      // 非邮件路由时跳回收件箱列表 (EmailList 据 customMailbox 过滤; 不动 view)。
      if (pathname !== '/') void navigate({ to: '/' })
    },
    [setCustomMailbox, setActiveMailbox, navigate, pathname]
  )

  if (!hasWhitelist || tree.length === 0) return null

  const overflow = tree.length > COLLAPSE_THRESHOLD
  const visible = overflow && !showAll ? tree.slice(0, COLLAPSE_THRESHOLD) : tree
  const hiddenCount = tree.length - COLLAPSE_THRESHOLD

  // 自定义文件夹高亮仅在邮件列表路由 (`/`) 有效。切到非邮件主视图 (Custom AI
  // Agents /agents · 报告 · 日历 · 设置 · 会话历史 等) 时 customMailbox 不走 setView
  // 清除 → 残留会导致与目标区双高亮。与内建 MAILBOXES 行的 `onInbox` 选中态门控
  // (Sidebar.tsx selectedView) 对齐: 仅 pathname==='/' 时按 customMailbox 高亮。
  const activeMailbox = pathname === '/' ? customMailbox : null

  return (
    <>
      {visible.map((node) => (
        <SidebarFolderRow
          key={node.imapName}
          node={node}
          depth={0}
          activeMailbox={activeMailbox}
          collapsed={collapsed}
          expanded={expanded}
          onSelect={handleSelect}
          onToggleExpand={toggleExpand}
        />
      ))}
      {overflow ? (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="row w-full flex items-center gap-2.5 px-2 py-1 rounded-md text-body text-left text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
        >
          {showAll ? (
            <ChevronDown size={13} strokeWidth={2} className="shrink-0 rotate-180" />
          ) : (
            <ChevronDown size={13} strokeWidth={2} className="shrink-0" />
          )}
          <span className="flex-1 truncate">
            {showAll
              ? t('nav.folderTree.showLess', { defaultValue: '折叠' })
              : t('nav.folderTree.showMore', {
                  defaultValue: '展开更多（+{count}）',
                  count: hiddenCount
                })}
          </span>
        </button>
      ) : null}
    </>
  )
}
