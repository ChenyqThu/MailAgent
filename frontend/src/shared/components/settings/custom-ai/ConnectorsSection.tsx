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
//   2. **清单完整性**。工具清单渲染远端 manifest 的**全部**行，包括已失效（orphan）的
//      行 —— 它们恒不可启用（远端已经没有这个工具了），但"看得见但用不了"远比"干脆不
//      显示"诚实：用户能确认这个服务确实有这么个工具、且我们确实没给 AI。
//
//   3. **per-tool 三档**（08-05 WP-10）。`mode_override` 是 'auto' / 'ask' / 'off' /
//      **null（跟随默认档 auto）**，UI 给三档图标单选 + 「默认」小字；批量清覆盖走
//      Reset permissions。折算规则（null→auto）**不在前端重算** —— 直接显示后端给的
//      `effective_mode`，否则那套规则就成了第二处手抄。destructive 工具设 auto 的那一下
//      弹一次性红色确认（§4.3）；升级/首连一次性「工具面变宽」概览提示（风险 1 处置）。
//
// 🔴 远程 web 面不能发起连接：OAuth 回调走本机 loopback，远程浏览器打不开那个地址，
// 点了只会静默超时。故 web 构建下「连接」按钮 disabled + 明示去桌面 App 操作；其余
// 只读展示与开关照常（它们走 serve-api，远程可用）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Ban, Check, ChevronDown, Hand, Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ConnectorCrudType,
  ConnectorStatusValue,
  ConnectorSummary,
  ConnectorToolMode,
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
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'

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

/** 08-05 WP-10 — 「工具面变宽」一次性概览提示的确认标记（per-connector，localStorage）。
 *  读写都 try/catch：web 面 storage 被禁时提示每次都出，方向是多提醒不是漏提醒。 */
const TOOLFACE_NOTICE_KEY_PREFIX = 'mailagent.connectors.toolfaceNotice.v1.'

function readToolfaceNoticeAck(connectorId: string): boolean {
  try {
    return window.localStorage.getItem(`${TOOLFACE_NOTICE_KEY_PREFIX}${connectorId}`) === '1'
  } catch {
    return false
  }
}

