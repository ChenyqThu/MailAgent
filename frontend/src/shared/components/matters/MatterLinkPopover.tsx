import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Bot, ExternalLink, Pause, Play, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'

import type { Matter, MatterLinkScope } from '@shared/api/types/matter'
import { useAnchoredPosition } from '@shared/hooks/useAnchoredPosition'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess, useToastStore } from '@shared/state/toast'

import { MatterCreateDialog } from './MatterCreateDialog'
import type { MatterCreateSource } from './MatterCreateDialog'
import { buildMatterResourceLookupKeys, mergeMatterResourceLinkHits } from './matterResource'
import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'
import { useMatterNavigation } from './navigation'

/** 面板宽度 / 列表最大高度 —— 与旧 `w-[340px]` / `max-h-[540px]` 逐字一致，只是从 class
 *  搬进常量供锚点计算复用（视口不够高时按可用空间收口，见 useAnchoredPosition）。 */
const PANEL_WIDTH = 340
const PANEL_LIST_MAX_HEIGHT = 540

interface MatterLinkPopoverProps {
  open: boolean
  source: MatterCreateSource
  /** 面板锚点（工具栏/命中行里那颗触发按钮的容器）。面板 portal 到 body 后靠它定位 ——
   *  0812 dogfood：祖先 `overflow-x-auto` 会把 `absolute` 面板整块裁掉，见 useAnchoredPosition。 */
  anchorRef: React.RefObject<HTMLElement | null>
  onClose(): void
  /** G-25 (Q2=c) —— 「AI 调研创建」行：唤起主 chat 带创建 prompt（关闭浮层由调用方做）。
   *  给了它，「创建新事项」行改标「快速新建」与之相区分；⌘K 消费方不传，形态不变。 */
  onAiResearch?: () => void
  /** G-25 ④ —— 次级一行「为此线程建立跟进 Agent」（复用 CustomAgentDrawer 既有流程）。
   *  仅在 trigger v2 开且线程键可派生时由调用方提供。 */
  onCreateFollowupAgent?: () => void
}

