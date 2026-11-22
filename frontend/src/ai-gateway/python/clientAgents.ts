// Skill supply/drafts, headless agent-runs, and custom-agent CRUD.
import { OpsDomainClient } from './clientOps'
import { DomainError } from './clientCore'
import type {
  DomainAgentCallEnqueueResult,
  DomainAgentRunDetail,
  DomainSkillFetchPreview,
  DomainSkillDraft,
  DomainSkillConfirmResult,
  DomainSkillUninstallResult,
  DomainSkillDocResult
} from './domainTypes'
import type {
  AgentRunListItem,
  AgentRunSpec,
  AgentRunToolOptions,
  ReportAgentConfig,
  ReportConfigPatch,
  ReportAgentCreateInput
} from '@shared/api/types'

export class AgentsDomainClient extends OpsDomainClient {
  // ── skill-supply primitives (S2 W4) — two-step install (fetch→quarantine→confirm re-hash),
  //    full-cleanup uninstall, and the SKILL.md read. All hit /agent/skills/* (owner API,
  //    verify_cf_access — the embedded gateway's local-token leg passes). The tools that call
  //    these are only registered when MAILAGENT_OPENNESS_SKILL_INSTALL is on; the three writes
  //    are gated by the gateway ApprovalGuard (edit-tier + class capability_change: always ask).

  /** skill_install (S2 W4) — stage one: download/import a skill package into quarantine.
   *  POST /agent/skills/fetch {sourceUrl?|localPath?} (exactly one). Returns the preview facts
   *  (quarantine id + real hashes + manifest summary + declared secret names + SKILL.md excerpt). */
  skillSupplyFetch(
    input: { sourceUrl?: string; localPath?: string; skillName?: string },
    signal?: AbortSignal
  ): Promise<DomainSkillFetchPreview> {
    const body: Record<string, unknown> = {}
    if (input.sourceUrl !== undefined) body.sourceUrl = input.sourceUrl
    if (input.localPath !== undefined) body.localPath = input.localPath
    if (input.skillName !== undefined) body.skillName = input.skillName
    return this._req<DomainSkillFetchPreview>('POST', '/agent/skills/fetch', { body, signal })
  }

  /** skill_install_confirm (S2 W4) — stage two: really install a quarantined package. POST
   *  /agent/skills/confirm {quarantineId, expectedPackageHash, expectedFiles?}. The server
   *  RE-HASHES the quarantine content against the expected values → 409 E_PACK_HASH_MISMATCH
   *  (→ DomainError) on any drift (TOCTOU guard — a forged hash only defeats the install). */
  skillSupplyConfirm(
    input: {
      quarantineId: string
      expectedPackageHash: string
      expectedFiles?: Record<string, string>
    },
    signal?: AbortSignal
  ): Promise<DomainSkillConfirmResult> {
    const body: Record<string, unknown> = {
      quarantineId: input.quarantineId,
      expectedPackageHash: input.expectedPackageHash
    }
    if (input.expectedFiles !== undefined) body.expectedFiles = input.expectedFiles
    return this._req<DomainSkillConfirmResult>('POST', '/agent/skills/confirm', { body, signal })
  }

  /** skill_uninstall (S2 W4) — full cleanup (row + on-disk dir + stored secrets). POST
   *  /agent/skills/uninstall {name} — NEVER the legacy row-only DELETE (stale-secret adoption). */
  skillSupplyUninstall(name: string, signal?: AbortSignal): Promise<DomainSkillUninstallResult> {
    return this._req<DomainSkillUninstallResult>('POST', '/agent/skills/uninstall', {
      body: { name },
      signal
    })
  }

  /** skill_read (S2 W4) — an installed skill's raw SKILL.md. GET /agent/skills/{name}/doc.
   *  The TOOL fences (UNTRUSTED_SKILL_DOC) + truncates before the model sees the content. */
  skillDocRead(name: string, signal?: AbortSignal): Promise<DomainSkillDocResult> {
    return this._req<DomainSkillDocResult>('GET', `/agent/skills/${encodeURIComponent(name)}/doc`, {
      signal
    })
  }

  /** skill_read_resource — list or inspect files bundled inside an installed skill safely. */
  skillResourceRead(
    input: {
      name: string
      path?: string
      search?: string
      jsonPath?: string
      offsetLine?: number
      maxLines?: number
      limit?: number
    },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>(
      'GET',
      `/agent/skills/${encodeURIComponent(input.name)}/resource`,
      {
        query: {
          path: input.path,
          search: input.search,
          json_path: input.jsonPath,
          offset_line: input.offsetLine,
          max_lines: input.maxLines,
          limit: input.limit
        },
        signal
      }
    )
  }

