// L4 群聊 — 群聊域（`/groups`）的整个工作区：三栏壳（清单列 ｜ 群聊视图 ｜ 群详情面）。
//
// 数据源：`GET /chat/sessions/all?origin=group`（GroupsLayout 注入 items + invalidate —— 列表数据
// 归 layout 管，与 AI Chat 侧同构）。serve-api 对 origin='group' 放宽了「有消息才出现」的判据，
// 零消息新群建好即在列表里；draftSession 只兜住「建群成功 → 列表 refetch 到达」之间那一拍。
// 成员候选 = 主 Agent + 团队页可对话成员（deriveTeamMembers canChat 判据，排除预处理/项目
// 周报/搜索三位），上限 MAX_GROUP_MEMBERS —— serve-api /sessions/new 同判据兜底校验，两侧
// 共读 ai-gateway/groupFloors.ts（TS 单源）与 src/chat/group_limits.py（Python 单源），
// 闸 tests/config/test_group_constants_parity.py。
//
// 🔴 主 Agent 用保留 id `MAIN_AGENT_MEMBER_ID` 入名单，名字与头像来自 assistant identity
// （它没有 report_agent 行）。serve-api 的成员校验对这个 id 短路放行，gateway 侧由
// resolveGroupSession 合成成员事实 —— renderer 这一侧只负责让它出现在候选与 memberMeta 里。
//
// 本组件持有四件跨栏状态：
//   ① 详情面开合 —— 落 `useGroupsView.detailsOpenBySession`，**按群记忆**（右栏是常驻面，
//      切回某个群应该还是离开时那副样子）。
//   ② 话题面（T3）—— 落 `useGroupsView.activeThreadBySession`，同样按群记忆。🔴 与详情面**互斥**
//      且互斥在这里执行（store 只存两件事实）：右栏的归属按「话题面优先」派生 —— 有话题就画话题面，
//      详情面只在没话题时才算开；点详情钮先收话题，开话题先收详情。通知直达
//      （`navigateToGroupThread`）只点名话题不碰详情键，派生规则保证它照样顶掉详情面。
//   ③ `useGroupLiveMap(labsOn)` —— 列表级在场态的**唯一订阅点**：一次订阅下发给清单列的脉冲，
//      同时作为群聊视图的初值（每行各订阅一次 = 行数倍的 IPC 监听）。
//   ④ `sendingSessionId` —— labs off 的 v1 发送期间由群聊视图上抛（那条路径没有服务端事件，
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
import { isGroupRowUnread } from '@shared/lib/groupUnread'
import { useGroupsView } from '@shared/state/groups-view'
import { Drawer } from '@shared/components/ui/drawer'

import { resolveAiGatewayBaseUrl } from '@shared/assistant/runtime/flags'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'

import { useReportConfig } from '../hooks'
import { OFFICIAL_ASSISTANT_AVATAR } from '../agentAvatarIdentity'
import { deriveTeamMembers } from '../team/teamMembers'
import { GroupChatView } from './GroupChatView'
import { GroupList } from './GroupList'
import { GroupDetailsPane } from './GroupDetailsPane'
import { GroupThreadPane } from './GroupThreadPane'
import { NewGroupDialog } from './NewGroupDialog'
import { useGroupLiveMap } from './useGroupTurnEvents'
import { parseMembersJson, type GroupCandidate, type GroupMemberMeta } from './members'
import type { GroupRowItem } from './GroupRow'

import { MAIN_AGENT_MEMBER_ID } from '../../../../ai-gateway/groupFloors'

/** 详情面 / 话题面宽度（右栏；窄屏改 Drawer）。 */
const DETAILS_WIDTH = 300

/** 团队清单 → 可入群的 agent 行（canChat 且是真 agent 行；主 Agent 另行拼在最前）。 */
function chatCapableMembers(agents: readonly ReportAgentConfig[]): GroupCandidate[] {
  return (
    deriveTeamMembers(agents)
      .filter((m) => m.canChat && m.ref.kind === 'agent' && m.cfg != null)
      // 存量行可能占着保留 id（serve-api 只在启动时告警，不动数据）。它在下游已经不可寻址
      // ——gateway 把这个 id 解析成主 Agent —— 再列一遍就是同一 key 的两行。
      .filter((m) => m.cfg?.id !== MAIN_AGENT_MEMBER_ID)
      .map((m) => {
        const cfg = m.cfg as ReportAgentConfig
        return {
          id: cfg.id,
          title: cfg.title?.trim() || cfg.id,
          avatar: cfg.avatar ?? null,
          model: cfg.model ?? null
        }
      })
  )
}

