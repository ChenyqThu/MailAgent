// ConnectorsSection — 设置-AI「外部连接（MCP）」区（08-01 阶段 1 PR4 · T2 lane）。
//
// 这是 MCP connector 的**唯一** owner 操作面：连接（OAuth 2.1/PKCE）· 授权可见性 ·
// 整体启停 · 邮件预处理独立授权 · 工具清单与 per-tool 三态权限 · 断开。
//
// 三条产品纲领（决定了本文件为什么不像别的设置区那么"薄"）：
//
//   1. **信任可见性**。外部 connector 是数据出机的口子，所以 connected 行不只显示
//      「已连接」——scopes（这次授权到底给了什么）、令牌有效期（还能用多久 / 是不是
//      已经过期）、上次同步时间、最近一次错误，全部摆在行上，不藏进展开区。
//
//   2. **清单完整性**。工具清单渲染远端 manifest 的**全部**行，包括 `delete` 类和
//      已失效（orphan）的行 —— 它们恒不可启用（后端置 true 直接 403
//      `E_CONNECTOR_TOOL_FORBIDDEN`），但"看得见但用不了"远比"干脆不显示"诚实：
//      用户能确认这个服务确实有个删除工具、且我们确实没给 AI。
//
//   3. **per-tool 三态**。`enabled_override` 是 true / false / **null（清除覆盖回默认）**
//      三态，UI 就得给三个档，不能用一个 Switch 冒充。默认档的折算规则（read 开 /
//      write·update 关 / delete 恒关）**不在前端重算** —— 直接显示后端给的
//      `effective_enabled`，否则那套规则就成了第二处手抄。
//
// 🔴 远程 web 面不能发起连接：OAuth 回调走本机 loopback，远程浏览器打不开那个地址，
// 点了只会静默超时。故 web 构建下「连接」按钮 disabled + 明示去桌面 App 操作；其余
// 只读展示与开关照常（它们走 serve-api，远程可用）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ConnectorCrudType,
  ConnectorStatusValue,
  ConnectorSummary,
  ConnectorToolSummary
} from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

import { Section } from '../parts/Section'
import { fetchConnectorToolsEnabled } from './shared'

/** 授权回调轮询节拍。服务端 `callback_timeout_seconds`（默认 300s）是上限，到点即放弃。 */
const AUTH_POLL_INTERVAL_MS = 2000

/** 远程 web（SPA）构建判定。镜像全仓既有 `VITE_BUILD_TARGET === 'web'` 探针
 *  （SettingsShell / EnvField / McpApprovalCard 同款），并额外读 `process.env` ——
 *  vitest 的 `vi.stubEnv` 只写得进 process.env（见 assistant/runtime/flags.ts 的同款注释）。
 *  生产 web bundle 里没有 `process`，Electron renderer 里这个键是 undefined，故这一读
 *  在两个真实环境里都不改变结果。 */
function isWebBuild(): boolean {
  if (typeof process !== 'undefined' && process.env && process.env.VITE_BUILD_TARGET === 'web') {
    return true
  }
  try {
    return (
      (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
        ?.VITE_BUILD_TARGET === 'web'
    )
  } catch {
    return false
  }
}

/** 外链走仓内既有安全方式：Electron 经 main 的 `shell:openExternal` IPC 打系统浏览器，
 *  web 退 window.open。抄 EmailSourcePanel.openExternal 的同一探针。 */
function openExternal(url: string): void {
  const w = window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } }
  }
  const invoke = w.electron?.ipcRenderer?.invoke
  if (invoke) void invoke('shell:openExternal', url)
  else window.open(url, '_blank', 'noopener')
}

/** sync 统计的收窄读取。`ConnectorSyncResult` 的统计键**有意**是 `unknown`（服务端可以加
 *  计数而契约不钉死），所以取用处显式收窄一次：拿不到数就当 0，绝不把 `undefined` 插进文案。 */
