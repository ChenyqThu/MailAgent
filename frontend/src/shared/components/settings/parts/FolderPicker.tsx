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
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  Folder,
  Inbox,
  Loader2,
  Lock,
  RefreshCw,
  Send,
  Server
} from 'lucide-react'

import type { FolderInfo, FolderTreeNode } from '@shared/api/types'
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

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; tree: FolderTreeNode[]; folders: FolderInfo[]; whitelist: string[] }
  | { status: 'gated' }
  | { status: 'error'; message: string }

/** system folder 图标 — special_use / INBOX 用对应图标, 其余 fallback Folder。 */
function systemIcon(node: FolderInfo): React.ReactNode {
  if (node.special_use === '\\sent')
    return <Send size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
  if (node.imap_name.toUpperCase() === 'INBOX')
    return <Inbox size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
  return <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink-fg-2" />
}

interface FolderRowProps {
  node: FolderTreeNode
  depth: number
  selected: ReadonlySet<string>
  expanded: ReadonlySet<string>
  onToggleSelect: (imapName: string) => void
  onToggleExpand: (imapName: string) => void
}

/** 单行 + 递归子节点。系统文件夹: lock 灰态不可选; 自定义: checkbox + count + 大徽标。 */
function FolderRow({
  node,
  depth,
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand
}: FolderRowProps): React.ReactElement {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imap_name)
  const isChecked = selected.has(node.imap_name)
  const isLarge = (node.message_count ?? 0) > LARGE_FOLDER_THRESHOLD
  // 缩进: 22px / 层 (照 mockup f-ind 宽度)。chevron 占位让叶子与父对齐。
  const indentPx = depth * 22

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 transition-colors duration-fast',
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
            />
          ))
        : null}
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
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  // MAILAGENT_BACKEND env 值做乐观门控 (默认 applescript)。空 → 视作未知, 仍尝试
  // discover (远程 web 读不到本机 env, 靠 discover 的 400 兜底门控)。
  const backendRaw = useEnvValue('MAILAGENT_BACKEND').trim().toLowerCase()
  const envGated = backendRaw !== '' && backendRaw !== 'davmail'

  const customMailbox = useEmailFilter((s) => s.customMailbox)
  const setView = useEmailFilter((s) => s.setView)

  const [state, setState] = React.useState<LoadState>({ status: 'idle' })
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const [lastRefresh, setLastRefresh] = React.useState<number | null>(null)
  const [saving, setSaving] = React.useState(false)

  const refresh = React.useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      const res = await mailApi.folder.discover({ counts: true })
      setState({
        status: 'ready',
        tree: res.tree,
        folders: res.folders,
        whitelist: res.whitelist
      })
      setSelected(new Set(res.whitelist))
      // 默认展开有已选子节点的父文件夹, 让用户直接看到选中态。
      const toExpand = new Set<string>()
      for (const f of res.folders) {
        if (f.parent && res.whitelist.includes(f.imap_name)) toExpand.add(f.parent)
      }
      setExpanded(toExpand)
      setLastRefresh(Date.now())
    } catch (e) {
      if (errorCode(e) === 'E_INVALID_ARG') {
        setState({ status: 'gated' })
        return
      }
      setState({ status: 'error', message: (e as Error).message })
    }
  }, [mailApi])

  // 首次 mount: 非 env 门控时自动拉一次 (env 门控时不发请求, gated 由渲染期
  // envGated 短路)。ref guard 让首拉只跑一次 — 不依赖 refresh 身份 (refresh
  // 随 mailApi 变, 若依赖会在 setState('loading') 后再触发 → 死循环风险)。手动
  // 刷新走 toolbar 按钮的 refresh()。refresh 含 setState('loading')→fetch 的数据
  // 加载语义 (同 PromptEditorDialog open-时 async fetch); react-query 化收益低于
  // 「叠本地选中态 mutation」的改造风险, effect 合理保留。
  const didInitRef = React.useRef(false)
  React.useEffect(() => {
    if (envGated || didInitRef.current) return
    didInitRef.current = true
    void refresh()
  }, [envGated, refresh])

  const toggleSelect = React.useCallback((imapName: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })
  }, [])

  const toggleExpand = React.useCallback((imapName: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })
  }, [])

  // dirty: 当前选中 ≠ 上次保存的白名单 (baseline = state.whitelist)。
  const dirty = React.useMemo(() => {
    if (state.status !== 'ready') return false
    const baseline = state.whitelist
    if (selected.size !== baseline.length) return true
    for (const n of baseline) if (!selected.has(n)) return true
    return false
  }, [selected, state])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const res = await mailApi.folder.setWhitelist(Array.from(selected))
      // 保存成功后把 baseline 推进到后端返回的去重排序结果。
      setState((prev) => (prev.status === 'ready' ? { ...prev, whitelist: res.folders } : prev))
      setSelected(new Set(res.folders))
      if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
      // customMailbox 若已被从白名单移除, 继续保留会导致列表永久空 → 重置到 inbox。
      // 判断：customMailbox 的 fullDisplayName 可能含路径; whitelist 存 imap_name。
      // 用 folders(imap_name 列表)兜底: 若当前 customMailbox 不在新 whitelist 对应的
      // folder 集合里则清空 (此处 res.folders = imap_name[], 与 customMailbox 不直接比,
      // 所以只要 whitelist 变小就保守地检查: 若 selected 里不含任何已删的 imap, 则
      // customMailbox 对应的 imap 也已被移出 → 清 inbox)。
      if (customMailbox !== null) {
        // state 里存有完整 discover 结果, 找当前 customMailbox 对应的 imap_name。
        const curState = state as Extract<typeof state, { status: 'ready' }>
        const match = curState.folders.find((f) => f.display_name === customMailbox)
        if (match && !res.folders.includes(match.imap_name)) {
          setView('inbox')
        }
      }
      toastSuccess(t('settings.folder.picker.saveOk', { defaultValue: '文件夹白名单已保存' }))
    } catch (e) {
      toastError(
        t('settings.folder.picker.saveFail', { defaultValue: '保存失败' }),
        (e as Error).message
      )
    } finally {
      setSaving(false)
    }
  }

  // ── 门控态 ────────────────────────────────────────────────────────────
  // env 乐观门控 (本机 MAILAGENT_BACKEND≠davmail) 或 discover 返回 E_INVALID_ARG。
  if (envGated || state.status === 'gated') {
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
    <div className="rounded-lg border border-ink-border-soft overflow-hidden">
      {/* toolbar */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-ink-border-soft">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={state.status === 'loading'}
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-meta',
            'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast',
            'disabled:opacity-50 disabled:pointer-events-none'
          )}
        >
          <RefreshCw
            size={13}
            strokeWidth={2}
            className={cn(state.status === 'loading' && 'animate-spin')}
          />
          {t('settings.folder.picker.refresh', { defaultValue: '刷新' })}
        </button>
        <span className="text-meta text-ink-fg-2 truncate">
          {state.status === 'ready'
            ? t('settings.folder.picker.summary', {
                defaultValue: '共 {{count}} 个文件夹',
                count: state.folders.length
              })
            : state.status === 'loading'
              ? t('settings.folder.picker.loadingMeta', { defaultValue: '拉取文件夹…' })
              : ''}
          {lastRefresh && state.status === 'ready' ? (
            <span className="text-ink-fg-3">
              {' · '}
              {t('settings.folder.picker.refreshedAt', {
                defaultValue: '上次刷新 {{time}}',
                time: new Date(lastRefresh).toLocaleTimeString()
              })}
            </span>
          ) : null}
        </span>
      </div>

      {/* body */}
      {state.status === 'loading' ? (
        <div className="px-4 py-8 flex items-center justify-center gap-2 text-meta text-ink-fg-2">
          <Loader2 size={14} className="animate-spin" />
          {t('settings.folder.picker.loading', { defaultValue: '加载中…' })}
        </div>
      ) : state.status === 'error' ? (
        <div className="px-4 py-6 flex flex-col items-center gap-2 text-center">
          <div className="text-aux text-fail">
            {t('settings.folder.picker.errorTitle', { defaultValue: '拉取文件夹失败' })}
          </div>
          <div className="text-meta text-ink-fg-2">{state.message}</div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-1 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-meta text-ink-fg-1 hover:bg-ink-3 transition-colors duration-fast"
          >
            <RefreshCw size={13} strokeWidth={2} />
            {t('settings.folder.picker.retry', { defaultValue: '重试' })}
          </button>
        </div>
      ) : state.status === 'ready' && state.tree.length === 0 ? (
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
      ) : state.status === 'ready' ? (
        <>
          <div className="max-h-80 overflow-y-auto scrollbar-thin divide-y divide-ink-border-soft/60">
            {state.tree.map((node) => (
              <FolderRow
                key={node.imap_name}
                node={node}
                depth={0}
                selected={selected}
                expanded={expanded}
                onToggleSelect={toggleSelect}
                onToggleExpand={toggleExpand}
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
      ) : null}
    </div>
  )
}
