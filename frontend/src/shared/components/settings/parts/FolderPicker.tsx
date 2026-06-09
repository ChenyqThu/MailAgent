// 多文件夹同步 (P3) — 设置页「自定义文件夹同步」文件夹树选择器。
//
// 照 mockup ①(docs/mockups/multi-folder-sync/index.html §s1): 刷新按钮拉
// discover → 树形渲染(缩进 + 展开/收起 chevron) + 勾选框(imap_name 为 key) +
// 邮件数(mono) + 大文件夹 ⚠较大 + 系统文件夹 lock 灰态 + 空态 + davmail 门控态 +
// 保存(setWhitelist)。窗口配置(FOLDER_SYNC_PAST_DAYS / MAX_MESSAGES)由 SyncTab 用
// 现成 EnvField 渲染, 不在本组件内。管理操作(新建/重命名/删除)是 P4, 本组件不含。
//
// 数据流: discover() 返回 {folders(flat, 带 is_synced), tree(嵌套), whitelist}。
// 用 tree 渲染层级, 选中态用本地 Set<imap_name>(初值 = whitelist)。保存调
// setWhitelist(Array.from(selected)) → restart 生效 → markRestartRequired。
//
// 门控: 非 davmail 后端 serve-api discover 返回 400 E_INVALID_ARG → 抛带 code 的
// Error, 这里捕获后切「需要 davmail 后端」veil。也提前用 MAILAGENT_BACKEND env
// 值做乐观门控(避免无谓的 discover 请求)。

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  Inbox,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Send,
  Server,
  Trash2,
  X
} from 'lucide-react'

import type { FolderCleanupResult, FolderInfo, FolderTreeNode } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useEnvStore } from '@shared/state/env'
import { useEmailFilter } from '@shared/state/email-filter'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'
import { cn } from '@shared/lib/cn'

// 大文件夹阈值 — 超过则展示「较大」徽标 + 首次同步较慢提示 (照 mockup ① · §4)。
const LARGE_FOLDER_THRESHOLD = 1000

/** 读单个 managed-env 值, 不订阅整个 store (仿 RemoteAccessTab.useEnvValue)。 */
function useEnvValue(key: string): string {
  return useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values[key] ?? '') : ''
  )
}

/** system folder 图标 — special_use / INBOX 用对应图标, 其余 fallback Folder。 */
function systemIcon(node: FolderInfo): React.ReactNode {
  if (node.special_use === '\\sent')
    return <Send size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
  if (node.imap_name.toUpperCase() === 'INBOX')
    return <Inbox size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
  return <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
}

// 管理操作 (P4) — inline 输入态: create(在 parent 下新建) / rename(改本节点)。
type EditState =
  | { mode: 'create'; parentImapName: string | null; value: string }
  | { mode: 'rename'; imapName: string; value: string }

interface ManageHandlers {
  /** 当前打开 ⋯ 菜单的 imap_name (null = 全关)。 */
  menuFor: string | null
  /** 当前 inline 编辑态 (null = 无)。 */
  edit: EditState | null
  /** 编辑提交中 (新建/重命名) 锁输入。 */
  editBusy: boolean
  onOpenMenu: (imapName: string | null) => void
  onStartCreate: (parentImapName: string) => void
  onStartRename: (node: FolderTreeNode) => void
  onRequestDelete: (node: FolderTreeNode) => void
  onEditChange: (value: string) => void
  onEditSubmit: () => void
  onEditCancel: () => void
}

// P5 — inline 清理提示 props。
interface CleanupRowHandlers {
  /** 正在清理中的 imap_name (null = 无)。 */
  cleanupBusy: string | null
  /** 当前待确认清理的 imap_name 集合。 */
  cleanupPrompts: ReadonlySet<string>
  onCleanup: (imapName: string, displayName: string) => void
  onDismissCleanup: (imapName: string) => void
}

interface FolderRowProps {
  node: FolderTreeNode
  depth: number
  selected: ReadonlySet<string>
  expanded: ReadonlySet<string>
  onToggleSelect: (imapName: string) => void
  onToggleExpand: (imapName: string) => void
  manage: ManageHandlers
  cleanup: CleanupRowHandlers
}