export function GroupChatWorkspace({
  items,
  invalidate,
  narrow,
  navHidden = false
}: {
  items: ChatSessionListItem[]
  invalidate: () => void
  narrow: boolean
  /** 09-01 侧栏批：群聊二级栏折叠时整列隐藏（与 AgentThreadList.navHidden 同语义，
   *  由 GroupsLayout 按 useDomainCollapsed('groups') 注入）；窄窗单栏形态下无意义。 */
  navHidden?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const { agents } = useReportConfig()
  const identity = useAssistantIdentity()
  const mainTitle = identity.name?.trim() || t('chat.title')
  // 未配置头像 → 官方形象（与团队页 / 设置页主 Agent 卡同一条回落，不走 id 派生）。
  const mainAvatar = identity.avatar ?? OFFICIAL_ASSISTANT_AVATAR
  const activeId = useGroupsView((s) => s.activeGroupSessionId)
  const setActiveId = useGroupsView((s) => s.setActiveGroupSessionId)
  const detailsOpenBySession = useGroupsView((s) => s.detailsOpenBySession)
  const setDetailsOpen = useGroupsView((s) => s.setDetailsOpen)
  const activeThreadBySession = useGroupsView((s) => s.activeThreadBySession)
  const setActiveThread = useGroupsView((s) => s.setActiveThread)
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
    // 保留 id 最后写：万一库里真有一行 id 叫 `main`（serve-api 已拒收 + 启动扫存量），
    // 展示面也以主 Agent 身份为准，不让它被顶替。
    map.set(MAIN_AGENT_MEMBER_ID, { title: mainTitle, avatar: mainAvatar })
    return map
  }, [agents, mainTitle, mainAvatar])

  // 可入群成员：建群对话框与详情面「加人」共用一份（每处各算一次会给两个组件各发一个新数组）。
  // 主 Agent 排在最前 —— 与团队页清单同序（那里也是「主 Agent → 内置 → 自定义」）。
  const candidates = useMemo<GroupCandidate[]>(
    () => [
      { id: MAIN_AGENT_MEMBER_ID, title: mainTitle, avatar: mainAvatar, model: null },
      ...chatCapableMembers(agents)
    ],
    [agents, mainTitle, mainAvatar]
  )

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
  // 右栏归属：话题面优先；详情面只在没话题时才算开（互斥的派生一半，写侧另一半见下面两个动作）。
  const activeThreadId = activeId != null ? (activeThreadBySession[activeId] ?? null) : null
  const detailsOpen =
    activeThreadId == null && activeId != null && detailsOpenBySession[activeId] === true
  const openThread = (groupId: number, threadId: number): void => {
    setActiveThread(groupId, threadId)
    setDetailsOpen(groupId, false)
  }
  const toggleDetails = (groupId: number): void => {
    if (!detailsOpen) setActiveThread(groupId, null)
    setDetailsOpen(groupId, !detailsOpen)
  }

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
      items={rows}
      memberMeta={memberMeta}
      activeId={activeId}
      liveBySession={liveBySession}
      sendingSessionId={sendingSessionId}
      canCreate={canCreate}
      unreadOf={(item) => isGroupRowUnread(item)}
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
      onToggleDetails={() => toggleDetails(activeSession.id)}
      initialLive={liveBySession.get(activeSession.id) ?? null}
      onSendingChange={(sending) => setSendingSessionId(sending ? activeSession.id : null)}
      activeThreadId={activeThreadId}
      onOpenThread={(threadId) => openThread(activeSession.id, threadId)}
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

  // 话题面顶替右栏；`key` 带话题 id，换话题整体重挂（数据 hook 同群视图，按 key 重跑）。
  const threadPane =
    activeSession != null && activeThreadId != null ? (
      <GroupThreadPane
        key={`${activeSession.id}:${activeThreadId}`}
        groupId={activeSession.id}
        threadId={activeThreadId}
        group={activeSession}
        memberMeta={memberMeta}
        initialLive={liveBySession.get(activeThreadId) ?? null}
        onClose={() => setActiveThread(activeSession.id, null)}
      />
    ) : null
  const sidePane = threadPane ?? (detailsOpen ? details : null)

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
        {/* 窄屏没有第三栏的宽度：详情面 / 话题面改抽屉（同一份组件，壳不同）。 */}
        <Drawer
          open={sidePane != null}
          onOpenChange={(open) => {
            if (open || activeSession == null) return
            if (activeThreadId != null) setActiveThread(activeSession.id, null)
            else setDetailsOpen(activeSession.id, false)
          }}
          ariaLabel={t(
            activeThreadId != null ? 'groupChat.thread.paneTitle' : 'groupChat.details.title'
          )}
          width={DETAILS_WIDTH}
        >
          {sidePane}
        </Drawer>
        {dialog}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      <div className="flex min-w-0 flex-1 flex-col">{detail}</div>
      {sidePane != null && (
        <aside
          className="glass-panel flex h-full shrink-0 flex-col overflow-hidden border-l border-ink-border"
          style={{ width: DETAILS_WIDTH }}
        >
          {sidePane}
        </aside>
      )}
      {dialog}
    </div>
  )
}
