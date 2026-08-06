// Connectors 配置台的共享常量 / 纯函数（08-06 双轨 + 独立配置台，Lane B）。
//
// 这里只放**非组件**导出（react-refresh/only-export-components：组件文件不混导出常量）。
// 大部分内容是从旧 settings/custom-ai/ConnectorsSection.tsx 原样搬来的 —— 那个区块降级成
// 指向 /connectors 的深链后，这些语义（web 判定 / 外链姿势 / 徽标配色 / 三档词表 / 一次性
// 提示的 localStorage 标记）全部由配置台接手，单源在此。

import type {
  ConnectorCatalogEntry,
  ConnectorCrudType,
  ConnectorStatusValue,
  ConnectorToolMode,
  ConnectorTrack
} from '@shared/api/types'

/** 授权回调轮询节拍。服务端 `callback_timeout_seconds`（默认 300s）是上限，到点即放弃。 */
export const AUTH_POLL_INTERVAL_MS = 2000

/** 授权等待的默认上限（秒）：跟随服务端在途流时本地没有 started 响应可读，用它兜底。 */
export const DEFAULT_AUTH_TIMEOUT_SECONDS = 300

/** 远程 web（SPA）构建判定。镜像全仓既有 `VITE_BUILD_TARGET === 'web'` 探针
 *  （SettingsShell / EnvField / McpApprovalCard 同款），并额外读 `process.env` ——
 *  vitest 的 `vi.stubEnv` 只写得进 process.env（见 assistant/runtime/flags.ts 的同款注释）。 */
export function isWebBuild(): boolean {
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
export function openExternal(url: string): void {
  const w = window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } }
  }
  const invoke = w.electron?.ipcRenderer?.invoke
  if (invoke) void invoke('shell:openExternal', url)
  else window.open(url, '_blank', 'noopener')
}

/** sync 统计的收窄读取。`ConnectorSyncResult` 的统计键**有意**是 `unknown`（服务端可以加
 *  计数而契约不钉死），所以取用处显式收窄一次：拿不到数就当 0，绝不把 `undefined` 插进文案。 */
