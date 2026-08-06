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
// 🔴 远程 web 面不能发起**直连**：OAuth 回调走本机 loopback，远程浏览器打不开那个地址，
// 点了只会静默超时。故 web 构建下直连行的「连接」按钮 disabled + 明示去桌面 App 操作；其余
// 只读展示与开关照常（它们走 serve-api，远程可用）。
// 🔴 **预置目录（Composio）不受这条限制**：它的授权页在 Composio 云上、回调也在它那边收，
// 我们只负责打开一个 https URL + 轮询状态 —— 远程网页版照样连得上。
//
// 08-05 WP-12（Composio 单轨预置目录）在本文件里加了三件事：
//   A. **BYOK key**：Composio API key 存 external_credential（Fernet+Keychain），设置页只
//      能写、不回显（状态只有「配了没 + 什么时候配的」）。**没配 key → 整个目录区 disabled**
//      + 引导（注册 → 取 key → 粘贴），点一下就跳到上面的输入框。
//   B. **出站告知三处之二**：目录区标题下一句常驻声明 + 每行「经 Composio」/「直连」小字；
//      首次连接任一预置服务时一次性 confirm（数据过境 / token 托管 / 去 dashboard 关日志
//      留存）。第三处在审批卡（McpApprovalCard）。
//   C. **多 toolkit 顺序授权**：Atlassian = Jira + Confluence 两个 toolkit，服务端连上第一个
//      之后把第二条链接填进 flow 并把 `link_seq` +1 —— 轮询里发现序号涨了就再开一次浏览器。

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
  ConnectorCatalogEntry,
  ConnectorCatalogView,
  ConnectorCrudType,
  ConnectorStatusValue,
  ConnectorSummary,
  ConnectorToolMode,
  ConnectorToolSummary
} from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
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

/** 08-05 WP-12 — 首次连接任一**预置**服务前的一次性出站告知（数据过境 / token 托管 /
 *  去 Composio dashboard 关日志留存）。全局一次，不是 per-connector：说的是这条路线的
 *  性质，不是某一家的性质。 */
const COMPOSIO_NOTICE_KEY = 'mailagent.connectors.composioOutboundNotice.v1'

function readComposioNoticeAck(): boolean {
  try {
    return window.localStorage.getItem(COMPOSIO_NOTICE_KEY) === '1'
  } catch {
    return false
  }
}

function writeComposioNoticeAck(): void {
  try {
    window.localStorage.setItem(COMPOSIO_NOTICE_KEY, '1')
  } catch {
    /* storage 不可用 → 下次还会问一次，方向是多提醒不是漏提醒 */
  }
}

