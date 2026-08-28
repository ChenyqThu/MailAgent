// Connectors 配置台（08-06 先独立页，Lane A1 撤回后承载在 Settings → Connectors tab）。
//
// 把原来散在 设置→AI 的两个区 ——「工具审批档」（33 项，以 BUILTIN_TOOL_POLICIES 为准）
// 与「外部连接（MCP）」（connector 连接 / 授权 / per-tool auto/ask/off）—— 合并成一个
// 左右两栏 master-detail 的独立页：
//
//   左栏（master）
//     内置工具  —— 按 tool_prefs.py 的功能域分组（邮件操作 / 草稿 / 联网 / 日历 / …），
//                  行 = 域名 + 工具数；分组顺序跟 wire 负载走（Python TOOL_PREF_GROUPS）。
//     外部连接  —— 已连行（状态点 + 轨道标识）+ 未连目录项（「连接」链接）+ Composio 账户。
//                  🔴 flag（connectorToolsEnabled）off 时整段不渲染且零 /api/connector 请求
//                  （旧 ConnectorsSection 的门控语义原样保留）。
//
//   右栏（detail）= 选中项的配置面，见 BuiltinDetailPane / ConnectorDetailPane /
//   CatalogDetailPane / ComposioAccountPane。
//
// 深链：`/settings?tab=connectors&item=builtin:<group>|connector:<id>|catalog:<id>|composio|external`。
// 旧 `/connectors?item=...` 在 router-instance.tsx 保留 redirect。
// `catalog:<id>` 在该家已配置后自动归一成 `connector:<id>`（目录连接发起后行由授权流建出，
// 选中项跟着数据走，轮询由 connector detail 接手）。
//
// 🔴 设置→AI 里原来那两个区已降级成指向本 tab 的深链 —— 同一份数据只有这一个可写面。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useSearch } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { fetchConnectorToolsEnabled } from '@shared/components/settings/custom-ai/shared'
import type {
  ConnectorCatalogView,
  ConnectorSummary,
  ToolApprovalPrefsPayload
} from '@shared/api/types'

import {
  parseItemParam,
  resolveCatalogTrack,
  type ConsoleItemParam,
  type ConsoleSelection
} from './consoleShared'
import { BuiltinDetailPane } from './BuiltinDetailPane'
import { ConnectorDetailPane } from './ConnectorDetailPane'
import { CatalogDetailPane, CatalogLogo, ComposioAccountPane } from './CatalogDetailPane'

/** 左栏行 —— 复用 Sidebar NavRow 的选中签名（`.row-selected acc-select` = --sel-wash 药丸 +
 *  3px 左条，DESIGN §18.1 C5：配置台左栏是导航面）。 */
function MasterRow({
  selected,
  onClick,
  children,
  right
}: {
  selected: boolean
  onClick(): void
  children: React.ReactNode
  right?: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'row relative flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5',
        'text-left text-aux transition-colors duration-fast',
        selected
          ? 'row-selected acc-select font-medium text-ink-fg'
          : 'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'
      )}
    >
      {children}
      {right != null ? <span className="ml-auto shrink-0">{right}</span> : null}
    </button>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <h2
      className="px-2 pb-1 pt-3 font-mono text-micro uppercase text-ink-fg-2"
      style={{ letterSpacing: '0.08em' }}
    >
      {children}
    </h2>
  )
}

/** 已连行的状态点：connected 绿勾 / error·needs_reauth 红点 / 其余灰点。 */
function StatusDot({ status }: { status: ConnectorSummary['status'] }): React.ReactElement {
  if (status === 'connected') {
    return <Check className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
  }
  if (status === 'error' || status === 'needs_reauth') {
    return <AlertCircle className="size-3.5 shrink-0 text-fail" aria-hidden="true" />
  }
  return <span aria-hidden="true" className="mx-1 size-1.5 shrink-0 rounded-full bg-ink-fg-3" />
}

