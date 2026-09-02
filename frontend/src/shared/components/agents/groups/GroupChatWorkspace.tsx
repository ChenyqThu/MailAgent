// L4 群聊 — 对话域「群聊」分段的整个工作区：左列（分段 + 新建群 + 群列表）+ 右侧群聊视图。
//
// 数据源：`GET /chat/sessions/all?origin=group`（AgentViewLayout 注入 items + invalidate —— 与
// AI 分段同构，列表数据归 layout 管）。listAllSessions 排除零消息会话，所以**刚建好还没发言
// 的群**由本组件以 draftSession 本地持有并选中；第一条消息落库后它自然进列表。
// 成员候选 = 团队页可对话成员（deriveTeamMembers canChat 判据，排除主 agent 与
// 预处理/项目周报/搜索三位），上限 MAX_GROUP_MEMBERS —— serve-api /sessions/new 同判据兜底
// 校验，两侧共读 ai-gateway/groupFloors.ts（TS 单源）与 src/chat/group_limits.py（Python 单源），
// 闸 tests/config/test_group_constants_parity.py。
//
// 🔴 群聊是桌面-only（发言链路走本地 gateway；groupChatClient 在 web 上恒 E_UNSUPPORTED）。
// 建群本身走 serve-api，在 web 上会「建得出来但一句话都发不了」——所以拿不到 gateway 时
// 直接禁用建群入口并说明原因，不留这个洞。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Plus, Users } from 'lucide-react'

import type { ChatSession, ChatSessionListItem, ReportAgentConfig } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useSessionsSegment } from '@shared/state/sessions-segment'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Input } from '@shared/components/ui/input'
import { Button } from '@shared/components/ui/button'

import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'

import { AgentAvatar } from '../AgentAvatar'
import { useReportConfig } from '../hooks'
import { deriveTeamMembers } from '../team/teamMembers'
import { GroupChatView } from './GroupChatView'
import { parseMembersJson, type GroupMemberMeta } from './members'

// 成员上限单源（照 members.ts 对 parseGroupMemberIds 的路子直引 gateway 叶子，不手抄数字）。
import { MAX_GROUP_MEMBERS } from '../../../../ai-gateway/groupFloors'

/** 团队清单 → 可入群成员（canChat 且是真 agent 行；主 Agent 不入群）。 */
function chatCapableMembers(agents: readonly ReportAgentConfig[]): ReportAgentConfig[] {
  return deriveTeamMembers(agents)
    .filter((m) => m.canChat && m.ref.kind === 'agent' && m.cfg != null)
    .map((m) => m.cfg as ReportAgentConfig)
}

