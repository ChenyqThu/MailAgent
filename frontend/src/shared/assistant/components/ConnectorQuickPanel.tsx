// 08-03 dogfood — composer 里的「外部连接」快捷面板（owner: 参考 lobechat，把外部工具放到
// 对话框底部随时开关）。
//
// 一个共享组件，两个视觉变体（双 composer 落点，与 ApprovalModePicker 同款分工）：
//   - 'icon' — 7×7 方角 icon 按钮，ThreadComposer 工具条（ComposerModelPicker 同尺寸/同弹层）
//   - 'chip' — 7×7 圆形 icon 按钮，AgentComposer 动作行（AgentAttachmentButton 同款圆钮）
// 远程 web 渲染同一棵树：开关走 serve-api，远程可用；**发起 OAuth 连接**不在这里（回调走本机
// loopback，远程点了只会静默超时），故本面板只有「开/关 + 去管理」，连接入口恒在设置页。
//
// 🔴 MVP 边界 = **全局开关的镜像**，不是第二套状态：Switch 直接写穿 `connector.setEnabled`
// （与设置页同一个后端位），成功后 invalidate `qk.connectors()` —— 与设置页同一个缓存键，所以
// 两处即时同步，不存在「面板开了、设置页还显示关」的分裂。没有 per-conversation / per-turn
// 覆盖：那需要一份会话级状态 + 一条把它送进 gateway 的通路，而 owner 要的是「随时开启调用」，
// 全局位已经满足；先不造第二个事实来源。
//
// 🔴 显隐三态（PR5 刚修过「不看 flag 就打 409」的破口，这里不许重犯）：
//   flag 未知/加载中 → **按 off 处理**（`flagEnabled !== true`），list 查询 `enabled:false`，
//   一个 `/api/connector/*` 请求都不发；flag on 但零行 → 按钮不渲染（面板里什么都没有的入口
//   是纯噪音）。只有 flag on **且**至少一行时才出按钮。
//
// 🔴 `useNavigate` 只在**展开后**的菜单里调用：两个 composer 在单测里常常没有 RouterProvider，
// 而 TanStack 的 useNavigate 在无 router 时只是 console.warn + 返回一个调用即炸的回调。把它
// 关在「用户点开了面板」之后，既不给既有测试添噪音，也不改变真实路径（真实树里恒有 router）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Blocks } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { Switch } from '@shared/components/ui/switch'
import { fetchConnectorToolsEnabled } from '@shared/components/settings/custom-ai/shared'
import { AI_TAB_ANCHOR_IDS } from '@shared/components/settings/aiTabAnchors'
import type {
  ConnectorStatusValue,
  ConnectorSummary,
  ConnectorToolSummary
} from '@shared/api/types'

const ICON_BTN =
  'grid h-7 w-7 place-items-center rounded-md transition-[color,background-color,transform] duration-fast'

/** 状态点三档。文案侧复用设置页的 `settings.connectors.status.*` —— 值域完全相同，
 *  在 chat 下另起一套翻译就是第二处手抄（五个标签，改一处漏一处）。 */
const STATUS_DOT_CLASS: Record<ConnectorStatusValue, string> = {
  connected: 'bg-ok',
  authorizing: 'bg-warn',
  needs_reauth: 'bg-fail',
  error: 'bg-fail',
  disconnected: 'bg-ink-fg-3'
}

const STATUS_LABEL_KEYS: Record<ConnectorStatusValue, string> = {
  connected: 'settings.connectors.status.connected',
  authorizing: 'settings.connectors.status.authorizing',
  needs_reauth: 'settings.connectors.status.needsReauth',
  error: 'settings.connectors.status.error',
  disconnected: 'settings.connectors.status.disconnected'
}

/** 设置页在**另一条路由**上，AiTab 要等这次导航之后才挂载 —— 所以不是「navigate 完就
 *  scrollIntoView」（那一刻目标元素还不存在，滚了个寂寞），而是有界地等它出现。找不到就安静
 *  放弃：用户此时已经在 AI tab 上，最坏是自己往下滚一屏，而不是留一个永不结束的轮询。 */
function scrollToAnchorWhenReady(id: string, budgetMs = 2000): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const deadline = Date.now() + budgetMs
  const tick = (): void => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (Date.now() < deadline) window.requestAnimationFrame(tick)
  }
  window.requestAnimationFrame(tick)
}

/** 一行 connector：状态点 + 名称 + 工具数 + 主开关 + 管理链接。
 *  工具清单只在**面板展开后**（本组件挂载即代表展开）且已连接时才拉 —— 没展开的面板不该
 *  为了一个数字打 N 个请求。 */
