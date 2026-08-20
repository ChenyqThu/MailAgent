// 通讯录 Agent 治理台抽屉（WP7；原型 `cagent.jsx::AgentDrawer` :49-134）。
//
// 右侧 460px 抽屉，两个 tab：待审建议（卡流）/ 它能做什么（工具面 + 系统提示词）。
// 脚：节拍说明 +「现在跑一次治理扫描」。
//
// 🔴 队列 tab 渲染**两批**：pending + blocked。后端 `list_suggestions` 只收单个
// status，所以是两条查询。blocked = 采纳时被不变量守卫拦下的行（服务端主动把它写成
// blocked 并返回错误信封），验收要求它「留在队列里」，所以必须看得见；但它不给
// 采纳/忽略按钮 —— 后端只允许 pending 被 adopt/ignore，画出来就是必然 400 的假入口。
//
// 🔴 零乐观更新：采纳/忽略都只在服务端落定后失效缓存，失败时那张卡留在原位
// （§4.2 纪律，与画像建议值同一条）。
//
// 🔴 merge 类的「采纳」不落合并：服务端把这条标 adopted 并交回**升序归一**的 id 对，
// 前端据此关抽屉 + 直入合并预览（唯一的人工确认路径，原型 `capp.jsx:365` 同款）。

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleCheckBig, Loader2, RefreshCw, ShieldAlert, Sparkles, X } from 'lucide-react'

import type { ContactGovernanceSuggestion } from '@shared/api/types/contact'
import { Drawer } from '@shared/components/ui/drawer'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastInfo, toastSuccess } from '@shared/state/toast'

import { ContactAgentToolFace } from './ContactAgentToolFace'
import { ContactSuggestionCard } from './ContactSuggestionCard'
import { SecHead } from './parts'
import {
  useContactAgentStatus,
  useContactList,
  useContactSuggestions,
  useContactsApi,
  useInvalidateContactSuggestions
} from './hooks'

type AgentTab = 'queue' | 'tools'

export interface ContactAgentDrawerProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** 点建议卡上的头像 → 关抽屉并打开那个人的档案。 */
  onOpenPerson(contactId: number): void
  /** merge 类采纳 → 关抽屉并直入合并预览步骤 2。 */
  onMergePair(pair: [number, number]): void
}

