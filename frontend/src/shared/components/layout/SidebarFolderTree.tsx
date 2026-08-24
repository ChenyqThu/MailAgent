// 多文件夹同步 (P3) — Sidebar MAILBOXES 段的「自定义文件夹树」(界面③)。
//
// 照 mockup ③(docs/mockups/multi-folder-sync/index.html §s3): 在「收件箱/发件箱/
// 存档/草稿箱/已标旗/所有邮件」之后追加已勾选(whitelist)文件夹, 树形缩进 + 展开
// 收起 chevron, 点击 setCustomMailbox(display_name) 过滤列表, 选中态 coral pill,
// 过长时「展开更多/折叠」。🔴 三段铁律: 文件夹挂 MAILBOXES 段内, 绝不新增 header。
//
// 数据源: getWhitelist (imap 原始名) + discover (display_name/count/parent)。只渲染
// whitelist ⊆ 的文件夹; 用 parent 链还原层级 (父未勾但子勾 → 子升顶层, 不丢)。
// discover 未就绪时用本地 seed 树兜底 (task 08-20-perf-shell-prefetch-sidebar §③):
// whitelist 逐项 decodeImapUtf7 合成 display_name (与 email_metadata.mailbox 同源
// 同值), 立即**可点**; discover 回来后换正式树 (同 orderIndex 排序, 零跳变)。
// 收起态(56px)由全局 .app-nav[data-collapsed] CSS 接管 (label/chevron span 自动
// 隐藏, 只剩 folder 图标 + title tooltip), 本组件不特判收起态。
//
// 隔离不变量: whitelist 空 → 整段不渲染任何行 (= 现状, 不破坏既有 Sidebar 行)。

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { useFolderPrefMap } from '@shared/hooks/useFolderPrefs'
import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { useEmailFilter } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'
import { useNavCollapsed } from '@shared/state/nav-shell'
import { cn } from '@shared/lib/cn'
import { AnimatedIconActiveProvider, FolderGlyph } from '@shared/components/icons'
import { HoverTip } from '@shared/components/ui/HoverTip'

