// Connectors 配置台 —— 已配置 connector 行的右栏 detail（Lane B）。
//
// 逻辑从旧 settings/custom-ai/ConnectorsSection.tsx 的 ConnectorRow 整体搬来，三条产品纲领
// 不变（信任可见性 / 清单完整性 / per-tool 三档），布局按 PRD §5 重排成 detail 形态：
//   · 顶部：标题 + 状态/路线药丸 + 一句话说明（目录条目的 description_key，找得到才有）
//     + 右上角操作（Reset permissions / Refresh=同步工具 / Uninstall=断开）。
//   · 主体：按 crud 分组的工具列表，**每组默认折叠**（owner 拍板），组头 = 计数 + 组级
//     批量下拉；sync 发现 orphan 自动展开**含 orphan 的组**（说了「有 N 个失效」就得让
//     证据当场可见）。
//   · destructive 设 auto 的一次性红色确认（单个 / 组级批量两形态）、「工具面变宽」一次性
//     概览、断开确认 + 「同时清除工具配置」勾选 —— 全部原样保留。
//
// 与旧 Row 的两点**有意**偏差：
//   1. 工具清单不再懒加载 —— detail 被选中就是「展开」，组头计数也需要这份数据。
//      （「没选中不打请求」的懒加载语义仍在：页面只 mount 选中项的 detail。）
//   2. 断开（Uninstall）对非 connected 行也可用 —— owner 活库里那行 error 的 atlassian
//     （composio）要能被**干净替换**成直连行（PRD §4.4），旧 UI 只在 connected 时给断开
//     入口，error 行根本无路可走。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Ban, Check, Hand, Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ConnectorCatalogEntry,
  ConnectorCrudType,
  ConnectorStatusValue,
  ConnectorSummary,
  ConnectorToolMode,
  ConnectorToolSummary
} from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

import {
  AUTH_POLL_INTERVAL_MS,
  CRUD_LABEL_KEYS,
  CRUD_ORDER,
  CRUD_PILL_CLASS,
  DEFAULT_AUTH_TIMEOUT_SECONDS,
  EFFECTIVE_MODE_LABEL_KEYS,
  PILL_BASE,
  STATUS_LABEL_KEYS,
  STATUS_PILL_CLASS,
  TOOL_MODE_LABEL_KEYS,
  countOf,
  formatEpoch,
  isWebBuild,
  openExternal,
  readToolfaceNoticeAck,
  writeToolfaceNoticeAck
} from './consoleShared'
import { BulkMenu, SegIconSelect, ToolCategoryGroup, type SegOption } from './parts'

const TOOL_MODE_ICONS: Record<
  ConnectorToolMode,
  React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
> = {
  auto: Check,
  ask: Hand,
  off: Ban
}

function ToolRow({
  tool,
  onChange
}: {
  tool: ConnectorToolSummary
  onChange(tool: ConnectorToolSummary, next: ConnectorToolMode): void
}): React.ReactElement {
  const { t } = useTranslation()
  // orphan 行远端已没有这个工具 —— 只展示不可改（delete 档退役后这是唯一的锁定成因）。
  const locked = tool.orphan
  const options: SegOption<ConnectorToolMode>[] = (['auto', 'ask', 'off'] as const).map((mode) => ({
    value: mode,
    label: t(TOOL_MODE_LABEL_KEYS[mode]),
    icon: TOOL_MODE_ICONS[mode]
  }))
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-all font-mono text-micro text-ink-fg">{tool.name}</span>
          <span className={cn(PILL_BASE, CRUD_PILL_CLASS[tool.crud_type])}>
            {t(CRUD_LABEL_KEYS[tool.crud_type])}
          </span>
          {tool.destructive ? (
            <span className={cn(PILL_BASE, 'bg-warn/15 text-warn')}>
              <AlertTriangle className="size-2.5" aria-hidden="true" />
              {t('settings.connectors.tools.destructive')}
            </span>
          ) : null}
          {tool.orphan ? (
            <span
              className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}
              title={t('settings.connectors.tools.orphanTip')}
            >
              {t('settings.connectors.tools.orphan')}
            </span>
          ) : null}
        </div>
        {tool.description ? (
          <div className="mt-0.5 text-meta text-ink-fg-2 line-clamp-2">{tool.description}</div>
        ) : null}
        <div className="mt-0.5 text-micro text-ink-fg-3">
          {t(EFFECTIVE_MODE_LABEL_KEYS[tool.effective_mode])}
          {tool.mode_override == null ? ` · ${t('settings.connectors.tools.followDefault')}` : ''}
        </div>
      </div>
      <SegIconSelect
        value={tool.effective_mode}
        options={options}
        disabled={locked}
        ariaLabel={t('settings.connectors.tools.mode.label')}
        onChange={(next) => onChange(tool, next)}
      />
    </div>
  )
}

