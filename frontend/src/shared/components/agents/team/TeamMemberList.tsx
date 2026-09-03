// task 08-27 P4a（lane team-shell）— 团队域二级栏：智能体清单（页面自管列；宽读
// `--app-second-w`，09-01 侧栏批起是团队域自己的记忆值，默认 336）。
//
// 分组按**内置 / 自定义**（design §8.0：不按运行状态 —— 状态每行自己写了，拿它当分组
// 会让同一个成员今天在这组明天在那组）。每行：头像 + 名 + 状态点 + 一句状态文案。
// 状态点两档起步（主 session 拍板）：配置启停色 + 「工作中」仅对有真实 run 读态的成员
//（hasLiveRunState，经 useAgentRuns 第一行 9 值域）。

import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { cn } from '@shared/lib/cn'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import { useEnvStore } from '@shared/state/env'
import { useTeamGroupCollapse, type TeamGroupKey } from '@shared/state/team-group-collapse'

import { AgentAvatar } from '../AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from '../agentAvatarIdentity'
import { MAIN_ASSISTANT_SEED, envFlagOn } from '../shared'
import { useAgentRuns } from '../hooks'
import { TeamAgentImportEntries } from './TeamAgentImportEntries'
import { memberAvatarSeed, memberTitle, type TeamMember } from './teamMembers'

function MemberRow({
  member,
  title,
  selected,
  onSelect
}: {
  member: TeamMember
  title: string
  selected: boolean
  onSelect: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const identity = useAssistantIdentity()
  // 「工作中」判据：仅 hasLiveRunState 成员查最近一次 run（9 值域第一行）；其余成员
  // 传 null = 不发请求（r8 §D：它们运行中不广播事件，硬标就是装饰）。
  const { runs } = useAgentRuns(member.hasLiveRunState ? memberAgentId(member) : null, 1)
  const lastState = runs[0]?.state ?? null
  const working = lastState === 'running' || lastState === 'queued'

  // 启停色：预处理行的 enabled 列无意义（绑全局 LLM_AGENT_ENABLED）；项目周报还叠
  // env 总闸。主 Agent 恒在线。
  const llmAgentOn = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['LLM_AGENT_ENABLED'] ?? '')
      : false
  )
  const progressMasterOn = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['PROJECT_PROGRESS_SYNC_ENABLED'] ?? '')
      : false
  )
  const enabled =
    member.ref.kind === 'main' || member.ref.kind === 'matterFollowup'
      ? true
      : member.cfg?.type === 'preprocess'
        ? llmAgentOn
        : member.cfg?.type === 'project_progress'
          ? progressMasterOn && (member.cfg?.enabled ?? false)
          : (member.cfg?.enabled ?? false)

  // 🔴 事项跟进没有全局启停位：跑不跑由**每件事**自己的跟进规则决定。渲染成「已停用」
  // 就是撒谎，渲染成「已启用」也不对 —— 说清开关在哪一层。
  const statusText =
    member.ref.kind === 'main'
      ? t('agents.mainAgent.badge')
      : member.ref.kind === 'matterFollowup'
        ? t('team.matterFollowup.badge')
        : working
          ? t('team.list.working')
          : enabled
            ? t('agents.card.enabled')
            : t('agents.card.disabled')

  return (
    <button
      type="button"
      onClick={onSelect}
      data-team-member={member.key}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left',
        'transition-colors duration-fast',
        selected
          ? 'border-[var(--hairline-strong)] bg-ink-fg/[0.07]'
          : 'border-transparent bg-transparent hover:bg-ink-fg/[0.03]'
      )}
    >
      {selected && (
        <span
          className="absolute bottom-2 left-0 top-2 w-[3px] rounded-sm"
          style={{ background: 'rgb(var(--c-accent))' }}
        />
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
          agentId={memberAvatarSeed(member)}
          config={member.cfg?.avatar}
          size={30}
          title={title}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-body font-medium text-ink-fg">{title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-micro text-ink-fg-3">
        <span
          data-status-dot={working ? 'working' : enabled ? 'on' : 'off'}
          className={cn(
            'size-1.5 rounded-full',
            working ? 'animate-pulse bg-info' : enabled ? 'bg-ok' : 'bg-ink-fg/30'
          )}
        />
        {statusText}
      </span>
    </button>
  )
}

function memberAgentId(member: TeamMember): string | null {
  return member.ref.kind === 'agent' ? member.ref.agentId : null
}

