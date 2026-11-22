// Extracted from ai_gateway_lifecycle.ts — connector manifest cache, approval resolution, system prompt & toolset construction.

import type { ToolSet } from 'ai'

import type { ApprovalRunStash } from '../../../ai-gateway/approvalStash'
import { extractApprovalStashInput } from '../../../ai-gateway/chatRun'
import type { AiGatewayConfig } from '../../../ai-gateway/config'
import type { ConnectorCatalogEntry } from '../../../ai-gateway/prompts/stable_prompt'
import {
  ProviderImageModelError,
  type ProviderModelResolver
} from '../../../ai-gateway/providerRef'
import type { MailAgentDomainClient } from '../../../ai-gateway/python/domainClient'
import type { ApprovalGuard } from '../../../ai-gateway/security/approval'
import type { GatewaySystemPromptConfig } from '../../../ai-gateway/systemPrompt'
import { buildGatewayTools } from '../../../ai-gateway/tools'
import { hasActiveComputerUseChildTools } from '../../../ai-gateway/tools/computer_use'
import {
  connectorCatalogForRun,
  connectorManifestSkipReason,
  createComputerUseChildConnectorTools,
  createConnectorManifestCache,
  createConnectorTools,
  fetchConnectorManifest,
  projectConnectorCatalog,
  shouldLoadConnectorTools
} from '../../../ai-gateway/tools/connector'
import type { GroupToolHooks } from '../../../ai-gateway/tools/groups'
import {
  isCustomAgentComputerUseEnabled,
  isMatterItemComputerUseEnabled
} from '../../../ai-gateway/tools/policy'
import { buildToolA2UIPayload } from '../../../shared/assistant/tools/a2ui'
import type { ComputerUseActivityState } from '../../../shared/computerUseOverlayContract'
import {
  appendMessage,
  createAgentSession,
  findSessionByParentToolCall,
  markToolCallApprovalExpired,
  setAgentSessionJobId
} from '../chat_db'
import { deriveExecRule, ExecRuleDeriveError } from '../exec_policy_matcher'
import { runBuildDiagnostics, runSubmitFeedback } from '../handlers/feedback'
import { getLocalApiToken } from '../local_token'
import { gatewayLogLine } from './persistenceGlue'
import { peekAdvertisedSkills, readImageGenModelRef } from './ttlResolvers'

export interface GatewayToolFlags {
  customAgentsEnabled: boolean
  customAgentCallEnabled: boolean
  internalAgentToolsEnabled: boolean
  serverResumeEnabled: boolean
  a2uiEnabled: boolean
  sendToolEnabled: boolean
  aguiMirrorEnabled: boolean
  skillGatingEnabled: boolean
  sessionToolsEnabled: boolean
  sessionProvenanceEnabled: boolean
  configToolsEnabled: boolean
  webToolsEnabled: boolean
  execToolsEnabled: boolean
  skillInstallToolsEnabled: boolean
  skillCreatorToolsEnabled: boolean
  calendarToolsEnabled: boolean
  notionAgentToolsEnabled: boolean
  mcpConnectorsEnabled: boolean
  imWebEnabled: boolean
  toolSearchEnabled: boolean
  computerUseEnabled: boolean
}

export type ApprovalAndToolConfigHooks = Pick<
  AiGatewayConfig,
  | 'resolveEditedApproval'
  | 'peekApprovalRecord'
  | 'rememberExecApproval'
  | 'rememberWebApproval'
  | 'aguiMirrorEnabled'
  | 'systemPromptProvider'
  | 'sessionProvenanceEnabled'
  | 'resolveApprovalRequest'
  | 'markApprovalExpired'
  | 'buildTools'
  | 'ensureConnectorManifest'
>

