// 08-03 dogfood — composer 里的「外部连接」快捷面板（owner: 参考 lobechat，把外部工具放到
// 对话框底部随时开关）。
//
// 🔴 08-04 WP6 起本文件只剩**面板内容**（行 + 审批提示），不再自带触发器：入口统一收编进两个
// composer 的「+」菜单（`ComposerPlusMenu`），由它拿 `useConnectorQuickRows()` 的判据决定菜单
// 里出不出「外部连接」项，点进去才挂载这里的内容。原来的 icon/chip 双触发器变体随之删除 ——
// 一个功能两个入口（独立圆钮 + 「+」菜单）只会让人猜哪个是真的。
// 远程 web 渲染同一棵树：开关走 serve-api，远程可用；**发起 OAuth 连接**不在这里（回调走本机
// loopback，远程点了只会静默超时），故本面板只有「开/关 + 去管理」，连接入口恒在设置页。
//
// 🔴 MVP 边界 = **全局开关的镜像**，不是第二套状态：Switch 直接写穿 `connector.setEnabled`
// （与设置页同一个后端位），成功后 invalidate `qk.connectors()` —— 与设置页同一个缓存键，所以
// 两处即时同步，不存在「面板开了、设置页还显示关」的分裂。没有 per-conversation / per-turn
// 覆盖：那需要一份会话级状态 + 一条把它送进 gateway 的通路，而 owner 要的是「随时开启调用」，
// 全局位已经满足；先不造第二个事实来源。
//
// 🔴 显隐三态（flag 未知 → 按 off、零请求；flag on 但零行 → 无入口）搬去了
// `@shared/hooks/useConnectorQuickRows`，判据与语义逐字未变，只是换了住处（菜单要在渲染项
// 之前就知道结果）。
//
// 🔴 `useNavigate` 只在**展开后**的内容里调用：两个 composer 在单测里常常没有 RouterProvider，
// 而 TanStack 的 useNavigate 在无 router 时只是 console.warn + 返回一个调用即炸的回调。把它
// 关在「用户点开了面板」之后（本组件挂载即代表展开），既不给既有测试添噪音，也不改变真实路径
// （真实树里恒有 router）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Switch } from '@shared/components/ui/switch'
import {
  AI_TAB_ANCHOR_IDS,
  scrollToAnchorWhenReady
} from '@shared/components/settings/aiTabAnchors'
import type {
  ConnectorStatusValue,
  ConnectorSummary,
  ConnectorToolSummary
} from '@shared/api/types'

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
    // 08-05 三档后「已启用」= 折算档非 off（auto / ask 都会注册给模型）。
    const enabled = tools.data.filter((x) => x.effective_mode !== 'off' && !x.orphan).length
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

/** 面板内容：connector 行 + 审批提示。定位/材质由宿主（`ComposerPlusMenu` 的二级弹层）提供，
 *  本组件只画内容 —— 挂载即代表「用户点开了」，`useNavigate` 就关在这一层（见文件头）。
 *  `onClose` = 收起整个弹层（点「管理」跳走时用）。 */
export function ConnectorQuickContent({
  rows,
  onClose
}: {
  rows: ConnectorSummary[]
  onClose(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()

  function handleManage(): void {
    onClose()
    void navigate({ to: '/settings', search: { tab: 'ai' } })
    scrollToAnchorWhenReady(AI_TAB_ANCHOR_IDS.connectors)
  }

  return (
    <>
      <div className="max-h-[280px] overflow-y-auto scrollbar-thin">
        {rows.map((c) => (
          <ConnectorQuickRow key={c.connector_id} connector={c} onManage={handleManage} />
        ))}
      </div>
      {/* 审批纪律摆在面板底部：开一个 connector ≠ 放行它的写操作。 */}
      <p className="mt-1 border-t border-ink-border-soft px-3 pb-0.5 pt-1.5 text-micro leading-snug text-ink-fg-3">
        {t('chat.connectors.approvalHint')}
      </p>
    </>
  )
}