function ConnectorQuickRow({
  connector,
  onManage
}: {
  connector: ConnectorSummary
  onManage(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const id = connector.connector_id
  const connected = connector.status === 'connected'
  const [saving, setSaving] = React.useState(false)

  const tools = useQuery<ConnectorToolSummary[]>({
    queryKey: qk.connectorTools(id),
    queryFn: () => api.connector.tools(id),
    enabled: connected,
    staleTime: 10_000,
    retry: false
  })

  async function handleToggle(next: boolean): Promise<void> {
    setSaving(true)
    try {
      await api.connector.setEnabled(id, next)
      // 设置页用的是**同一个** key —— 一次 invalidate 两处一起刷新。
      await qc.invalidateQueries({ queryKey: qk.connectors() })
      toastSuccess(
        t('chat.connectors.saved', { name: connector.display_name }),
        // gateway 的 connector manifest 有 TTL：开关落库 ≠ 模型当场看得见。说清楚，
        // 否则用户会在 30s 内反复开关一个「没生效」的东西。
        t('chat.connectors.savedDetail')
      )
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const toolLine = ((): string | null => {
    if (!connected) return t(STATUS_LABEL_KEYS[connector.status])
    if (!tools.data) return null
    // orphan 行远端已经没有了，恒不注册 —— 不该混进「已启用」这个数字里。
    const enabled = tools.data.filter((x) => x.effective_enabled && !x.orphan).length
    return t('chat.connectors.toolCount', { enabled, total: tools.data.length })
  })()

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[connector.status])}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-meta font-medium text-ink-fg-1">
          {connector.display_name}
        </span>
        {toolLine !== null ? (
          <span className="block truncate text-micro text-ink-fg-3">{toolLine}</span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onManage}
        className="shrink-0 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
      >
        {t('chat.connectors.manage')}
      </button>
      <Switch
        checked={connector.enabled}
        // 没连接过的行后端没有配置行，setEnabled 会 404 —— 开关灰掉，把用户送去「管理」
        // 那条真正有用的路，而不是让他点一个必然失败的开关。
        disabled={!connected || saving}
        onCheckedChange={(next) => void handleToggle(next)}
        aria-label={`${t('settings.connectors.enabled')} · ${connector.display_name}`}
        className="shrink-0"
      />
    </div>
  )
}

/** 展开后的面板本体。单独一层的唯一理由：把 `useNavigate` 关在展开之后（见文件头）。 */
function ConnectorQuickMenu({
  rows,
  label,
  onClose
}: {
  rows: ConnectorSummary[]
  label: string
  onClose(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()

  function handleManage(): void {
    onClose()
    void navigate({ to: '/settings', search: { tab: 'ai' } })
    scrollToAnchorWhenReady(AI_TAB_ANCHOR_IDS.connectors)
  }

  return (
    <div
      role="dialog"
      aria-label={label}
      // 🔴 居中锚定（而不是兄弟 picker 的 left-0）：本入口是左组的**最后**一个按钮，在 360px
      // 宽的邮件 chat 面板里 left-0 会把 268px 的弹层顶出右边界；以触发器为中心两侧各 134px
      // 则在两个 composer 里都落在可视区内。
      className={cn(
        'absolute bottom-full left-1/2 z-50 mb-1.5 w-[268px] -translate-x-1/2',
        'rounded-[var(--r-ctl)] py-1',
        'glass-pop shadow-[0_4px_12px_rgba(0,0,0,0.35)]'
      )}
    >
      <div className="max-h-[280px] overflow-y-auto scrollbar-thin">
        {rows.map((c) => (
          <ConnectorQuickRow key={c.connector_id} connector={c} onManage={handleManage} />
        ))}
      </div>
      {/* 审批纪律摆在面板底部：开一个 connector ≠ 放行它的写操作。 */}
      <p className="mt-1 border-t border-ink-border-soft px-3 pb-0.5 pt-1.5 text-micro leading-snug text-ink-fg-3">
        {t('chat.connectors.approvalHint')}
      </p>
    </div>
  )
}

export function ConnectorQuickPanel({
  variant
}: {
  variant: 'icon' | 'chip'
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

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

  React.useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const rows = list.data ?? []
  // flag 未知/加载中/off，或一行都没有 → 入口不存在。
  if (flagEnabled !== true || rows.length === 0) return null

  const label = t('chat.connectors.label')
  // 「现在有东西接着」的常驻信号：至少一个已连接且启用的 connector 就把入口染上强调色，
  // 免得用户每次都要点开才知道 AI 手上有没有外部工具。
  const anyActive = rows.some((c) => c.enabled && c.status === 'connected')
  const highlighted = open || anyActive

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          ICON_BTN,
          highlighted
            ? 'bg-coral/10 text-coral active:scale-[0.96]'
            : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg active:scale-[0.96]'
        )}
      >
        <Blocks size={13} strokeWidth={2} />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-fast',
          highlighted ? 'bg-coral/10 text-coral' : 'text-ink-fg-2 hover:bg-ink-4 hover:text-ink-fg'
        )}
      >
        <Blocks size={16} strokeWidth={2} />
      </button>
    )

  return (
    <div className="relative" ref={ref}>
      <HoverTip text={label} side="top">
        {trigger}
      </HoverTip>
      {open && <ConnectorQuickMenu rows={rows} label={label} onClose={() => setOpen(false)} />}
    </div>
  )
}