/** 授权等待的默认上限（秒）：服务端 composio 轨等 Connect Link 的窗口与 loopback 回调同量级。 */
const DEFAULT_AUTH_TIMEOUT_SECONDS = 300

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
  // `openedSeq` = 已经替用户打开过第几条授权链接（08-05 WP-12 多 toolkit 顺序授权）。
  const [awaiting, setAwaiting] = React.useState<{
    deadline: number
    timeoutSeconds: number
    openedSeq: number
  } | null>(null)
  // 用户点过「取消等待」的那条流（按 started_at 认身份）——防止下面的「跟随服务端在途流」
  // 效应把它立刻重新拉起来（取消按钮会变得点不动）。
  const dismissedFlowRef = React.useRef<number | null>(null)
  const [syncing, setSyncing] = React.useState(false)
  const [purging, setPurging] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)
  // 断开对话框里的「同时清除工具配置」勾选（08-05 WP-12 差距表 #10）。被预置目录取代的老
  // 直连行**默认勾上** —— 那一行的存在意义就是等着被换掉，留着它 Composio 版本装不进来。
  const [purgeOnDisconnect, setPurgeOnDisconnect] = React.useState(connector.superseded_by_catalog)
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
  // 跟随服务端在途流：预置目录里点的「连接」发生在这一行**存在之前**（行由授权流建出来），
  // 所以列表刷新后要由行自己接手轮询，否则那次连接永远没人看结果。
  React.useEffect(() => {
    const flow = connector.flow
    if (flow == null || flow.status !== 'authorizing') return
    if (awaiting != null || connector.status === 'connected') return
    if (dismissedFlowRef.current === flow.started_at) return
    setAwaiting({
      deadline: Date.now() + DEFAULT_AUTH_TIMEOUT_SECONDS * 1000,
      timeoutSeconds: DEFAULT_AUTH_TIMEOUT_SECONDS,
      // 服务端已给出的链接由发起方（目录卡 / 本行按钮）负责打开，这里只从下一条起接手。
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
      await api.connector.disconnect(id, purgeOnDisconnect)
      setAwaiting(null)
      await invalidateList()
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // 记下这条流的身份，免得「跟随服务端在途流」效应立刻把等待重新拉起来。
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
              // 每次打开都按当前行状态重算勾选（useState 的初值只在挂载那一次生效：上一轮
              // 取消/不勾选之后再开，勾选态就会与「这行是不是被目录取代」脱节）。
              setPurgeOnDisconnect(connector.superseded_by_catalog)
              setConfirmOpen(true)
            }}
          >
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
              {/* 出站告知①之二：每行如实说这条连接的**执行路线**。判据是服务端字段，
                  不靠 URL 长相猜。 */}
              <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}>
                {connector.source === 'composio'
                  ? t('settings.connectors.viaComposio')
                  : t('settings.connectors.viaDirect')}
              </span>
            </span>
            <span className="mt-0.5 flex flex-col gap-0.5 text-meta text-ink-fg-2">
              <span className="truncate font-mono">{connector.server_url}</span>
              {connector.superseded_by_catalog ? (
                <span className="text-warn">{t('settings.connectors.supersededHint')}</span>
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
          {/* 08-05 WP-12 差距表 #10 —— 「同时清除工具配置」（= 把行也删掉）。被预置目录
              取代的老直连行默认勾上：那一行不清掉，同 id 的 Composio 版本就装不进来。 */}
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
      // 08-05 WP-12：列表 = 库里的行，一个都没有是**正常初始态**（去下面的预置目录连第一家）。
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
      <CatalogArea />
    </Section>
  )
}

// ── 预置目录（Composio 单轨）+ BYOK key ─────────────────────────────────────

/** 品牌字母牌（代码内数据，零网络）——见 `composio_catalog.py` 的 logo 取舍注释。 */
function CatalogLogo({ entry }: { entry: ConnectorCatalogEntry }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-[var(--r-ctl)] text-micro font-semibold text-white"
      style={{ backgroundColor: entry.logo_color }}
    >
      {entry.logo_text}
    </span>
  )
}

function CatalogTile({
  entry,
  disabled,
  connecting,
  onConnect
}: {
  entry: ConnectorCatalogEntry
  disabled: boolean
  connecting: boolean
  onConnect(entry: ConnectorCatalogEntry): void
}): React.ReactElement {
  const { t } = useTranslation()
  // 已配置 / 被老直连行占位 → 卡片只做陈述，操作在上面那一行里（同一家不给两个入口）。
  const occupied = entry.configured
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-[var(--r-card)] border border-ink-border p-2.5',
        disabled && 'opacity-50'
      )}
    >
      <CatalogLogo entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-aux font-medium text-ink-fg">{entry.display_name}</span>
          <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}>
            {t('settings.connectors.catalog.toolCount', { count: entry.tool_count })}
          </span>
        </div>
        <div className="mt-0.5 text-meta text-ink-fg-2 line-clamp-2">
          {t(entry.description_key)}
        </div>
        {entry.superseded ? (
          <div className="mt-0.5 text-micro text-warn">
            {t('settings.connectors.catalog.supersedes')}
          </div>
        ) : null}
      </div>
      <Button
        size="sm"
        variant={occupied ? 'ghost' : 'secondary'}
        disabled={disabled || occupied || connecting}
        onClick={() => onConnect(entry)}
      >
        {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {occupied
          ? t('settings.connectors.catalog.alreadyAdded')
          : t('settings.connectors.connect')}
      </Button>
    </div>
  )
}

