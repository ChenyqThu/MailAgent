// 多文件夹同步 (P3) — 设置页「自定义文件夹同步」文件夹树选择器。
//
// 照 mockup ①(docs/mockups/multi-folder-sync/index.html §s1): 刷新按钮拉
// discover → 树形渲染 + 勾选框 + 邮件数 + 大文件夹提示 + 系统文件夹 lock 灰态 +
// 空态 + davmail 门控态 + 保存(setWhitelist)。

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Folder, Loader2, RefreshCw, Server } from 'lucide-react'

import type { FolderCleanupResult } from '@shared/api/types'
import type { ReorderItem } from '@shared/components/ui/DragReorderList'
import { envFlagOn } from '@shared/components/agents/shared'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage as toErrorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { cn } from '@shared/lib/cn'
import { useEmailFilter } from '@shared/state/email-filter'
import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'

import { FolderDeleteConfirmDialog, FolderSyncedOrderSection } from './FolderSyncedOrderSection'
import { FolderRow, type CleanupRowHandlers } from './FolderTreeRows'
import { useFolderManage } from './useFolderManage'

/** 两份白名单逐位相同 —— **有序**比较, 仅调序也算变了 (数组序 = 侧边栏显示顺序)。 */
function sameSeq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** 读单个 managed-env 值, 不订阅整个 store (仿 RemoteAccessTab.useEnvValue)。 */
function useEnvValue(key: string): string {
  return useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values[key] ?? '') : ''
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

  // 已勾选文件夹的**有序**列表 —— 数组序 = SYNC_FOLDERS 数组序 = 侧边栏显示顺序。
  const [order, setOrder] = React.useState<readonly string[]>([])
  const selected = React.useMemo<ReadonlySet<string>>(() => new Set(order), [order])
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = React.useState(false)

  // P5 — 本地副本清理提示。
  const [cleanupPrompts, setCleanupPrompts] = React.useState<ReadonlySet<string>>(new Set())
  const [cleanupBusy, setCleanupBusy] = React.useState<string | null>(null)

  const discoverQuery = useQuery({
    queryKey: qk.folder.discover(),
    queryFn: () => mailApi.folder.discover({ counts: false, refresh: true }),
    enabled: !envGated,
    staleTime: 10 * 60_000,
    gcTime: 15 * 60_000,
    retry: false
  })
  const refresh = discoverQuery.refetch

  const discoverData = discoverQuery.data
  const dataUpdatedAt = discoverQuery.dataUpdatedAt

  const gated = errorCode(discoverQuery.error) === 'E_INVALID_ARG'
  const isLoading = discoverQuery.isPending && discoverQuery.fetchStatus === 'fetching'
  const isFetching = discoverQuery.isFetching
  const isError = discoverQuery.isError && !gated
  const errorMessage = isError ? toErrorMessage(discoverQuery.error) : ''
  const isReady = discoverData !== undefined

  const tree = React.useMemo(() => discoverData?.tree ?? [], [discoverData])
  const folders = React.useMemo(() => discoverData?.folders ?? [], [discoverData])
  const whitelist = React.useMemo(() => discoverData?.whitelist ?? [], [discoverData])
  const lastRefresh = isReady ? dataUpdatedAt : null

  // 本机选中态/展开态/清理提示从 discover 的 whitelist seed；不许覆盖未保存的本地编辑。
  const [seed, setSeed] = React.useState<{ at: number; whitelist: readonly string[] } | null>(null)
  if (discoverData && dataUpdatedAt !== seed?.at) {
    const wl = discoverData.whitelist
    const edited = seed !== null && !sameSeq(order, seed.whitelist)
    setSeed({ at: dataUpdatedAt, whitelist: edited ? seed.whitelist : wl })
    if (!edited) {
      setOrder(wl)
      setCleanupPrompts(new Set())
    }
    const toExpand = new Set<string>()
    for (const f of discoverData.folders) {
      if (f.parent && wl.includes(f.imap_name)) toExpand.add(f.parent)
    }
    setExpanded(toExpand)
  }

  const toggleSelect = React.useCallback(
    (imapName: string): void => {
      const isDeselecting = selected.has(imapName)
      setOrder((prev) =>
        prev.includes(imapName) ? prev.filter((n) => n !== imapName) : [...prev, imapName]
      )
      if (isDeselecting) {
        if (isReady && whitelist.includes(imapName)) {
          setCleanupPrompts((p) => {
            const np = new Set(p)
            np.add(imapName)
            return np
          })
        }
      } else {
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

  const dirty = React.useMemo(
    () => isReady && !sameSeq(order, whitelist),
    [order, isReady, whitelist]
  )

  const setChanged = React.useMemo(() => {
    if (!isReady) return false
    if (order.length !== whitelist.length) return true
    const base = new Set(whitelist)
    for (const n of order) if (!base.has(n)) return true
    return false
  }, [order, isReady, whitelist])

  async function handleSave(): Promise<void> {
    setSaving(true)
    try {
      const res = await mailApi.folder.setWhitelist([...order])
      setOrder(res.folders)
      setSeed((s) => (s ? { ...s, whitelist: res.folders } : s))
      if (res.restart_required) markRestartRequired(['SYNC_FOLDERS'])
      if (customMailbox !== null) {
        const match = folders.find((f) => f.display_name === customMailbox)
        if (match && !res.folders.includes(match.imap_name)) {
          setView('inbox')
        }
      }
      toastSuccess(t('settings.folder.picker.saveOk', { defaultValue: '文件夹白名单已保存' }))
      setCleanupPrompts(new Set())
      void qc.invalidateQueries({ queryKey: qk.folder.all() })
    } catch (e) {
      toastError(
        t('settings.folder.picker.saveFail', { defaultValue: '保存失败' }),
        toErrorMessage(e)
      )
    } finally {
      setSaving(false)
    }
  }

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
        void qc.invalidateQueries({ queryKey: qk.folder.all() })
      } catch (e) {
        toastError(
          t('settings.folder.picker.manage.cleanupFail', { defaultValue: '清理本地副本失败' }),
          toErrorMessage(e)
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

  const displayNameByImap = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const f of folders) m.set(f.imap_name, f.display_name)
    return m
  }, [folders])

  const folderManage = useFolderManage({
    setExpanded,
    customMailbox,
    setView,
    displayNameByImap
  })

  const cleanupHandlers: CleanupRowHandlers = {
    cleanupBusy,
    cleanupPrompts,
    onCleanup: (imapName, displayName) => void handleCleanup(imapName, displayName),
    onDismissCleanup: dismissCleanup
  }

  const orderItems = React.useMemo<ReorderItem[]>(
    () => order.map((n) => ({ id: n, label: displayNameByImap.get(n) ?? n })),
    [order, displayNameByImap]
  )

  const handleReorder = React.useCallback((list: ReorderItem[]): void => {
    setOrder(list.map((item) => item.id))
  }, [])

  const globalNotify = envFlagOn(useEnvValue('FEISHU_NOTIFY_ENABLED'))
  const globalAi = envFlagOn(useEnvValue('LLM_AGENT_ENABLED'))

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
      {folderManage.menuFor !== null ? (
        <div className="fixed inset-0 z-10" aria-hidden="true" onClick={folderManage.dismissMenu} />
      ) : null}

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
                manage={folderManage.manage}
                cleanup={cleanupHandlers}
              />
            ))}
          </div>

          <FolderSyncedOrderSection
            orderItems={orderItems}
            onReorder={handleReorder}
            globalNotify={globalNotify}
            globalAi={globalAi}
            prefOf={folderManage.prefOf}
            prefBusy={folderManage.prefBusy}
            savePref={folderManage.savePref}
            iconAnchor={folderManage.iconAnchor}
            openIconPicker={folderManage.openIconPicker}
            closeIconPicker={folderManage.closeIconPicker}
          />

          <div className="flex items-center justify-end gap-2.5 px-3 py-2.5 border-t border-ink-border-soft">
            {dirty ? (
              <span className="mr-auto text-meta text-ink-fg-2">
                {setChanged
                  ? t('settings.folder.picker.dirtyHint', {
                      defaultValue: '保存后需重启同步服务生效'
                    })
                  : t('settings.folder.picker.orderOnlyHint', {
                      defaultValue: '仅调整显示顺序，保存后立即生效'
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

      <FolderDeleteConfirmDialog
        open={folderManage.deleteDlgRender && folderManage.renderDeleteTarget !== null}
        target={folderManage.renderDeleteTarget}
        scopeRef={folderManage.deleteDlgRef}
        deleting={folderManage.deleting}
        onCancel={folderManage.closeDelete}
        onConfirm={folderManage.confirmDelete}
      />
    </div>
  )
}
