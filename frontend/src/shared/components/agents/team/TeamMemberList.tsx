// task 08-27 P4a（lane team-shell）— 团队域二级栏：智能体清单（页面自管列，定宽 336）。
//
// 分组按**内置 / 自定义**（design §8.0：不按运行状态 —— 状态每行自己写了，拿它当分组
// 会让同一个成员今天在这组明天在那组）。每行：头像 + 名 + 状态点 + 一句状态文案。
// 状态点两档起步（主 session 拍板）：配置启停色 + 「工作中」仅对有真实 run 读态的成员
//（hasLiveRunState，经 useAgentRuns 第一行 9 值域）。

import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { cn } from '@shared/lib/cn'
import { useEnvStore } from '@shared/state/env'

import { AgentAvatar } from '../AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from '../agentAvatarIdentity'
import { MAIN_ASSISTANT_SEED, envFlagOn } from '../shared'
import { useAgentRuns } from '../hooks'
import { memberTitle, type TeamMember } from './teamMembers'

/** 报告域清单列同款定宽（左列总宽 392 = 导轨 56 + 336）。 */
const LIST_WIDTH = 336

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
  // env 总闸（AgentsTab 卡片同款语义）。主 Agent 恒在线。
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
    member.ref.kind === 'main'
      ? true
      : member.cfg?.type === 'preprocess'
        ? llmAgentOn
        : member.cfg?.type === 'project_progress'
          ? progressMasterOn && (member.cfg?.enabled ?? false)
          : (member.cfg?.enabled ?? false)

  const statusText =
    member.ref.kind === 'main'
      ? t('agents.mainAgent.badge')
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
          agentId={member.cfg?.id ?? 'unknown'}
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
  onCreate
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
}): React.ReactElement {
  const { t } = useTranslation()
  const identity = useAssistantIdentity()
  const mainName = identity.name ?? t('chat.title')
  const builtin = members.filter((m) => m.group === 'builtin')
  const custom = members.filter((m) => m.group === 'custom')

  const group = (labelKey: string, rows: readonly TeamMember[]): React.ReactElement => (
    <section>
      <div className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
        <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
        <span className="font-mono tabular-nums opacity-60">{rows.length}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((m) => (
          <MemberRow
            key={m.key}
            member={m}
            title={memberTitle(m, mainName, t('agents.custom.runs.unknownAgent'))}
            selected={m.key === selectedKey}
            onSelect={() => onSelect(m)}
          />
        ))}
      </div>
    </section>
  )

  return (
    <div
      data-team-member-list
      className="flex h-full shrink-0 flex-col"
      style={{
        width: fluid ? '100%' : LIST_WIDTH,
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
            {group('team.list.builtin', builtin)}
            {(custom.length > 0 || showCreate === true) && (
              <section>
                <div className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-micro font-medium uppercase tracking-wider text-ink-fg-3">
                  <span className="min-w-0 flex-1 truncate">{t('team.list.custom')}</span>
                  <span className="font-mono tabular-nums opacity-60">{custom.length}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {custom.map((m) => (
                    <MemberRow
                      key={m.key}
                      member={m}
                      title={memberTitle(m, mainName, t('agents.custom.runs.unknownAgent'))}
                      selected={m.key === selectedKey}
                      onSelect={() => onSelect(m)}
                    />
                  ))}
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
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
