// ImFeishuSection — 设置-AI「飞书对话」区（08-01 阶段 2 PR-4「信任可见」）。
//
// PRODUCT.md 设计原则 1：*"Make trust observable: expose provenance, permissions, run
// state, approvals, costs, and failure causes at the point of action"*。IM 入口引入了
// 两样此前不存在的东西 —— 新的 **provenance**（消息来自飞书的哪个人）与新的**权限面**
// （飞书这个场合能用哪些工具）。它们**不能只在代码里正确**，必须在桌面上看得见。
// 本区就是那句原则的落地：连接状态 / 绑定了谁 / IM 侧工具集 / 上网开关 / 批过哪些操作。
//
// 三条与别的设置区不同的取舍（都是有意的）：
//
//   1. **flag off 时不隐身，如实显示「未启用」**。ConnectorsSection 在 flag off 时整区
//      `return null`；这里不。理由：`MAILAGENT_IM_FEISHU` 是**没有 UI 开关**的 env 灰度闸
//      （双载体、翻它要同时重启 serve 与 app），整区隐身 = 用户既不知道有这个功能、也不
//      知道它为什么不工作。摆出来 + 写清键名，才是「能决定」而不是「找不到」。
//
//   2. **IM 工具集是陈述，不是配置**。那五行不是开关 —— 它们由 `im_chat` 的 policy 矩阵
//      钉死（读免批 / 写恒 HITL / 本地命令·配置修改·外呼根本不注册），把它们画成可点的
//      控件就是撒谎。唯一真开关是上网那一个（grill Q19=A）。
//
//   3. **审批历史的标题必须说人话且不越界**。DB 里能查到的是「`origin='im'` 会话里的审批
//      决定」，**不是**「点击发生在飞书」—— gateway 对桌面卡与飞书卡写的是同一个
//      `approval_status`，分不出来。文案照此写，宁可弱一点也不能暗示一个查不出的事实。
//
// 🔴 远程 web 构建：`POST /api/im/pair` 挂 `verify_local_token`（远程 CF 用户恒 403 ——
// 把飞书账号接进本机执行通道的动作不该从远程发起），上网开关走 `env:set`（web 上
// notImplemented）。故两者在 web 下禁用 + 明示去桌面 App 操作；只读展示照常。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, MessageCircle } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { resolveApiBaseUrl } from './shared'

// query key：本区是叶子消费方（没有第二处需要 invalidate 它），故不进 `qk` 工厂 ——
// 那份工厂是给跨组件共享的键准备的，塞一个独占键进去只会让它更难读。
const QK_IM_STATUS = ['im', 'status'] as const
const QK_IM_APPROVALS = ['im', 'approvals'] as const

// 🔴 上网开关的 env 键（`MAILAGENT_IM_WEB_ENABLED`，Node 单载体、main-env-only）在下面
// **写成字面量而不是抽成常量**：`tests/main/env_keys_ui_coverage.test.ts` 的三条抽取正则
// 只认字面量形态的读写点。抽成常量并不会让那道闸变红（正则匹配不上就当没看见），但会让
// 这个键悄悄**脱离**「渲染了就必须存得进去」的覆盖 —— 一个安静失效的闸比没有闸更糟。
// （同理，这段注释里也不能出现那三个正则的样例写法 —— 它扫的是整份源文件文本，注释里的
// 占位样例会被当成真实使用点抽出来。）

/** 远程 web（SPA）构建判定 —— 与 ConnectorsSection 同款双探针（vitest 的 `vi.stubEnv`
 *  只写得进 process.env；生产 web bundle 里没有 `process`，Electron renderer 里该键
 *  是 undefined，故这一读在两个真实环境里都不改变结果）。 */
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

// ── wire 形状（serve-api /api/im/*，envelope = {status, data, error, meta}）────────

export interface ImStatus {
  enabled: boolean
  connection_status: string
  connected_at: string
  last_event_at: string
  bound_open_id: string
  bound_at: string
  bot_app_name: string
  bot_open_id: string
  bot_app_id: string
  conflict: boolean
  conflict_reason: string
  last_error: string
  credential_present: boolean
  credential_updated_at: number | null
  pair_code_pending: boolean
  pair_code_expires_at: number
}