export function MatterLinkPopover({
  open,
  source,
  anchorRef,
  onClose,
  onAiResearch,
  onCreateFollowupAgent
}: MatterLinkPopoverProps): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openMatter = useMatterNavigation((state) => state.open)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const lookupKeys = useMemo(
    () => buildMatterResourceLookupKeys(source.internalId, source.threadId),
    [source.internalId, source.threadId]
  )

  const lookup = useQuery({
    queryKey: qk.matters.resourceLookup('mailagent', lookupKeys),
    queryFn: () => api.lookupResourceLinks('mailagent', lookupKeys),
    enabled: open && lookupKeys.length > 0,
    staleTime: 10_000
  })
  const linked = useMemo(
    () => mergeMatterResourceLinkHits(lookup.data, lookupKeys),
    [lookup.data, lookupKeys]
  )
  const activeMatters = useQuery({
    queryKey: qk.matters.captureCandidates(search.trim()),
    queryFn: () => api.list({ q: search.trim() || undefined, limit: search.trim() ? 20 : 12 }),
    enabled: open,
    staleTime: 15_000
  })
  const candidates = (activeMatters.data?.items ?? [])
    .filter((matter) => !['done', 'canceled'].includes(matter.status))
    .filter((matter) => !linked.some((entry) => entry.publicId === matter.public_id))
    .slice(0, search.trim() ? 8 : 4)

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: qk.matters.resourceLookup('mailagent', lookupKeys)
      }),
      queryClient.invalidateQueries({ queryKey: qk.matters.list() })
    ])
  }

  // 捕获浮层一次面对多个事项 ⇒ 目标事项从 mutation 变量里取（`useMatterMutation` 的
  // resolver 形态），冲突时刷新的才是**被写的那个**事项。
  const link = useMatterMutation({
    matterId: ({ matter }: { matter: Matter; scope: MatterLinkScope }) => matter.public_id,
    mutationFn: async ({ matter, scope }: { matter: Matter; scope: MatterLinkScope }) =>
      api.linkResource(
        matter.public_id,
        {
          source_resource: {
            provider: 'mailagent',
            kind: 'email',
            internal_id: source.internalId,
            link_scope: source.threadId ? scope : 'single'
          }
        },
        { expectedVersion: matter.version }
      ),
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const unlink = useMatterMutation({
    matterId: (entry: (typeof linked)[number]) => entry.publicId,
    mutationFn: async (entry: (typeof linked)[number]) => {
      const detail = await api.get(entry.publicId)
      let version = detail.matter.version
      for (const resourceId of [...new Set(entry.links.map((hit) => hit.resource_id))]) {
        const result = await api.unlinkResource(entry.publicId, resourceId, {
          expectedVersion: version,
          reason: 'user_unlinked_email_capture'
        })
        version = result.matter?.version ?? version + 1
      }
    },
    onSuccess: () => {
      toastSuccess(t('matters.resource.unlinkedNoDelete'))
      void refresh()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const subscription = useMatterMutation({
    matterId: (entry: (typeof linked)[number]) => entry.publicId,
    mutationFn: async (entry: (typeof linked)[number]) => {
      if (!entry.subscription) return
      const detail = await api.get(entry.publicId)
      await api.patchResource(
        entry.publicId,
        entry.subscription.resource_id,
        { sub_state: entry.subscription.sub_state === 'active' ? 'paused' : 'active' },
        { expectedVersion: detail.matter.version }
      )
    },
    onSuccess: () => void refresh(),
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  // 新建没有 `expectedVersion`（事项还不存在），结构上撞不到版本冲突 —— 走同一个出口只是
  // 为了让「这个文件里还有一个裸 useMutation」不成立（闸按文件判，见 matterMutationGate）。
  const create = useMatterMutation({
    matterId: null,
    mutationFn: (input: Parameters<typeof api.create>[0]) => api.create(input),
    onSuccess: async (result) => {
      setCreateOpen(false)
      await refresh()
      if (result.matter) {
        openMatter(result.matter.public_id)
        void navigate({ to: '/matters' })
        onClose()
      }
    },
    onError: (error) => toastError(t('matters.toast.createFailed'), errorMessage(error))
  })

  // 面板可见期间才测量/挂 resize·scroll 监听；createOpen 时面板本就不渲染。
  const position = useAnchoredPosition(anchorRef, open && !createOpen, {
    width: PANEL_WIDTH,
    align: 'end',
    maxHeight: PANEL_LIST_MAX_HEIGHT
  })

  // 0812 codex #8 —— 它是 `role="dialog"` 却只能点遮罩/关闭钮退出：键盘用户按 Esc 没反应。
  // 顺带补 portal 之后的焦点归位：面板 portal 到 body，关闭后焦点会落到 body 而不是触发按钮。
  // 🔴 `onClose` 是调用方的内联箭头（每次 render 换身份），只能进 ref —— 进依赖会让本 effect
  // 每次 render 重跑，cleanup 里的 focus() 就成了「每帧把焦点抢回触发按钮」。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const openerRef = useRef<HTMLElement | null>(null)
  const panelActive = open && !createOpen
  useEffect(() => {
    if (!panelActive) return undefined
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const opener = openerRef.current
      openerRef.current = null
      // 触发按钮可能已经随行/工具栏卸载（或用户已被导航走）—— 还在 DOM 里才归位。
      if (opener && opener.isConnected) opener.focus()
    }
  }, [panelActive])

  if (!open) return null

  const goToMatter = (publicId: string): void => {
    openMatter(publicId)
    void navigate({ to: '/matters' })
    onClose()
  }

  return (
    <>
      {!createOpen && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={onClose}
                className="fixed inset-0 z-[99] cursor-default"
              />
              <div
                role="dialog"
                aria-label={t('matters.capture.title')}
                style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
                className="fixed z-[100] overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-md"
              >
                <header className="flex items-center justify-between border-b border-ink-border px-3 py-2.5">
                  <span className="text-aux font-semibold text-ink-fg">
                    {t('matters.capture.title')}
                  </span>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-[var(--r-ctl)] p-1 hover:bg-ink-3"
                  >
                    <X size={14} />
                  </button>
                </header>
                <div
                  style={{ maxHeight: position.maxHeight }}
                  className="overflow-y-auto p-2 scrollbar-thin"
                >
                  {linked.length > 0 ? (
                    <section className="mb-2">
                      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-fg-3">
                        {t('matters.capture.linked')}
                      </div>
                      {linked.map((entry) => (
                        <div
                          key={entry.publicId}
                          className="rounded-[var(--r-ctl)] px-2 py-2 hover:bg-ink-3"
                        >
                          <div className="flex items-center gap-2">
                            <StatusPip status={entry.status} />
                            <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                              {entry.title}
                            </span>
                            <span className="font-mono text-[10px] text-ink-fg-3">
                              {entry.publicId}
                            </span>
                          </div>
                          {entry.subscription ? (
                            <div className="mt-2 flex items-start gap-2 rounded bg-ok/5 px-2 py-1.5 text-meta leading-4 text-ink-fg-2">
                              <span className="flex-1">
                                {t(
                                  entry.subscription.sub_state === 'active'
                                    ? 'matters.capture.threadSubscribed'
                                    : 'matters.capture.threadPaused'
                                )}
                              </span>
                              <button
                                type="button"
                                onClick={() => subscription.mutate(entry)}
                                className="rounded p-1 text-ink-fg-2 hover:bg-ink-4"
                                title={t(
                                  entry.subscription.sub_state === 'active'
                                    ? 'matters.resource.pauseSubscription'
                                    : 'matters.resource.resumeSubscription'
                                )}
                              >
                                {entry.subscription.sub_state === 'active' ? (
                                  <Pause size={12} />
                                ) : (
                                  <Play size={12} />
                                )}
                              </button>
                            </div>
                          ) : null}
                          <div className="mt-2 flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => goToMatter(entry.publicId)}
                              className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 hover:bg-ink-4"
                            >
                              <ExternalLink size={11} />
                              {t('matters.capture.open')}
                            </button>
                            <button
                              type="button"
                              onClick={() => unlink.mutate(entry)}
                              className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-fail hover:bg-fail/10"
                            >
                              <Trash2 size={11} />
                              {t('matters.capture.unlink')}
                            </button>
                          </div>
                        </div>
                      ))}
                      <div className="mx-2 my-2 h-px bg-ink-border" />
                    </section>
                  ) : null}

                  {onAiResearch ? (
                    <button
                      type="button"
                      onClick={onAiResearch}
                      className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-aux text-ink-fg hover:bg-ink-3"
                    >
                      <Sparkles size={14} className="text-ai" />
                      {t('matters.capture.aiResearch')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setCreateOpen(true)}
                    className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-aux text-ink-fg hover:bg-ink-3"
                  >
                    <Plus size={14} className="text-coral" />
                    {t(onAiResearch ? 'matters.capture.quickCreate' : 'matters.capture.create')}
                  </button>
                  <div className="mx-2 my-2 h-px bg-ink-border" />
                  <section>
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-fg-3">
                      {t('matters.capture.addExisting')}
                    </div>
                    <label className="mx-2 mb-1 flex items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2 py-1.5">
                      <Search size={12} className="text-ink-fg-3" />
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t('matters.capture.search')}
                        className="min-w-0 flex-1 bg-transparent text-meta outline-none"
                      />
                    </label>
                    {candidates.map((matter) => (
                      <button
                        key={matter.public_id}
                        type="button"
                        onClick={() =>
                          link.mutate({ matter, scope: source.threadId ? 'thread' : 'single' })
                        }
                        className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left hover:bg-ink-3"
                      >
                        <StatusPip status={matter.status} />
                        <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
                          {matter.title}
                        </span>
                        <span className="font-mono text-[10px] text-ink-fg-3">
                          {matter.public_id}
                        </span>
                      </button>
                    ))}
                    {candidates.length === 0 ? (
                      <p className="px-2 py-3 text-center text-meta text-ink-fg-3">
                        {t('matters.capture.noCandidates')}
                      </p>
                    ) : null}
                  </section>
                  {onCreateFollowupAgent ? (
                    <>
                      <div className="mx-2 my-2 h-px bg-ink-border" />
                      {/* 次级入口：事项本身就是这条线程的跟进载体，Custom Agent 是另一种
                          形态（0812 从工具栏一级位撤下），故收进菜单末位、弱化配色。 */}
                      <button
                        type="button"
                        onClick={onCreateFollowupAgent}
                        className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2.5 py-2 text-left text-meta text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg"
                      >
                        <Bot size={13} />
                        {t('toolbar.followupAgent')}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </>,
            document.body
          )
        : null}
      <MatterCreateDialog
        open={createOpen}
        busy={create.isPending}
        source={source}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => create.mutate(input)}
        onUseExisting={async (candidate, linkScope) => {
          const detail = await api.get(candidate.matter.public_id)
          await api.linkResource(
            candidate.matter.public_id,
            {
              source_resource: {
                provider: 'mailagent',
                kind: 'email',
                internal_id: source.internalId,
                link_scope: source.threadId ? linkScope : 'single'
              }
            },
            {
              expectedVersion: detail.matter.version,
              reason: 'user_selected_duplicate_matter'
            }
          )
          setCreateOpen(false)
          await refresh()
          // G-24 —— 「加入该事项」：关联 + 关弹窗 + toast 带跳转。不再强制离开当前邮件
          // （用户多半还要继续读信），要去看事项点 toast 上的按钮。
          useToastStore.getState().push({
            variant: 'success',
            title: t('matters.capture.addedToast', { title: candidate.matter.title }),
            action: {
              label: t('matters.capture.open'),
              onClick: () => goToMatter(candidate.matter.public_id)
            }
          })
          onClose()
        }}
      />
    </>
  )
}

function StatusPip({ status }: { status: Matter['status'] }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span className="shrink-0 rounded-[var(--r-pill)] bg-ink-4 px-1.5 py-0.5 text-[10px] text-ink-fg-2">
      {t(`matters.status.${status}`)}
    </span>
  )
}