/** inline 输入行 (新建子文件夹 / 重命名)。coral ring + 勾/叉确认。 */
function InlineEditRow({
  depth,
  value,
  placeholder,
  busy,
  icon,
  onChange,
  onSubmit,
  onCancel
}: {
  depth: number
  value: string
  placeholder: string
  busy: boolean
  icon: React.ReactNode
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}): React.ReactElement {
  const indentPx = depth * 22
  // inline 编辑刚由用户主动触发 → mount 时聚焦 + 全选 (ref+effect, 不用 autoFocus
  // 属性以满足 jsx-a11y 与 React 受控聚焦时机)。
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 bg-ink-2"
      style={{ paddingLeft: `${12 + indentPx}px` }}
    >
      <span className="shrink-0 w-4 h-4" aria-hidden="true" />
      <span className="shrink-0 w-4 h-4" aria-hidden="true" />
      {icon}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
          else if (e.key === 'Escape') onCancel()
        }}
        className={cn(
          'flex-1 min-w-0 px-2 py-1 rounded-md text-aux bg-ink-1 text-ink-fg',
          'border border-coral/60 outline-none focus:ring-2 focus:ring-coral/30',
          'disabled:opacity-60'
        )}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || value.trim() === ''}
        className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ok hover:bg-ink-3 transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none"
      >
        {busy ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Check size={14} strokeWidth={2.5} />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast disabled:opacity-40"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/** 单行 + 递归子节点。系统文件夹: lock 灰态不可选; 自定义: checkbox + count + 大徽标
 *  + 行尾 ⋯ 管理菜单 (P4, hover 显)。 */
function FolderRow({
  node,
  depth,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
  manage,
  cleanup
}: FolderRowProps): React.ReactElement {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imap_name)
  const isChecked = selected.has(node.imap_name)
  const isLarge = (node.message_count ?? 0) > LARGE_FOLDER_THRESHOLD
  // 缩进: 22px / 层 (照 mockup f-ind 宽度)。chevron 占位让叶子与父对齐。
  const indentPx = depth * 22

  const isRenaming = manage.edit?.mode === 'rename' && manage.edit.imapName === node.imap_name
  const isCreatingHere =
    manage.edit?.mode === 'create' && manage.edit.parentImapName === node.imap_name
  const menuOpen = manage.menuFor === node.imap_name

  // 重命名态: 整行替换为 inline 输入 (预填当前名)。
  if (isRenaming && manage.edit) {
    return (
      <InlineEditRow
        depth={depth}
        value={manage.edit.value}
        placeholder={t('settings.folder.picker.manage.renamePlaceholder', {
          defaultValue: '文件夹名称'
        })}
        busy={manage.editBusy}
        icon={<Pencil size={15} strokeWidth={1.75} className="shrink-0 text-coral" />}
        onChange={manage.onEditChange}
        onSubmit={manage.onEditSubmit}
        onCancel={manage.onEditCancel}
      />
    )
  }

  return (
    <>
      <div
        className={cn(
          'group/frow relative flex items-center gap-2 px-3 py-2 transition-colors duration-fast',
          node.is_system ? 'opacity-70' : 'hover:bg-ink-3'
        )}
        style={{ paddingLeft: `${12 + indentPx}px` }}
      >
        {/* checkbox / lock */}
        {node.is_system ? (
          <span
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] bg-ink-3 border border-ink-border-soft text-ink-fg-3"
            title={t('settings.folder.picker.systemLockTip', {
              defaultValue: '系统文件夹 · 始终同步'
            })}
          >
            <Lock size={9} strokeWidth={2} />
          </span>
        ) : (
          <button
            type="button"
            role="checkbox"
            aria-checked={isChecked}
            aria-label={node.display_name}
            onClick={() => onToggleSelect(node.imap_name)}
            className={cn(
              'shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] border transition-colors duration-fast',
              isChecked
                ? 'bg-coral/100 border-coral text-accent-fg'
                : 'bg-transparent border-ink-border hover:border-ink-fg-2'
            )}
          >
            {isChecked ? (
              <svg
                viewBox="0 0 24 24"
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </button>
        )}

        {/* expand chevron (有子才可点, 叶子占位对齐) */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.imap_name)}
            aria-label={
              isOpen
                ? t('settings.folder.picker.collapse', { defaultValue: '收起' })
                : t('settings.folder.picker.expand', { defaultValue: '展开' })
            }
            aria-expanded={isOpen}
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast"
          >
            <ChevronRight
              size={13}
              strokeWidth={2}
              className={cn('transition-transform duration-fast', isOpen && 'rotate-90')}
            />
          </button>
        ) : (
          <span className="shrink-0 w-4 h-4" aria-hidden="true" />
        )}

        {/* folder icon */}
        {node.is_system ? (
          systemIcon(node)
        ) : (
          <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
        )}

        {/* name */}
        <span className="flex-1 min-w-0 truncate text-aux text-ink-fg">{node.display_name}</span>

        {/* count (mono) */}
        {typeof node.message_count === 'number' ? (
          <span className="shrink-0 text-meta font-mono tabular-nums text-ink-fg-2">
            {node.message_count.toLocaleString('en-US')}
          </span>
        ) : null}

        {/* large badge */}
        {isLarge && !node.is_system ? (
          <span
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-mono bg-warn/15 text-warn"
            title={t('settings.folder.picker.largeTip', {
              defaultValue: '超过 1000 封，首次同步可能较慢'
            })}
          >
            <AlertTriangle size={10} strokeWidth={2} />
            {t('settings.folder.picker.large', { defaultValue: '较大' })}
          </span>
        ) : null}

        {/* system state label */}
        {node.is_system ? (
          <span className="shrink-0 text-meta text-ink-fg-3">
            {t('settings.folder.picker.systemState', { defaultValue: '系统 · 始终同步' })}
          </span>
        ) : null}

        {/* ⋯ 管理菜单 (P4) — hover 显 (菜单打开时常驻); 系统文件夹禁用 + tooltip。 */}
        <button
          type="button"
          aria-label={t('settings.folder.picker.manage.menuLabel', { defaultValue: '管理文件夹' })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={node.is_system}
          title={
            node.is_system
              ? t('settings.folder.picker.manage.systemHint', {
                  defaultValue: '系统文件夹不可修改'
                })
              : undefined
          }
          onClick={() => manage.onOpenMenu(menuOpen ? null : node.imap_name)}
          className={cn(
            'shrink-0 inline-flex items-center justify-center w-6 h-6 rounded transition-colors duration-fast',
            node.is_system
              ? 'opacity-40 cursor-not-allowed text-ink-fg-3'
              : cn(
                  'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg',
                  menuOpen ? 'bg-ink-4 text-ink-fg' : 'opacity-0 group-hover/frow:opacity-100'
                )
          )}
        >
          <MoreHorizontal size={15} strokeWidth={2} />
        </button>

        {/* 菜单 popup — 仅自定义文件夹。新建子文件夹 / 重命名 / 删除。 */}
        {menuOpen && !node.is_system ? (
          <div
            role="menu"
            className="absolute right-2 top-9 z-20 min-w-40 py-1 rounded-md border border-ink-border bg-ink-1 shadow-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => manage.onStartCreate(node.imap_name)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-meta text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
            >
              <FolderPlus size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
              {t('settings.folder.picker.manage.newChild', { defaultValue: '新建子文件夹' })}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => manage.onStartRename(node)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-meta text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
            >
              <Pencil size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
              {t('settings.folder.picker.manage.rename', { defaultValue: '重命名' })}
            </button>
            <div className="my-1 h-px bg-ink-border-soft" />
            <button
              type="button"
              role="menuitem"
              onClick={() => manage.onRequestDelete(node)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-meta text-fail hover:bg-fail/10 transition-colors duration-fast"
            >
              <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
              {t('settings.folder.picker.manage.delete', { defaultValue: '删除' })}
            </button>
          </div>
        ) : null}
      </div>

      {hasChildren && isOpen
        ? node.children.map((child) => (
            <FolderRow
              key={child.imap_name}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
              manage={manage}
              cleanup={cleanup}
            />
          ))
        : null}

      {/* inline 新建子文件夹行 — 在本节点的子列表末尾 (depth+1)。 */}
      {isCreatingHere && manage.edit ? (
        <InlineEditRow
          depth={depth + 1}
          value={manage.edit.value}
          placeholder={t('settings.folder.picker.manage.newChildPlaceholder', {
            defaultValue: '子文件夹名称'
          })}
          busy={manage.editBusy}
          icon={<FolderPlus size={15} strokeWidth={1.75} className="shrink-0 text-coral" />}
          onChange={manage.onEditChange}
          onSubmit={manage.onEditSubmit}
          onCancel={manage.onEditCancel}
        />
      ) : null}

      {/* P5 — 本地副本清理提示。仅自定义文件夹 + 有 pending 清理请求时渲染。 */}
      {!node.is_system && cleanup.cleanupPrompts.has(node.imap_name) ? (
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-ink-2 border-t border-ink-border-soft/50"
          style={{ paddingLeft: `${12 + depth * 22 + 24}px` }}
          role="group"
          aria-label={t('settings.folder.picker.manage.cleanupPrompt', {
            defaultValue: '也清理本地副本？'
          })}
        >
          <AlertTriangle size={12} strokeWidth={2} className="shrink-0 text-warn" />
          <span className="text-meta text-ink-fg-2 flex-1 min-w-0 truncate">
            {typeof node.message_count === 'number' && node.message_count > 0
              ? t('settings.folder.picker.manage.cleanupHint', {
                  defaultValue: '仅删本地已同步的 {count} 封副本，不删 Exchange 文件夹/邮件',
                  count: node.message_count
                })
              : t('settings.folder.picker.manage.cleanupHintNoCount', {
                  defaultValue: '仅删本地已同步副本，不删 Exchange 文件夹/邮件'
                })}
          </span>
          <button
            type="button"
            onClick={() => cleanup.onDismissCleanup(node.imap_name)}
            disabled={cleanup.cleanupBusy === node.imap_name}
            className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-meta text-ink-fg-1 hover:bg-ink-3 transition-colors duration-fast disabled:opacity-40"
          >
            {t('settings.folder.picker.manage.cleanupKeep', { defaultValue: '保留' })}
          </button>
          <button
            type="button"
            onClick={() => cleanup.onCleanup(node.imap_name, node.display_name)}
            disabled={cleanup.cleanupBusy === node.imap_name}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-meta text-ink-fg bg-warn/20 hover:bg-warn/30 transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cleanup.cleanupBusy === node.imap_name ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Trash2 size={11} strokeWidth={2} />
            )}
            {cleanup.cleanupBusy === node.imap_name
              ? t('settings.folder.picker.manage.cleanupBusy', { defaultValue: '清理中…' })
              : t('settings.folder.picker.manage.cleanupDo', { defaultValue: '清理' })}
          </button>
        </div>
      ) : null}
    </>
  )
}