function writeToolfaceNoticeAck(connectorId: string): void {
  try {
    window.localStorage.setItem(`${TOOLFACE_NOTICE_KEY_PREFIX}${connectorId}`, '1')
  } catch {
    /* storage 不可用 → 下次还会提示，可接受 */
  }
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

/** crud 三色：read 中性（只读不该染色成"好/坏"）· write 警示 · update 强调。
 *  🔴 08-03 起没有第四档 —— 「会不会毁数据」由 `destructive` 徽标单独承担（删除类工具
 *  就是 destructive 的 write），不再用一个恒不可用的 crud 档位表达。 */
const CRUD_PILL_CLASS: Record<ConnectorCrudType, string> = {
  read: 'bg-ink-4 text-ink-fg-2',
  write: 'bg-warn/15 text-warn',
  update: 'bg-coral/15 text-coral'
}

const CRUD_LABEL_KEYS: Record<ConnectorCrudType, string> = {
  read: 'settings.connectors.tools.crud.read',
  write: 'settings.connectors.tools.crud.write',
  update: 'settings.connectors.tools.crud.update'
}

// ── per-tool 三档控件（08-05 WP-10：auto ✓ / ask ✋ / off 🚫）─────────────────

const TOOL_MODES: readonly ConnectorToolMode[] = ['auto', 'ask', 'off']

const TOOL_MODE_LABEL_KEYS: Record<ConnectorToolMode, string> = {
  auto: 'settings.connectors.tools.mode.auto',
  ask: 'settings.connectors.tools.mode.ask',
  off: 'settings.connectors.tools.mode.off'
}

const TOOL_MODE_ICONS: Record<
  ConnectorToolMode,
  React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
> = {
  auto: Check,
  ask: Hand,
  off: Ban
}

const EFFECTIVE_MODE_LABEL_KEYS: Record<ConnectorToolMode, string> = {
  auto: 'settings.connectors.tools.effective.auto',
  ask: 'settings.connectors.tools.effective.ask',
  off: 'settings.connectors.tools.effective.off'
}

/** 三档图标单选走 authored `.seg` + `.on`（AgentsTab 排程/窗口选择的存量原生用法，
 *  index.css §.seg）。不用 `ui/segmented` 是因为它没有 disabled 形态，而 orphan 行
 *  **必须**渲染成禁用而不是消失。选中态显示的是**折算后的有效档**；覆盖为 null（跟随
 *  默认）时行上另有「默认」小字 —— NULL 能力保留（Reset permissions 批量清覆盖），
 *  控件本身只发显式三档。 */
function ToolModeControl({
  value,
  disabled,
  ariaLabel,
  onChange
}: {
  value: ConnectorToolMode
  disabled: boolean
  ariaLabel: string
  onChange(next: ConnectorToolMode): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="seg shrink-0" role="group" aria-label={ariaLabel}>
      {TOOL_MODES.map((mode) => {
        const Icon = TOOL_MODE_ICONS[mode]
        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            aria-pressed={value === mode}
            aria-label={t(TOOL_MODE_LABEL_KEYS[mode])}
            title={t(TOOL_MODE_LABEL_KEYS[mode])}
            onClick={() => {
              if (mode !== value) onChange(mode)
            }}
            className={cn(
              value === mode && 'on',
              disabled && 'cursor-not-allowed opacity-50 hover:text-ink-fg-2'
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

// ── 单个工具行 ──────────────────────────────────────────────────────────────

function ToolRow({
  tool,
  onChange
}: {
  tool: ConnectorToolSummary
  onChange(tool: ConnectorToolSummary, next: ConnectorToolMode): void
}): React.ReactElement {
  const { t } = useTranslation()
  // orphan 行远端已没有这个工具 —— 只展示不可改。（delete 档退役后这是唯一的锁定成因：
  // 破坏性工具照常可配，红药丸常显 + 设 auto 时一次性红色确认。）
  const locked = tool.orphan
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
          {t(EFFECTIVE_MODE_LABEL_KEYS[tool.effective_mode])}
          {tool.mode_override == null ? ` · ${t('settings.connectors.tools.followDefault')}` : ''}
        </div>
      </div>
      <ToolModeControl
        value={tool.effective_mode}
        disabled={locked}
        ariaLabel={t('settings.connectors.tools.mode.label')}
        onChange={(next) => onChange(tool, next)}
      />
    </div>
  )
}

// ── crud 分组头（计数 + 组级批量下拉，差距表 #5/#6）──────────────────────────

const CRUD_ORDER: readonly ConnectorCrudType[] = ['read', 'write', 'update']

function GroupBulkMenu({
  crud,
  onApply
}: {
  crud: ConnectorCrudType
  onApply(mode: ConnectorToolMode): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
          aria-label={`${t('settings.connectors.tools.bulk.label')} · ${t(CRUD_LABEL_KEYS[crud])}`}
        >
          {t('settings.connectors.tools.bulk.label')}
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        {TOOL_MODES.map((mode) => {
          const Icon = TOOL_MODE_ICONS[mode]
          return (
            <button
              key={mode}
              type="button"
              className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-4"
              onClick={() => {
                setOpen(false)
                onApply(mode)
              }}
            >
              <Icon className="size-3.5 text-ink-fg-2" aria-hidden="true" />
              {t(`settings.connectors.tools.bulk.${mode}`)}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
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
  // 08-05 WP-10 — destructive 工具设 auto 的一次性红色确认（单个 / 组级批量两形态）。
  const [confirmAuto, setConfirmAuto] = React.useState<
    | { kind: 'single'; tool: ConnectorToolSummary }
    | { kind: 'bulk'; crud: ConnectorCrudType; destructiveCount: number }
    | null
  >(null)
  // 08-05 WP-10 — 升级/首连一次性「工具面变宽」概览提示（风险 1 的处置）：per-connector
  // 的确认标记落 localStorage —— 升级前就连着的行没有标记 ⇒ 首次打开设置页即弹一次。
  const [noticeAck, setNoticeAck] = React.useState<boolean>(() => readToolfaceNoticeAck(id))

  const invalidateList = React.useCallback(
    () => qc.invalidateQueries({ queryKey: qk.connectors() }),
    [qc]
  )

  const connected = connector.status === 'connected'
  const noticePending = connected && !noticeAck

  const toolsQuery = useQuery<ConnectorToolSummary[]>({
    queryKey: qk.connectorTools(id),
    queryFn: () => api.connector.tools(id),
    // 懒加载：没展开就不打这个请求（registry 全集恒在列表里，展开的是少数）。
    // 例外：概览提示未确认时提前拉一次 —— N 读 M 写 K 破坏性的计数就来自这份清单。
    enabled: expanded || noticePending,
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
      // mode=null 全量清 per-tool 覆盖（Reset permissions，差距表 #8）——回到默认档 auto。
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
    // 按操作类型分组 + 计数（差距表 #5）；组头带批量下拉（#6）。
    const groups = CRUD_ORDER.map((crud) => ({
      crud,
      tools: toolsQuery.data!.filter((x) => x.crud_type === crud)
    })).filter((g) => g.tools.length > 0)
    return (
      <>
        <div className="flex items-center justify-between gap-3 pb-1">
          <div className="text-micro text-ink-fg-3">
            {t('settings.connectors.tools.defaultHint')}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void handleResetPermissions()}>
            {t('settings.connectors.tools.reset')}
          </Button>
        </div>
        {groups.map((group) => (
          <div key={group.crud} className="pt-1">
            <div className="flex items-center justify-between gap-3 border-b border-ink-border-soft pb-1">
              <div className="flex items-center gap-1.5">
                <span className={cn(PILL_BASE, CRUD_PILL_CLASS[group.crud])}>
                  {t(CRUD_LABEL_KEYS[group.crud])}
                </span>
                <span className="text-micro text-ink-fg-3">{group.tools.length}</span>
              </div>
              <GroupBulkMenu
                crud={group.crud}
                onApply={(mode) => handleBulkMode(group.crud, mode)}
              />
            </div>
            {group.tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} onChange={handleToolMode} />
            ))}
          </div>
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

      {/* 08-05 WP-10 — 升级/首连一次性「工具面变宽」概览：N 读 M 写 K 破坏性、默认全自动、
          可去下方调档。计数来自工具清单（noticePending 时 query 已提前启用）；清单还没到
          就先渲染骨架文案，不空转。 */}
      {noticePending ? (
        <div className="flex items-start gap-3 border-t border-ink-border-soft bg-warn/[0.06] px-[var(--settings-tile-px,1rem)] py-3">
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
                setExpanded(true)
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

      {/* 邮件预处理是**独立**授权位（不复用 custom agent 的 grant_connectors）——08-05 场地
          放开后不再限只读：开了之后该场地可用的是 per-tool「自动」档的工具（含写类；
          「需审批」在无人值守场地等同禁用）。摆成一行常驻子行而不是藏进折叠区。 */}
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

      {/* 08-05 WP-10 §4.3 — destructive 工具设 auto 的一次性红色确认：不阻止、只加摩擦。
          确认后该工具自动执行不再弹审批卡（红药丸仍常显；ask 档的审批卡红警告链不受影响）。 */}
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