export function buildApprovalAndToolHooks(deps: {
  domain: MailAgentDomainClient
  generatedImagesDir: string
  approvalGuard: ApprovalGuard
  approvalStash?: ApprovalRunStash
  groupToolHooks: GroupToolHooks
  providerModelResolver?: ProviderModelResolver
  computerUseOverlay?: {
    reportActivity: (state: ComputerUseActivityState) => void
    registerAbort: (runId: string, abort: () => void) => () => void
  }
  getSystemPromptConfig: () => Promise<GatewaySystemPromptConfig | null>
  readPerBuildToolFlags: () => {
    kosTimeDecayEnabled: boolean
    planToolsEnabled: boolean
    writeToolsEnabled: boolean
  }
  flags: GatewayToolFlags
}): ApprovalAndToolConfigHooks {
  const { flags, approvalStash } = deps
  // PR3 — refresh RETURNS its in-flight promise (single-flight): cfg.ensureConnectorManifest below
  // AWAITS it so neither a one-shot headless run with connector grants nor an owner-present turn
  // (manual/im — 0804 主修, prepareChatRun awaits before buildTools) builds tools off a cold cache.
  const connectorManifest = createConnectorManifestCache(
    (opts) =>
      fetchConnectorManifest(deps.domain, {
        // D1 observability — the degradation warnings used to go console-only (invisible in a
        // packaged app); mirror them into the on-disk gateway log. 0805 dogfood — `quiet` (set by
        // the prewarm's middle retries, connector.ts) suppresses only the ON-DISK line; console.warn
        // still fires unconditionally (cheap, dev-only visibility) since it never accumulates on disk.
        onWarn: (message, err) => {
          console.warn(message, err)
          if (!opts?.quiet) {
            gatewayLogLine({ event: 'connector_manifest_warn', message, error: String(err) })
          }
        }
      }),
    gatewayLogLine
  )
  const refreshConnectorManifest = (): Promise<void> =>
    flags.mcpConnectorsEnabled ? connectorManifest.refresh() : Promise.resolve()
  // Prewarm (fire-and-forget — a slow serve-api must never block gateway startup) WITH bounded
  // retries: 0805 dogfood raised these from 2 to 5 attempts (~40s cumulative, see
  // CONNECTOR_MANIFEST_PREWARM_RETRIES_MS) after field logs showed serve-api's cold start ranging
  // 4-34s, not the ~1.2s the original 1s/3s schedule assumed.
  if (flags.mcpConnectorsEnabled) connectorManifest.prewarm()

  return {
    // Phase 04a — apply an edit-tier UI edit to a pending approval (the resolve side-channel).
    // applyEdit overlays the editable fields onto the original input (identity pinned) WITHOUT
    // touching the ai@6 history input, so the signed approval stays valid on replay. Throws an
    // ApprovalError (.code) on not-found / expired / not-editable → typed HTTP from server.ts.
    resolveEditedApproval: (toolCallId, editedFields) => {
      const rec = deps.approvalGuard.applyEdit(toolCallId, editedFields)
      return { approvalId: rec.approvalId, toolName: rec.toolName }
    },
    // L4 批次2 — the READ-ONLY half of the same seam: GET /api/ai/approval/pending surfaces the
    // EFFECTIVE input + the registered editableFields so the generic in-panel approval card can
    // render an editor for the 12 tools that registered editable fields (chat's 3 rich edit cards
    // stay as they are). peek never mutates / never consumes; nothing else of the record leaves.
    peekApprovalRecord: (toolCallId: string) => {
      const rec = deps.approvalGuard.peek(toolCallId)
      if (!rec) return null
      return { input: rec.editedInput ?? rec.input, editableFields: rec.editableFields ?? [] }
    },
    // S2 W1 — the exec approval card's "always allow" affordance (POST /api/ai/policy/remember).
    // Peek the pending exec approval (READ-ONLY — never mutates/consumes; the same approved
    // argv/cwd/path so the model cannot forge a broader rule), derive a full-PIN structured rule,
    // and persist it via the owner policy API with context_mode PINNED to manual_chat (a whitelist
    // is manual-only, ADR-001 §9). Only wired when exec tools are on → /remember 501s otherwise.
    // Throws an ExecRuleDeriveError/.code (non-exec tool / no record / fs error) → typed HTTP.
    rememberExecApproval:
      flags.execToolsEnabled || flags.computerUseEnabled
        ? async (toolCallId: string) => {
            const rec = deps.approvalGuard.peek(toolCallId)
            // E_APPROVAL_NOT_FOUND → server maps to 404 (the pending approval expired / wrong id).
            if (!rec) {
              throw new ExecRuleDeriveError(
                'E_APPROVAL_NOT_FOUND',
                'no pending approval to remember'
              )
            }
            const input = rec.editedInput ?? rec.input
            const { capability, matcher } = deriveExecRule(rec.toolName, input)
            const rule = await deps.domain.createPolicyRule({
              capability,
              matcher,
              contextMode: 'manual_chat',
              note: '审批卡「总是允许」'
            })
            return rule as unknown as Record<string, unknown>
          }
        : undefined,
    // S6 W3-3 (ADR-004 rev3.1 §4.2 D-fix-3) — the in-record web_fetch "always allow this domain" PIN.
    // Wired only when web tools + custom agents + the stash are on (else the { approvalId } shape 501s).
    // Peeks the STASHED headless approval by approvalId (read-only), enforces the agent-run-only
    // boundary (a manual web_fetch never lands in the stash — only headless runs stash — so a per-agent
    // rule can never derive from manual chat; the toolName + agentRunContext asserts are defence in
    // depth), extracts the approved URL, and creates a per-agent web origin rule with the agent id +
    // SERVER-derived contextMode (Python normalizes the origin on store — TS never self-normalizes).
    rememberWebApproval:
      flags.webToolsEnabled && flags.customAgentsEnabled && approvalStash
        ? async (approvalId: string) => {
            const entry = approvalStash.peekByApprovalId(approvalId)
            if (!entry) {
              throw new ExecRuleDeriveError(
                'E_APPROVAL_NOT_FOUND',
                'no pending approval to remember'
              )
            }
            const agentId = entry.agentRunContext?.agentId
            if (entry.toolName !== 'web_fetch' || agentId == null) {
              throw new ExecRuleDeriveError(
                'E_INVALID_ARG',
                'remember-web applies only to a headless web_fetch approval'
              )
            }
            const extracted = extractApprovalStashInput(entry.responseMessage)
            const url =
              extracted && extracted.input != null && typeof extracted.input === 'object'
                ? (extracted.input as { url?: unknown }).url
                : undefined
            if (typeof url !== 'string' || url.length === 0) {
              throw new ExecRuleDeriveError('E_INVALID_ARG', 'approved web_fetch has no url')
            }
            const rule = await deps.domain.createPolicyRule({
              capability: 'web',
              // origin = the approved URL verbatim; Python _normalize_origin canonicalizes on store.
              matcher: { v: 1, origin: url },
              agentId,
              note: '审批卡「总是允许该域名」'
            })
            return rule as unknown as Record<string, unknown>
          }
        : undefined,
    // Phase 05 — AG-UI mirror flag + its approval-request enricher. The enricher is READ-ONLY
    // (deps.approvalGuard.peek — never mutates / consumes) and only surfaces what a client needs to render
    // the interrupt card (risk / reason / expiry + optional A2UI). NO token / secret leaves main.
    aguiMirrorEnabled: flags.aguiMirrorEnabled,
    // S3 — the standing-context provider is always injected (CONTEXT_INJECTION GA'd away).
    // The provider never throws (returns null → context-light) so a /chat/config blip can't
    // break a turn.
    // D1 (connector dogfood batch) — merge the MCP connector catalog into the projection so the
    // system prompt can announce the mcp__* tools (root cause ①: zero prompt-level告知 → the
    // model "honestly" denied having them). Data source = the SAME connectorManifest cache the
    // ToolSet builds from (zero new loopback requests, zero new TTLs — buildTools' per-turn
    // refresh keeps it warm; since the 0804 fix prepareChatRun awaits the warm-up before BOTH
    // reads, prompt and ToolSet can no longer disagree about the catalog).
    // Cold cache / flag off / nothing admitted → field omitted → prompt
    // byte-identical to today. The catalog here is manual-shape; prepareChatRun scopes it per run
    // (headless: granted connectors only) via connectorCatalogForRun.
    systemPromptProvider: async () => {
      const value = await deps.getSystemPromptConfig()
      if (!flags.mcpConnectorsEnabled) return value
      const catalog = projectConnectorCatalog(connectorManifest.peek())
      if (!catalog) return value
      // /chat/config blip (value null) + a warm manifest → still surface the catalog: the
      // connector tools ARE registered on such a turn, so the context-light prompt should not
      // go connector-blind on top of losing standing context.
      return { ...(value ?? {}), connectorCatalog: catalog }
    },
    sessionProvenanceEnabled: flags.sessionProvenanceEnabled,
    resolveApprovalRequest: flags.aguiMirrorEnabled
      ? (info) => {
          const rec = deps.approvalGuard.peek(info.toolCallId)
          if (!rec) return null
          const input = rec.editedInput ?? rec.input
          const a2ui = flags.a2uiEnabled
            ? (buildToolA2UIPayload(rec.toolName, { args: input, risk: rec.risk }) ?? undefined)
            : undefined
          return {
            toolCallId: rec.toolCallId,
            toolName: rec.toolName,
            input,
            approval: {
              id: rec.approvalId,
              risk: rec.risk,
              reason: `${rec.toolName} needs your approval before it runs (${rec.risk}-tier).`,
              expiresAt: new Date(rec.expiresAt).toISOString()
            },
            ...(a2ui ? { a2ui } : {})
          }
        }
      : undefined,
    markApprovalExpired: (toolCallId: string) => markToolCallApprovalExpired(toolCallId),
    // Factory: the gateway builds the tools per request bound to a fresh audit collector
    // (closure). Read tools always; the approval-gated write tools under
    // MAILAGENT_AI_SDK_WRITE_TOOLS — S3: an env-only KILL-SWITCH, default literal true (the
    // cutover master it used to follow was GA'd away). `approvalMode` (PART 2) comes from the
    // request body (default 'always'); 'auto-reversible' lets reversible preview writes skip the
    // card. The blocking send always asks regardless (safety floor in auditedSendTool).
    buildTools: (
      collector,
      approvalMode,
      contextMode,
      agentRunContext,
      toolApprovalPrefs,
      parentSessionId,
      sessionAgentId,
      groupTools
    ) => {
      const perBuildFlags = deps.readPerBuildToolFlags()
      // Stage 1 PR2/PR3 — dynamic MCP connector tools. Two admitted shapes (shouldLoadConnectorTools):
      // manual_chat without an agentRunContext (PR2, unchanged), and a headless agent run whose
      // per-agent connector grants parse non-empty (PR3 — grant 外的 headless run performs ZERO
      // connector work, not "fetch then deny"). The ToolSet is built synchronously from the TTL
      // cache; a warm cache refreshes in the background (the NEXT turn sees manifest changes), and
      // EVERY admitted shape pre-warms it via cfg.ensureConnectorManifest before buildTools runs
      // (headless: agentRun.ts; owner-present manual/im: prepareChatRun — 0804 dogfood 主修), so
      // the read here is populated even on the first turn after a restart.
      let dynamicTools: ToolSet | undefined
      // D1 — the run-scoped catalog matching dynamicTools, threaded to discover_skills so the
      // self-description tool stops being connector-blind (dogfood root cause ②).
      let connectorCatalog: ConnectorCatalogEntry[] | null = null
      const connectorGrants = agentRunContext?.modeGrants?.connectors
      const connectorToolGrants = agentRunContext?.modeGrants?.connectorTools
      const disabledConnectors =
        contextMode === 'manual_chat' ? groupTools?.disabledConnectors : undefined
      if (
        shouldLoadConnectorTools(
          flags.mcpConnectorsEnabled,
          contextMode,
          agentRunContext != null,
          connectorGrants
        )
      ) {
        void refreshConnectorManifest()
        const manifest = connectorManifest.peek()
        const skipReason = connectorManifestSkipReason(manifest)
        if (skipReason !== null) {
          // 0804 dogfood — an admitted run that registers NOTHING used to fail silently (the log
          // only ever carried the success line), which is why「connector 不可用」took a whole
          // session to explain. One line per skipped run, with which of the two shapes it was.
          gatewayLogLine({
            event: 'connector_tools_skipped',
            mode: contextMode ?? null,
            reason: skipReason
          })
        } else if (manifest) {
          dynamicTools = createConnectorTools(
            deps.domain,
            collector,
            deps.approvalGuard,
            manifest,
            {
              a2uiEnabled: flags.a2uiEnabled,
              approvalMode,
              oneShot: flags.serverResumeEnabled,
              contextMode,
              // PR3 — headless only: the per-connector ceilings + the caller agent id (manual runs
              // carry no context → both absent → PR2 byte-identical).
              ...(agentRunContext != null
                ? {
                    connectorGrants,
                    ...(connectorToolGrants !== undefined ? { connectorToolGrants } : {}),
                    agentId: agentRunContext.agentId
                  }
                : {}),
              ...(disabledConnectors && disabledConnectors.length > 0 ? { disabledConnectors } : {})
            }
          )
          // Same single filter source as the prompt path: projection + per-run narrowing.
          connectorCatalog = connectorCatalogForRun(
            projectConnectorCatalog(manifest),
            contextMode,
            agentRunContext != null,
            connectorGrants,
            { connectorToolGrants, disabledConnectors }
          )
          // D1 observability — registered-count line per connector-bearing run (on-disk log).
          gatewayLogLine({
            event: 'connector_tools_registered',
            mode: contextMode ?? null,
            tools: Object.keys(dynamicTools).length,
            connectors: connectorCatalog?.length ?? 0
          })
        }
      }
      // WS-5 — private child connector tools for explicit `propose_only` `matter_item_run`
      // (`browser_use` / `desktop_use` ONLY, NEVER exposed to `dynamicTools` or the outer ToolSet).
      let matterComputerUseChildTools: ToolSet | undefined
      const matterCuPolicy =
        flags.computerUseEnabled &&
        contextMode === 'matter_followup' &&
        isMatterItemComputerUseEnabled(agentRunContext?.modeGrants)
          ? agentRunContext!.modeGrants!.matterItemComputerUse
          : undefined
      if (flags.mcpConnectorsEnabled && matterCuPolicy) {
        void refreshConnectorManifest()
        const manifest = connectorManifest.peek()
        if (connectorManifestSkipReason(manifest) === null && manifest) {
          matterComputerUseChildTools = createComputerUseChildConnectorTools(
            deps.domain,
            collector,
            manifest,
            {
              contextMode: 'matter_followup',
              connectors: matterCuPolicy.connectors,
              agentId: agentRunContext?.agentId,
              jobId: matterCuPolicy.jobId ?? agentRunContext?.jobId,
              dispatchId: matterCuPolicy.dispatchId
            }
          )
        }
      }
      // Wave 6 — private child connector tools for Custom Agents granted bounded `grant_computer_use`
      let customAgentComputerUseChildTools: ToolSet | undefined
      const cuHeadlessMode: 'untrusted_trigger' | 'cron_headless' | undefined =
        contextMode === 'untrusted_trigger' || contextMode === 'cron_headless'
          ? contextMode
          : undefined
      const customAgentCuPolicy =
        flags.computerUseEnabled &&
        cuHeadlessMode != null &&
        isCustomAgentComputerUseEnabled(agentRunContext?.modeGrants)
          ? agentRunContext!.modeGrants!.customAgentComputerUse
          : undefined
      if (
        flags.mcpConnectorsEnabled &&
        cuHeadlessMode != null &&
        customAgentCuPolicy &&
        agentRunContext?.agentId
      ) {
        void refreshConnectorManifest()
        const manifest = connectorManifest.peek()
        if (connectorManifestSkipReason(manifest) === null && manifest) {
          customAgentComputerUseChildTools = createComputerUseChildConnectorTools(
            deps.domain,
            collector,
            manifest,
            {
              contextMode: cuHeadlessMode,
              connectors: customAgentCuPolicy.connectors,
              agentId: agentRunContext.agentId,
              jobId: customAgentCuPolicy.jobId ?? agentRunContext.jobId,
              allowDestructive: customAgentCuPolicy.submitMode === 'allow_submit'
            }
          )
        }
      }
      const manualComputerUseActive =
        flags.computerUseEnabled &&
        contextMode === 'manual_chat' &&
        hasActiveComputerUseChildTools(dynamicTools)
      const matterComputerUseActive =
        Boolean(matterCuPolicy) &&
        matterComputerUseChildTools != null &&
        Object.keys(matterComputerUseChildTools).length > 0
      const customAgentComputerUseActive =
        Boolean(customAgentCuPolicy) &&
        customAgentComputerUseChildTools != null &&
        Object.keys(customAgentComputerUseChildTools).length > 0
      return buildGatewayTools(
        {
          domain: deps.domain,
          kosTimeDecayEnabled: perBuildFlags.kosTimeDecayEnabled,
          // P0 — default ON fixes the prompt/tool mismatch; this main-process-only flag is an
          // emergency rollback switch and is intentionally not exposed through a Vite define.
          planToolsEnabled: perBuildFlags.planToolsEnabled,
          toolSearchEnabled: flags.toolSearchEnabled,
          sessionProvenanceEnabled: flags.sessionProvenanceEnabled,
          writeToolsEnabled: perBuildFlags.writeToolsEnabled,
          approvalGuard: deps.approvalGuard,
          a2uiEnabled: flags.a2uiEnabled,
          // Phase 04b — the send tool needs the approval guard (write tools) + the signing secret
          // (local API token). Both already constructed above; off by default.
          sendToolEnabled: flags.sendToolEnabled,
          sendSigningSecret: getLocalApiToken(),
          // PART 2 — auto-approval mode from the request body (default 'always' when absent).
          approvalMode,
          // 08-05 WP-11 — the per-tool approval tiers + send whitelist prepareChatRun resolved
          // for THIS run (manual only; the headless wrapper's 3-arg signature never forwards
          // the 5th slot, and buildGatewayTools additionally drops it for non-manual modes).
          toolApprovalPrefs,
          // S2 W0 (ADR-001 D1) — the run's trusted context mode from prepareChatRun (never the
          // body). Absent → buildGatewayTools fail-closes to 'untrusted_trigger'.
          contextMode,
          // M4a — skill→tool gating (MAILAGENT_SKILL_SELF_MOUNT). advertisedSkills from the TTL-cached
          // /chat/config projection; the systemPromptProvider (always injected post-S3) re-fetches it
          // per-request → a Settings skill toggle takes effect within the 15s TTL. null (cache empty /
          // Python hiccup) → fails open. SELF_MOUNT off → applySkillGating never called → ToolSet
          // byte-identical.
          skillGatingEnabled: flags.skillGatingEnabled,
          advertisedSkills: peekAdvertisedSkills(),
          // Part B / 07-15 — one-shot preview/edit writes whenever server-side resume is live
          // (always since the owner拍板): an in-panel/island-resumed approval and a renderer-resumed
          // approval must never double-execute, independent of the island flag.
          oneShotWrites: flags.serverResumeEnabled,
          // S1 R1 — chat-session read tools (MAILAGENT_OPENNESS_SESSION_TOOLS, default off).
          sessionToolsEnabled: flags.sessionToolsEnabled,
          // S1 R2 — profile-config tools (MAILAGENT_OPENNESS_CONFIG_TOOLS, default off).
          configToolsEnabled: flags.configToolsEnabled,
          // S1 R3 — web tools (MAILAGENT_OPENNESS_WEB_TOOLS, default off).
          webToolsEnabled: flags.webToolsEnabled,
          // Stage 2 PR-1 — the im web venue switch (MAILAGENT_IM_WEB_ENABLED, Q19=A; NOT a
          // grant). Only the im_chat matrix branch consults it — non-im runs byte-identical.
          imWebEnabled: flags.imWebEnabled,
          // S2 W1 — exec tools (MAILAGENT_OPENNESS_EXEC_TOOLS, default off).
          execToolsEnabled: flags.execToolsEnabled,
          // S2 W4 — skill-supply tools (MAILAGENT_OPENNESS_SKILL_INSTALL, default off).
          skillInstallToolsEnabled: flags.skillInstallToolsEnabled,
          skillCreatorToolsEnabled: flags.skillCreatorToolsEnabled,
          // calendar epic 4.1/4.2 — calendar tools (MAILAGENT_CALENDAR_AGENT_TOOLS, default on).
          calendarToolsEnabled: flags.calendarToolsEnabled,
          // task 07-21 — notion-agent tool (MAILAGENT_NOTION_AGENT_TOOL, default on; skill-gated).
          notionAgentToolsEnabled: flags.notionAgentToolsEnabled,
          // task 08-27 P4a — submit_feedback 的提交实现。诊断包在**批准之后**才组装（弹卡时
          // 不该先花掉），截图恒无（agent 截不了图）。
          // 🔴 这条路跳过 `PRAGMA quick_check`：3.2G 的 sync_store 上实测 70s+，对话里这段时间
          // 模型什么都不吐、看起来就是卡死。设置页的「导出诊断包」是人主动等的，仍跑 quick_check。
          submitFeedback: async (input) => {
            let diagnosticsPath: string | undefined
            if (input.attach_diagnostics === true) {
              const diag = await runBuildDiagnostics({ quickCheck: false })
              diagnosticsPath = diag.path
            }
            return runSubmitFeedback({
              kind: input.kind,
              title: input.title,
              detail: input.detail,
              freq: input.freq,
              email: input.email,
              diagnosticsPath,
              viaAgent: true
            })
          },
          // S5 W3 — conversational custom-agent CRUD tools (MAILAGENT_CUSTOM_AGENTS_ENABLED, the same
          // flag that gates the S4 headless kernel; default off → byte-identical to the S4 set).
          customAgentToolsEnabled: flags.customAgentsEnabled,
          // task 08-14 — 内建 agent 只读面（默认开）。与上一行是两件事：那个管「自建 agent」，
          // 这个管「内建 agent」——零 custom 行的库里前者恒返回空列表。
          internalAgentToolsEnabled: flags.internalAgentToolsEnabled,
          customAgentCallEnabled: flags.customAgentCallEnabled,
          parentSessionId,
          // P4b — the team-session recursion guard input (tools/index.ts drops
          // custom_agent_call when non-null). Threaded verbatim from prepareChatRun's 7th slot.
          sessionAgentId,
          // g2 — the main-agent版 group tools' gate inputs from prepareChatRun's 8th slot
          // (labs on + not a group session), joined here with the hook bundle. The headless
          // wrapper's 3-arg signature structurally never forwards the slot → undefined → absent.
          groupTools: groupTools
            ? {
                enabled: groupTools.enabled,
                isGroupSession: groupTools.isGroupSession,
                hooks: deps.groupToolHooks,
                sessionId: parentSessionId ?? null
              }
            : undefined,
          // task 09-02 — generate_image deps. The model ref is hot-read from .env on every
          // assembly (Settings change → next turn); the resolver is the flag-on registry one
          // (flag off → typed E_IMAGE_MODEL_UNSUPPORTED, never a bare throw). The session id
          // scopes the on-disk folder + the chain-edit file_id namespace. Registered in manual
          // chat only through the outbound class row (tools/index.ts).
          imageGen: {
            modelRef: readImageGenModelRef(),
            resolveImageModel: (ref) =>
              deps.providerModelResolver?.resolveImageModel
                ? deps.providerModelResolver.resolveImageModel(ref)
                : Promise.reject(
                    new ProviderImageModelError(
                      'LLM provider registry is off — image models need MAILAGENT_LLM_PROVIDER_REGISTRY on'
                    )
                  ),
            generatedDir: deps.generatedImagesDir,
            sessionId: parentSessionId ?? null
          },
          findSessionByParentToolCall,
          createAgentCallSession: (input) =>
            createAgentSession({
              agentId: input.agentId,
              title: input.title,
              parentSessionId: input.parentSessionId,
              parentToolCallId: input.parentToolCallId,
              invokedBy: input.invokedBy
            }),
          setAgentSessionJobId,
          // S5 W4 (ADR-004) — the per-agent run context of a headless agent run, from
          // wrapCfgForAgentRun's buildTools wrapper (4th param). Manual runs pass undefined →
          // assembly byte-identical.
          agentRunContext,
          // Stage 1 PR2 — connector tools ride the stage-0b admitDynamicTools seam (after both
          // skill-gating passes, before the context-mode policy). undefined (flag off / headless /
          // empty cache) → identity pass-through, byte-identical.
          dynamicTools,
          // D1 — the matching run-scoped catalog (discover_skills External-connectors summary).
          connectorCatalog,
          // WS-4 + WS-5 — expose computer_use_run in manual_chat OR explicit propose_only
          // matter_item_run when bounded browser_use / desktop_use child tools are available.
          computerUse:
            manualComputerUseActive || matterComputerUseActive || customAgentComputerUseActive
              ? {
                  ...(matterComputerUseActive && matterCuPolicy
                    ? {
                        childTools: matterComputerUseChildTools,
                        forceStopBeforeSubmit: true,
                        matterItemPolicy: matterCuPolicy
                      }
                    : customAgentComputerUseActive && customAgentCuPolicy
                      ? {
                          childTools: customAgentComputerUseChildTools,
                          forceStopBeforeSubmit:
                            customAgentCuPolicy.submitMode === 'stop_before_submit',
                          customAgentPolicy: customAgentCuPolicy
                        }
                      : {}),
                  persistChildSummary: (childSid, summaryText) => {
                    try {
                      appendMessage({
                        sessionId: childSid,
                        role: 'assistant',
                        content: summaryText,
                        status: 'complete'
                      })
                    } catch (err) {
                      console.warn('[ai-gateway] computer_use child summary persist failed', err)
                    }
                  },
                  ...(deps.computerUseOverlay
                    ? {
                        onActivity: deps.computerUseOverlay.reportActivity,
                        registerAbort: deps.computerUseOverlay.registerAbort
                      }
                    : {})
                }
              : undefined
        },
        collector
      )
    },
    // Stage 1 PR3 — BOUNDED connector-manifest warm-up for a headless run with connector grants
    // (runHeadlessAgent awaits it before building tools; the fire-and-forget TTL cache alone would
    // let a one-shot cron run read an empty cold cache and silently miss its granted tools).
    // Single-flight + fresh-cache short-circuit inside refreshConnectorManifest; the fetch is
    // 3s-bounded per request and never throws. Flag off → unwired → zero work, byte-identical.
    ensureConnectorManifest: flags.mcpConnectorsEnabled
      ? () => refreshConnectorManifest()
      : undefined
  }
}
