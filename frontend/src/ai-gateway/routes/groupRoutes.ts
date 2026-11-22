// Group-chat append/speak handlers and GroupOrchestrator scheduler wiring.
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type AiGatewayConfig, type GroupSessionFacts, type SessionAgentIdentity } from '../config'
import { encodeAttachmentsMetadata, validateAttachmentsInput } from '../groupAttachments'
import { encodeLibraryRefsMetadata, readLibraryRefsInput } from '../groupLibraryRefs'
import { assembleGroupHistory, type GroupTranscriptRow } from '../groupChat'
import { isSilence } from '../groupFloors'
import {
  GroupOrchestrator,
  type GroupSpeakInput,
  type GroupSpeakResult
} from '../groupOrchestrator'
import { prepareChatRun } from '../chatRun'
import { corsHeadersFor, readJsonBody, writeJson, writeSse, SSE_HEADERS } from '../httpUtil'

/**
 * `POST /api/ai/group-chat` — L4 群聊 (CHAT_DB v30): custom-agent group-chat writes. Two modes,
 * both requiring the session to BE a group (cfg.resolveGroupSession non-null; anything else →
 * 400 E_NOT_GROUP — /api/ai/chat never consults these hooks, so a group sessionId posted THERE
 * keeps today's main-agent semantics and a `speakAsAgentId` in that body is simply never read):
 *
 *   • `{ sessionId, userText, attachments? }` — append the owner's user message (speaker NULL) →
 *     JSON. T2: `attachments`（renderer 已读出正文；图片 text=null）落 `metadata.attachments`，
 *     形状不合格 / 超过条数上限 → 400 E_INVALID_ARG（写侧不静默丢）。
 *   • `{ sessionId, speakAsAgentId, model? }` — ONE member's speaking turn. 🔴 Membership is
 *     validated HERE in server code against the server-resolved members_json (the body only picks
 *     among server facts — it can never mint an identity; non-member → 403 E_NOT_GROUP_MEMBER).
 *     The run reads the FULL persisted transcript server-side (cfg.listGroupHistory →
 *     assembleGroupHistory: own rows → assistant, everyone else → `[名字]`-prefixed user),
 *     carries the member's identity + group roster into prepareChatRun (group block replaces the
 *     team block; 🔴 ToolSet structurally EMPTY — chatRun's isGroupSpeakerRun guard), streams
 *     `{type:'text-delta'}` SSE frames, then persists the finished reply with speaker_agent_id
 *     and emits the terminal `{type:'done'}` frame. A failed / client-aborted run persists
 *     NOTHING (the frontend marks the bubble failed and moves to the next member — 成本护栏:
 *     the server has NO fan-out; one POST = at most one member reply, sequencing lives in the
 *     renderer loop, so an agent reply can never trigger another agent).
 *
 * Registered unconditionally; the three cfg hooks gate it (404 on hand-built harness cfgs).
 *
 * g1 (labs `groupAgents` on, 调度器 built) — the append branch answers FIRST, then hands the new
 * row to `groupScheduler.onGroupMessage` (the chain runs detached, never tied to `req`); the
 * speaker branch is refused 409 E_LABS_ORCHESTRATED (the two drivers are mutually exclusive).
 * labs off / 调度器 absent → both branches byte-identical to v30 (`orchestrated:false`).
 */