  skillDraftCreate(
    input: { name: string; manifest?: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<DomainSkillDraft> {
    return this._req<DomainSkillDraft>('POST', '/agent/skills/drafts', { body: input, signal })
  }

  skillDraftWriteFile(
    input: { draftId: string; path: string; content: string },
    signal?: AbortSignal
  ): Promise<{ path: string; bytes: number }> {
    return this._req('PUT', `/agent/skills/drafts/${encodeURIComponent(input.draftId)}/file`, {
      body: { path: input.path, content: input.content },
      signal
    })
  }

  skillDraftGet(draftId: string, signal?: AbortSignal): Promise<DomainSkillDraft> {
    return this._req('GET', `/agent/skills/drafts/${encodeURIComponent(draftId)}`, { signal })
  }

  skillDraftReadFile(
    draftId: string,
    path: string,
    signal?: AbortSignal
  ): Promise<{ path: string; content: string }> {
    return this._req('GET', `/agent/skills/drafts/${encodeURIComponent(draftId)}/file`, {
      query: { path },
      signal
    })
  }

  skillDraftValidate(
    draftId: string,
    signal?: AbortSignal
  ): Promise<{ draftId: string; validation: Record<string, unknown> }> {
    return this._req('POST', `/agent/skills/drafts/${encodeURIComponent(draftId)}/validate`, {
      body: {},
      signal
    })
  }

  skillDraftPublish(
    draftId: string,
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req('POST', `/agent/skills/drafts/${encodeURIComponent(draftId)}/publish`, {
      body: { enabled },
      signal
    })
  }

  skillDraftDiscard(draftId: string, signal?: AbortSignal): Promise<DomainSkillDraft> {
    return this._req('POST', `/agent/skills/drafts/${encodeURIComponent(draftId)}/discard`, {
      body: {},
      signal
    })
  }

  // ── agent-run primitives (S4 W3) — the headless custom-agent run's spec pull + approval回写. Both
  //    hit /agent-runs/* (owner surface, verify_local_token — the embedded gateway's local-token leg).
  //    Called ONLY by the lifecycle's fetchAgentRunSpec hook (gate) + onServerResumeSettled, and only
  //    when MAILAGENT_CUSTOM_AGENTS_ENABLED is on.

  /** fetchAgentRunSpec (S4 W3) — pull the authoritative agent-run spec by jobId + claimToken (D2
   *  one-shot CAS server-side). GET /agent-runs/{jobId}/spec with the X-Claim-Token header. E_SPEC_*
   *  envelope errors (403 forbidden / 404 not-found / 409 already-claimed / 409 agent-invalid)
   *  surface as DomainError (code + httpStatus) → the endpoint forwards them to the worker. */
  fetchAgentRunSpec(
    jobId: number,
    claimToken: string,
    signal?: AbortSignal
  ): Promise<AgentRunSpec> {
    return this._req<AgentRunSpec>('GET', `/agent-runs/${jobId}/spec`, {
      headers: { 'X-Claim-Token': claimToken },
      signal
    })
  }

  /** settleAgentApprovalState (S4 W3) — write a headless run's terminal approval decision after an
   *  island resume (D4, by-job-id). POST /agent-runs/{jobId}/approval-state {state}. Only migrates
   *  from pending; a non-pending job → DomainError E_APPROVAL_NOT_PENDING (409, best-effort — the
   *  caller ignores it). */
  settleAgentApprovalState(
    jobId: number,
    state: 'approved' | 'rejected',
    signal?: AbortSignal
  ): Promise<{ jobId: number; approvalState: string; idempotent: boolean }> {
    return this._req<{ jobId: number; approvalState: string; idempotent: boolean }>(
      'POST',
      `/agent-runs/${jobId}/approval-state`,
      { body: { state }, signal }
    )
  }

  enqueueAgentCall(
    body: {
      agent_id: string
      fire_key: string
      session_id: number
      invocation: Record<string, unknown>
    },
    signal?: AbortSignal
  ): Promise<DomainAgentCallEnqueueResult> {
    return this._req<DomainAgentCallEnqueueResult>('POST', '/agent-runs/call', { body, signal })
  }

  getAgentRun(jobId: number, signal?: AbortSignal): Promise<DomainAgentRunDetail> {
    return this._req<DomainAgentRunDetail>('GET', `/agent-runs/${jobId}`, { signal })
  }

  cancelAgentRun(
    jobId: number,
    signal?: AbortSignal
  ): Promise<{ cancelled: boolean; state?: string }> {
    return this._req<{ cancelled: boolean; state?: string }>(
      'POST',
      `/agent-runs/${jobId}/cancel`,
      { signal }
    )
  }

  // ── custom-agent CRUD primitives (S5 W3) — the conversational build/edit/run surface. All hit the
  //    SAME report-agent REST endpoints W1 opened for type='custom' (owner API, verify_cf_access —
  //    the embedded gateway's local-token leg passes). Deep validation (trigger/tool_policy/budget)
  //    is Python-authoritative (validate_agent_config_patch) — the client never re-validates. The
  //    tools that call these are only registered when MAILAGENT_CUSTOM_AGENTS_ENABLED is on.

  /** custom_agent_list — all agent configs (the tool filters to type='custom'). GET /report-agents. */
  listReportAgents(signal?: AbortSignal): Promise<ReportAgentConfig[]> {
    return this._req<ReportAgentConfig[]>('GET', '/report-agents', { signal })
  }

  /** Resolve the backend-owned default allowed-tools set when a legacy/null tool policy is edited
   *  through capability tiers. This prevents a partial tier patch from erasing untouched defaults. */
  getAgentRunToolOptions(signal?: AbortSignal): Promise<AgentRunToolOptions> {
    return this._req<AgentRunToolOptions>('GET', '/agent-runs/tool-options', { signal })
  }

  /** custom_agent_get — one agent config by id. GET /report-agents?agentId=. E_NOT_FOUND → null. */
  async getReportAgent(agentId: string, signal?: AbortSignal): Promise<ReportAgentConfig | null> {
    try {
      return await this._req<ReportAgentConfig>('GET', '/report-agents', {
        query: { agentId },
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** 事项域的全局跟进默认（model / effort / fallback_models）。GET /matters/agent-defaults。
   *  群聊里「事项跟进」成员的模型取这里的 model；没配过 → `{}`。 */
  async getMatterAgentDefaults(signal?: AbortSignal): Promise<{ model?: string } | null> {
    const data = await this._req<{ defaults?: { model?: string } | null }>(
      'GET',
      '/matters/agent-defaults',
      { signal }
    )
    return data.defaults ?? null
  }

  /** custom_agent_create — new agent row (type pinned to 'custom' by the tool). POST /report-agents.
   *  A duplicate id → DomainError E_CONFLICT (409); a bad trigger → E_INVALID_ARG (deep-validated
   *  server-side). The wire body carries only the friendly patch fields the tool assembled. */
  createReportAgent(
    input: ReportAgentCreateInput & ReportConfigPatch,
    signal?: AbortSignal
  ): Promise<ReportAgentConfig> {
    return this._req<ReportAgentConfig>('POST', '/report-agents', { body: input, signal })
  }

  /** custom_agent_update — partial patch of an existing agent. PUT /report-agents/{id}. Missing id →
   *  DomainError E_NOT_FOUND (404); a bad trigger → E_INVALID_ARG (server validate_agent_config_patch). */
  setReportAgentConfig(
    agentId: string,
    patch: ReportConfigPatch,
    signal?: AbortSignal
  ): Promise<ReportAgentConfig> {
    return this._req<ReportAgentConfig>('PUT', `/report-agents/${encodeURIComponent(agentId)}`, {
      body: patch,
      signal
    })
  }

  /** custom_agent_delete — delete an agent row. DELETE /report-agents/{id}. Missing → E_NOT_FOUND. */
  deleteReportAgent(agentId: string, signal?: AbortSignal): Promise<{ deleted: string }> {
    return this._req<{ deleted: string }>(
      'DELETE',
      `/report-agents/${encodeURIComponent(agentId)}`,
      { signal }
    )
  }

  /** custom_agent_run_now — enqueue one immediate run (custom → run_queue, S4 enqueue). POST
   *  /report-agents/{id}/run → {jobId, agentId, wasCreated}. A runs/day budget miss → DomainError
   *  E_BUDGET; a non-custom/report agent → E_INVALID_ARG. */
  runReportAgentNow(
    agentId: string,
    signal?: AbortSignal
  ): Promise<{ jobId: number; agentId: string; wasCreated: boolean }> {
    return this._req<{ jobId: number; agentId: string; wasCreated: boolean }>(
      'POST',
      `/report-agents/${encodeURIComponent(agentId)}/run`,
      { body: {}, signal }
    )
  }

  /** custom_agent_get run history — the agent's recent runs (read態唯一经 derive_agent_run_state
   *  server-side). GET /agent-runs?agentId=&limit=. The 8-value `state` is authoritative; the tool
   *  never re-derives it. */
  listAgentRuns(agentId: string, limit: number, signal?: AbortSignal): Promise<AgentRunListItem[]> {
    // 08-31 起这个聚合返两种台账行：async_jobs run（既有形状）与 agent_run_log
    // （`kind: 'run_log'`，时间是 ISO 字符串）。工具把整行交给模型，不解读字段。
    return this._req<AgentRunListItem[]>('GET', '/agent-runs', {
      query: { agentId, limit },
      signal
    })
  }
}