export function countOf(result: Record<string, unknown>, key: string): number {
  const raw = result[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/** epoch 秒 → 本地可读时间；非法值返回 null（调用方退化成"未知"文案，不显示 Invalid Date）。 */
export function formatEpoch(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString()
}

/** 目录条目的轨道收窄（跨 lane 契约 §3）。🔴 **不直读 `entry.track`**：Lane A 未落地 /
 *  老服务端时字段缺席，缺席按 `composio`（现状语义）处理 —— 把一个 Composio 轨条目误当
 *  直连轨只是少了 BYOK gate 提示，反过来会让直连条目卡在「先填 key」死路上。 */
export function resolveCatalogTrack(entry: ConnectorCatalogEntry): ConnectorTrack {
  return (entry as { track?: unknown }).track === 'direct' ? 'direct' : 'composio'
}

// ── 一次性提示的 localStorage 标记（读写都 try/catch：storage 被禁时提示每次都出，
//    方向是多提醒不是漏提醒）─────────────────────────────────────────────────────

/** 08-05 WP-10 — 「工具面变宽」一次性概览提示的确认标记（per-connector）。 */
export const TOOLFACE_NOTICE_KEY_PREFIX = 'mailagent.connectors.toolfaceNotice.v1.'

export function readToolfaceNoticeAck(connectorId: string): boolean {
  try {
    return window.localStorage.getItem(`${TOOLFACE_NOTICE_KEY_PREFIX}${connectorId}`) === '1'
  } catch {
    return false
  }
}

export function writeToolfaceNoticeAck(connectorId: string): void {
  try {
    window.localStorage.setItem(`${TOOLFACE_NOTICE_KEY_PREFIX}${connectorId}`, '1')
  } catch {
    /* storage 不可用 → 下次还会提示，可接受 */
  }
}

/** 08-05 WP-12 — 首次连接任一 **Composio 轨**服务前的一次性出站告知。全局一次，不是
 *  per-connector：说的是这条路线的性质，不是某一家的性质。直连轨不经它。 */
export const COMPOSIO_NOTICE_KEY = 'mailagent.connectors.composioOutboundNotice.v1'

export function readComposioNoticeAck(): boolean {
  try {
    return window.localStorage.getItem(COMPOSIO_NOTICE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeComposioNoticeAck(): void {
  try {
    window.localStorage.setItem(COMPOSIO_NOTICE_KEY, '1')
  } catch {
    /* storage 不可用 → 下次还会问一次，方向是多提醒不是漏提醒 */
  }
}

// ── 徽标 / 词表 ─────────────────────────────────────────────────────────────

export const PILL_BASE =
  'inline-flex items-center gap-1 rounded-full border border-ink-border px-1.5 py-0.5 text-micro'

export const STATUS_PILL_CLASS: Record<ConnectorStatusValue, string> = {
  connected: 'bg-ok/15 text-ok',
  authorizing: 'bg-warn/15 text-warn',
  // needs_reauth 与 error 同吃危险色档：对用户是同一级别的「现在用不了」，区别在**主操作**
  // （重新连接 vs 重试），那由按钮文案承担，不靠药丸颜色暗示。
  needs_reauth: 'bg-fail/15 text-fail',
  error: 'bg-fail/15 text-fail',
  disconnected: 'bg-ink-4 text-ink-fg-2'
}

export const STATUS_LABEL_KEYS: Record<ConnectorStatusValue, string> = {
  connected: 'settings.connectors.status.connected',
  authorizing: 'settings.connectors.status.authorizing',
  needs_reauth: 'settings.connectors.status.needsReauth',
  error: 'settings.connectors.status.error',
  disconnected: 'settings.connectors.status.disconnected'
}

/** crud 三色：read 中性 · write 警示 · update 强调。🔴 08-03 起没有第四档 —— 「会不会毁
 *  数据」由 `destructive` 徽标单独承担。 */
export const CRUD_PILL_CLASS: Record<ConnectorCrudType, string> = {
  read: 'bg-ink-4 text-ink-fg-2',
  write: 'bg-warn/15 text-warn',
  update: 'bg-coral/15 text-coral'
}

export const CRUD_LABEL_KEYS: Record<ConnectorCrudType, string> = {
  read: 'settings.connectors.tools.crud.read',
  write: 'settings.connectors.tools.crud.write',
  update: 'settings.connectors.tools.crud.update'
}

export const CRUD_ORDER: readonly ConnectorCrudType[] = ['read', 'write', 'update']

export const TOOL_MODES: readonly ConnectorToolMode[] = ['auto', 'ask', 'off']

export const TOOL_MODE_LABEL_KEYS: Record<ConnectorToolMode, string> = {
  auto: 'settings.connectors.tools.mode.auto',
  ask: 'settings.connectors.tools.mode.ask',
  off: 'settings.connectors.tools.mode.off'
}

export const EFFECTIVE_MODE_LABEL_KEYS: Record<ConnectorToolMode, string> = {
  auto: 'settings.connectors.tools.effective.auto',
  ask: 'settings.connectors.tools.effective.ask',
  off: 'settings.connectors.tools.effective.off'
}

// ── 选中项（左栏 master → 右栏 detail 的路由词）────────────────────────────────

/** 配置台的选中项。`?item=` 深链与左栏点击共用这一形状；`external-root` 只出现在深链解析
 *  （「跳到外部连接区」的模糊落点），渲染前会被归一成具体条目。 */
export type ConsoleSelection =
  | { kind: 'builtin'; group: string }
  | { kind: 'connector'; id: string }
  | { kind: 'catalog'; id: string }
  | { kind: 'composio' }

export type ConsoleItemParam = ConsoleSelection | { kind: 'external-root' }

/** 选中项 → `?item=` 值（`builtin:<group>` / `connector:<id>` / `catalog:<id>` / `composio`）。 */
export function selectionToItemParam(sel: ConsoleSelection): string {
  switch (sel.kind) {
    case 'builtin':
      return `builtin:${sel.group}`
    case 'connector':
      return `connector:${sel.id}`
    case 'catalog':
      return `catalog:${sel.id}`
    case 'composio':
      return 'composio'
  }
}

/** `?item=` → 选中项；非法 / 缺席 → null（页面落到默认选中）。宽松解析：手敲 URL 不崩页。 */
export function parseItemParam(raw: string | undefined | null): ConsoleItemParam | null {
  if (!raw) return null
  if (raw === 'composio') return { kind: 'composio' }
  if (raw === 'external') return { kind: 'external-root' }
  const idx = raw.indexOf(':')
  if (idx <= 0) return null
  const kind = raw.slice(0, idx)
  const rest = raw.slice(idx + 1)
  if (!rest) return null
  if (kind === 'builtin') return { kind: 'builtin', group: rest }
  if (kind === 'connector') return { kind: 'connector', id: rest }
  if (kind === 'catalog') return { kind: 'catalog', id: rest }
  return null
}