export async function handleGroupChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  groupScheduler: GroupOrchestrator | null
): Promise<void> {
  const { resolveGroupSession, listGroupHistory, appendGroupMessage } = cfg
  if (!resolveGroupSession || !listGroupHistory || !appendGroupMessage) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'group chat feature not wired' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (int) required' })
    return
  }
  let facts: GroupSessionFacts | null = null
  try {
    facts = (await resolveGroupSession(sessionId)) ?? null
  } catch (err) {
    console.warn('[ai-gateway] resolveGroupSession failed', err)
  }
  if (facts == null) {
    writeJson(res, 400, { error: 'E_NOT_GROUP', hint: 'session is not a group chat' })
    return
  }
  const speakAs =
    typeof body.speakAsAgentId === 'string' && body.speakAsAgentId.length > 0
      ? body.speakAsAgentId
      : null
  const userText =
    typeof body.userText === 'string' && body.userText.length > 0 ? body.userText : null
  const orchestrating = groupScheduler != null && (await labsGroupAgentsOn(cfg))

  // Retry mode — `{ sessionId, retry: { agentId, chainId } }`: re-enqueue one member on its chain
  // (调度器.requeue). Only meaningful under server-side orchestration; membership is checked
  // against server facts inside requeue; a stopped chain is never revived (409 E_RUN_STOPPED).
  // Not gated on「上一条是不是 failed」: the UI only offers the button on a failed row and a
  // double click is folded by enqueueCoalesced.
  const retry = body.retry
  if (retry != null && typeof retry === 'object' && !Array.isArray(retry)) {
    const r = retry as { agentId?: unknown; chainId?: unknown }
    const agentId = typeof r.agentId === 'string' && r.agentId.length > 0 ? r.agentId : null
    const chainId = typeof r.chainId === 'number' && Number.isInteger(r.chainId) ? r.chainId : null
    if (agentId == null || chainId == null) {
      writeJson(res, 400, {
        error: 'E_INVALID_ARG',
        hint: 'retry.agentId + retry.chainId required'
      })
      return
    }
    if (!orchestrating || groupScheduler == null) {
      writeJson(res, 409, {
        error: 'E_LABS_ORCHESTRATED',
        hint: 'retry needs server-side orchestration (labs.groupAgents on)'
      })
      return
    }
    const out = await groupScheduler.requeue(sessionId, agentId, chainId)
    if (out.error === 'E_NOT_GROUP_MEMBER') {
      writeJson(res, 403, {
        error: 'E_NOT_GROUP_MEMBER',
        hint: `agent ${agentId} is not a member of this group`
      })
      return
    }
    if (out.error === 'E_RUN_STOPPED') {
      writeJson(res, 409, { error: 'E_RUN_STOPPED', hint: 'this chain was stopped' })
      return
    }
    if (out.error != null) {
      writeJson(res, 400, { error: 'E_NOT_GROUP', hint: 'session is not a group chat' })
      return
    }
    writeJson(res, 200, { ok: true, queued: out.queued })
    return
  }

  // Append mode — the owner's message enters the shared transcript once, BEFORE any speaker run.
  if (speakAs == null) {
    if (userText == null) {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'speakAsAgentId or userText required' })
      return
    }
    // T2 群附件 — 形状 / 条数校验在这里（写侧不静默丢，见 validateAttachmentsInput 头注）；
    // 正文由 renderer 读出，服务端只搬运 + 截断，从不去读文件。
    const attachments = validateAttachmentsInput(body.attachments)
    if (!attachments.ok) {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: attachments.hint })
      return
    }
    // P2-L13 群 @ 资料 — 同一纪律：形状不合格整条 400。落进同一个 metadata 对象的另一个键，
    // 两个编码器都保留 base 的其余键，所以链起来即可（都空 → metadata 恒 null，行字节不变）。
    const libraryRefs = readLibraryRefsInput(body)
    if (!libraryRefs.ok) {
      writeJson(res, 400, { error: 'E_INVALID_ARG', hint: libraryRefs.hint })
      return
    }
    const metadata = encodeLibraryRefsMetadata(
      libraryRefs.items,
      encodeAttachmentsMetadata(attachments.items)
    )
    const messageId = appendGroupMessage(sessionId, {
      role: 'user',
      content: userText,
      speakerAgentId: null,
      // 🔴 无附件时**不传** metadata 键 —— 绝大多数消息走这条路径，它与改动前逐字节一致。
      ...(metadata != null ? { metadata } : {})
    })
    writeJson(res, 200, { ok: true, messageId, orchestrated: orchestrating })
    if (orchestrating) {
      const row: GroupTranscriptRow = {
        id: messageId,
        role: 'user',
        content: userText,
        speakerAgentId: null,
        status: 'complete',
        chainId: messageId,
        via: null,
        createdAt: Date.now(),
        // 这一行是刚落库那条的投影：带上附件 / 资料引用才与 listGroupHistory 之后读回来的形状一致。
        ...(attachments.items.length > 0 ? { attachments: attachments.items } : {}),
        ...(libraryRefs.items.length > 0 ? { libraryRefs: libraryRefs.items } : {})
      }
      groupScheduler.onGroupMessage(sessionId, row).catch((err: unknown) => {
        console.warn('[ai-gateway] group onGroupMessage failed', { sessionId, messageId, err })
      })
    }
    return
  }

  if (orchestrating) {
    writeJson(res, 409, {
      error: 'E_LABS_ORCHESTRATED',
      hint: 'group speaker turns are driven server-side while labs.groupAgents is on'
    })
    return
  }

  // Speaker mode — membership check against server facts (never the body).
  const member = facts.members.find((m) => m.agentId === speakAs)
  if (member == null) {
    writeJson(res, 403, {
      error: 'E_NOT_GROUP_MEMBER',
      hint: `agent ${speakAs} is not a member of this group`
    })
    return
  }
  const titleById = new Map(facts.members.map((m) => [m.agentId, m.title]))
  const messages = assembleGroupHistory(listGroupHistory(sessionId), speakAs, titleById)
  if (messages.length === 0) {
    writeJson(res, 400, {
      error: 'E_INVALID_ARG',
      hint: 'group history empty — append a user message first'
    })
    return
  }
  const identity: SessionAgentIdentity = {
    agentId: member.agentId,
    agentTitle: member.title,
    duty: member.duty ?? null,
    model: member.model ?? null,
    scheduleLine: null,
    group: {
      members: facts.members.map((m) => ({ agentId: m.agentId, title: m.title })),
      // T4 (design M7) — labs off 也是减重态 + 沉默契约：群里有其他 agent 的半可信输出，
      // memory.md / 技能名单 / connector 名单不该进这个 prompt，且两态的 prompt 面必须一致。
      // sessionId 有意不带 → chatRun 不调 buildGroupSpeakerTools，v30 的零工具姿态不变。
      groupSpeakerRun: true
    }
  }
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  // 🔴 sessionId deliberately NOT in the prepared body: the group writer persists via
  // appendGroupMessage below, never via makePersistOnFinish / eager user persist (those would
  // double-write the assembled per-speaker view into the shared transcript).
  const prepared = await prepareChatRun(
    {
      messages,
      ...(typeof body.model === 'string' && body.model.length > 0 ? { model: body.model } : {})
    },
    cfg,
    controller.signal,
    'manual_chat',
    identity
  )
  if (!prepared.ok) {
    writeJson(res, prepared.status, prepared.body)
    return
  }
  res.writeHead(200, { ...SSE_HEADERS, ...corsHeadersFor(req.headers.origin) })
  try {
    for await (const delta of prepared.run.result.textStream) {
      if (controller.signal.aborted) break
      writeSse(res, { type: 'text-delta', delta })
    }
    const text = await prepared.run.result.text
    if (!controller.signal.aborted) {
      // 沉默契约的 v30 半边：按契约回 [沉默] 的 turn 不落行（落了会被 renderer 下一次 refetch
      // 当成一条发言显示，还会喂进其他成员的历史）。done 帧 messageId=null，groupChatClient
      // 本就按 number 判型。
      const messageId = isSilence(text)
        ? null
        : appendGroupMessage(sessionId, {
            role: 'assistant',
            content: text,
            speakerAgentId: speakAs,
            model: prepared.run.modelId
          })
      writeSse(res, { type: 'done', messageId, content: text, speakerAgentId: speakAs })
    }
  } catch (err) {
    // Stream OR persist failure — the reply is not durable, say so (never a silent truncation;
    // the renderer marks the bubble failed and continues with the next member).
    const message = err instanceof Error ? err.message : String(err)
    console.error('[ai-gateway] /api/ai/group-chat failed', { message })
    if (!controller.signal.aborted) writeSse(res, { type: 'error', errorText: message })
  }
  res.end()
}

