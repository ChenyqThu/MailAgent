// L4 群聊 — 对话域「群聊」分段的整个工作区：三栏壳（清单列 ｜ 群聊视图 ｜ 群详情面）。
//
// 数据源：`GET /chat/sessions/all?origin=group`（AgentViewLayout 注入 items + invalidate —— 与
// AI 分段同构，列表数据归 layout 管）。serve-api 对 origin='group' 放宽了「有消息才出现」的判据，
// 零消息新群建好即在列表里；draftSession 只兜住「建群成功 → 列表 refetch 到达」之间那一拍。
// 成员候选 = 团队页可对话成员（deriveTeamMembers canChat 判据，排除主 agent 与
// 预处理/项目周报/搜索三位），上限 MAX_GROUP_MEMBERS —— serve-api /sessions/new 同判据兜底
// 校验，两侧共读 ai-gateway/groupFloors.ts（TS 单源）与 src/chat/group_limits.py（Python 单源），
// 闸 tests/config/test_group_constants_parity.py。
//
// 本组件持有三件跨栏状态：
//   ① 详情面开合 —— 落 `useSessionsSegment.detailsOpenBySession`，**按群记忆**（右栏是常驻面，
//      切回某个群应该还是离开时那副样子）。
//   ② `useGroupLiveMap(labsOn)` —— 列表级在场态的**唯一订阅点**：一次订阅下发给清单列的脉冲，
//      同时作为群聊视图的初值（每行各订阅一次 = 行数倍的 IPC 监听）。
//   ③ `sendingSessionId` —— labs off 的 v1 发送期间由群聊视图上抛（那条路径没有服务端事件，
//      列表的「发言中」只能靠它）。
//
// 🔴 群聊是桌面-only（发言链路走本地 gateway；groupChatClient 在 web 上恒 E_UNSUPPORTED）。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Users } from 'lucide-react'

import type { ChatSession, ChatSessionListItem, ReportAgentConfig } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useLabsFlags } from '@shared/hooks/useLabsFlags'
import { toastError } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { isSessionUnread } from '@shared/lib/chatUnread'
import { useSessionsSegment } from '@shared/state/sessions-segment'
import { Drawer } from '@shared/components/ui/drawer'

import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'

import { useReportConfig } from '../hooks'
import { deriveTeamMembers } from '../team/teamMembers'
import { GroupChatView } from './GroupChatView'
import { GroupList } from './GroupList'
import { GroupDetailsPane } from './GroupDetailsPane'
import { NewGroupDialog } from './NewGroupDialog'
import { useGroupLiveMap } from './useGroupTurnEvents'
import { parseMembersJson, type GroupMemberMeta } from './members'
import type { GroupRowItem } from './GroupRow'

