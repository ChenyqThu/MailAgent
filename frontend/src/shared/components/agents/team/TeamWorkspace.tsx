// task 08-27 P4a（lane team-shell）— 团队域工作台：清单（页面自管二级栏 336）+ 成员详情。
// 取代旧的「卡片网格 + 点卡开抽屉」形态。
//
// design §8.1 的两条硬规则在这里：
//   🔴 换成员恒回第一档（selectMember 里显式 reset —— 不是「保持上次视图」）。
//   🔴 当前档不在新成员可选集里时纠正（clampMemberTab；主 Agent 只有设置档，
//      从别人的「执行」档切过去不能白屏）。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, MessageSquare } from 'lucide-react'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { cn } from '@shared/lib/cn'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'
import { useEnvStore } from '@shared/state/env'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { SegmentedControl } from '@shared/components/ui/segmented'

import { AgentAvatar } from '../AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from '../agentAvatarIdentity'
import { MAIN_ASSISTANT_SEED, memberRefKey } from '../shared'
import { useCustomAgentsEnabled, useNarrow, useReportConfig } from '../hooks'
import { useAgentsNavigation } from '../navigation'
// 接缝收口（lane agent-config 已落盘）：设置档挂正式的配置页骨架（八区注册），
// 新建走它 re-export 的 CustomAgentCreateView（design §8.4：新建只有设置档）。
import { AgentSettingsView, CustomAgentCreateView } from '../settings/AgentSettingsView'
import { TeamMemberList } from './TeamMemberList'
import { TeamRecordPane } from './TeamRecordPane'
import {
  clampMemberTab,
  deriveTeamMembers,
  findMemberByAgentId,
  memberTitle,
  type TeamMember,
  type TeamViewTab
} from './teamMembers'

/** 记录列强制收起断点：rail 56 + 清单 336 + 记录列 216 = 608，窗口再窄详情就没法看
 *  （minWidth 940 时详情只剩 332）——判据与二级栏窄窗让位同构。 */
const RECORD_FORCE_COLLAPSE_BELOW = 1024

function MemberDetail({
  member,
  title,
  tab,
  onTab,
  recordCollapsed,
  onToggleRecordCollapsed,
  forcedRecordCollapsed,
  onBack
}: {
  member: TeamMember
  title: string
  tab: TeamViewTab
  onTab: (tab: TeamViewTab) => void
  recordCollapsed: boolean
  onToggleRecordCollapsed: () => void
  forcedRecordCollapsed: boolean
  /** 窄窗单栏时的返回入口；宽窗不传。 */
  onBack?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const identity = useAssistantIdentity()
  const goChat = (): void => navigateToNavEntry(navigate, navEntry('sessions'))

  const tabOptions = member.tabs.map((tabId) => ({
    value: tabId,
    label:
      tabId === 'settings'
        ? t('team.tabs.settings')
        : member.canChat
          ? t('team.tabs.chat')
          : t('team.tabs.record')
  }))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-team-member-detail={member.key}>
      {/* 页头：头像 + 名 + 视图档；主 Agent 给「去对话」（它就是全局对话本身，无记录档）。 */}
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-ink-border px-4">
        {onBack != null && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('agents.reports.backToList')}
            className="grid size-8 shrink-0 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
        )}
        {member.ref.kind === 'main' ? (
          <AgentAvatar
            agentId={MAIN_ASSISTANT_SEED}
            config={identity.avatar ?? OFFICIAL_ASSISTANT_AVATAR}
            size={30}
            title={title}
          />
        ) : (
          <AgentAvatar
            agentId={member.cfg?.id ?? 'unknown'}
            config={member.cfg?.avatar}
            size={30}
            title={title}
          />
        )}
        <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-ink-fg">{title}</h2>
        {member.ref.kind === 'main' && (
          <button
            type="button"
            onClick={goChat}
            data-go-chat
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-ink-border px-2.5 text-meta font-medium text-ink-fg-1 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
          >
            <MessageSquare size={12} strokeWidth={2} />
            {t('team.goChat')}
          </button>
        )}
        {member.tabs.length > 1 && (
          <SegmentedControl
            value={tab}
            onChange={(v) => onTab(v as TeamViewTab)}
            ariaLabel={t('team.tabs.aria')}
            options={tabOptions}
          />
        )}
      </div>
      {tab === 'record' ? (
        <TeamRecordPane
          key={member.key}
          member={member}
          memberTitle={title}
          collapsed={recordCollapsed}
          onToggleCollapsed={onToggleRecordCollapsed}
          forcedCollapsed={forcedRecordCollapsed}
        />
      ) : (
        // 🔴 这里不再滚动：配置页骨架自带滚动容器，外面再套一层 overflow-y-auto 就是
        // 两条滚动条（骨架 height:100% 时外层恒不溢出而白留一条；一旦上面那句说明把内容
        // 顶高，两层就同时可滚）。收敛成一层：这里只做 flex 列，滚动交给骨架。
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-team-settings>
          {/* 搜索 Agent：零执行台账（主 session 拍板偏离 design §8.0），设置档顶部一句说明。 */}
          {member.noChatReasonKey != null && !member.tabs.includes('record') && (
            <div
              className="shrink-0 border-b border-ink-border-soft px-4 py-2 text-meta leading-relaxed text-ink-fg-2"
              data-no-chat-reason
            >
              {t(member.noChatReasonKey)}
            </div>
          )}
          <AgentSettingsView member={member.ref} />
        </div>
      )}
    </div>
  )
}