/** g1 — labs `groupAgents` as the endpoints see it: hook absent (harness / not wired) or any
 *  failure → off (fail-closed, the hook's own contract restated at the call site). */
async function labsGroupAgentsOn(cfg: AiGatewayConfig): Promise<boolean> {
  if (!cfg.resolveLabsFlags) return false
  try {
    return (await cfg.resolveLabsFlags()).groupAgents === true
  } catch {
    return false
  }
}

/** 流式 delta 事件的最小间隔（≤ 10 帧/秒，红线 5）；尾帧不受节流。 */
const GROUP_DELTA_THROTTLE_MS = 100

/** g1 — one 调度器 member turn = one prepareChatRun with the member's identity + the group roster
 *  (same seams as the v30 speaker branch above: member model middle priority, <current_group_chat>
 *  block, 🔴 zero tools by construction), plus `groupSpeakerRun:true` for the prompt 减重门 and
 *  the 沉默契约. The run's text + usage go back to the 调度器, which decides silent / held_dup /
 *  spoke and does the persisting — nothing here writes the transcript.
 *  UX 批 — the text is drained from `textStream` (accumulated, throttled to `input.onDelta`, tail
 *  frame always sent) so the renderer can show the reply growing; `GroupSpeakResult` is unchanged.
 *  🔴 `config.modelOverride` (全群统一模型) is read HERE and nowhere else. */