export function TeamMemberList({
  members,
  selectedKey,
  onSelect,
  isLoading,
  fluid,
  showCreate,
  createSelected,
  onCreate,
  onImported
}: {
  members: readonly TeamMember[]
  /** 选中成员 key；null = 选中的是「新建」态。 */
  selectedKey: string | null
  onSelect: (member: TeamMember) => void
  isLoading: boolean
  /** 窄窗单栏：占满宽、去右分割线（ReportsPage 同款）。 */
  fluid?: boolean
  /** 「新建智能体」行（MAILAGENT_CUSTOM_AGENTS_ENABLED 门控，design §8.4）。 */
  showCreate?: boolean
  createSelected?: boolean
  onCreate?: () => void
  /** 导入 / 模板落地后的流转（同新建：选中新成员落设置档）。传了才渲染这两个次级入口。 */
  onImported?: (agentId: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const identity = useAssistantIdentity()
  const mainName = identity.name ?? t('chat.title')
  const builtin = members.filter((m) => m.group === 'builtin')
  const custom = members.filter((m) => m.group === 'custom')

  // task 09-02 misc08 —— 分组标题变可点击折叠头，折叠态记 localStorage（`mailagent.
  // team.groupsCollapsed`，先例 EmailList 日期分组）。`CollapsibleRegion` 恒挂载内容
  // （只是 height:0 + inert），选中成员即便所在组被折叠也不丢选中态。
  const collapsedMap = useTeamGroupCollapse((s) => s.collapsed)
  const toggleGroup = useTeamGroupCollapse((s) => s.toggle)
  const isGroupCollapsed = (key: TeamGroupKey): boolean => collapsedMap[key] === true

  const group = (
    key: TeamGroupKey,
    labelKey: string,
    rows: readonly TeamMember[],
    footer?: React.ReactNode
  ): React.ReactElement => {
    const expanded = !isGroupCollapsed(key)
    const bodyId = `team-group-${key}`
    return (
      <section>
        <button
          type="button"
          onClick={() => toggleGroup(key)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex w-full items-center gap-2 px-2.5 pb-1 pt-2 text-left text-micro font-medium uppercase tracking-wider text-ink-fg-3 transition-colors duration-fast hover:text-ink-fg-2"
        >
          <CollapseChevron expanded={expanded} size={10} />
          <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
          <span className="font-mono tabular-nums opacity-60">{rows.length}</span>
        </button>
        <CollapsibleRegion expanded={expanded} id={bodyId}>
          <div className="flex flex-col gap-0.5">
            {rows.map((m) => (
              <MemberRow
                key={m.key}
                member={m}
                title={memberTitle(
                  m,
                  mainName,
                  t('agents.custom.runs.unknownAgent'),
                  t('team.matterFollowup.title')
                )}
                selected={m.key === selectedKey}
                onSelect={() => onSelect(m)}
              />
            ))}
            {footer}
          </div>
        </CollapsibleRegion>
      </section>
    )
  }

  return (
    <div
      data-team-member-list
      className="flex h-full shrink-0 flex-col"
      style={{
        // 宽读 `--app-second-w`（团队域自己的记忆，09-01 侧栏批；外壳在 TeamWorkspace）。
        width: fluid ? '100%' : 'var(--app-second-w, 336px)',
        borderRight: fluid ? 'none' : '1px solid rgb(var(--ink-border))'
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-border-soft px-3.5 pb-2.5 pt-3.5">
        <h2 className="text-body font-semibold text-ink-fg">{t('nav.domain.team')}</h2>
        <span className="font-mono text-meta text-ink-fg-3">{members.length}</span>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-2">
        {isLoading && members.length <= 1 ? (
          <div className="px-2 py-6 text-meta text-ink-fg-3">{t('agents.reports.loading')}</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {group('builtin', 'team.list.builtin', builtin)}
            {(custom.length > 0 || showCreate === true) &&
              group(
                'custom',
                'team.list.custom',
                custom,
                <>
                  {showCreate === true && (
                    <button
                      type="button"
                      onClick={onCreate}
                      data-team-create-row
                      className={cn(
                        'relative flex w-full items-center gap-2.5 rounded-lg border border-dashed px-2.5 py-2 text-left',
                        'transition-colors duration-fast',
                        createSelected === true
                          ? 'border-[var(--hairline-strong)] bg-ink-fg/[0.07] text-ink-fg'
                          : 'border-ink-border text-ink-fg-2 hover:bg-ink-fg/[0.03] hover:text-ink-fg'
                      )}
                    >
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-full border border-dashed border-ink-border text-ink-fg-3">
                        <Plus size={14} strokeWidth={2} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body font-medium">
                        {t('team.list.newAgent')}
                      </span>
                    </button>
                  )}
                  {/* 从零建之外的两条路：导入既有 Agent / 套模板（MAILAGENT_AGENT_PLUGINS 门控）。 */}
                  {showCreate === true && onImported != null && (
                    <TeamAgentImportEntries onImported={onImported} />
                  )}
                </>
              )}
          </div>
        )}
      </div>
    </div>
  )
}