/** error.code accessor — ElectronApi/HttpApi 都在 Error 实例挂 .code。 */
function errorCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code?: unknown }).code
    return typeof c === 'string' ? c : undefined
  }
  return undefined
}

export function FolderPicker(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  // MAILAGENT_BACKEND env 值做乐观门控 (默认 applescript)。空 → 视作未知, 仍尝试
  // discover (远程 web 读不到本机 env, 靠 discover 的 400 兜底门控)。
  const backendRaw = useEnvValue('MAILAGENT_BACKEND').trim().toLowerCase()
  const envGated = backendRaw !== '' && backendRaw !== 'davmail'

  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const setView = useEmailFilter((s) => s.setView)

  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = React.useState(false)

  // P5 — 本地副本清理提示。取消勾选一个「已在白名单中」的文件夹时, 在其行下方
  // 展示 inline 提示「也清理本地副本？[保留][清理]」。默认保留 (不主动清理)。
  // Set<imap_name> 存需要展示提示的文件夹; 重新勾选 / 刷新 / 清理完成后移除。
  const [cleanupPrompts, setCleanupPrompts] = React.useState<ReadonlySet<string>>(new Set())
  // 正在执行 cleanup 的 imap_name (null = 无), 同时禁用两按钮防重复。
  const [cleanupBusy, setCleanupBusy] = React.useState<string | null>(null)

  // discover 走 React Query, 与 SidebarFolderTree 共用 ['folder','discover'] 缓存 (counts
  // 一致) → 重进设置页命中缓存零请求, 只在 staleTime(10min) 过期 / 手动刷新 / CRUD
  // invalidate 时才重打 IMAP STATUS。env 门控时 enabled=false 不发请求 (gated 由渲染期
  // envGated 短路)。retry:false 让 E_INVALID_ARG 立即落到 error → 兜底门控。无
  // refetchInterval → 不会有意外的后台刷新 clobber 用户选中态。
  const discoverQuery = useQuery({
    queryKey: ['folder', 'discover'],
    queryFn: () => mailApi.folder.discover({ counts: true }),
    enabled: !envGated,
    staleTime: 10 * 60_000,
    gcTime: 15 * 60_000,
    retry: false
  })
  const refresh = discoverQuery.refetch

  const discoverData = discoverQuery.data
  const dataUpdatedAt = discoverQuery.dataUpdatedAt

  // 派生加载态/门控态/错误态 — 替代旧 LoadState 机。E_INVALID_ARG → gated; 其余
  // error → 错误态。ready = 有数据且非 fetching-without-data。
  const gated = errorCode(discoverQuery.error) === 'E_INVALID_ARG'
  // isLoading = 仅首拉无数据时 (body 显 skeleton); isFetching = 任意在途请求 (含
  // 手动刷新 refetch, toolbar 转圈反馈)。distinguish initial-load vs refetch 避免
  // 重进/刷新时 body 闪 skeleton (react-pitfalls.md「Avoiding Flash of Loading」)。
  const isLoading = discoverQuery.isPending && discoverQuery.fetchStatus === 'fetching'
  const isFetching = discoverQuery.isFetching
  const isError = discoverQuery.isError && !gated
  const errorMessage = isError ? (discoverQuery.error as Error).message : ''
  const isReady = discoverData !== undefined
  // useMemo 稳定引用 (discoverData?.x ?? [] 每次 render 新建空数组 → 下游 hook 依赖
  // 抖动)。仅在 discoverData 身份变 (refetch 落地) 时重算。
  const tree = React.useMemo(() => discoverData?.tree ?? [], [discoverData])
  const folders = React.useMemo(() => discoverData?.folders ?? [], [discoverData])
  const whitelist = React.useMemo(() => discoverData?.whitelist ?? [], [discoverData])
  const lastRefresh = isReady ? dataUpdatedAt : null

  // 本机选中态/展开态/清理提示从 discover 的 whitelist seed。每次 discover 数据更新
  // (首拉 / 手动刷新 / CRUD 后 invalidate refetch) → 把用户编辑回归到后端真实白名单
  // baseline (= 旧 refresh() 体的 setSelected/setExpanded/clear cleanupPrompts 语义)。
  // 用 render 期对比 dataUpdatedAt (存 useState, 非 ref) 触发 set-state — React 文档
  // 「storing info from previous renders / adjusting state when data changes」官方模式,
  // 收敛 (seededAt guard 保证每 dataUpdatedAt 仅 seed 一次), 比 effect 少一次 commit, 且
  // React-Compiler 友好 (无 ref-during-render / set-state-in-effect)。无 refetchInterval,
  // 仅上述显式时机数据会变。
  const [seededAt, setSeededAt] = React.useState<number | null>(null)
  if (discoverData && dataUpdatedAt !== seededAt) {
    setSeededAt(dataUpdatedAt)
    const wl = discoverData.whitelist
    setSelected(new Set(wl))
    setCleanupPrompts(new Set())
    const toExpand = new Set<string>()
    for (const f of discoverData.folders) {
      if (f.parent && wl.includes(f.imap_name)) toExpand.add(f.parent)
    }
    setExpanded(toExpand)
  }

  const toggleSelect = React.useCallback(
    (imapName: string): void => {
      // 是否当前已选中 (取消方向)。
      const isDeselecting = selected.has(imapName)
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(imapName)) next.delete(imapName)
        else next.add(imapName)
        return next
      })
      if (isDeselecting) {
        // 取消勾选 + 该文件夹在白名单 (有本地已同步副本) → 展示清理提示。
        if (isReady && whitelist.includes(imapName)) {
          setCleanupPrompts((p) => {
            const np = new Set(p)
            np.add(imapName)
            return np
          })
        }
      } else {
        // 重新勾选 → 撤销清理提示。
        setCleanupPrompts((p) => {
          if (!p.has(imapName)) return p
          const np = new Set(p)
          np.delete(imapName)
          return np
        })
      }
    },
    [selected, isReady, whitelist]
  )

  const toggleExpand = React.useCallback((imapName: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })
  }, [])

  // dirty: 当前选中 ≠ 上次保存的白名单 (baseline = discover 的 whitelist)。保存后
  // invalidate→refetch 会把 whitelist baseline 推进, dirty 收敛回 false。
  const dirty = React.useMemo(() => {
    if (!isReady) return false
    const baseline = whitelist
    if (selected.size !== baseline.length) return true
    for (const n of baseline) if (!selected.has(n)) return true
    return false
  }, [selected, isReady, whitelist])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const res = await mailApi.folder.setWhitelist(Array.from(selected))
      // 乐观推进选中态到后端去重排序结果 (baseline 由下方 invalidate→refetch 的
      // re-seed effect 落地)。
      setSelected(new Set(res.folders))
      if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
      // customMailbox 若已被从白名单移除, 继续保留会导致列表永久空 → 重置到 inbox。
      // 判断：customMailbox 的 fullDisplayName 可能含路径; whitelist 存 imap_name。
      // 用 folders(imap_name 列表)兜底: 若当前 customMailbox 不在新 whitelist 对应的
      // folder 集合里则清空 (此处 res.folders = imap_name[], 与 customMailbox 不直接比,
      // 所以只要 whitelist 变小就保守地检查: 若 selected 里不含任何已删的 imap, 则
      // customMailbox 对应的 imap 也已被移出 → 清 inbox)。
      if (customMailbox !== null) {
        // 用当前 discover 结果找 customMailbox 对应的 imap_name。
        const match = folders.find((f) => f.display_name === customMailbox)
        if (match && !res.folders.includes(match.imap_name)) {
          setView('inbox')
        }
      }
      toastSuccess(t('settings.folder.picker.saveOk', { defaultValue: '文件夹白名单已保存' }))
      // 保存后重置所有 pending 清理提示 (whitelist 已更新, 旧提示失效)。
      setCleanupPrompts(new Set())
      // 失效共享 folder 缓存 → SidebarFolderTree 的 ['folder','whitelist'] /
      // ['folder','discover'] 重拉, 否则其 staleTime(30s / 5min) 内滞后。
      void qc.invalidateQueries({ queryKey: ['folder'] })
    } catch (e) {
      toastError(
        t('settings.folder.picker.saveFail', { defaultValue: '保存失败' }),
        (e as Error).message
      )
    } finally {
      setSaving(false)
    }
  }

  // P5 — 清理本地副本。用户点「清理」时调用 cleanup(imapName), 成功后关闭提示 +
  // restart_required 处理 + refetch。失败 → toast 不关提示 (用户可重试)。
  const handleCleanup = React.useCallback(
    async (imapName: string, displayName: string): Promise<void> => {
      setCleanupBusy(imapName)
      try {
        const res: FolderCleanupResult = await mailApi.folder.cleanup(imapName)
        if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
        setCleanupPrompts((p) => {
          const np = new Set(p)
          np.delete(imapName)
          return np
        })
        toastSuccess(
          t('settings.folder.picker.manage.cleanupOk', {
            defaultValue: '已清理「{name}」的本地副本（{count} 封）',
            name: displayName,
            count: res.affected_local_rows
          })
        )
        // 失效共享 folder 缓存 → 本组件 + sidebar 的 ['folder','discover'] 重拉
        // (本地行数已变)。re-seed effect 据新 whitelist 重置选中/展开态。
        void qc.invalidateQueries({ queryKey: ['folder'] })
      } catch (e) {
        toastError(
          t('settings.folder.picker.manage.cleanupFail', { defaultValue: '清理本地副本失败' }),
          (e as Error).message
        )
      } finally {
        setCleanupBusy(null)
      }
    },
    [mailApi, markRestartRequired, qc, t]
  )

  const dismissCleanup = React.useCallback((imapName: string): void => {
    setCleanupPrompts((p) => {
      if (!p.has(imapName)) return p
      const np = new Set(p)
      np.delete(imapName)
      return np
    })
  }, [])

  // ── 文件夹管理 (P4) — ⋯ 菜单 / inline 输入 / 删除二次确认 ──────────────────
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [edit, setEdit] = React.useState<EditState | null>(null)
  const [editBusy, setEditBusy] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<FolderTreeNode | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  const openMenu = React.useCallback((imapName: string | null): void => {
    setMenuFor(imapName)
  }, [])

  const startCreate = React.useCallback((parentImapName: string): void => {
    setMenuFor(null)
    setEdit({ mode: 'create', parentImapName, value: '' })
    // 展开父节点, 让 inline 新建行可见。
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(parentImapName)
      return next
    })
  }, [])

  const startRename = React.useCallback((node: FolderTreeNode): void => {
    setMenuFor(null)
    setEdit({ mode: 'rename', imapName: node.imap_name, value: node.display_name })
  }, [])

  const editChange = React.useCallback((value: string): void => {
    setEdit((prev) => (prev ? { ...prev, value } : prev))
  }, [])

  const editCancel = React.useCallback((): void => {
    setEdit(null)
  }, [])

  const editSubmit = React.useCallback(async (): Promise<void> => {
    if (!edit) return
    const name = edit.value.trim()
    if (name === '') return
    setEditBusy(true)
    try {
      if (edit.mode === 'create') {
        const res = await mailApi.folder.createFolder(edit.parentImapName, name)
        if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
        toastSuccess(
          t('settings.folder.picker.manage.createOk', {
            defaultValue: '已新建文件夹「{name}」',
            name
          })
        )
      } else {
        const res = await mailApi.folder.renameFolder(edit.imapName, name)
        if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
        toastSuccess(
          t('settings.folder.picker.manage.renameOk', {
            defaultValue: '已重命名为「{name}」',
            name
          })
        )
      }
      setEdit(null)
      // 成功后失效共享 folder 缓存 → discover 重拉 (拿到 Exchange 真实状态 + 新计数,
      // sidebar 同步)。re-seed effect 据新 whitelist 重置选中/展开态。
      void qc.invalidateQueries({ queryKey: ['folder'] })
    } catch (e) {
      toastError(
        edit.mode === 'create'
          ? t('settings.folder.picker.manage.createFail', { defaultValue: '新建文件夹失败' })
          : t('settings.folder.picker.manage.renameFail', { defaultValue: '重命名失败' }),
        (e as Error).message
      )
    } finally {
      setEditBusy(false)
    }
  }, [edit, mailApi, markRestartRequired, qc, t])

  const requestDelete = React.useCallback((node: FolderTreeNode): void => {
    setMenuFor(null)
    setDeleteTarget(node)
  }, [])

  const confirmDelete = React.useCallback(async (): Promise<void> => {
    if (!deleteTarget) return
    const node = deleteTarget
    setDeleting(true)
    try {
      const res = await mailApi.folder.deleteFolder(node.imap_name)
      if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
      // 删除的若是当前正在看的文件夹 → 重置到收件箱 (列表否则永久空)。
      if (customMailbox !== null && customMailbox === node.display_name) {
        setView('inbox')
      }
      setDeleteTarget(null)
      toastSuccess(
        t('settings.folder.picker.manage.deleteOk', {
          defaultValue: '已删除文件夹「{name}」',
          name: node.display_name
        })
      )
      // 成功后失效共享 folder 缓存 → discover 重拉 (本地树同步到 Exchange 真实状态,
      // sidebar 同步)。
      void qc.invalidateQueries({ queryKey: ['folder'] })
    } catch (e) {
      // 失败: 后端已把本地树回滚到服务器真实状态; 关弹窗 + toast 提示回滚。
      setDeleteTarget(null)
      toastError(
        t('settings.folder.picker.manage.deleteFail', { defaultValue: '删除失败' }),
        `${(e as Error).message} · ${t('settings.folder.picker.manage.deleteRollback', {
          defaultValue: 'Exchange 操作失败，本地文件夹树已回滚到服务器真实状态。'
        })}`
      )
      // 回滚后失效缓存 refetch, 确保本地树与服务器一致。
      void qc.invalidateQueries({ queryKey: ['folder'] })
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, mailApi, markRestartRequired, customMailbox, setView, qc, t])

  const manage: ManageHandlers = {
    menuFor,
    edit,
    editBusy,
    onOpenMenu: openMenu,
    onStartCreate: startCreate,
    onStartRename: startRename,
    onRequestDelete: requestDelete,
    onEditChange: editChange,
    onEditSubmit: () => void editSubmit(),
    onEditCancel: editCancel
  }

  const cleanupHandlers: CleanupRowHandlers = {
    cleanupBusy,
    cleanupPrompts,
    onCleanup: (imapName, displayName) => void handleCleanup(imapName, displayName),
    onDismissCleanup: dismissCleanup
  }

  // ── 门控态 ────────────────────────────────────────────────────────────
  // env 乐观门控 (本机 MAILAGENT_BACKEND≠davmail) 或 discover 返回 E_INVALID_ARG。
  if (envGated || gated) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-ink-border px-4 py-5 bg-ink-2">
        <Server size={18} strokeWidth={1.75} className="shrink-0 mt-0.5 text-ink-fg-2" />
        <div>
          <div className="text-aux font-medium text-ink-fg">
            {t('settings.folder.picker.gatedTitle', { defaultValue: '需要 davmail 后端' })}
          </div>
          <div className="text-meta text-ink-fg-2 mt-1 leading-relaxed">
            {t('settings.folder.picker.gatedBody', {
              defaultValue:
                '多文件夹发现、勾选与同步仅在 davmail 后端可用。请在「账户」切换后端后再启用本区。'
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative rounded-lg border border-ink-border-soft overflow-visible">
      {/* 点击空白处关 ⋯ 菜单 (overlay 在菜单层之下, 不挡菜单项点击)。 */}
      {menuFor !== null ? (
        <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setMenuFor(null)} />
      ) : null}
      {/* toolbar */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-ink-border-soft">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isFetching}
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-meta',
            'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast',
            'disabled:opacity-50 disabled:pointer-events-none'
          )}
        >
          <RefreshCw size={13} strokeWidth={2} className={cn(isFetching && 'animate-spin')} />
          {t('settings.folder.picker.refresh', { defaultValue: '刷新' })}
        </button>
        <span className="text-meta text-ink-fg-2 truncate">
          {isReady
            ? t('settings.folder.picker.summary', {
                defaultValue: '共 {count} 个文件夹',
                count: folders.length
              })
            : isLoading
              ? t('settings.folder.picker.loadingMeta', { defaultValue: '拉取文件夹…' })
              : ''}
          {lastRefresh && isReady ? (
            <span className="text-ink-fg-3">
              {' · '}
              {t('settings.folder.picker.refreshedAt', {
                defaultValue: '上次刷新 {time}',
                time: new Date(lastRefresh).toLocaleTimeString()
              })}
            </span>
          ) : null}
        </span>
      </div>

      {/* body — isReady 优先 (有数据时即便后台 refetch 也不闪 skeleton); 仅首拉无
          数据时显 loading; error 仅在无缓存数据时显 (有数据则静默保留旧树)。 */}
      {isReady && tree.length === 0 ? (
        <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-ink-3 text-ink-fg-3">
            <Folder size={18} strokeWidth={1.75} />
          </span>
          <div className="text-aux font-medium text-ink-fg">
            {t('settings.folder.picker.emptyTitle', {
              defaultValue: '没有可同步的自定义文件夹'
            })}
          </div>
          <div className="text-meta text-ink-fg-2 max-w-sm leading-relaxed">
            {t('settings.folder.picker.emptyBody', {
              defaultValue:
                '你的邮箱里暂未发现收件箱 / 发件箱以外的文件夹。在 Outlook 里新建文件夹后点「刷新」重新拉取。'
            })}
          </div>
        </div>
      ) : isReady ? (
        <>
          <div className="max-h-80 overflow-y-auto scrollbar-thin divide-y divide-ink-border-soft/60">
            {tree.map((node) => (
              <FolderRow
                key={node.imap_name}
                node={node}
                depth={0}
                selected={selected}
                expanded={expanded}
                onToggleSelect={toggleSelect}
                onToggleExpand={toggleExpand}
                manage={manage}
                cleanup={cleanupHandlers}
              />
            ))}
          </div>
          {/* save row */}
          <div className="flex items-center justify-end gap-2.5 px-3 py-2.5 border-t border-ink-border-soft">
            {dirty ? (
              <span className="mr-auto text-meta text-ink-fg-2">
                {t('settings.folder.picker.dirtyHint', {
                  defaultValue: '保存后需重启同步服务生效'
                })}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!dirty || saving}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-aux',
                'text-accent-fg bg-coral/100 hover:bg-coral-hover',
                'transition-colors duration-fast',
                'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-coral/100'
              )}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : null}
              {saving
                ? t('settings.folder.picker.saving', { defaultValue: '保存中…' })
                : t('settings.folder.picker.save', { defaultValue: '保存' })}
            </button>
          </div>
        </>
      ) : isError ? (
        <div className="px-4 py-6 flex flex-col items-center gap-2 text-center">
          <div className="text-aux text-fail">
            {t('settings.folder.picker.errorTitle', { defaultValue: '拉取文件夹失败' })}
          </div>
          <div className="text-meta text-ink-fg-2">{errorMessage}</div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-1 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-meta text-ink-fg-1 hover:bg-ink-3 transition-colors duration-fast"
          >
            <RefreshCw size={13} strokeWidth={2} />
            {t('settings.folder.picker.retry', { defaultValue: '重试' })}
          </button>
        </div>
      ) : (
        <div className="px-4 py-8 flex items-center justify-center gap-2 text-meta text-ink-fg-2">
          <Loader2 size={14} className="animate-spin" />
          {t('settings.folder.picker.loading', { defaultValue: '加载中…' })}
        </div>
      )}

      {/* 删除二次确认弹窗 (P4 · 界面⑤) — 危险态 + 影响说明 + Exchange 回写警示。 */}
      {deleteTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-ink-border bg-ink-1 shadow-md overflow-hidden">
            <div className="px-5 pt-5 pb-4">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-fail/12 text-fail mb-3">
                <Trash2 size={18} strokeWidth={1.75} />
              </div>
              <h3 className="text-aux font-semibold text-ink-fg">
                {t('settings.folder.picker.manage.deleteTitle', {
                  defaultValue: '删除文件夹「{name}」？',
                  name: deleteTarget.display_name
                })}
              </h3>
              <p className="text-meta text-ink-fg-1 mt-2 leading-relaxed">
                {typeof deleteTarget.message_count === 'number'
                  ? t('settings.folder.picker.manage.deleteBodyWithCount', {
                      defaultValue:
                        '将删除 Exchange 上的该文件夹，以及本地已同步的 {count} 封邮件副本。此操作不可撤销。',
                      count: deleteTarget.message_count
                    })
                  : t('settings.folder.picker.manage.deleteBody', {
                      defaultValue:
                        '将删除 Exchange 上的该文件夹，以及本地已同步的邮件副本。此操作不可撤销。'
                    })}
              </p>
              <div className="mt-3 flex items-start gap-2 rounded-md bg-warn/10 px-3 py-2 text-[12px] text-ink-fg-1 leading-relaxed">
                <AlertTriangle size={14} strokeWidth={2} className="shrink-0 mt-0.5 text-warn" />
                <span>
                  {t('settings.folder.picker.manage.deleteWarn', {
                    defaultValue:
                      '该文件夹在 Outlook 规则中可能仍被引用；删除后相关规则会失效。Notion 已归档页面不受影响。'
                  })}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-ink-border-soft bg-ink-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="inline-flex items-center px-3 py-1 rounded-md text-aux text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast disabled:opacity-50"
              >
                {t('settings.folder.picker.manage.cancel', { defaultValue: '取消' })}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-aux text-on-fail bg-fail hover:bg-fail/90 transition-colors duration-fast disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {deleting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} strokeWidth={2} />
                )}
                {deleting
                  ? t('settings.folder.picker.manage.deleting', { defaultValue: '删除中…' })
                  : t('settings.folder.picker.manage.deleteConfirm', {
                      defaultValue: '删除文件夹'
                    })}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