export function ContactAgentDrawer({
  open,
  onOpenChange,
  onOpenPerson,
  onMergePair
}: ContactAgentDrawerProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useContactsApi()
  const invalidate = useInvalidateContactSuggestions()
  const [tab, setTab] = useState<AgentTab>('queue')

  const pending = useContactSuggestions('pending', open)
  const blocked = useContactSuggestions('blocked', open)
  // WP7 dogfood 修复：治理 job failed 之后抽屉里零呈现 —— 用户点了「现在跑一次」，看到的
  // 只是「什么都没发生」（实测 job 是 failed E_DISABLED）。这里读同一条 agent-status 查询
  // （key 与胶囊徽标同源，react-query 去重，不多发请求）把终态显出来。
  // 🔴 两个键都是 optional：后端还没上线时是 undefined → 一行都不渲染。
  const agentStatus = useContactAgentStatus(open)
  const lastScanStatus = agentStatus.data?.last_scan_status
  const lastScanError = agentStatus.data?.last_scan_error
  const scanInFlight = lastScanStatus === 'queued' || lastScanStatus === 'running'
  // 相关人名字/头像的查表源。🔴 有意**不传 limit**：按往来密度截断会正好丢掉建议指向的
  // 那类冷门行（机器人 / 刚换的新地址），而查不到名字的卡只能显示 `#id`。key 与工作台
  // 「全部」视图的列表查询同构，用户在那个视图时零额外请求。
  const directory = useContactList({ view: 'all', q: '', sort: 'density', enabled: open })

  const personById = new Map((directory.data?.items ?? []).map((row) => [row.id, row]))

  const adopt = useMutation({
    mutationFn: (suggestion: ContactGovernanceSuggestion) => api.adoptSuggestion(suggestion.id),
    onSuccess: async (result, suggestion) => {
      await invalidate()
      const pair = result.merge_pair
      if (suggestion.type === 'merge' && pair !== undefined && pair.length === 2) {
        onOpenChange(false)
        onMergePair([pair[0] as number, pair[1] as number])
        return
      }
      toastSuccess(t('contacts.toast.suggestionAdopted'))
    },
    // 🔴 被守卫拦下走的是**错误信封**（那一行已经提交成 blocked）——失效后它会从
    // blocked 那条查询里读回来，在「被拦下的建议」小节显示原因。不当异常吞掉。
    onError: async (error) => {
      await invalidate()
      toastError(t('contacts.toast.suggestionBlocked'), errorMessage(error))
    }
  })

  const ignore = useMutation({
    mutationFn: (suggestion: ContactGovernanceSuggestion) => api.ignoreSuggestion(suggestion.id),
    onSuccess: async () => {
      await invalidate()
      toastSuccess(t('contacts.toast.suggestionIgnored'))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  const run = useMutation({
    mutationFn: () => api.runAgentScan(),
    onSuccess: async (result) => {
      await invalidate()
      // 🔴 端点只入队，不等扫描结束 —— 文案说「已排入」而不是「已完成」。
      if (result.coalesced) toastInfo(t('contacts.toast.scanCoalesced'))
      else toastSuccess(t('contacts.toast.scanQueued'))
    },
    onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
  })

  const pendingItems = pending.data?.items ?? []
  const blockedItems = blocked.data?.items ?? []
  const queueEmpty =
    !pending.isPending && !blocked.isPending && pendingItems.length === 0 && blockedItems.length === 0
  const busy = adopt.isPending || ignore.isPending

  const renderCard = (suggestion: ContactGovernanceSuggestion): React.ReactElement => (
    <ContactSuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      personOf={(contactId) => personById.get(contactId)}
      busy={busy}
      onAdopt={(item) => adopt.mutate(item)}
      onIgnore={(item) => ignore.mutate(item)}
      onOpenPerson={(contactId) => {
        onOpenChange(false)
        onOpenPerson(contactId)
      }}
    />
  )

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width={460}
      ariaLabel={t('contacts.agent.title')}
    >
      <div className="flex shrink-0 items-center gap-[9px] border-b border-ink-border-soft px-4 py-[13px]">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-[var(--r-ctl)] bg-ai/[0.12] text-ai">
          <Sparkles size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-aux font-semibold text-ink-fg">{t('contacts.agent.title')}</div>
          <div className="mt-px text-micro text-ink-fg-2">{t('contacts.agent.subtitle')}</div>
        </div>
        <button
          type="button"
          aria-label={t('contacts.agent.close')}
          title={t('contacts.agent.close')}
          onClick={() => onOpenChange(false)}
          className="grid size-[26px] shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg"
        >
          <X size={14} />
        </button>
      </div>

      <div className="shrink-0 px-4 pt-2.5">
        <SegmentedControl<AgentTab>
          ariaLabel={t('contacts.agent.title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'queue', label: t('contacts.agent.tab.queue', { count: pendingItems.length }) },
            { value: 'tools', label: t('contacts.agent.tab.tools') }
          ]}
        />
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3">
        {tab === 'queue' ? (
          <>
            {pending.isError || blocked.isError ? (
              <p className="mb-2 text-meta leading-[1.6] text-warn">
                {t('contacts.agent.loadFailed')}
              </p>
            ) : null}
            {/* 扫描本身失败 ≠ 队列读取失败：前者是「这一轮压根没跑出来」，空队列是假象。 */}
            {lastScanStatus === 'failed' ? (
              <p className="mb-2 text-micro leading-[1.6] text-warn">
                {t('contacts.agent.scanFailed', { error: lastScanError ?? '—' })}
              </p>
            ) : null}
            {queueEmpty ? (
              <EmptyState
                icon={<CircleCheckBig size={20} strokeWidth={1.5} />}
                title={t('contacts.agent.empty.title')}
                hint={t('contacts.agent.empty.hint')}
              />
            ) : (
              <>
                {/* 采纳/忽略后该卡从服务端投影里消失 → 只做透明度过渡（红线：不许位移动画）。 */}
                <div
                  className={cn(
                    'flex flex-col gap-[9px] transition-opacity duration-base ease-standard',
                    busy && 'opacity-70'
                  )}
                >
                  {pendingItems.map(renderCard)}
                </div>
                {blockedItems.length > 0 ? (
                  <div className="mt-4">
                    <SecHead
                      icon={<ShieldAlert size={13} aria-hidden className="shrink-0 text-fail" />}
                      title={t('contacts.agent.blocked.title')}
                      count={blockedItems.length}
                    />
                    <p className="mb-2 text-micro leading-[1.6] text-ink-fg-3">
                      {t('contacts.agent.blocked.hint')}
                    </p>
                    <div className="flex flex-col gap-[9px]">{blockedItems.map(renderCard)}</div>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : (
          <ContactAgentToolFace />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-ink-border-soft px-4 py-[11px]">
        <span className="text-micro leading-[1.5] text-ink-fg-3">
          {t('contacts.agent.cadence')}
        </span>
        <span aria-hidden className="flex-1" />
        {/* 上一轮还在队列/在跑时说明白 —— 否则再点一次只会被后端合流（coalesced），
            用户看到的又是「什么都没发生」。 */}
        {scanInFlight ? (
          <span className="shrink-0 text-micro leading-[1.5] text-ink-fg-2">
            {t('contacts.agent.scanInFlight')}
          </span>
        ) : null}
        <button
          type="button"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3 disabled:pointer-events-none disabled:opacity-60"
        >
          {run.isPending ? (
            <Loader2 size={12} aria-hidden className="animate-spin" />
          ) : (
            <RefreshCw size={12} aria-hidden />
          )}
          {t(run.isPending ? 'contacts.agent.running' : 'contacts.agent.runNow')}
        </button>
      </div>
    </Drawer>
  )
}
