// Extracted from ai_gateway_lifecycle.ts — group chat roster, judge scope hash, transcript history, and tool hooks.

import { createHash } from 'node:crypto'

import type { AssistantIdentity, ReportAgentConfig } from '@shared/api/types'
import type { GroupConfig } from '@shared/chat_model'
import type {
  AiGatewayConfig,
  GroupRunLogMirror,
  GroupSessionMember,
  LabsFlags
} from '../../../ai-gateway/config'
import { parseAttachmentsMetadata } from '../../../ai-gateway/groupAttachments'
import { parseGroupMemberIds } from '../../../ai-gateway/groupChat'
import {
  MAIN_AGENT_MEMBER_ID,
  MATTER_FOLLOWUP_MEMBER_ID,
  MATTER_FOLLOWUP_MEMBER_TITLE,
  type GroupResponseMode
} from '../../../ai-gateway/groupFloors'
import { parseLibraryRefsMetadata } from '../../../ai-gateway/groupLibraryRefs'
import type { MailAgentDomainClient } from '../../../ai-gateway/python/domainClient'
import type { ApprovalGuard } from '../../../ai-gateway/security/approval'
import {
  createGroupJudgeTools,
  createGroupMemberTools,
  type GroupToolHooks
} from '../../../ai-gateway/tools/groups'
import { stripOwnerDeniedTools } from '../../../ai-gateway/tools/types'
import { appendMessage, getMessage, getSession, listLastNMessages, listMessages } from '../chat_db'
import {
  advanceSeenCursor,
  familyOf,
  getGroupMemberConfigs,
  getSeenCursor,
  groupUsage,
  insertGroupTurn
} from '../chat_db/groups'
import { maybeNotifyGroupReply } from '../notification_fanout'
import { broadcastChatEvent } from './persistenceGlue'
import { describeAgentSchedule } from './ttlResolvers'

/** g1 群编排 — `ai_chat_sessions.group_config_json` → GroupConfig。🔴 脏值/坏 JSON 一律回落
 *  `{ v: 1 }` = 全取出厂默认（地板默认值单源在 groupFloors.ts）：一行坏 JSON 不该让整个群停摆，
 *  而「取默认」永远是更严的那一侧（默认地板最紧）。 */
export function parseGroupConfig(raw: string | null): GroupConfig {
  if (typeof raw !== 'string' || raw.length === 0) return { v: 1 }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { v: 1 }
    return { ...(parsed as GroupConfig), v: 1 }
  } catch {
    return { v: 1 }
  }
}

/** g2 — 法官免卡锚是否失配：有法官位且 `sha256(members_json 原文 utf-8).hexdigest` ≠ 群设置里
 *  owner 确认法官位时写入的 judgeScopeHash。🔴 钉的是**原文**（等价重排也算变）—— 与 src/chat/db.py
 *  get_group_config / put_group_config 同口径（闸 tests/config/test_judge_scope_hash_parity.py），
 *  绝不从解析后的 members[] 重新序列化。无法官 → false。 */
export function computeJudgeScopeStale(
  rawMembersJson: string | null,
  config: { judgeAgentId?: string | null; judgeScopeHash?: string | null }
): boolean {
  if (config.judgeAgentId == null) return false
  const digest = createHash('sha256')
    .update(rawMembersJson ?? '', 'utf8')
    .digest('hex')
  return digest !== config.judgeScopeHash
}

/** 事项跟进在群里的职责参考（<duty>）。🔴 不用事项域的任务契约：那份写给「跟进一件事、调提案
 *  工具」的 run，群里的发言 turn 既没有事项锚点也没有提案工具，照搬会让它在群里假装在提案。 */
const MATTER_FOLLOWUP_GROUP_DUTY =
  '从事项推进的角度参与讨论：关注各件事的进展、卡点、风险和下一步，指出需要谁在什么时候做什么。' +
  '事项的状态只在事项页里经跟进提案审阅后变更，群里不直接改。'