/** 详情面宽度（右栏；窄屏改 Drawer）。 */
const DETAILS_WIDTH = 300

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
  const mailApi = useMailApi()
  const { agents } = useReportConfig()
  const activeId = useSessionsSegment((s) => s.activeGroupSessionId)
  const setActiveId = useSessionsSegment((s) => s.setActiveGroupSessionId)
  const detailsOpenBySession = useSessionsSegment((s) => s.detailsOpenBySession)
  const setDetailsOpen = useSessionsSegment((s) => s.setDetailsOpen)
  const [dialogOpen, setDialogOpen] = useState(false)
  // 刚建好、列表还没 refetch 到的群，本地持有一拍。
  const [draftSession, setDraftSession] = useState<ChatSession | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [sendingSessionId, setSendingSessionId] = useState<number | null>(null)
  const { groupAgents: labsOn } = useLabsFlags()
  // 列表级在场态：整个工作区订阅一次（labs off → 空 Map 且不订阅）。
  const liveBySession = useGroupLiveMap(labsOn)
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

  // 可入群成员：建群对话框与详情面「加人」共用一份（每处各算一次会给两个组件各发一个新数组）。
  const candidates = useMemo(() => chatCapableMembers(agents), [agents])

  const rows: GroupRowItem[] = useMemo(
    () =>
      draftSession != null && !items.some((s) => s.id === draftSession.id)
        ? [draftSession, ...items]
        : items,
    [draftSession, items]
  )

  const listed = activeId != null ? (items.find((s) => s.id === activeId) ?? null) : null
  const activeSession: ChatSession | null =
    listed ?? (draftSession != null && draftSession.id === activeId ? draftSession : null)
  const detailsOpen = activeId != null && detailsOpenBySession[activeId] === true

  // 一局 = 本群 + 父群 + 本群的子群（自己在首位）。狼人杀的预算是 family 合计，单群数字
  // 会低报到看不出问题；父子关系只从这一屏的行里推（清单已含全部 origin='group' 行）。
  const familySessionIds = useMemo<number[]>(() => {
    if (activeSession == null) return []
    const ids = [activeSession.id]
    const parentId = activeSession.parent_session_id ?? null
    if (parentId != null) ids.push(parentId)
    for (const i of items) if (i.parent_session_id === activeSession.id) ids.push(i.id)
    return [...new Set(ids)]
  }, [activeSession, items])

  const select = (id: number): void => {
    setActiveId(id)
    if (narrow) setMobileDetail(true)
  }

  const rename = (id: number, title: string): void => {
    void mailApi.chat
      .updateSessionTitle(id, title)
      .then(() => {
        setDraftSession((prev) => (prev != null && prev.id === id ? { ...prev, title } : prev))
        invalidate()
      })
      .catch((err: unknown) =>
        toastError(t('groupChat.renameFailed', { error: errorMessage(err) }))
      )
  }

  const remove = (id: number): void => {
    void mailApi.chat
      .deleteSession(id)
      .then(() => {
        setDraftSession((prev) => (prev != null && prev.id === id ? null : prev))
        if (activeId === id) setActiveId(null)
        invalidate()
      })
      .catch((err: unknown) =>
        toastError(t('groupChat.deleteFailed', { error: errorMessage(err) }))
      )
  }

  const list = (
    <GroupList
      headerSlot={headerSlot}
      items={rows}
      memberMeta={memberMeta}
      activeId={activeId}
      liveBySession={liveBySession}
      sendingSessionId={sendingSessionId}
      canCreate={canCreate}
      unreadOf={(item) => isSessionUnread(item)}
      narrow={narrow}
      navHidden={navHidden}
      onSelect={select}
      onNew={() => setDialogOpen(true)}
      onRename={rename}
      onDelete={remove}
    />
  )

  const detail = activeSession ? (
    <GroupChatView
      key={activeSession.id}
      session={activeSession}
      memberMeta={memberMeta}
      onActivity={invalidate}
      detailsOpen={detailsOpen}
      onToggleDetails={() => setDetailsOpen(activeSession.id, !detailsOpen)}
      initialLive={liveBySession.get(activeSession.id) ?? null}
      onSendingChange={(sending) => setSendingSessionId(sending ? activeSession.id : null)}
    />
  ) : (
    <div className="grid flex-1 place-items-center text-meta text-ink-fg-3">
      <div className="flex flex-col items-center gap-2">
        <Users size={20} strokeWidth={1.5} />
        <span>{t('groupChat.noSelection')}</span>
      </div>
    </div>
  )

  const details =
    activeSession != null ? (
      <GroupDetailsPane
        key={activeSession.id}
        sessionId={activeSession.id}
        session={activeSession}
        memberIds={parseMembersJson(activeSession.members_json ?? null)}
        familySessionIds={familySessionIds}
        memberMeta={memberMeta}
        candidates={candidates}
        labsOn={labsOn}
        onClose={() => setDetailsOpen(activeSession.id, false)}
        onRenamed={invalidate}
        onDeleted={() => {
          setDetailsOpen(activeSession.id, false)
          setDraftSession((prev) => (prev?.id === activeSession.id ? null : prev))
          setActiveId(null)
          invalidate()
        }}
        onMembersChanged={invalidate}
      />
    ) : null

  const dialog = (
    <NewGroupDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      candidates={candidates}
      labsOn={labsOn}
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
        {/* 窄屏没有第三栏的宽度：详情面改抽屉（同一份组件，壳不同）。 */}
        <Drawer
          open={detailsOpen && activeSession != null}
          onOpenChange={(open) => {
            if (!open && activeSession != null) setDetailsOpen(activeSession.id, false)
          }}
          ariaLabel={t('groupChat.details.title')}
          width={DETAILS_WIDTH}
        >
          {details}
        </Drawer>
        {dialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      <div className="flex min-w-0 flex-1 flex-col">{detail}</div>
      {detailsOpen && details != null && (
        <aside
          className="glass-panel flex h-full shrink-0 flex-col overflow-hidden border-l border-ink-border"
          style={{ width: DETAILS_WIDTH }}
        >
          {details}
        </aside>
      )}
      {dialog}
    </div>
  )
}