export function GroupChatWorkspace({
  headerSlot,
  items,
  invalidate,
  narrow,
  navHidden = false
}: {
  /** 「AI」｜「群聊」分段控件（与 AI 分段同一实例形态，由 AgentViewLayout 注入）。 */
  headerSlot: React.ReactNode
  items: ChatSessionListItem[]
  invalidate: () => void
  narrow: boolean
  /** 09-01 侧栏批：对话域二级栏折叠时整列隐藏（与 AgentThreadList.navHidden 同语义，
   *  由 AgentViewLayout 按 useDomainCollapsed('chats') 注入）；窄窗单栏形态下无意义。 */
  navHidden?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const { agents } = useReportConfig()
  const activeId = useSessionsSegment((s) => s.activeGroupSessionId)
  const setActiveId = useSessionsSegment((s) => s.setActiveGroupSessionId)
  const [dialogOpen, setDialogOpen] = useState(false)
  // 刚建好、还没有消息（listAllSessions 拉不到）的群，本地持有到第一条消息落库。
  const [draftSession, setDraftSession] = useState<ChatSession | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)
  // 拿不到本地 gateway（web 构建 / 端口未注入）→ 建出来的群一句话都发不了，禁用入口。
  // 🔴 判据是**真值**不是 `!= null`：web 构建下 resolveAiGatewayBaseUrl 返回空串（同源代理
  // 语义），而群聊链路把空串当「没有 gateway」（groupChatClient 的 `if (!baseUrl)` 抛
  // E_UNSUPPORTED）—— 用 `!= null` 会在 web 上放行建群，正好漏掉要堵的那个洞。
  const canCreate = useMemo(() => Boolean(resolveAiGatewayBaseUrl()), [])

  // agentId → 展示元数据（名字/头像），群列表行与群聊视图共用。
  const memberMeta = useMemo(() => {
    const map = new Map<string, GroupMemberMeta>()
    for (const cfg of agents) {
      map.set(cfg.id, { title: cfg.title?.trim() || cfg.id, avatar: cfg.avatar ?? null })
    }
    return map
  }, [agents])

  const listed = activeId != null ? (items.find((s) => s.id === activeId) ?? null) : null
  const activeSession: ChatSession | null =
    listed ?? (draftSession != null && draftSession.id === activeId ? draftSession : null)

  const select = (id: number): void => {
    setActiveId(id)
    if (narrow) setMobileDetail(true)
  }

  const list = (
    <aside
      data-nav-second
      className={cn(
        'glass-panel flex h-full shrink-0 flex-col overflow-hidden',
        // 09-01 侧栏批：清单列读对话域的记忆宽（默认 336），折叠时整列隐藏——与 AgentThreadList 同契约，
        // 否则 `[` 折叠后顶栏左段收到 56 而这一列纹丝不动，hairline 与列边界错开。
        narrow ? 'w-full' : 'w-[var(--app-second-w,336px)] border-r border-ink-border'
      )}
      style={
        navHidden && !narrow ? { width: 0, visibility: 'hidden', borderRightWidth: 0 } : undefined
      }
    >
      <div className="flex h-12 shrink-0 items-center px-3">
        <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-ink-fg">
          {t('groupChat.listTitle')}
        </h2>
      </div>
      <div className="px-3 pb-2">{headerSlot}</div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={!canCreate}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-lg border border-ink-border-soft bg-ink-2 px-2.5',
            'text-body font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3',
            'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink-2'
          )}
        >
          <Plus size={15} strokeWidth={2} className="shrink-0 text-coral" />
          <span className="truncate">{t('groupChat.newGroup')}</span>
        </button>
        {!canCreate && (
          <p className="mt-1.5 text-micro leading-relaxed text-ink-fg-3">
            {t('groupChat.desktopOnly')}
          </p>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2">
        {items.length === 0 && draftSession == null ? (
          <div className="px-2 py-6 text-center text-meta text-ink-fg-3">
            {t('groupChat.emptyList')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {draftSession != null && !items.some((s) => s.id === draftSession.id) && (
              <GroupRow
                key={`draft-${draftSession.id}`}
                title={draftSession.title ?? t('groupChat.defaultTitle')}
                membersJson={draftSession.members_json ?? null}
                memberMeta={memberMeta}
                selected={draftSession.id === activeId}
                onSelect={() => select(draftSession.id)}
                t={t}
              />
            )}
            {items.map((s) => (
              <GroupRow
                key={s.id}
                title={s.title ?? t('groupChat.defaultTitle')}
                membersJson={s.members_json ?? null}
                memberMeta={memberMeta}
                selected={s.id === activeId}
                onSelect={() => select(s.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )

  const detail = activeSession ? (
    <GroupChatView
      key={activeSession.id}
      session={activeSession}
      memberMeta={memberMeta}
      onActivity={invalidate}
    />
  ) : (
    <div className="grid flex-1 place-items-center text-meta text-ink-fg-3">
      <div className="flex flex-col items-center gap-2">
        <Users size={20} strokeWidth={1.5} />
        <span>{t('groupChat.noSelection')}</span>
      </div>
    </div>
  )

  const dialog = (
    <NewGroupDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      candidates={chatCapableMembers(agents)}
      onCreated={(session) => {
        setDraftSession(session)
        setActiveId(session.id)
        invalidate()
        if (narrow) setMobileDetail(true)
      }}
    />
  )

  if (narrow) {
    return (
      <div className="flex h-full w-full flex-col">
        {mobileDetail && activeSession ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-border px-2">
              <button
                type="button"
                onClick={() => setMobileDetail(false)}
                aria-label={t('agents.reports.backToList')}
                className="grid size-8 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
              >
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <span className="truncate text-body font-medium text-ink-fg">
                {activeSession.title ?? t('groupChat.defaultTitle')}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{detail}</div>
          </>
        ) : (
          <div className="h-full w-full">{list}</div>
        )}
        {dialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      <div className="flex min-w-0 flex-1 flex-col">{detail}</div>
      {dialog}
    </div>
  )
}

function GroupRow({
  title,
  membersJson,
  memberMeta,
  selected,
  onSelect,
  t
}: {
  title: string
  membersJson: string | null
  memberMeta: Map<string, GroupMemberMeta>
  selected: boolean
  onSelect: () => void
  t: ReturnType<typeof useTranslation>['t']
}): React.ReactElement {
  const memberIds = parseMembersJson(membersJson)
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-[var(--r-ctl)]',
        selected ? '[background-image:var(--sel-wash)]' : 'hover:bg-ink-fg/[0.04]'
      )}
    >
      {selected && (
        <span
          className="absolute bottom-2 left-0 top-2 w-[3px] rounded-sm"
          style={{ background: 'rgb(var(--c-accent))' }}
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-ctl)] pl-2.5 pr-2 text-left"
      >
        {/* 成员头像堆叠（最多 3 个，overlap）。 */}
        <span className="flex shrink-0 items-center -space-x-1.5">
          {memberIds.slice(0, 3).map((id) => (
            <span key={id} className="rounded-full ring-2 ring-[rgb(var(--c-bg,255_255_255))/0]">
              <AgentAvatar
                agentId={id}
                config={memberMeta.get(id)?.avatar}
                size={20}
                title={memberMeta.get(id)?.title}
              />
            </span>
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-ink-fg-1" title={title}>
            {title}
          </span>
          <span className="block truncate text-micro text-ink-fg-3">
            {t('groupChat.memberCount', { count: memberIds.length })}
          </span>
        </span>
      </button>
    </div>
  )
}

function NewGroupDialog({
  open,
  onOpenChange,
  candidates,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  candidates: ReportAgentConfig[]
  onCreated: (session: ChatSession) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_GROUP_MEMBERS) next.add(id)
      return next
    })

  const create = async (): Promise<void> => {
    if (picked.size === 0 || creating) return
    setCreating(true)
    try {
      // 成员序 = 候选清单序（deriveTeamMembers 稳定序），落 members_json = 群内回复顺序。
      const members = candidates.filter((c) => picked.has(c.id)).map((c) => c.id)
      const session = await mailApi.chat.newSession({
        anchorType: 'general',
        backendKind: 'ai-sdk',
        groupMembers: members,
        title: title.trim() || t('groupChat.defaultTitle')
      })
      onCreated(session)
      onOpenChange(false)
      setTitle('')
      setPicked(new Set())
    } catch (err) {
      toastError(t('groupChat.createFailed', { error: errorMessage(err) }))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('groupChat.dialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.dialogTitleLabel')}
            </span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('groupChat.defaultTitle')}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.dialogMembersLabel', { max: MAX_GROUP_MEMBERS })}
            </span>
            {candidates.length === 0 ? (
              <div className="rounded-lg bg-ink-2 px-3 py-4 text-center text-meta text-ink-fg-3">
                {t('groupChat.dialogNoCandidates')}
              </div>
            ) : (
              <div className="scrollbar-thin flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                {candidates.map((c) => {
                  const checked = picked.has(c.id)
                  const disabled = !checked && picked.size >= MAX_GROUP_MEMBERS
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5',
                        'transition-colors duration-fast hover:bg-ink-2',
                        disabled && 'cursor-not-allowed opacity-50'
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggle(c.id)}
                      />
                      <AgentAvatar
                        agentId={c.id}
                        config={c.avatar}
                        size={24}
                        title={c.title ?? c.id}
                      />
                      <span className="min-w-0 flex-1 truncate text-body text-ink-fg">
                        {c.title?.trim() || c.id}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('groupChat.cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={picked.size === 0 || creating}>
            {creating ? t('groupChat.creating') : t('groupChat.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