export function ConnectorsConsolePage(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const search = useSearch({ strict: false }) as { item?: string }

  // ── 内置工具（tool prefs）：左栏计数与右栏 detail 共用一份。读走 react-query（旧
  //    ToolApprovalSection 是 effect+setState，会踩 set-state-in-effect），写端点回全量
  //    负载 → setQueryData 原地覆盖（不 invalidate，避免一次多余的 GET）。
  const qc = useQueryClient()
  const prefsQuery = useQuery<ToolApprovalPrefsPayload>({
    queryKey: qk.toolApprovalPrefs(),
    queryFn: () => api.chat.getToolPrefs(),
    staleTime: 10_000,
    retry: false
  })
  const prefs = prefsQuery.data ?? null
  const prefsError = prefsQuery.isError ? errorMessage(prefsQuery.error) : null
  const [busy, setBusy] = React.useState(false)

  const setPrefsData = React.useCallback(
    (updater: (prev: ToolApprovalPrefsPayload | null) => ToolApprovalPrefsPayload | null): void => {
      qc.setQueryData<ToolApprovalPrefsPayload>(qk.toolApprovalPrefs(), (prev) => {
        const next = updater(prev ?? null)
        return next ?? prev
      })
    },
    [qc]
  )

  const mutatePrefs = React.useCallback(
    async (run: () => Promise<ToolApprovalPrefsPayload>): Promise<void> => {
      setBusy(true)
      try {
        const result = await run()
        setPrefsData(() => result)
      } catch (err) {
        toastError(t('settings.ai.toolPrefs.saveFailed'), errorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [t, setPrefsData]
  )

  // ── 外部连接：flag off（false / 加载中 / 不可达）→ 整段不渲染、零 /api/connector 请求。
  const { data: flagEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('connectorToolsEnabled'),
    queryFn: fetchConnectorToolsEnabled,
    staleTime: 30_000,
    retry: false
  })
  const externalEnabled = flagEnabled === true

  const list = useQuery<ConnectorSummary[]>({
    queryKey: qk.connectors(),
    queryFn: () => api.connector.list(),
    enabled: externalEnabled,
    staleTime: 10_000,
    retry: false
  })

  const catalog = useQuery<ConnectorCatalogView>({
    queryKey: qk.connectorCatalog(),
    queryFn: () => api.connector.catalog(),
    enabled: externalEnabled,
    staleTime: 10_000,
    retry: false
  })

  // ── 选中项：URL `?item=` 深链种子 + 页内点击。跟随数据归一（见文件头）。
  // 深链变化用「render 期比较-写入」承接（React docs 的 adjust-state-on-prop-change 形状，
  // 不是 effect 里 setState）：页面已挂载时再收到 navigate 深链（如设置页跳过来前就开着），
  // 用新 item 覆盖当前选中。
  const [rawSelection, setRawSelection] = React.useState<ConsoleItemParam | null>(() =>
    parseItemParam(search.item)
  )
  const [seenItem, setSeenItem] = React.useState(search.item)
  if (search.item !== seenItem) {
    setSeenItem(search.item)
    const parsed = parseItemParam(search.item)
    if (parsed != null) setRawSelection(parsed)
  }

  const builtinGroups = React.useMemo(() => {
    const seen = new Map<string, number>()
    for (const row of prefs?.tools ?? []) {
      seen.set(row.group, (seen.get(row.group) ?? 0) + 1)
    }
    return [...seen.entries()].map(([group, count]) => ({ group, count }))
  }, [prefs])

  const connectors = React.useMemo(() => list.data ?? [], [list.data])
  const catalogEntries = React.useMemo(() => catalog.data?.entries ?? [], [catalog.data])
  const unconfiguredEntries = React.useMemo(
    () => catalogEntries.filter((e) => !e.configured),
    [catalogEntries]
  )
  const keyConfigured = catalog.data?.composio.configured === true

  // 归一：模糊落点（external）与失效落点（已被配置的 catalog 项 / 已删除的行）收敛到可渲染项。
  const selection: ConsoleSelection | null = React.useMemo(() => {
    const fallbackBuiltin: ConsoleSelection | null =
      builtinGroups.length > 0 ? { kind: 'builtin', group: builtinGroups[0].group } : null
    const fallbackExternal: ConsoleSelection | null = !externalEnabled
      ? null
      : connectors.length > 0
        ? { kind: 'connector', id: connectors[0].connector_id }
        : unconfiguredEntries.length > 0
          ? { kind: 'catalog', id: unconfiguredEntries[0].connector_id }
          : { kind: 'composio' }
    const sel = rawSelection
    if (sel == null) return fallbackBuiltin ?? fallbackExternal
    switch (sel.kind) {
      case 'external-root':
        return fallbackExternal ?? fallbackBuiltin
      case 'builtin':
        return builtinGroups.some((g) => g.group === sel.group)
          ? sel
          : (fallbackBuiltin ?? fallbackExternal)
      case 'connector': {
        if (!externalEnabled) return fallbackBuiltin
        if (connectors.some((c) => c.connector_id === sel.id)) return sel
        // 行没了（断开 + 清除配置，含「切换轨道」路径）→ 落到同 id 的目录条目：用户下一步
        // 正是要从目录按出厂轨重连，掉回默认选中会把他丢在别处。
        if (catalogEntries.some((e) => e.connector_id === sel.id)) {
          return { kind: 'catalog', id: sel.id }
        }
        return fallbackExternal ?? fallbackBuiltin
      }
      case 'catalog': {
        if (!externalEnabled) return fallbackBuiltin
        // 已配置 → 归一成 connector detail（连接发起后行由授权流建出来，轮询由它接手）。
        if (connectors.some((c) => c.connector_id === sel.id)) {
          return { kind: 'connector', id: sel.id }
        }
        return catalogEntries.some((e) => e.connector_id === sel.id)
          ? sel
          : (fallbackExternal ?? fallbackBuiltin)
      }
      case 'composio':
        return externalEnabled ? sel : fallbackBuiltin
    }
  }, [
    rawSelection,
    builtinGroups,
    connectors,
    catalogEntries,
    unconfiguredEntries,
    externalEnabled
  ])

  const select = React.useCallback((next: ConsoleSelection): void => {
    setRawSelection(next)
  }, [])

  // ── 右栏 detail ───────────────────────────────────────────────────────────
  const detail: React.ReactNode = (() => {
    if (selection == null) {
      if (prefsError != null) {
        return (
          <div className="flex items-center justify-between gap-3">
            <div className="text-aux text-ink-fg-3">
              {t('settings.ai.toolPrefs.loadError', { message: prefsError })}
            </div>
            <Button size="sm" variant="ghost" onClick={() => void prefsQuery.refetch()}>
              {t('settings.ai.toolPrefs.retry')}
            </Button>
          </div>
        )
      }
      return (
        <div className="flex items-center gap-2 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        </div>
      )
    }
    // 🔴 detail pane 一律带 key=选中项：换选中 = 重挂载，pane 内的临时态（折叠 / 确认 /
    // 草稿 / 一次性提示 ack）从惰性初始化重新来 —— 不靠 effect 里 setState 归零。
    switch (selection.kind) {
      case 'builtin':
        return prefs != null ? (
          <BuiltinDetailPane
            key={selection.group}
            group={selection.group}
            data={prefs}
            busy={busy}
            onMutate={mutatePrefs}
            onWhitelistSaved={(next) =>
              setPrefsData((prev) => (prev ? { ...prev, sendWhitelist: next } : prev))
            }
          />
        ) : null
      case 'connector': {
        const row = connectors.find((c) => c.connector_id === selection.id)
        if (row == null) return null
        return (
          <ConnectorDetailPane
            key={selection.id}
            connector={row}
            catalogEntry={catalogEntries.find((e) => e.connector_id === selection.id) ?? null}
            nowMs={list.dataUpdatedAt}
          />
        )
      }
      case 'catalog': {
        const entry = catalogEntries.find((e) => e.connector_id === selection.id)
        if (entry == null) return null
        return (
          <CatalogDetailPane
            key={selection.id}
            entry={entry}
            keyConfigured={keyConfigured}
            onSelectComposio={() => select({ kind: 'composio' })}
          />
        )
      }
      case 'composio':
        return <ComposioAccountPane status={catalog.data?.composio ?? null} />
    }
  })()

  // ── 左栏外部连接段 ────────────────────────────────────────────────────────
  const externalSection: React.ReactNode = !externalEnabled ? null : (
    <>
      <SectionHeader>{t('connectorsConsole.sectionExternal')}</SectionHeader>
      <nav className="space-y-px px-2" aria-label={t('connectorsConsole.sectionExternal')}>
        {list.isError ? (
          <div className="px-2 py-1 text-micro text-ink-fg-3">
            {t('settings.connectors.loadError', { message: errorMessage(list.error) })}
          </div>
        ) : null}
        {connectors.map((c) => (
          <MasterRow
            key={c.connector_id}
            selected={selection?.kind === 'connector' && selection.id === c.connector_id}
            onClick={() => select({ kind: 'connector', id: c.connector_id })}
            right={
              <span className="text-micro text-ink-fg-3">
                {c.source === 'composio'
                  ? t('settings.connectors.viaComposio')
                  : t('settings.connectors.viaDirect')}
              </span>
            }
          >
            <StatusDot status={c.status} />
            <span className="min-w-0 flex-1 truncate">{c.display_name}</span>
          </MasterRow>
        ))}
        {unconfiguredEntries.map((entry) => (
          <MasterRow
            key={entry.connector_id}
            selected={selection?.kind === 'catalog' && selection.id === entry.connector_id}
            onClick={() => select({ kind: 'catalog', id: entry.connector_id })}
            right={
              <span className="text-micro text-coral">{t('settings.connectors.connect')}</span>
            }
          >
            <CatalogLogo entry={entry} size="sm" />
            <span className="min-w-0 flex-1 truncate">{entry.display_name}</span>
            <span className="sr-only">
              {resolveCatalogTrack(entry) === 'composio'
                ? t('settings.connectors.viaComposio')
                : t('settings.connectors.viaDirect')}
            </span>
          </MasterRow>
        ))}
        {catalog.isFetching && !catalog.data ? (
          <div className="flex items-center gap-2 px-2 py-1 text-micro text-ink-fg-3">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            {t('settings.connectors.loading')}
          </div>
        ) : null}
        <MasterRow
          selected={selection?.kind === 'composio'}
          onClick={() => select({ kind: 'composio' })}
          right={
            keyConfigured ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : undefined
          }
        >
          <span aria-hidden="true" className="mx-1 size-1.5 shrink-0 rounded-full bg-ink-fg-3" />
          <span className="min-w-0 flex-1 truncate">{t('connectorsConsole.composioAccount')}</span>
        </MasterRow>
      </nav>
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头 —— 高度 41 与 sidebar app-nav-header 共线（各页页头同款约束）。 */}
      <div
        className="flex shrink-0 items-center gap-3 px-[18px]"
        style={{ height: 41, borderBottom: '1px solid var(--hairline)' }}
      >
        <h1 className="text-body font-semibold text-ink-fg">{t('connectorsConsole.title')}</h1>
        <span className="truncate text-meta text-ink-fg-2">{t('connectorsConsole.subtitle')}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左栏 master */}
        <aside
          aria-label={t('connectorsConsole.title')}
          className="w-60 shrink-0 overflow-y-auto border-r border-ink-border/60 py-2 scrollbar-thin"
        >
          <SectionHeader>{t('connectorsConsole.sectionBuiltin')}</SectionHeader>
          <nav className="space-y-px px-2" aria-label={t('connectorsConsole.sectionBuiltin')}>
            {prefsError != null ? (
              <div className="px-2 py-1 text-micro text-ink-fg-3">
                {t('settings.ai.toolPrefs.loadError', { message: prefsError })}
              </div>
            ) : prefs == null ? (
              <div className="flex items-center gap-2 px-2 py-1 text-micro text-ink-fg-3">
                <Loader2 className="size-3 shrink-0 animate-spin" />
              </div>
            ) : (
              builtinGroups.map(({ group, count }) => (
                <MasterRow
                  key={group}
                  selected={selection?.kind === 'builtin' && selection.group === group}
                  onClick={() => select({ kind: 'builtin', group })}
                  right={
                    <span className="font-mono text-micro tabular-nums text-ink-fg-3">{count}</span>
                  }
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t(`settings.ai.toolPrefs.group.${group}`)}
                  </span>
                </MasterRow>
              ))
            )}
          </nav>
          {externalSection}
        </aside>

        {/* 右栏 detail */}
        <section className="min-w-0 flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
          <div className="mx-auto max-w-[720px]">{detail}</div>
        </section>
      </div>
    </div>
  )
}