/** T4 主 agent 入群 — 一个 members_json 成员 id → GroupSessionMember（导出供测试）。保留字
 *  `main` 没有 report_agent 行：title 取 owner_settings 的 assistant-identity.name（缺省 'AI'），
 *  duty 恒 null（SOUL/AGENT 已作 standingContext 恒注入，再塞进 <duty> 是重复注入 + 破坏可缓存
 *  前缀），model 恒 null（落到主 agent 默认模型，群级 modelOverride 仍优先）。保留字
 *  `matter_followup`（事项跟进）同样没有行：名字固定、职责用群专用的一段、模型取事项域的全局
 *  跟进默认。其余 id 走 report_agent 行。
 *  🔴 永不 throw、永不丢成员：读失败只降级 title / duty / model —— 成员资格是 handleGroupChat
 *  校验 speakAsAgentId 的安全事实，不能依赖 serve-api 可用性（resolveSessionAgent 同一契约）。 */
export async function resolveGroupMember(
  agentId: string,
  read: {
    reportAgent: (agentId: string) => Promise<ReportAgentConfig | null>
    assistantIdentity: () => Promise<AssistantIdentity | null>
    matterAgentDefaults: () => Promise<{ model?: string } | null>
  }
): Promise<GroupSessionMember> {
  if (agentId === MAIN_AGENT_MEMBER_ID) {
    let name: string | null = null
    try {
      name = (await read.assistantIdentity())?.name ?? null
    } catch (err) {
      console.warn('[ai-gateway] assistant identity fetch failed (main agent member degrades)', err)
    }
    return { agentId, title: name?.trim() || 'AI', duty: null, model: null }
  }
  if (agentId === MATTER_FOLLOWUP_MEMBER_ID) {
    let model: string | null = null
    try {
      model = (await read.matterAgentDefaults())?.model?.trim() || null
    } catch (err) {
      console.warn(
        '[ai-gateway] matter agent defaults fetch failed (follow-up member degrades)',
        err
      )
    }
    return {
      agentId,
      title: MATTER_FOLLOWUP_MEMBER_TITLE,
      duty: MATTER_FOLLOWUP_GROUP_DUTY,
      model
    }
  }
  try {
    const agent = await read.reportAgent(agentId)
    return {
      agentId,
      title: agent?.title?.trim() || agentId,
      duty: agent?.prompt?.trim() || null,
      model: agent?.model?.trim() || null
    }
  } catch (err) {
    console.warn('[ai-gateway] group member config fetch failed (degrades)', agentId, err)
    return { agentId, title: agentId, duty: null, model: null }
  }
}

/** g1 群编排 — 一条群消息的 `metadata.via`：'main_agent'（主助理投递进群的行）、g2 的
 *  'judge_post'（法官跨群投递的链根行，调度器据此定 trigger_kind），其余一律 null。
 *  🔴 装配侧据此标 `[主助理]`，**不用** speaker_agent_id 哨兵（那会污染成员命名空间）。 */
export function readMessageVia(metadata: string | null): 'main_agent' | 'judge_post' | null {
  if (typeof metadata !== 'string' || metadata.length === 0) return null
  try {
    const parsed = JSON.parse(metadata) as { via?: unknown }
    if (parsed?.via === 'main_agent') return 'main_agent'
    if (parsed?.via === 'judge_post') return 'judge_post'
    return null
  } catch {
    return null
  }
}

/** g2 — 本会话最近一条 role='user' 行的正文（主 agent 版 group_post / group_create 的
 *  user_requested 核验只读这一份服务端事实，绝不读请求 body）。近 30 行里没有人类消息 → null
 *  → 工厂退 ask。 */
export function lastHumanMessageText(sessionId: number): string | null {
  const last = listLastNMessages(sessionId, 30)
    .filter((row) => row.role === 'user')
    .at(-1)
  return last?.content ?? null
}

export type GroupGatewayConfigHooks = Pick<
  AiGatewayConfig,
  | 'resolveSessionAgent'
  | 'resolveGroupSession'
  | 'listGroupHistory'
  | 'appendGroupMessage'
  | 'resolveLabsFlags'
  | 'getSeenCursor'
  | 'advanceSeenCursor'
  | 'insertGroupTurn'
  | 'groupUsage'
  | 'lastHumanMessageText'
  | 'buildGroupSpeakerTools'
  | 'mirrorGroupRunLog'
>

export interface GroupGatewayHooks {
  configHooks: GroupGatewayConfigHooks
  groupToolHooks: GroupToolHooks
}