interface ImApproval {
  tool_name: string
  approval_status: string
  /** 🔴 epoch **毫秒**（CHAT_DB 的 `COALESCE(confirmed_at, updated_at)`，两列都由
   *  `chat_db/tool_calls.ts` 的 `Date.now()` 写入），**不是秒** —— 与本文件另一个时间
   *  字段 `pair_code_expires_at`（Python `time.time()`，秒）单位相反。见 `formatEpochMs`。 */
  decided_at: number | null
  session_id: number
  session_title: string | null
}

interface ImApprovals {
  /** false = 账本读不到（ai_chat.db 不存在 / 锁）。🔴 **不是**「零条」——把不可达渲染成
   *  0 就是谎报，所以两种情况的文案必须分开。 */
  available: boolean
  items: ImApproval[]
}

async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${resolveApiBaseUrl()}${path}`, { credentials: 'include' })
  const body = (await resp.json().catch(() => null)) as {
    data?: T
    error?: { message?: string; code?: string }
  } | null
  if (!resp.ok) {
    throw new Error(body?.error?.message || `HTTP ${resp.status}`)
  }
  if (!body || body.data == null) throw new Error('empty response')
  return body.data
}

async function postPair(rebind: boolean): Promise<{ code: string; expires_at: number }> {
  const resp = await fetch(`${resolveApiBaseUrl()}/im/pair`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rebind })
  })
  const body = (await resp.json().catch(() => null)) as {
    data?: { code: string; expires_at: number }
    error?: { message?: string }
  } | null
  if (!resp.ok || !body?.data) throw new Error(body?.error?.message || `HTTP ${resp.status}`)
  return body.data
}

// ── 连接状态徽标 ─────────────────────────────────────────────────────────────

const PILL_BASE =
  'inline-flex items-center gap-1 rounded-full border border-ink-border px-1.5 py-0.5 text-micro'

/** `src/im/state.py` 的 `STATUS_*` 值域（disabled/connecting/connected/disconnected/
 *  conflict/error/stopped）→ 药丸配色，外加一个**纯 UI 态** `unknown`（状态还没读到 /
 *  读失败，见下方 `effectiveStatus`）。未知值走 fallback 中性档（后端加了新态时不至于
 *  渲染成空白，而是显示原始字符串 —— fail-visible 胜过静默）。 */
const STATUS_PILL_CLASS: Record<string, string> = {
  unknown: 'bg-ink-4 text-ink-fg-3',
  connected: 'bg-ok/15 text-ok',
  connecting: 'bg-warn/15 text-warn',
  disconnected: 'bg-warn/15 text-warn',
  conflict: 'bg-fail/15 text-fail',
  error: 'bg-fail/15 text-fail',
  stopped: 'bg-ink-4 text-ink-fg-2',
  disabled: 'bg-ink-4 text-ink-fg-3'
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  unknown: 'settings.imFeishu.status.unknown',
  connected: 'settings.imFeishu.status.connected',
  connecting: 'settings.imFeishu.status.connecting',
  disconnected: 'settings.imFeishu.status.disconnected',
  conflict: 'settings.imFeishu.status.conflict',
  error: 'settings.imFeishu.status.error',
  stopped: 'settings.imFeishu.status.stopped',
  disabled: 'settings.imFeishu.status.disabled'
}

/** epoch 秒 → 本地可读时间；非法值 → null（调用方退化成「未知」，不显示 Invalid Date）。
 *  用于 **Python 侧**产生的时间戳（`pair_code_expires_at` = `time.time()`）。 */
function formatEpoch(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null
  const d = new Date(sec * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

/** epoch **毫秒** → 本地可读时间。用于 **CHAT_DB 侧**产生的时间戳（`decided_at`）。
 *
 *  🔴 与 `formatEpoch` 刻意分成两个函数：两个数据源的单位真的不同，而两者都是十位/十三位
 *  整数、在 JSON 里肉眼分不出来。用错单位**不会报错也不会红**，只会安静地把 2026 年渲染成
 *  五万七千年（`new Date(1785863678495 * 1000)`）—— 这正是本函数存在的理由。 */
function formatEpochMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

/** ISO 串 → 本地可读时间；空/非法 → null。 */
function formatIso(iso: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

// ── 绑定码卡（含到期倒计时）──────────────────────────────────────────────────

function PairCodeBox({ code, expiresAt }: { code: string; expiresAt: number }): React.ReactElement {
  const { t } = useTranslation()
  const [nowSec, setNowSec] = React.useState(() => Math.floor(Date.now() / 1000))
  React.useEffect(() => {
    const id = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])
  const left = expiresAt - nowSec
  const expired = left <= 0
  const mm = Math.floor(Math.max(left, 0) / 60)
  const ss = Math.max(left, 0) % 60

  return (
    <div className="mt-2 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-4/60 px-3 py-2.5">
      <div
        className={cn(
          'font-mono text-lead tracking-[0.35em]',
          expired ? 'text-ink-fg-3 line-through' : 'text-ink-fg'
        )}
      >
        {code}
      </div>
      <div className="mt-1 text-meta text-ink-fg-2">
        {expired
          ? t('settings.imFeishu.pair.expired')
          : t('settings.imFeishu.pair.countdown', {
              time: `${mm}:${String(ss).padStart(2, '0')}`
            })}
      </div>
      <div className="mt-1 text-meta text-ink-fg-3">{t('settings.imFeishu.pair.howto')}</div>
    </div>
  )
}

// ── Section ─────────────────────────────────────────────────────────────────

export function ImFeishuSection(): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isWeb = isWebBuild()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const envState = useEnvStore((s) => s.state)

  const [pairing, setPairing] = React.useState(false)
  const [issued, setIssued] = React.useState<{ code: string; expiresAt: number } | null>(null)
  const [webSubmitting, setWebSubmitting] = React.useState(false)

  const status = useQuery<ImStatus>({
    queryKey: QK_IM_STATUS,
    queryFn: () => apiGet<ImStatus>('/im/status'),
    staleTime: 10_000,
    retry: false
  })

  const approvals = useQuery<ImApprovals>({
    queryKey: QK_IM_APPROVALS,
    queryFn: () => apiGet<ImApprovals>('/im/approvals?limit=10'),
    staleTime: 30_000,
    retry: false
  })

  // 上网开关：env 快照直读 + `applyEnvPatch` 写（WebCapabilityRow 同款）。envBool 镜像：
  // 未设 → 默认 OFF；显式值 lowercased ∈ {1,true} → ON。env store 未 ready 时按默认 OFF
  // 展示并禁用交互（避免加载态被误当成「已关」后误写）。
  const envReady = envState.status === 'ready'
  const webRaw = envReady ? (envState.snapshot.values['MAILAGENT_IM_WEB_ENABLED'] ?? '') : ''
  const webChecked = envReady ? ['1', 'true'].includes(webRaw.trim().toLowerCase()) : false

  async function handleToggleWeb(next: boolean): Promise<void> {
    setWebSubmitting(true)
    try {
      const result = await applyEnvPatch({ MAILAGENT_IM_WEB_ENABLED: next ? 'true' : 'false' })
      if (result.ok) {
        // restart-required：gateway 启动时 envBool 读一次（main-env-only，无 vite define）。
        if (result.changedKeys.length > 0) markRestartRequired(result.changedKeys)
        toastSuccess(t('settings.imFeishu.web.title'))
      } else {
        toastError(
          t('settings.imFeishu.web.title'),
          `${result.error.code}: ${result.error.message}`
        )
      }
    } finally {
      setWebSubmitting(false)
    }
  }

  async function handlePair(rebind: boolean): Promise<void> {
    setPairing(true)
    try {
      const data = await postPair(rebind)
      setIssued({ code: data.code, expiresAt: data.expires_at })
      await qc.invalidateQueries({ queryKey: QK_IM_STATUS })
    } catch (err) {
      toastError(t('settings.imFeishu.pair.failed'), errorMessage(err))
    } finally {
      setPairing(false)
    }
  }

  const s = status.data
  // 三态，两条都是「不撒谎」：
  //   · 还没读到 / 读失败（`s == null`）→ `unknown`。**不能显示成「未启用」** —— 那是一句
  //     关于系统状态的断言，而此刻我们恰恰不知道（后端没起时最容易被误读成「功能没开」）。
  //   · flag off → `connection_status` 是**上次记录**（serve 被 kill -9 时它可能还停在
  //     connected），直接当现状显示同样是撒谎，故强制 disabled 档。
  const effectiveStatus = s == null ? 'unknown' : s.enabled ? s.connection_status : 'disabled'
  const pillClass = STATUS_PILL_CLASS[effectiveStatus] ?? 'bg-ink-4 text-ink-fg-2'
  const statusLabelKey = STATUS_LABEL_KEYS[effectiveStatus]

  const connectionBody: React.ReactNode = (() => {
    if (status.isError) {
      return (
        <div className="text-meta text-ink-fg-3">
          {t('settings.imFeishu.loadError', { message: errorMessage(status.error) })}
        </div>
      )
    }
    if (!s) {
      return (
        <div className="flex items-center gap-2 text-meta text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.imFeishu.loading')}
        </div>
      )
    }
    const connectedAt = formatIso(s.connected_at)
    const lastEventAt = formatIso(s.last_event_at)
    return (
      <span className="flex flex-col gap-0.5 text-meta text-ink-fg-2">
        {!s.enabled ? <span>{t('settings.imFeishu.disabledHint')}</span> : null}
        {s.enabled && connectedAt ? (
          <span>{t('settings.imFeishu.connectedAt', { time: connectedAt })}</span>
        ) : null}
        {s.enabled && lastEventAt ? (
          <span>{t('settings.imFeishu.lastEventAt', { time: lastEventAt })}</span>
        ) : null}
        {!s.credential_present ? (
          <span className="text-warn">{t('settings.imFeishu.noCredential')}</span>
        ) : null}
        {s.conflict ? (
          <span className="flex items-start gap-1 text-fail">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>
              {t('settings.imFeishu.conflict', {
                reason: s.conflict_reason || t('settings.imFeishu.conflictUnknown')
              })}
            </span>
          </span>
        ) : null}
        {s.last_error ? (
          <span className="text-fail">
            {t('settings.imFeishu.lastError', { message: s.last_error })}
          </span>
        ) : null}
      </span>
    )
  })()

  const bindingBody: React.ReactNode = (() => {
    if (!s) return null
    const boundAt = formatIso(s.bound_at)
    if (s.bound_open_id) {
      return (
        <span className="flex flex-col gap-0.5 text-meta text-ink-fg-2">
          <span className="font-mono break-all">
            {t('settings.imFeishu.bind.boundTo', { openId: s.bound_open_id })}
          </span>
          {boundAt ? <span>{t('settings.imFeishu.bind.boundAt', { time: boundAt })}</span> : null}
          <span>
            {t('settings.imFeishu.bind.bot', {
              name: s.bot_app_name || t('settings.imFeishu.bind.unknownBot'),
              appId: s.bot_app_id || '—'
            })}
          </span>
          {/* 🔴 C6 实证的同名陷阱：owner 环境里对话 app 与通知 app 都叫「MailAgent」，
              光看名字分不出在跟哪个 bot 说话。所以这一行永远把 app_id 摆出来。 */}
          <span className="text-ink-fg-3">{t('settings.imFeishu.bind.sameNameTrap')}</span>
        </span>
      )
    }
    return (
      <span className="flex flex-col gap-0.5 text-meta text-ink-fg-2">
        <span>{t('settings.imFeishu.bind.unbound')}</span>
        {s.pair_code_pending && !issued ? (
          <span>
            {t('settings.imFeishu.bind.codePending', {
              time: formatEpoch(s.pair_code_expires_at) ?? '—'
            })}
          </span>
        ) : null}
      </span>
    )
  })()

  const approvalsBody: React.ReactNode = (() => {
    if (approvals.isError) {
      return (
        <div className="text-meta text-ink-fg-3">
          {t('settings.imFeishu.approvals.loadError', { message: errorMessage(approvals.error) })}
        </div>
      )
    }
    if (!approvals.data) {
      return (
        <div className="flex items-center gap-2 text-meta text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          {t('settings.imFeishu.approvals.loading')}
        </div>
      )
    }
    if (!approvals.data.available) {
      // 🔴 「读不到」≠「零条」。分开说，别把不可达渲染成「没批过任何操作」。
      return (
        <div className="text-meta text-ink-fg-3">
          {t('settings.imFeishu.approvals.unavailable')}
        </div>
      )
    }
    if (approvals.data.items.length === 0) {
      return <div className="text-meta text-ink-fg-3">{t('settings.imFeishu.approvals.empty')}</div>
    }
    return (
      <ul className="flex flex-col gap-1.5">
        {approvals.data.items.map((item, i) => {
          const rejected = item.approval_status === 'rejected'
          const at = formatEpochMs(item.decided_at)
          return (
            <li
              key={`${item.session_id}-${item.tool_name}-${item.decided_at ?? i}`}
              className="flex flex-wrap items-center gap-2 text-meta text-ink-fg-2"
            >
              <span
                className={cn(PILL_BASE, rejected ? 'bg-fail/15 text-fail' : 'bg-ok/15 text-ok')}
              >
                {rejected
                  ? t('settings.imFeishu.approvals.rejected')
                  : t('settings.imFeishu.approvals.approved')}
              </span>
              <span className="font-mono text-ink-fg">{item.tool_name}</span>
              {at ? <span className="text-ink-fg-3">{at}</span> : null}
            </li>
          )
        })}
      </ul>
    )
  })()

  return (
    <Section title={t('settings.imFeishu.title')} helper={t('settings.imFeishu.desc')}>
      {/* ① 连接状态 */}
      <Row
        label={
          <span className="flex items-center gap-2">
            <MessageCircle className="size-3.5 shrink-0 text-ink-fg-2" />
            {t('settings.imFeishu.connection')}
          </span>
        }
        helper={connectionBody}
      >
        <span className={cn(PILL_BASE, pillClass)}>
          {statusLabelKey ? t(statusLabelKey) : effectiveStatus}
        </span>
      </Row>

      {/* ② 绑定 */}
      <Row label={t('settings.imFeishu.bind.title')} helper={bindingBody}>
        {s ? (
          <Button
            size="sm"
            variant={s.bound_open_id ? 'ghost' : 'default'}
            disabled={isWeb || pairing || !s.enabled}
            title={
              isWeb
                ? t('settings.imFeishu.bind.webDisabled')
                : !s.enabled
                  ? t('settings.imFeishu.bind.flagOffDisabled')
                  : undefined
            }
            onClick={() => void handlePair(Boolean(s.bound_open_id))}
          >
            {pairing ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {s.bound_open_id
              ? t('settings.imFeishu.bind.rebind')
              : t('settings.imFeishu.bind.issue')}
          </Button>
        ) : null}
      </Row>
      {issued ? (
        <div className="px-[var(--settings-tile-px,1rem)] py-3">
          <PairCodeBox code={issued.code} expiresAt={issued.expiresAt} />
        </div>
      ) : null}

      {/* ③ IM 工具集 —— 陈述，不是配置（见文件头取舍 2）。 */}
      <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
        <div className="text-aux font-medium text-ink-fg">{t('settings.imFeishu.tools.title')}</div>
        <div className="mt-0.5 text-meta text-ink-fg-2">{t('settings.imFeishu.tools.desc')}</div>
        <ul className="mt-1.5 flex flex-col gap-1 text-meta text-ink-fg-2">
          <li>{t('settings.imFeishu.tools.read')}</li>
          <li>{t('settings.imFeishu.tools.write')}</li>
          <li>{t('settings.imFeishu.tools.connector')}</li>
          <li>{t('settings.imFeishu.tools.web')}</li>
          <li>{t('settings.imFeishu.tools.denied')}</li>
        </ul>
      </div>

      {/* ④ 上网开关（grill Q19=A —— 唯一真开关） */}
      <Row
        label={t('settings.imFeishu.web.title')}
        helper={
          <span className="flex flex-col gap-0.5">
            <span>{t('settings.imFeishu.web.desc')}</span>
            <span className="text-ink-fg-3">{t('settings.imFeishu.web.restartHint')}</span>
            {isWeb ? (
              <span className="text-ink-fg-3">{t('settings.imFeishu.web.webDisabled')}</span>
            ) : null}
          </span>
        }
      >
        <Switch
          checked={webChecked}
          disabled={!envReady || isWeb || webSubmitting}
          onCheckedChange={(next) => void handleToggleWeb(next)}
          aria-label={t('settings.imFeishu.web.title')}
        />
      </Row>

      {/* ⑤ 审批历史 */}
      <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
        <div className="text-aux font-medium text-ink-fg">
          {t('settings.imFeishu.approvals.title')}
        </div>
        <div className="mt-0.5 mb-1.5 text-meta text-ink-fg-2">
          {t('settings.imFeishu.approvals.desc')}
        </div>
        {approvalsBody}
      </div>
    </Section>
  )
}