export function ConnectorDetailPane({
  connector,
  catalogEntry,
  // 🔴 判「令牌是否过期」的时间基准来自 react-query 的 `dataUpdatedAt`（这份数据落进缓存的
  // 那一刻），不是 render 里的 `Date.now()`（render 期不纯读，react-hooks/purity）。
  nowMs
}: {
  connector: ConnectorSummary
  /** 同 id 的目录条目（找得到才有）——一句话说明从这来，行数据自己没有描述。 */
  catalogEntry: ConnectorCatalogEntry | null
  nowMs: number
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const id = connector.connector_id
  const isWeb = isWebBuild()

  const [starting, setStarting] = React.useState(false)
  // 在途授权流（本地视角）：deadline 到点即放弃轮询。null = 没在等。
  // `openedSeq` = 已经替用户打开过第几条授权链接（08-05 WP-12 多 toolkit 顺序授权）。
  const [awaiting, setAwaiting] = React.useState<{
    deadline: number
    timeoutSeconds: number
    openedSeq: number
  } | null>(null)
  const dismissedFlowRef = React.useRef<number | null>(null)
  const [syncing, setSyncing] = React.useState(false)
  const [purging, setPurging] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)
  // 断开对话框里的「同时清除工具配置」勾选。被目录取代（轨道不符）的行**默认勾上** ——
  // 那一行的存在意义就是等着被换掉，留着它另一轨版本装不进来。
  const [purgeOnDisconnect, setPurgeOnDisconnect] = React.useState(connector.superseded_by_catalog)
  const [confirmAuto, setConfirmAuto] = React.useState<
    | { kind: 'single'; tool: ConnectorToolSummary }
    | { kind: 'bulk'; crud: ConnectorCrudType; destructiveCount: number }
    | null
  >(null)
  const [noticeAck, setNoticeAck] = React.useState<boolean>(() => readToolfaceNoticeAck(id))
  // 🔴 owner 拍板：crud 组默认折叠，点组头单独展开。「切换 connector 归零」（折叠态 / 确认态 /
  // notice ack / purge 勾选的惰性初始化）由父级 key={connector_id} 重挂载承担 —— 不在 effect
  // 里 setState（react-hooks/set-state-in-effect）。
  const [expandedGroups, setExpandedGroups] = React.useState<Set<ConnectorCrudType>>(new Set())

  const invalidateList = React.useCallback(
    () => qc.invalidateQueries({ queryKey: qk.connectors() }),
    [qc]
  )

  const connected = connector.status === 'connected'
  const noticePending = connected && !noticeAck

  // detail 被选中即「展开」：工具清单直接拉（组头计数、概览提示计数都需要它）。
  const toolsQuery = useQuery<ConnectorToolSummary[]>({
    queryKey: qk.connectorTools(id),
    queryFn: () => api.connector.tools(id),
    staleTime: 10_000,
    retry: false
  })

  // 跟随服务端在途流：预置目录里点的「连接」发生在这一行**存在之前**（行由授权流建出来），
  // 列表刷新后由 detail 接手轮询，否则那次连接永远没人看结果。
  React.useEffect(() => {
    const flow = connector.flow
    if (flow == null || flow.status !== 'authorizing') return
    if (awaiting != null || connector.status === 'connected') return
    if (dismissedFlowRef.current === flow.started_at) return
    setAwaiting({
      deadline: Date.now() + DEFAULT_AUTH_TIMEOUT_SECONDS * 1000,
      timeoutSeconds: DEFAULT_AUTH_TIMEOUT_SECONDS,
      openedSeq: flow.link_seq
    })
  }, [connector.flow, connector.status, awaiting])

  React.useEffect(() => {
    if (awaiting == null) return undefined
    let disposed = false
    const timer = window.setInterval(() => {
      void (async () => {
        if (disposed) return
        if (Date.now() >= awaiting.deadline) {
          setAwaiting(null)
          void invalidateList()
          toastError(
            t('settings.connectors.title'),
            t('settings.connectors.authTimeout', { seconds: awaiting.timeoutSeconds })
          )
          return
        }
        try {
          const s = await api.connector.status(id)
          if (disposed) return
          // 多 toolkit 顺序授权：服务端把下一条链接填进 flow 并把序号 +1 → 再开一次浏览器。
          const seq = s.flow?.link_seq ?? 0
          if (s.flow?.authorize_url && seq > awaiting.openedSeq) {
            openExternal(s.flow.authorize_url)
            setAwaiting((prev) => (prev == null ? prev : { ...prev, openedSeq: seq }))
            return
          }
          if (s.status === 'connected') {
            setAwaiting(null)
            void invalidateList()
            toastSuccess(t('settings.connectors.connectedToast', { name: connector.display_name }))
          } else if (s.status === 'error') {
            setAwaiting(null)
            void invalidateList()
            toastError(t('settings.connectors.authFailed'), s.last_error ?? '')
          }
        } catch {
          /* 瞬时失败：保持等待，下一拍再看 */
        }
      })()
    }, AUTH_POLL_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [awaiting, api, id, invalidateList, t, connector.display_name])

  async function handleConnect(): Promise<void> {
    setStarting(true)
    try {
      const started = await api.connector.oauthStart(id)
      // 🔴 可能没有 URL（composio 轨：全部 toolkit 之前就授权过）——那就不开浏览器，只接手
      // 轮询等它落 connected。open(null) 在 web 构建下会弹一个 about:blank 空标签页。
      if (started.authorize_url) openExternal(started.authorize_url)
      setAwaiting({
        deadline: Date.now() + started.callback_timeout_seconds * 1000,
        timeoutSeconds: started.callback_timeout_seconds,
        openedSeq: started.authorize_url ? 1 : 0
      })
      await invalidateList()
    } catch (err) {
      toastError(t('settings.connectors.authFailed'), errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  async function handleToggleEnabled(next: boolean): Promise<void> {
    try {
      await api.connector.setEnabled(id, next)
      await invalidateList()
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  async function handleTogglePreprocess(next: boolean): Promise<void> {
    try {
      await api.connector.setPreprocessEnabled(id, next)
      await invalidateList()
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  async function handleSync(): Promise<void> {
    setSyncing(true)
    try {
      const result = await api.connector.sync(id)
      await invalidateList()
      await qc.invalidateQueries({ queryKey: qk.connectorTools(id) })
      const orphaned = countOf(result, 'orphaned')
      toastSuccess(
        t('settings.connectors.syncDone', {
          inserted: countOf(result, 'inserted'),
          updated: countOf(result, 'updated'),
          orphaned
        })
      )
      // 「有工具失效了」是这次同步唯一需要用户看一眼的结果 —— 展开**含 orphan 的组**，
      // 让失效行当场可见，而不是让 toast 说完就消失、把找证据的活儿留给用户。
      if (orphaned > 0) {
        const fresh = await qc.fetchQuery<ConnectorToolSummary[]>({
          queryKey: qk.connectorTools(id),
          queryFn: () => api.connector.tools(id)
        })
        setExpandedGroups((prev) => {
          const next = new Set(prev)
          for (const tool of fresh) if (tool.orphan) next.add(tool.crud_type)
          return next
        })
      }
    } catch (err) {
      toastError(t('settings.connectors.title'), errorMessage(err))
    } finally {
      setSyncing(false)
    }
  }

  async function handlePurgeOrphans(): Promise<void> {
    setPurging(true)
    try {
      const result = await api.connector.purgeOrphans(id)
      await qc.invalidateQueries({ queryKey: qk.connectorTools(id) })
      toastSuccess(t('settings.connectors.tools.purgeDone', { count: result.purged }))
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    } finally {
      setPurging(false)
    }
  }

  async function handleDisconnect(): Promise<void> {
    setDisconnecting(true)
    try {
      await api.connector.disconnect(id, purgeOnDisconnect)
      setAwaiting(null)
      await invalidateList()
      await qc.invalidateQueries({ queryKey: qk.connectorCatalog() })
      setConfirmOpen(false)
      setPurgeOnDisconnect(false)
    } catch (err) {
      toastError(t('settings.connectors.title'), errorMessage(err))
    } finally {
      setDisconnecting(false)
    }
  }

  async function applyToolMode(toolName: string, next: ConnectorToolMode): Promise<void> {
    try {
      await api.connector.setToolMode(id, toolName, next)
      await qc.invalidateQueries({ queryKey: qk.connectorTools(id) })
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  function handleToolMode(tool: ConnectorToolSummary, next: ConnectorToolMode): void {
    // destructive → auto 的那一下弹一次性红色确认（§4.3：不阻止、只加摩擦与可见性）。
    if (next === 'auto' && tool.destructive) {
      setConfirmAuto({ kind: 'single', tool })
      return
    }
    void applyToolMode(tool.name, next)
  }

  async function applyBulkMode(crud: ConnectorCrudType, mode: ConnectorToolMode): Promise<void> {
    try {
      const result = await api.connector.bulkSetToolMode(id, mode, crud)
      await qc.invalidateQueries({ queryKey: qk.connectorTools(id) })
      toastSuccess(t('settings.connectors.tools.bulkDone', { count: result.updated }))
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  function handleBulkMode(crud: ConnectorCrudType, mode: ConnectorToolMode): void {
    // 🔴 组级批量设 auto 且组里有 destructive 可配行 → 同样先过红确认（复核抓过的真 bug：
    // 组级批量绕过单行确认）。
    const destructiveCount = (toolsQuery.data ?? []).filter(
      (x) => x.crud_type === crud && x.destructive && !x.orphan
    ).length
    if (mode === 'auto' && destructiveCount > 0) {
      setConfirmAuto({ kind: 'bulk', crud, destructiveCount })
      return
    }
    void applyBulkMode(crud, mode)
  }

  async function handleConfirmAuto(): Promise<void> {
    const pending = confirmAuto
    setConfirmAuto(null)
    if (pending == null) return
    if (pending.kind === 'single') await applyToolMode(pending.tool.name, 'auto')
    else await applyBulkMode(pending.crud, 'auto')
  }

  async function handleResetPermissions(): Promise<void> {
    try {
      // mode=null 全量清 per-tool 覆盖（Reset permissions）——回到默认档 auto。
      const result = await api.connector.bulkSetToolMode(id, null)
      await qc.invalidateQueries({ queryKey: qk.connectorTools(id) })
      toastSuccess(t('settings.connectors.tools.resetDone', { count: result.updated }))
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  // 本地在途流优先于服务端快照（oauthStart 刚返回、列表还没刷新时也要显示"授权中"）。
  const status: ConnectorStatusValue = awaiting != null ? 'authorizing' : connector.status
  const expiresAt = formatEpoch(connector.credential?.expires_at)
  const expired =
    connector.credential?.expires_at != null && connector.credential.expires_at * 1000 < nowMs
  const lastSynced = formatEpoch(connector.last_synced_at)

  const headerActions: React.ReactNode = (() => {
    if (awaiting != null) {
      return (
        <>
          <Button size="sm" variant="secondary" disabled>
            <Loader2 className="size-3.5 animate-spin" />
            {t('settings.connectors.awaiting')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              dismissedFlowRef.current = connector.flow?.started_at ?? null
              setAwaiting(null)
            }}
          >
            {t('settings.connectors.cancel')}
          </Button>
        </>
      )
    }
    if (connected) {
      return (
        <>
          <Button size="sm" variant="ghost" onClick={() => void handleResetPermissions()}>
            {t('settings.connectors.tools.reset')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={syncing}
            onClick={() => void handleSync()}
          >
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {syncing ? t('settings.connectors.syncing') : t('settings.connectors.sync')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // 每次打开都按当前行状态重算勾选（useState 初值只在挂载那一次生效）。
              setPurgeOnDisconnect(connector.superseded_by_catalog)
              setConfirmOpen(true)
            }}
          >
            {t('settings.connectors.disconnect')}
          </Button>
        </>
      )
    }
    // needs_reauth 走**同一个** handleConnect —— 「重新连接」就是重走一次 OAuth。
    // 非 connected 行也给「断开」：error/orphan 行要能干净清掉（含 purge，见文件头偏差 2）。
    return (
      <>
        <Button
          size="sm"
          disabled={isWeb || starting}
          title={isWeb ? t('settings.connectors.connectWeb') : undefined}
          onClick={() => void handleConnect()}
        >
          {starting ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {connector.status === 'needs_reauth'
            ? t('settings.connectors.reconnect')
            : t('settings.connectors.connect')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPurgeOnDisconnect(connector.superseded_by_catalog)
            setConfirmOpen(true)
          }}
        >
          {t('settings.connectors.disconnect')}
        </Button>
      </>
    )
  })()

  const toolsBody: React.ReactNode = (() => {
    if (toolsQuery.isError) {
      return (
        <div className="py-1.5 text-aux text-ink-fg-3">
          {t('settings.connectors.tools.loadError', { message: errorMessage(toolsQuery.error) })}
        </div>
      )
    }
    if (!toolsQuery.data) {
      return (
        <div className="flex items-center gap-2 py-1.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.connectors.tools.loading')}
        </div>
      )
    }
    if (toolsQuery.data.length === 0) {
      return (
        <div className="py-1.5 text-aux text-ink-fg-3">{t('settings.connectors.tools.empty')}</div>
      )
    }
    const orphanCount = toolsQuery.data.filter((x) => x.orphan).length
    const groups = CRUD_ORDER.map((crud) => ({
      crud,
      tools: toolsQuery.data!.filter((x) => x.crud_type === crud)
    })).filter((g) => g.tools.length > 0)
    return (
      <>
        <div className="pb-1 text-micro text-ink-fg-3">
          {t('settings.connectors.tools.defaultHint')}
        </div>
        {groups.map((group) => (
          <ToolCategoryGroup
            key={group.crud}
            id={`connector-tools-${id}-${group.crud}`}
            expanded={expandedGroups.has(group.crud)}
            onToggle={() =>
              setExpandedGroups((prev) => {
                const next = new Set(prev)
                if (next.has(group.crud)) next.delete(group.crud)
                else next.add(group.crud)
                return next
              })
            }
            labelPill={
              <span className={cn(PILL_BASE, CRUD_PILL_CLASS[group.crud])}>
                {t(CRUD_LABEL_KEYS[group.crud])}
              </span>
            }
            count={group.tools.length}
            bulk={
              <BulkMenu
                ariaLabel={`${t('settings.connectors.tools.bulk.label')} · ${t(CRUD_LABEL_KEYS[group.crud])}`}
                items={(['auto', 'ask', 'off'] as const).map((mode) => ({
                  key: mode,
                  label: t(`settings.connectors.tools.bulk.${mode}`),
                  icon: TOOL_MODE_ICONS[mode]
                }))}
                onApply={(key) => handleBulkMode(group.crud, key as ConnectorToolMode)}
              />
            }
          >
            <div>
              {group.tools.map((tool) => (
                <ToolRow key={tool.name} tool={tool} onChange={handleToolMode} />
              ))}
            </div>
          </ToolCategoryGroup>
        ))}
        {/* 清理只删已失效行 —— 恒不注册、恒不可调用，删掉不改变任何 AI 能做的事，不配确认。 */}
        {orphanCount > 0 ? (
          <div className="flex justify-end pt-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={purging}
              onClick={() => void handlePurgeOrphans()}
            >
              {purging ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('settings.connectors.tools.purgeOrphans', { count: orphanCount })}
            </Button>
          </div>
        ) : null}
      </>
    )
  })()

  return (
    <div>
      {/* ── 顶部：标题 + 药丸 + 一句话说明 + 右上角操作 ─────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lead font-medium text-ink-fg">{connector.display_name}</h2>
            <span className={cn(PILL_BASE, STATUS_PILL_CLASS[status])}>
              {t(STATUS_LABEL_KEYS[status])}
            </span>
            {/* 出站告知：每行如实说这条连接的**执行路线**。判据是服务端字段，不靠 URL 长相猜。 */}
            <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}>
              {connector.source === 'composio'
                ? t('settings.connectors.viaComposio')
                : t('settings.connectors.viaDirect')}
            </span>
          </div>
          {catalogEntry ? (
            <p className="mt-1 text-aux leading-relaxed text-ink-fg-2">
              {t(catalogEntry.description_key)}
            </p>
          ) : null}
          <div className="mt-1 flex flex-col gap-0.5 text-meta text-ink-fg-2">
            <span className="truncate font-mono">{connector.server_url}</span>
            {connector.superseded_by_catalog ? (
              // 🔴 双向 superseded（08-06）：不能只留一句提示 —— owner 活库那行 error 的
              // atlassian(composio) 点「重新连接」只会再走一次走不通的 Composio 流程。
              // 切轨的唯一正确路径 = 断开 + 清除配置 → 从目录按出厂轨重连，这里给出
              // 明确动作（预勾 purge 打开断开对话框；清掉后页面自动落到目录条目）。
              // 文案按**行的 source** 分方向：`supersededHint` 覆盖「直连行、出厂轨已转
              // Composio」；反方向（composio 行、出厂轨已回直连 —— 正是 owner 的处境）用
              // `supersededByDirect`，否则提示与事实正好颠倒。
              // 🔴 两条都只**陈述轨道不符 + 指向下面那颗「切换轨道」按钮**，不写方位词、
              // 也不重述手动步骤：旧措辞里的「下方预置目录」在 master-detail 里已经不成立
              // （目录在左栏），而「先断开再勾选清除配置」是在教用户绕开旁边这颗一键按钮。
              <span className="flex flex-wrap items-center gap-2 text-warn">
                {connector.source === 'composio'
                  ? t('connectorsConsole.supersededByDirect')
                  : t('settings.connectors.supersededHint')}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setPurgeOnDisconnect(true)
                    setConfirmOpen(true)
                  }}
                >
                  {t('connectorsConsole.switchTrack')}
                </Button>
              </span>
            ) : null}
            {connected ? (
              <>
                {connector.scopes && connector.scopes.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="text-ink-fg-3">{t('settings.connectors.scopes')}</span>
                    {connector.scopes.map((scope) => (
                      <span
                        key={scope}
                        className={cn(PILL_BASE, 'bg-ink-4 font-mono text-ink-fg-2')}
                      >
                        {scope}
                      </span>
                    ))}
                  </span>
                ) : null}
                <span className={expired ? 'text-warn' : undefined}>
                  {/* 🔴 `expires_at == null` 的真实语义是「**由自动刷新维护**」，不是「未知」。 */}
                  {connector.credential == null
                    ? t('settings.connectors.tokenNone')
                    : expiresAt == null
                      ? t('settings.connectors.tokenAutoRefresh')
                      : expired
                        ? t('settings.connectors.tokenExpired', { time: expiresAt })
                        : t('settings.connectors.tokenExpires', { time: expiresAt })}
                </span>
                <span>
                  {lastSynced == null
                    ? t('settings.connectors.neverSynced')
                    : t('settings.connectors.lastSynced', { time: lastSynced })}
                </span>
              </>
            ) : null}
            {connector.last_error ? (
              <span className="text-fail">
                {t('settings.connectors.lastError', { message: connector.last_error })}
              </span>
            ) : null}
            {!connected && isWeb ? (
              <span className="text-ink-fg-3">{t('settings.connectors.connectWeb')}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{headerActions}</div>
      </div>

      {/* 「工具面变宽」一次性概览：N 读 M 写 K 破坏性、默认全自动、可在下方调档。 */}
      {noticePending ? (
        <div className="mt-3 flex items-start gap-3 rounded-[var(--r-card)] border border-warn/30 bg-warn/[0.06] px-3 py-3">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-aux font-medium text-ink-fg">
              {t('settings.connectors.toolfaceNotice.title')}
            </div>
            <div className="mt-0.5 text-meta text-ink-fg-2">
              {toolsQuery.data
                ? t('settings.connectors.toolfaceNotice.body', {
                    reads: toolsQuery.data.filter((x) => !x.orphan && x.crud_type === 'read')
                      .length,
                    writes: toolsQuery.data.filter(
                      (x) => !x.orphan && (x.crud_type === 'write' || x.crud_type === 'update')
                    ).length,
                    destructive: toolsQuery.data.filter((x) => !x.orphan && x.destructive).length
                  })
                : t('settings.connectors.toolfaceNotice.loading')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                // 「查看并调档」= 展开全部组（概览说的是整张工具面，不是某一组）。
                setExpandedGroups(new Set(CRUD_ORDER))
                writeToolfaceNoticeAck(id)
                setNoticeAck(true)
              }}
            >
              {t('settings.connectors.toolfaceNotice.review')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                writeToolfaceNoticeAck(id)
                setNoticeAck(true)
              }}
            >
              {t('settings.connectors.toolfaceNotice.dismiss')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 整体启停 + 邮件预处理独立授权位（connected 才有意义）。 */}
      {connected ? (
        <div className="mt-3 rounded-[var(--r-card)] border border-ink-border-soft divide-y divide-ink-border-soft">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-aux font-medium text-ink-fg">
                {t('settings.connectors.enabled')}
              </div>
              <div className="mt-0.5 text-meta text-ink-fg-2">
                {t('settings.connectors.enabledHelper')}
              </div>
            </div>
            <Switch
              checked={connector.enabled}
              onCheckedChange={(next) => void handleToggleEnabled(next)}
              aria-label={t('settings.connectors.enabled')}
            />
          </div>
          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-aux font-medium text-ink-fg">
                {t('settings.connectors.preprocess')}
              </div>
              <div className="mt-0.5 text-meta text-ink-fg-2">
                {t('settings.connectors.preprocessHelper')}
              </div>
            </div>
            <Switch
              checked={connector.preprocess_enabled}
              onCheckedChange={(next) => void handleTogglePreprocess(next)}
              aria-label={t('settings.connectors.preprocess')}
            />
          </div>
        </div>
      ) : null}

      <div className="mt-3">{toolsBody}</div>

      {/* destructive 工具设 auto 的一次性红色确认（单个 / 组级批量两形态）。 */}
      <Dialog
        open={confirmAuto != null}
        onOpenChange={(open) => {
          if (!open) setConfirmAuto(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-fail">
              {t('settings.connectors.destructiveAutoDialog.title')}
            </DialogTitle>
            <DialogDescription>
              {confirmAuto?.kind === 'bulk'
                ? t('settings.connectors.destructiveAutoDialog.bulkDesc', {
                    count: confirmAuto.destructiveCount
                  })
                : t('settings.connectors.destructiveAutoDialog.desc', {
                    name: confirmAuto?.kind === 'single' ? confirmAuto.tool.name : ''
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirmAuto(null)}>
              {t('settings.connectors.destructiveAutoDialog.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void handleConfirmAuto()}>
              {t('settings.connectors.destructiveAutoDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('settings.connectors.disconnectDialog.title', { name: connector.display_name })}
            </DialogTitle>
            <DialogDescription>{t('settings.connectors.disconnectDialog.desc')}</DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 px-1 text-meta text-ink-fg-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={purgeOnDisconnect}
              onChange={(e) => setPurgeOnDisconnect(e.target.checked)}
              aria-label={t('settings.connectors.disconnectDialog.purge')}
            />
            <span>
              <span className="text-ink-fg">{t('settings.connectors.disconnectDialog.purge')}</span>
              <span className="block text-ink-fg-3">
                {t('settings.connectors.disconnectDialog.purgeHelper')}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              disabled={disconnecting}
              onClick={() => setConfirmOpen(false)}
            >
              {t('settings.connectors.disconnectDialog.cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={disconnecting}
              onClick={() => void handleDisconnect()}
            >
              {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {disconnecting
                ? t('settings.connectors.disconnectDialog.confirming')
                : t('settings.connectors.disconnectDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