export function buildGroupGatewayHooks(deps: {
  domain: MailAgentDomainClient
  approvalGuard: ApprovalGuard
  a2uiEnabled: boolean
  groupMemberReads: {
    reportAgent: (agentId: string) => Promise<ReportAgentConfig | null>
    assistantIdentity: () => Promise<AssistantIdentity | null>
    matterAgentDefaults: () => Promise<{ model?: string } | null>
  }
  resolveLabsFlags: () => Promise<LabsFlags>
  isGroupForeground: (groupId: number, threadId: number | null) => boolean
  getDeliverGroupMessage: () => AiGatewayConfig['deliverGroupMessage']
}): GroupGatewayHooks {
  const gatewayHooks: GroupGatewayConfigHooks = {
    // P4b (task 08-27) — TEAM session identity by sessionId reverse lookup (S2 W0: never from
    // the body). Only origin='team' rows resolve; NULL/'agent'/'im' → null → byte-identical run.
    // 🔴 Contract (config.ts): when the row says 'team' + agent_id, the identity is returned even
    // if the report_agent config fetch fails (weakened fields) — the custom_agent_call recursion
    // guard must not depend on serve-api availability.
    resolveSessionAgent: async (sessionId) => {
      const session = getSession(sessionId)
      if (!session || session.origin !== 'team') return null
      const agentId = session.agent_id
      if (typeof agentId !== 'string' || agentId.length === 0) return null
      try {
        const agent = await deps.domain.getReportAgent(agentId)
        if (agent) {
          return {
            agentId,
            agentTitle: agent.title?.trim() || agentId,
            duty: agent.prompt?.trim() || null,
            model: agent.model?.trim() || null,
            scheduleLine: describeAgentSchedule(agent)
          }
        }
      } catch (err) {
        console.warn('[ai-gateway] team agent config fetch failed (identity degrades)', err)
      }
      return { agentId, agentTitle: agentId, duty: null, model: null, scheduleLine: null }
    },
    // v30（群聊）— GROUP session facts by sessionId reverse lookup (origin='group' rows only;
    // everything else → null → /api/ai/group-chat answers E_NOT_GROUP). Per-member config fetch
    // is best-effort (a failure degrades title/duty/model to id/null) but 🔴 NEVER drops the
    // member: membership is the security fact handleGroupChat validates speakAsAgentId against,
    // and it must not depend on serve-api availability (resolveSessionAgent's contract, same
    // rationale).
    resolveGroupSession: async (sessionId) => {
      const session = getSession(sessionId)
      if (!session || session.origin !== 'group') return null
      const memberIds = parseGroupMemberIds(session.members_json ?? null)
      const members: GroupSessionMember[] = []
      for (const memberId of memberIds) {
        members.push(await resolveGroupMember(memberId, deps.groupMemberReads))
      }
      // g1 (v31) — 群设置 / 每成员响应模式 / family 一并解析。🔴 每次 onGroupMessage 重读、
      // 不缓存：这就是「owner 改完设置对下一条消息生效」的结构性保证（AC1），不靠缓存失效。
      const family = familyOf(sessionId)
      const modes: Record<string, GroupResponseMode> = {}
      for (const row of getGroupMemberConfigs(sessionId)) {
        // 只收还在名单里的成员（成员被移出群后残留的设置行不该影响候选集）。
        if (memberIds.includes(row.agentId)) modes[row.agentId] = row.responseMode
      }
      const config = parseGroupConfig(session.group_config_json ?? null)
      // T3（v32）— 话题事实。判据恒是 invoked_by（话题与子群同是 origin='group' + 父群非空）。
      // 根消息的说话人从 messages 表现查：它是参与者集合的种子（对着谁的话开的话题，那位默认
      // 在场），人发的根消息 → null。根消息已被删（清空历史）→ getMessage 返 null → 同样退化成
      // null，话题照常能开，只是少一个默认参与者。
      const isThread = session.invoked_by === 'thread'
      const rootMessageId = session.thread_root_message_id ?? null
      const threadRootSpeakerAgentId =
        isThread && rootMessageId != null
          ? (getMessage(rootMessageId)?.speaker_agent_id ?? null)
          : null
      return {
        members,
        config,
        modes,
        parentSessionId: family.parentSessionId,
        childSessionIds: family.childSessionIds,
        threadSessionIds: family.threadSessionIds,
        isThread,
        threadRootSpeakerAgentId,
        judgeScopeStale: computeJudgeScopeStale(session.members_json ?? null, config)
      }
    },
    // v30（群聊）— the shared transcript, projected for server-side history assembly.
    // g1 (v31): 多带四项 —— 行 id（seen 游标 / 窗口边界）、chain_id（链归属）、metadata.via
    // （主助理投递的装配标签）、created_at。
    // T2: 再多一项 attachments —— 与 via 同读 metadata 这一列的两个读者，各取各的键、互不影响；
    // 没有附件的行恒 null（不是空数组），装配侧据此决定要不要前置围栏块。
    // P2-L13: libraryRefs 是同一列的第三个读者（键 library_refs，由 groupLibraryRefs.ts 单源）。
    listGroupHistory: (sessionId) =>
      listMessages(sessionId).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        speakerAgentId: row.speaker_agent_id ?? null,
        status: row.status,
        chainId: row.chain_id ?? null,
        via: readMessageVia(row.metadata ?? null),
        attachments: parseAttachmentsMetadata(row.metadata ?? null),
        libraryRefs: parseLibraryRefsMetadata(row.metadata ?? null),
        createdAt: row.created_at
      })),
    // v30（群聊）— persist one group message (owner user message / member reply). appendMessage
    // bumps the session's updated_at, so the 群聊 list orders by fresh activity like every list.
    // g1 (v31): token / cost / chain_id / metadata 一并落库（AC6 成本可见 + 链上限地板的计数
    // 依据），写完广播 chat:turn-persisted 让 renderer 刷新（labs on 的群视图只 append + 订阅）。
    appendGroupMessage: (sessionId, message) => {
      const row = appendMessage({
        sessionId,
        role: message.role,
        content: message.content,
        status: 'complete',
        model: message.model ?? null,
        speakerAgentId: message.speakerAgentId ?? null,
        tokensInput: message.tokensInput ?? null,
        tokensOutput: message.tokensOutput ?? null,
        cacheReadTokens: message.cacheReadTokens ?? null,
        cacheWriteTokens: message.cacheWriteTokens ?? null,
        costUsd: message.costUsd ?? null,
        chainId: message.chainId ?? null,
        metadata: message.metadata ?? null
      })
      // 🔴 runId:null = 「无租约持久化」语义（headless run 同款，:374 那一处的注释）：renderer 的
      // settle 门不会因为对不上 runId 而丢弃它。group:true 让群视图只 invalidate 本群。
      try {
        broadcastChatEvent('chat:turn-persisted', {
          sessionId,
          status: 'finished',
          runId: null,
          group: true
        })
      } catch (err) {
        console.error('[ai-gateway] group turn-persisted broadcast failed (persist landed)', err)
      }
      // L4 群聊 UX 批 — 通知中心投影（判据与 dedupe 见 maybeNotifyGroupReply 头注）。labs on / off
      // 两条路径都经这里 → 同样生效。T3：话题行（invoked_by='thread'）由它自己按父群分支，
      // getSession 同时充当父群的读取器。
      maybeNotifyGroupReply(
        {
          sessionId,
          role: message.role,
          content: message.content,
          speakerAgentId: message.speakerAgentId ?? null,
          chainId: message.chainId ?? null
        },
        getSession,
        deps.isGroupForeground,
        async (agentId) => (await resolveGroupMember(agentId, deps.groupMemberReads)).title
      )
      return row.id
    },
    resolveLabsFlags: deps.resolveLabsFlags,
    getSeenCursor,
    advanceSeenCursor,
    insertGroupTurn: (row) => insertGroupTurn(row),
    groupUsage: (sessionIds, sinceMs) => groupUsage(sessionIds, sinceMs),
    lastHumanMessageText,
    // g2 — the group SPEAKER run's ToolSet (调度器 turns only; chatRun calls this instead of
    // buildTools for identity.group.groupSpeakerRun). labs off → undefined (a member turn keeps
    // the zero-tool posture; the judge factory is never even constructed — labs off must be
    // byte-identical to g1). Facts are re-read here (not trusted from the spec) so the judge's
    // judgeScopeStale is the current roster's. The judge result additionally passes the owner
    // 'deny' strip: an owner-denied group_post is invisible to the judge, not silently asked.
    buildGroupSpeakerTools: async (collector, spec) => {
      if (!(await deps.resolveLabsFlags()).groupAgents) return undefined
      const facts = (await resolveGroupSession(spec.sessionId)) ?? null
      if (!facts) return undefined
      if (!spec.isJudge) {
        return createGroupMemberTools(collector, groupToolHooks, {
          sessionId: spec.sessionId,
          libraryDomain: deps.domain
        })
      }
      const tools = createGroupJudgeTools(collector, deps.approvalGuard, groupToolHooks, {
        sessionId: spec.sessionId,
        judgeAgentId: spec.agentId,
        familySessionIds: spec.familySessionIds,
        judgeScopeStale: facts.judgeScopeStale,
        contextMode: 'manual_chat',
        toolApprovalPrefs: spec.toolApprovalPrefs?.tools,
        a2uiEnabled: deps.a2uiEnabled,
        libraryDomain: deps.domain
      })
      return stripOwnerDeniedTools(tools, spec.toolApprovalPrefs?.tools)
    },
    // g1 — spoke turn → 一行 agent_run_log（团队页执行记录可见，AC6）。🔴 best-effort：跨库无
    // 事务（run log 在 sync_store.db、群消息在 ai_chat.db），失败只 warn —— ai_chat_group_turn
    // 才是权威源。status 值域按 run_log.py（completed / failed / skipped / running，**无
    // stopped**），步骤只用 trig / out 两类。
    mirrorGroupRunLog: async (input: GroupRunLogMirror) => {
      // T4 — 主 agent 成员的 spoke turn 不镜像：团队页的主 Agent 没有记录档（teamMembers.ts
      // recordSource:'none'），写了也是一行没有入口的孤儿台账；ai_chat_group_turn 仍是权威源。
      // 事项跟进同理：它的记录档只列事项会话（recordSource:'matter'），不读 agent_run_log。
      if (input.agentId === MAIN_AGENT_MEMBER_ID || input.agentId === MATTER_FOLLOWUP_MEMBER_ID) {
        return
      }
      try {
        await deps.domain.postRunLog({
          agentId: input.agentId,
          startedAtMs: input.startedAtMs,
          completedAtMs: input.finishedAtMs,
          status: input.status,
          triggerKind: 'group_chat',
          triggerDetail: `session:${input.sessionId};chain:${input.chainId};run:${input.runId}`,
          summary: input.summary,
          model: input.model ?? null,
          inputTokens: input.tokensInput ?? null,
          outputTokens: input.tokensOutput ?? null,
          error: input.error ?? null,
          steps: [
            {
              kind: 'trig',
              name: '群聊唤醒',
              detail: `窗口 #${input.windowFromId ?? '-'}-#${input.windowToId ?? '-'}`
            },
            {
              kind: 'out',
              name: '发言',
              detail: input.messageId == null ? null : `message:${input.messageId}`,
              ok: input.status === 'completed'
            }
          ]
        })
      } catch (err) {
        console.warn('[ai-gateway] group run-log mirror failed (turn ledger is authoritative)', err)
      }
    }
  }

  const resolveGroupSession = gatewayHooks.resolveGroupSession!
  const listGroupHistory = gatewayHooks.listGroupHistory!
  const appendGroupMessage = gatewayHooks.appendGroupMessage!

  const groupToolHooks: GroupToolHooks = {
    resolveGroupSession: (sessionId) => resolveGroupSession(sessionId),
    listGroupHistory: (sessionId) => listGroupHistory(sessionId),
    appendGroupMessage: (sessionId, message) => appendGroupMessage(sessionId, message),
    groupUsage: (sessionIds, sinceMs) => groupUsage(sessionIds, sinceMs),
    deliverGroupMessage: () => deps.getDeliverGroupMessage(),
    getSessionTitle: (sessionId) => getSession(sessionId)?.title ?? null,
    lastHumanMessageText,
    createGroupSession: async (input) => {
      const created = await deps.domain.createGroupSession({
        title: input.title,
        groupMembers: input.memberAgentIds,
        parentSessionId: input.parentSessionId,
        invokedBy: input.invokedBy
      })
      return {
        sessionId: created.id,
        title: created.title ?? null,
        members: parseGroupMemberIds(created.members_json),
        parentSessionId: created.parent_session_id ?? input.parentSessionId
      }
    },
    setGroupConfig: (sessionId, patch) => deps.domain.setGroupConfig(sessionId, patch),
    deleteSession: (sessionId) => deps.domain.deleteSession(sessionId)
  }

  return {
    configHooks: gatewayHooks,
    groupToolHooks
  }
}