function countOf(result: Record<string, unknown>, key: string): number {
  const raw = result[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/** epoch 秒 → 本地可读时间；非法值返回 null（调用方退化成"未知"文案，不显示 Invalid Date）。 */
function formatEpoch(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

// ── 徽标 ────────────────────────────────────────────────────────────────────

const PILL_BASE =
  'inline-flex items-center gap-1 rounded-full border border-ink-border px-1.5 py-0.5 text-micro'

const STATUS_PILL_CLASS: Record<ConnectorStatusValue, string> = {
  connected: 'bg-ok/15 text-ok',
  authorizing: 'bg-warn/15 text-warn',
  // needs_reauth 与 error 同吃危险色档：对用户是同一级别的「现在用不了」，区别在**主操作**
  // （重新连接 vs 重试），那由下面的按钮文案承担，不靠药丸颜色暗示。
  needs_reauth: 'bg-fail/15 text-fail',
  error: 'bg-fail/15 text-fail',
  disconnected: 'bg-ink-4 text-ink-fg-2'
}

const STATUS_LABEL_KEYS: Record<ConnectorStatusValue, string> = {
  connected: 'settings.connectors.status.connected',
  authorizing: 'settings.connectors.status.authorizing',
  needs_reauth: 'settings.connectors.status.needsReauth',
  error: 'settings.connectors.status.error',
  disconnected: 'settings.connectors.status.disconnected'
}

/** crud 四色：read 中性（只读不该染色成"好/坏"）· write 警示 · update 强调 · delete 失败色。 */
const CRUD_PILL_CLASS: Record<ConnectorCrudType, string> = {
  read: 'bg-ink-4 text-ink-fg-2',
  write: 'bg-warn/15 text-warn',
  update: 'bg-coral/15 text-coral',
  delete: 'bg-fail/15 text-fail'
}

const CRUD_LABEL_KEYS: Record<ConnectorCrudType, string> = {
  read: 'settings.connectors.tools.crud.read',
  write: 'settings.connectors.tools.crud.write',
  update: 'settings.connectors.tools.crud.update',
  delete: 'settings.connectors.tools.crud.delete'
}

// ── per-tool 三态控件 ───────────────────────────────────────────────────────

type ToolState = 'default' | 'on' | 'off'

const TOOL_STATES: readonly ToolState[] = ['default', 'on', 'off']

const TOOL_STATE_LABEL_KEYS: Record<ToolState, string> = {
  default: 'settings.connectors.tools.state.default',
  on: 'settings.connectors.tools.state.on',
  off: 'settings.connectors.tools.state.off'
}

function toolStateOf(override: boolean | null): ToolState {
  if (override == null) return 'default'
  return override ? 'on' : 'off'
}

/** 三段控件走 authored `.seg` + `.on`（AgentsTab 排程/窗口选择的存量原生用法，index.css
 *  §.seg）。不用 `ui/segmented` 是因为它没有 disabled 形态，而 delete / orphan 行**必须**
 *  渲染成禁用而不是消失。 */
function ToolStateControl({
  value,
  disabled,
  ariaLabel,
  onChange
}: {
  value: ToolState
  disabled: boolean
  ariaLabel: string
  onChange(next: ToolState): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="seg shrink-0" role="group" aria-label={ariaLabel}>
      {TOOL_STATES.map((state) => (
        <button
          key={state}
          type="button"
          disabled={disabled}
          aria-pressed={value === state}
          onClick={() => {
            if (state !== value) onChange(state)
          }}
          className={cn(
            value === state && 'on',
            disabled && 'cursor-not-allowed opacity-50 hover:text-ink-fg-2'
          )}
        >
          {t(TOOL_STATE_LABEL_KEYS[state])}
        </button>
      ))}
    </div>
  )
}

// ── 单个工具行 ──────────────────────────────────────────────────────────────

function ToolRow({
  tool,
  onChange
}: {
  tool: ConnectorToolSummary
  onChange(tool: ConnectorToolSummary, next: ToolState): void
}): React.ReactElement {
  const { t } = useTranslation()
  // delete 类恒不可启用（后端 403），orphan 行远端已没有这个工具 —— 两者都只展示不可改。
  const locked = tool.crud_type === 'delete' || tool.orphan
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-micro text-ink-fg break-all">{tool.name}</span>
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
          {tool.crud_type === 'delete'
            ? t('settings.connectors.tools.deleteTip')
            : tool.effective_enabled
              ? t('settings.connectors.tools.effectiveOn')
              : t('settings.connectors.tools.effectiveOff')}
        </div>
      </div>
      <ToolStateControl
        value={toolStateOf(tool.enabled_override)}
        disabled={locked}
        ariaLabel={t('settings.connectors.tools.state.label')}
        onChange={(next) => onChange(tool, next)}
      />
    </div>
  )
}

// ── 单个 connector 行 ───────────────────────────────────────────────────────

function ConnectorRow({
  connector,
  // 🔴 判「令牌是否过期」的时间基准来自 **react-query 的 `dataUpdatedAt`**（这份数据落进
  // 缓存的那一刻），不是 render 里的 `Date.now()`：后者在 render 期是不纯读
  // （react-hooks/purity），同一份 props 两次 render 能给出不同答案。列表每次刷新
  // （staleTime 10s / 每个写操作后 invalidate）这个基准跟着更新，够用 —— 令牌有效期
  // 是小时/天量级，不需要秒级跟随。
  nowMs
}: {
  connector: ConnectorSummary
  nowMs: number
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const id = connector.connector_id
  const bodyId = `connector-tools-${id}`
  const isWeb = isWebBuild()

  const [expanded, setExpanded] = React.useState(false)
  const [starting, setStarting] = React.useState(false)
  // 在途授权流（本地视角）：deadline 到点即放弃轮询。null = 没在等。
  const [awaiting, setAwaiting] = React.useState<{
    deadline: number
    timeoutSeconds: number
  } | null>(null)
  const [syncing, setSyncing] = React.useState(false)
  const [purging, setPurging] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)

  const invalidateList = React.useCallback(
    () => qc.invalidateQueries({ queryKey: qk.connectors() }),
    [qc]
  )

  const toolsQuery = useQuery<ConnectorToolSummary[]>({
    queryKey: qk.connectorTools(id),
    queryFn: () => api.connector.tools(id),
    // 懒加载：没展开就不打这个请求（registry 全集恒在列表里，展开的是少数）。
    enabled: expanded,
    staleTime: 10_000,
    retry: false
  })

  // 授权轮询。刻意用 setInterval 而非 useQuery.refetchInterval：这里还要一个**截止
  // 时间**（服务端只等 callback_timeout_seconds），deadline 判定与轮询同处一个回调
  // 比"query 轮询 + 另一个 effect 看时钟"少一层状态同步。轮询期的瞬时失败不打断——
  // 授权流在服务端进程内跑，网络抖一下不代表失败，等下一拍或超时。
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
      openExternal(started.authorize_url)
      setAwaiting({
        deadline: Date.now() + started.callback_timeout_seconds * 1000,
        timeoutSeconds: started.callback_timeout_seconds
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
      // 「有工具失效了」是这次同步唯一需要用户看一眼的结果 —— 折叠区里躺着的失效行才是
      // 证据，所以直接展开给他，而不是让 toast 说完就消失、把找证据的活儿留给用户。
      if (orphaned > 0) setExpanded(true)
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
      await api.connector.disconnect(id)
      setAwaiting(null)
      await invalidateList()
      setConfirmOpen(false)
    } catch (err) {
      toastError(t('settings.connectors.title'), errorMessage(err))
    } finally {
      setDisconnecting(false)
    }
  }

  async function handleToolState(tool: ConnectorToolSummary, next: ToolState): Promise<void> {
    try {
      // 'default' → null = 清除覆盖回默认档（三态的第三态，不是 false）。
      await api.connector.setToolEnabled(id, tool.name, next === 'default' ? null : next === 'on')
      await qc.invalidateQueries({ queryKey: qk.connectorTools(id) })
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  // 本地在途流优先于服务端快照（oauthStart 刚返回、列表还没刷新时也要显示"授权中"）。
  const status: ConnectorStatusValue = awaiting != null ? 'authorizing' : connector.status
  const connected = connector.status === 'connected'
  const expiresAt = formatEpoch(connector.credential?.expires_at)
  const expired =
    connector.credential?.expires_at != null && connector.credential.expires_at * 1000 < nowMs
  const lastSynced = formatEpoch(connector.last_synced_at)

  const controls: React.ReactNode = (() => {
    if (awaiting != null) {
      return (
        <>
          <Button size="sm" variant="secondary" disabled>
            <Loader2 className="size-3.5 animate-spin" />
            {t('settings.connectors.awaiting')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAwaiting(null)}>
            {t('settings.connectors.cancel')}
          </Button>
        </>
      )
    }
    if (connected) {
      return (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={syncing}
            onClick={() => void handleSync()}
          >
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {syncing ? t('settings.connectors.syncing') : t('settings.connectors.sync')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmOpen(true)}>
            {t('settings.connectors.disconnect')}
          </Button>
          <Switch
            checked={connector.enabled}
            onCheckedChange={(next) => void handleToggleEnabled(next)}
            aria-label={t('settings.connectors.enabled')}
            title={t('settings.connectors.enabledHelper')}
          />
        </>
      )
    }
    // needs_reauth 走**同一个** handleConnect —— 「重新连接」就是重走一次 OAuth，没有第二套
    // 逻辑；变的只是文案（对着一个曾经连上、现在授权失效的行说「连接」会让人以为没连过）。
    return (
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
      // 未展开且尚未取过数 → 什么都不渲染（否则折叠区里躺着一行幽灵「加载中」）。
      return expanded ? (
        <div className="flex items-center gap-2 py-1.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.connectors.tools.loading')}
        </div>
      ) : null
    }
    if (toolsQuery.data.length === 0) {
      return (
        <div className="py-1.5 text-aux text-ink-fg-3">{t('settings.connectors.tools.empty')}</div>
      )
    }
    const orphanCount = toolsQuery.data.filter((x) => x.orphan).length
    return (
      <>
        <div className="pb-1 text-micro text-ink-fg-3">
          {t('settings.connectors.tools.defaultHint')}
        </div>
        {toolsQuery.data.map((tool) => (
          <ToolRow
            key={tool.name}
            tool={tool}
            onChange={(x, next) => void handleToolState(x, next)}
          />
        ))}
        {/* 清理只删已失效行 —— 它们恒不注册、恒不可调用，删掉不改变任何 AI 能做的事，
            故不配确认对话框（给低风险动作加确认会稀释真正需要确认的那些）。 */}
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
      <div className="flex items-start gap-3 px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex flex-1 min-w-0 items-start gap-2 -my-1 rounded py-1 text-left transition-colors duration-fast hover:bg-ink-fg/[0.025]"
        >
          <CollapseChevron expanded={expanded} size={16} className="mt-0.5 text-ink-fg-2" />
          <span className="flex-1 min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-aux font-medium text-ink-fg">{connector.display_name}</span>
              <span className={cn(PILL_BASE, STATUS_PILL_CLASS[status])}>
                {t(STATUS_LABEL_KEYS[status])}
              </span>
            </span>
            <span className="mt-0.5 flex flex-col gap-0.5 text-meta text-ink-fg-2">
              <span className="truncate font-mono">{connector.server_url}</span>
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
                    {/* 🔴 `expires_at == null` 的真实语义是「**由自动刷新维护**」，不是「未知」：
                        有 refresh_token 时后端有意在明文列写 NULL（Notion 就是这样），所以这一
                        支恒成立于一个健康的连接。旧文案「令牌有效期未知」把一个正常状态说成了
                        可疑状态，用户会去点重连修一个没坏的东西。 */}
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
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">{controls}</div>
      </div>

      {/* 邮件预处理是**独立**授权位（不复用 custom agent 的 grant_connectors），天花板恒
          只读 —— 摆成一行常驻子行而不是藏进折叠区。 */}
      {connected ? (
        <div className="flex items-center gap-3 border-t border-ink-border-soft px-[var(--settings-tile-px,1rem)] py-3">
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
      ) : null}

      <CollapsibleRegion
        expanded={expanded}
        id={bodyId}
        bodyClassName="border-t border-ink-border-soft px-[var(--settings-tile-px,1rem)] py-3"
      >
        {toolsBody}
      </CollapsibleRegion>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('settings.connectors.disconnectDialog.title', { name: connector.display_name })}
            </DialogTitle>
            <DialogDescription>{t('settings.connectors.disconnectDialog.desc')}</DialogDescription>
          </DialogHeader>
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

// ── Section ────────────────────────────────────────────────────────────────

export function ConnectorsSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()

  const { data: flagEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('connectorToolsEnabled'),
    queryFn: fetchConnectorToolsEnabled,
    staleTime: 30_000,
    retry: false
  })

  const list = useQuery<ConnectorSummary[]>({
    queryKey: qk.connectors(),
    queryFn: () => api.connector.list(),
    enabled: flagEnabled === true,
    staleTime: 10_000,
    retry: false
  })

  // flag off（false / 加载中 / 不可达）→ 整区不渲染。此时 `/api/connector/*` 全 409。
  if (flagEnabled !== true) return null

  const rows: React.ReactNode = (() => {
    if (list.isError) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          {t('settings.connectors.loadError', { message: errorMessage(list.error) })}
        </div>
      )
    }
    if (!list.data) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.connectors.loading')}
        </div>
      )
    }
    if (list.data.length === 0) {
      // registry 全集恒在列表里 → 正常走不到；防御渲染，别让空数组变成一个空白卡片。
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.connectors.empty')}</div>
      )
    }
    return list.data.map((c) => (
      <ConnectorRow key={c.connector_id} connector={c} nowMs={list.dataUpdatedAt} />
    ))
  })()

  return (
    <Section title={t('settings.connectors.title')} helper={t('settings.connectors.desc')}>
      {rows}
    </Section>
  )
}