export async function speakAsGroupMember(
  cfg: AiGatewayConfig,
  input: GroupSpeakInput
): Promise<GroupSpeakResult> {
  const identity: SessionAgentIdentity = {
    agentId: input.member.agentId,
    agentTitle: input.member.title,
    duty: input.member.duty ?? null,
    model: input.facts.config.modelOverride ?? input.member.model ?? null,
    scheduleLine: null,
    group: {
      members: input.facts.members.map((m) => ({ agentId: m.agentId, title: m.title })),
      sessionId: input.sessionId,
      isJudge:
        input.facts.config.judgeAgentId != null &&
        input.facts.config.judgeAgentId === input.agentId,
      familySessionIds: input.facts.familySessionIds,
      groupSpeakerRun: true,
      topic: input.facts.config.topic ?? null
    }
  }
  const prepared = await prepareChatRun(
    { messages: input.messages },
    cfg,
    input.signal,
    'manual_chat',
    identity
  )
  if (!prepared.ok) throw new Error(`${prepared.body.error}: ${prepared.body.hint}`)
  let text = ''
  let lastSentAt = 0
  let lastSent: string | null = null
  for await (const delta of prepared.run.result.textStream) {
    text += delta
    if (!input.onDelta) continue
    const now = Date.now()
    if (now - lastSentAt >= GROUP_DELTA_THROTTLE_MS) {
      lastSentAt = now
      lastSent = text
      input.onDelta(text)
    }
  }
  // 尾帧：保证末字到达（节流可能吞掉最后一段）。
  if (input.onDelta && text.length > 0 && lastSent !== text) input.onDelta(text)
  const usage = await prepared.run.result.usage
  return {
    text,
    modelId: prepared.run.modelId,
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
      noCacheTokens: usage.inputTokenDetails?.noCacheTokens ?? null
    },
    protocol: prepared.run.protocol
  }
}

/** g1 — build the 调度器 from the cfg group hooks (all seven + activeRuns present), else null =
 *  orchestration impossible (endpoint stays v30 whatever labs says). Mirrors the CompactCoordinator
 *  construction point: cfg.groupScheduler (tests) wins over a fresh instance. */
export function buildGroupScheduler(cfg: AiGatewayConfig): GroupOrchestrator | null {
  if (cfg.groupScheduler) return cfg.groupScheduler
  const {
    resolveGroupSession,
    listGroupHistory,
    appendGroupMessage,
    getSeenCursor,
    advanceSeenCursor,
    insertGroupTurn,
    groupUsage,
    activeRuns
  } = cfg
  if (
    !resolveGroupSession ||
    !listGroupHistory ||
    !appendGroupMessage ||
    !getSeenCursor ||
    !advanceSeenCursor ||
    !insertGroupTurn ||
    !groupUsage ||
    !activeRuns
  ) {
    return null
  }
  return new GroupOrchestrator({
    deps: {
      resolveFacts: async (sessionId) => {
        const facts = (await resolveGroupSession(sessionId)) ?? null
        if (!facts) return null
        return {
          members: facts.members,
          modes: facts.modes,
          config: facts.config,
          familySessionIds: [
            sessionId,
            ...(facts.parentSessionId != null ? [facts.parentSessionId] : []),
            ...facts.childSessionIds
          ],
          // T3 — 话题事实：三项在 GroupSessionFacts 上可缺，这里归一（`?? []` / `=== true`）。
          threadSessionIds: facts.threadSessionIds ?? [],
          isThread: facts.isThread === true,
          threadRootSpeakerAgentId: facts.threadRootSpeakerAgentId ?? null
        }
      },
      listHistory: listGroupHistory,
      appendMessage: appendGroupMessage,
      getSeenCursor,
      advanceSeenCursor,
      insertTurn: insertGroupTurn,
      groupUsage,
      resolveLabs: async () => ({ groupAgents: await labsGroupAgentsOn(cfg) }),
      speak: (input) => speakAsGroupMember(cfg, input),
      registerRun: (sessionId, controller) => activeRuns.register(sessionId, controller),
      releaseRun: (sessionId, runId) => activeRuns.release(sessionId, runId),
      mirrorRunLog: cfg.mirrorGroupRunLog,
      emitEvent: cfg.onGroupTurnEvent,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }
  })
}