export function TeamWorkspace(): React.ReactElement {
  const { t } = useTranslation()
  const { agents, isLoading } = useReportConfig()
  const members = useMemo(() => deriveTeamMembers(agents), [agents])
  const identity = useAssistantIdentity()
  const mainName = identity.name ?? t('chat.title')

  // env store 默认 idle（仅设置页 SettingsShell mount 时 refresh，见 env.ts 头注释）；
  // 团队页的启停徽标（TeamMemberList）与设置档 enable/model 预填（Preprocess/
  // ProjectProgressSettings）都读它，没开过设置页的会话里会恒灰/恒 stale。P4a 从
  // AgentsTab 迁移到本组件时丢了这段 mount 补丁（见 git show f49a447d^ 同名注释），
  // 08-31 回归修复：进团队页主动拉一次。
  useEffect(() => {
    if (useEnvStore.getState().state.status === 'idle') void useEnvStore.getState().refresh()
  }, [])

  const narrow = useNarrow()
  const forcedRecordCollapsed = useNarrow(RECORD_FORCE_COLLAPSE_BELOW)

  const [selectedKey, setSelectedKey] = useState<string>(members[0].key)
  const [tab, setTab] = useState<TeamViewTab>(members[0].tabs[0])
  const [recordCollapsed, setRecordCollapsed] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  // 新建自定义 Agent 态（design §8.4：新建走设置，只有设置档，保存后才有对话）。
  const [creating, setCreating] = useState(false)

  const member = members.find((m) => m.key === selectedKey) ?? members[0]
  // 纠正：当前档不在该成员可选集（深链/自定义行被删后回落）→ 落它的第一档。
  const effectiveTab = clampMemberTab(member, tab)

  // 🔴 换成员恒回第一档 —— 不是「保持上次视图」（design §8.1 容易漏的第 1 条）。
  const selectMember = (m: TeamMember): void => {
    setSelectedKey(m.key)
    setTab(m.tabs[0])
    if (narrow) setMobileDetail(true)
  }

  // 跨页直达（通讯录工作台「去配置」）：store 点名 agent id → 选中该成员并落设置档。
  // 🔴 等 isLoading 落定再消费（查询在途时消费 = 深链被吃掉）；
  // 目标不在（老库没播种）时只清 intent。
  const navigationTargetAgentId = useAgentsNavigation((state) => state.targetAgentId)
  const clearAgentsNavigation = useAgentsNavigation((state) => state.clear)
  useEffect(() => {
    if (navigationTargetAgentId === null || isLoading) return
    const target = findMemberByAgentId(members, navigationTargetAgentId)
    if (target) {
      setCreating(false)
      setSelectedKey(target.key)
      setTab('settings')
      if (narrow) setMobileDetail(true)
    }
    clearAgentsNavigation()
  }, [navigationTargetAgentId, isLoading, members, clearAgentsNavigation, narrow])

  // 新建入口的门控与流转。表单本体 = agent-config lane 的 CustomAgentCreateView；
  // 创建成功 → 选中新成员落设置档。
  const customAgentsEnabled = useCustomAgentsEnabled()
  const startCreate = (): void => {
    setCreating(true)
    if (narrow) setMobileDetail(true)
  }
  const selectMemberAndStopCreating = (m: TeamMember): void => {
    setCreating(false)
    selectMember(m)
  }
  // 新建 / 导入 / 套模板落地后的统一流转：退出新建态 → 选中该行 → 落设置档。
  // （行本身要等 report.config 刷新才在 members 里；期间 member 回落主 Agent，
  //   设置档在它那儿也成立，刷新到达后自然对上。）
  const showAgentSettings = (agentId: string): void => {
    setCreating(false)
    setSelectedKey(memberRefKey({ kind: 'agent', agentId }))
    setTab('settings')
  }

  const title = memberTitle(member, mainName, t('agents.custom.runs.unknownAgent'))
  // 主标签第二段 = 当前那位智能体（design §三「team → 当前智能体」）；新建态显 tile 同款标题。
  useMainBreadcrumb('agents', creating ? t('agents.custom.newTileTitle') : title)

  const list = (
    <TeamMemberList
      members={members}
      selectedKey={creating ? null : member.key}
      onSelect={selectMemberAndStopCreating}
      isLoading={isLoading}
      fluid={narrow}
      showCreate={customAgentsEnabled}
      createSelected={creating}
      onCreate={startCreate}
      onImported={showAgentSettings}
    />
  )

  const detail = creating ? (
    // 同设置档：滚动归骨架自己那层，这里只做 flex 列（新建没有外层页头，骨架标题照常在）。
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-team-create>
      <CustomAgentCreateView onCreated={showAgentSettings} />
    </div>
  ) : (
    <MemberDetail
      member={member}
      title={title}
      tab={effectiveTab}
      onTab={setTab}
      recordCollapsed={recordCollapsed}
      onToggleRecordCollapsed={() => setRecordCollapsed((v) => !v)}
      forcedRecordCollapsed={forcedRecordCollapsed}
      onBack={narrow ? () => setMobileDetail(false) : undefined}
    />
  )

  if (narrow) {
    return (
      <div className={cn('h-full w-full', mobileDetail ? 'flex min-h-0 flex-col' : '')}>
        {mobileDetail ? detail : list}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      {detail}
    </div>
  )
}