import {
  buildSeedFolderInfos,
  buildSidebarFolderTree,
  type SidebarFolderNode
} from './sidebarFolderTree.helpers'

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
  /** imap_name → `folder_pref.icon`（lucide kebab 名）。取不到 = 没设过 → 兜底 folder。
   *  🔴 收起态 56px rail 上只剩这个图标，是它区分各文件夹的唯一线索。 */
  iconKeys: ReadonlyMap<string, string | null>
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
  iconKeys,
  onSelect,
  onToggleExpand
}: SidebarFolderRowProps): React.ReactElement {
  const { t } = useTranslation()
  // 整行 hover/focus 经 AnimatedIconActiveProvider 驱动图标动画（同 NavRow 范式）。
  const [iconActive, setIconActive] = React.useState(false)
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imapName)
  const selected = activeMailbox === node.fullDisplayName
  const count = node.count ?? 0

  // 收起态时 HoverTip 接管名称浮现 → 不再设原生 title= (避免双 tooltip, 同
  // Sidebar.maybeWrapTip 语义)。展开态保留原生 title。
  // (seed 树的 display_name 已本地解码 → 不再有「等待加载」的 disabled 行。)
  const nativeTitle = collapsed ? undefined : node.fullDisplayName

  return (
    <>
      {maybeWrapFolderTip(
        collapsed,
        node.fullDisplayName,
        <button
          type="button"
          onClick={() => onSelect(node)}
          onPointerEnter={() => setIconActive(true)}
          onPointerLeave={() => setIconActive(false)}
          onFocus={() => setIconActive(true)}
          onBlur={() => setIconActive(false)}
          title={nativeTitle}
          // 缩进用 paddingLeft (depth*14); 收起态 CSS 用 padding-inline 覆盖, 缩进自然消失。
          style={depth > 0 ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
          className={cn(
            'row relative w-full flex items-center gap-2.5 px-2 py-1 rounded-[var(--r-ctl)]',
            'text-body text-left transition-colors duration-fast',
            selected
              ? 'row-selected acc-select text-ink-fg font-medium'
              : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
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
              // #16 命中区扩展 — 视觉仍 16px，但 ::before 把可点区域纵向撑到
              // 整行高度、横向 +4px，不放大可见 swatch 故不压到父行选中左光条
              // (row-selected::before left:-8px) 也不与父行选中区视觉重合。
              className="shrink-0 -ml-1 relative inline-flex items-center justify-center w-4 h-4 rounded text-ink-fg-2 hover:text-ink-fg before:absolute before:-inset-y-1 before:-inset-x-0.5 before:content-['']"
            >
              <ChevronRight
                size={12}
                strokeWidth={2}
                className={cn('transition-transform duration-fast', isOpen && 'rotate-90')}
              />
            </span>
          ) : depth > 0 ? (
            <span className="shrink-0 w-4 h-4" aria-hidden="true" />
          ) : null}

          {/* 用户在设置页挑的图标；没设过 / key 不认识 → FolderGlyph 兜底回默认 folder。
              🔴 svg 必须是 button 的直接子节点（FolderGlyph 与 Provider 都不加 DOM）——
              收起态 56px rail 的图标放大规则选的就是 `button > svg`。 */}
          <AnimatedIconActiveProvider active={iconActive}>
            <FolderGlyph
              iconKey={iconKeys.get(node.imapName)}
              size={15}
              strokeWidth={1.75}
              className="shrink-0"
            />
          </AnimatedIconActiveProvider>
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
              iconKeys={iconKeys}
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

  // connectedIntervalMs — SSE 连上后不归零而留 5min 保险轮询 (邮件主列表 a5953a13
  // 同纪律)。whitelist 一旦打空整段树就消失, 而 SSE 秒级连上就会把兜底轮询清掉,
  // 于是「等下一次轮询」这条退路在自定义文件夹这里原本是不存在的。
  const pollingInterval = usePollingFallback({ connectedIntervalMs: 300_000 })

  // whitelist — 轻量 (.env 读), 常拉。空 → 不发 discover (省 IMAP LIST/STATUS)。
  //
  // 🔴 retry 按错误码: 它是开窗那一瞬最早发出的 serve-api query, 冷启时 renderer 常比
  // serve-api 先起 → 首拉 E_NETWORK, 而全局 retry:1 一秒内两发就废完; 失败即整段树不
  // 渲染 (下方 hasWhitelist 门), AppShell 单例化后 Sidebar 也不再随路由 remount 自愈。
  // 业务错误 (非 davmail 后端的 E_INVALID_ARG) 重试结果一样, 只会把门控态拖慢 → 不重。
  const { data: whitelistData } = useQuery({
    queryKey: qk.folder.whitelist(),
    queryFn: () => mailApi.folder.getWhitelist(),
    staleTime: 30_000,
    retry: (failureCount, error) =>
      (error as { code?: string } | null)?.code === 'E_NETWORK' && failureCount < 5,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false
  })
  // 🔴 保留数组序 —— SYNC_FOLDERS 数组序 = 用户自定义显示顺序 (排序 task)。
  // Set 化会丢序, 只在需要成员判定的地方局部构造。
  const whitelist = React.useMemo(() => whitelistData?.folders ?? [], [whitelistData])
  const hasWhitelist = whitelist.length > 0

  // discover — 仅在有白名单时拉 (enabled 判据是 whitelist query 的 data, 缓存有值
  // **首帧即真** → 重挂载不再等一轮 whitelist 网络往返, 冷启动才有真串行), 长缓存。
  // 失败/门控静默 (seed 树仍在场, 见下)。counts:false (issue #45) — 大邮箱逐文件夹
  // STATUS 分钟级; 树只需 display_name/层级, count 缺失 null-safe (count ?? 0 →
  // badge 仅 >0 渲染)。与 FolderPicker 共用缓存 key (它发的请求带 refresh=true
  // 穿透服务端 60s TTL; 这里缺省 false 吃缓存), counts 语义保持一致。
  const { data: discoverData } = useQuery({
    queryKey: qk.folder.discover(),
    queryFn: () => mailApi.folder.discover({ counts: false }),
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
    // discover 未就绪/失败 — 本地 seed 树 (§③): whitelist 逐项 decodeImapUtf7 合成
    // display_name (与 email_metadata.mailbox 同源同值 → **可点**, 过滤 key 正确),
    // 走同一条 buildSidebarFolderTree 路径 (🔴 同 orderIndex 排序, discover 回来零跳变)。
    return buildSidebarFolderTree(buildSeedFolderInfos(whitelist), whitelist)
  }, [hasWhitelist, discoverData, whitelist])

  // per-folder 图标 (v62 folder_pref) — 与设置页共用 ['folder','prefs'] 缓存。无条件
  // 并发拉 (§③ 拆串行: 纯本地 SQLite 读, 不依赖 whitelist, 不必排在它后面)；
  // 失败/缺行静默退回兜底图标 (图标是观感, 不该让整棵树跟着挂)。
  const prefMap = useFolderPrefMap()
  const iconKeys = React.useMemo<ReadonlyMap<string, string | null>>(() => {
    const m = new Map<string, string | null>()
    for (const [imapName, pref] of prefMap) m.set(imapName, pref.icon)
    return m
  }, [prefMap])

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
          iconKeys={iconKeys}
          onSelect={handleSelect}
          onToggleExpand={toggleExpand}
        />
      ))}
      {overflow ? (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="row w-full flex items-center gap-2.5 px-2 py-1 rounded-[var(--r-ctl)] text-body text-left text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4 transition-colors duration-fast"
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