function CatalogArea(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const keyInputRef = React.useRef<HTMLInputElement | null>(null)
  const [keyDraft, setKeyDraft] = React.useState('')
  const [savingKey, setSavingKey] = React.useState(false)
  const [connectingId, setConnectingId] = React.useState<string | null>(null)
  // 出站告知②：首次连接任一预置服务前的一次性 confirm（pending = 等确认的那一家）。
  const [pendingNotice, setPendingNotice] = React.useState<ConnectorCatalogEntry | null>(null)

  const catalog = useQuery<ConnectorCatalogView>({
    queryKey: qk.connectorCatalog(),
    queryFn: () => api.connector.catalog(),
    staleTime: 10_000,
    retry: false
  })

  const configured = catalog.data?.composio.configured === true

  async function saveKey(): Promise<void> {
    const value = keyDraft.trim()
    if (!value) return
    setSavingKey(true)
    try {
      await api.connector.setComposioKey(value)
      // 🔴 明文只在这一刻存在于内存里，保存后立刻清空输入框（不做任何回显）。
      setKeyDraft('')
      await qc.invalidateQueries({ queryKey: qk.connectors() })
      toastSuccess(t('settings.connectors.catalog.keySaved'))
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    } finally {
      setSavingKey(false)
    }
  }

  async function clearKey(): Promise<void> {
    try {
      await api.connector.clearComposioKey()
      await qc.invalidateQueries({ queryKey: qk.connectors() })
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  async function startConnect(entry: ConnectorCatalogEntry): Promise<void> {
    setConnectingId(entry.connector_id)
    try {
      const started = await api.connector.oauthStart(entry.connector_id)
      // 🔴 没有 URL = 这家在 Composio 侧之前就授权过（清行重装 / 上次拉清单失败后重试）：
      // 不开浏览器，行已建出来，下面刷新列表后由 ConnectorRow 跟随在途流轮询到 connected。
      if (started.authorize_url) openExternal(started.authorize_url)
      // 行由授权流建出来 → 刷新列表，之后由 ConnectorRow 接手轮询（它会跟随服务端在途流）。
      await qc.invalidateQueries({ queryKey: qk.connectors() })
    } catch (err) {
      toastError(t('settings.connectors.authFailed'), errorMessage(err))
    } finally {
      setConnectingId(null)
    }
  }

  function handleConnect(entry: ConnectorCatalogEntry): void {
    if (!readComposioNoticeAck()) {
      setPendingNotice(entry)
      return
    }
    void startConnect(entry)
  }

  const gateBlock = configured ? null : (
    <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-4/40 p-3">
      <div className="text-aux font-medium text-ink-fg">
        {t('settings.connectors.catalog.gateTitle')}
      </div>
      <div className="mt-0.5 whitespace-pre-line text-meta text-ink-fg-2">
        {t('settings.connectors.catalog.gateBody')}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            keyInputRef.current?.focus()
            keyInputRef.current?.scrollIntoView({ block: 'center' })
          }}
        >
          {t('settings.connectors.catalog.gateCta')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openExternal('https://app.composio.dev')}>
          {t('settings.connectors.catalog.gateSignup')}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-3 border-t border-ink-border-soft px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
      <div>
        <div className="text-aux font-medium text-ink-fg">
          {t('settings.connectors.catalog.title')}
        </div>
        {/* 出站告知①：常驻声明，不折叠、不 hover 才出现。 */}
        <div className="mt-0.5 text-meta text-ink-fg-2">
          {t('settings.connectors.catalog.outboundNotice')}
        </div>
      </div>

      {/* BYOK key —— 只写不回显；已配置时只显示「什么时候配的」。 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={keyInputRef}
          type="password"
          value={keyDraft}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('settings.connectors.catalog.keyPlaceholder')}
          aria-label={t('settings.connectors.catalog.keyLabel')}
          className="h-8 max-w-xs flex-1 text-aux"
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <Button
          size="sm"
          disabled={savingKey || keyDraft.trim() === ''}
          onClick={() => void saveKey()}
        >
          {savingKey ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('settings.connectors.catalog.keySave')}
        </Button>
        {configured ? (
          <>
            <span className="text-micro text-ink-fg-3">
              {t('settings.connectors.catalog.keyConfigured', {
                time: formatEpoch(catalog.data?.composio.updated_at) ?? '—'
              })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void clearKey()}>
              {t('settings.connectors.catalog.keyClear')}
            </Button>
          </>
        ) : null}
      </div>

      {gateBlock}

      {catalog.isError ? (
        <div className="text-aux text-ink-fg-3">
          {t('settings.connectors.loadError', { message: errorMessage(catalog.error) })}
        </div>
      ) : !catalog.data ? (
        <div className="flex items-center gap-2 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.connectors.loading')}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.data.entries.map((entry) => (
            <CatalogTile
              key={entry.connector_id}
              entry={entry}
              disabled={!configured}
              connecting={connectingId === entry.connector_id}
              onConnect={handleConnect}
            />
          ))}
        </div>
      )}

      {/* 出站告知②：一次性 confirm —— 数据过境 / token 托管 / 去 dashboard 关日志留存。 */}
      <Dialog
        open={pendingNotice != null}
        onOpenChange={(open) => {
          if (!open) setPendingNotice(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.connectors.catalog.outboundDialog.title')}</DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {t('settings.connectors.catalog.outboundDialog.desc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPendingNotice(null)}>
              {t('settings.connectors.catalog.outboundDialog.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const entry = pendingNotice
                setPendingNotice(null)
                writeComposioNoticeAck()
                if (entry) void startConnect(entry)
              }}
            >
              {t('settings.connectors.catalog.outboundDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
