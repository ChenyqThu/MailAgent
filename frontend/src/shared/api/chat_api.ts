// S3 (07-02) — ChatApi, the serve-api fetch face. This is the SURVIVING half of the
// legacy shared/chat/runtime.ts: the legacy engine half (dispatcher + HttpChatPlatform +
// harness loop + emitter + confirmTool + runSearchAgent) was deleted with the legacy
// runtime — chat turns run exclusively on the embedded AI SDK Gateway. What remains is a
// thin transport: every method is a direct fetch against serve-api (loopback on Electron,
// same-origin on the remote web), throwing Error&{code} or degrading gracefully as
// documented per method.
//
// Wiring (unchanged): web = HttpApi lazy getter constructs createChatRuntime({baseUrl});
// electron = ElectronApi constructs it against the loopback base and overrides openPopout
// with the window:openChatPopout IPC. Components only ever see useMailApi().chat.
//
// 🔴 不变式：零 Electron import（pnpm build:web 验）。只引 shared/api。

import { request } from './http_client'
import type {
  AgentProfileDoc,
  AgentPluginImportResult,
  AgentProfileHistoryEntry,
  ChatAnchorType,
  ChatApi,
  ChatBackendKind,
  ChatMessage,
  ChatSession,
  ChatSessionListItem,
  ChatToolCall,
  CompileUserMdResult,
  CreatePolicyRuleInput,
  ExecPolicyRule,
  GlobalApprovalMode,
  KosDoctorCheck,
  ListAllSessionsOptions,
  SkillConfirmResult,
  SkillEntrypoints,
  SkillPackPreview,
  SkillSecretMeta,
  SkillSummary,
  SkillDraftSummary,
  SkillTrustRule,
  SkillUninstallResult,
  ToolApprovalPrefsPayload,
  ToolApprovalTierValue
} from './types'

export interface ChatRuntimeDeps {
  /** persist / kos / chat 读 fetch 基址（同 HttpApi baseUrl）。 */
  baseUrl: string
}

export function createChatRuntime(deps: ChatRuntimeDeps): ChatApi {
  const { baseUrl } = deps

  return {
    async newSession(input: {
      anchorType?: ChatAnchorType
      emailId?: number | null
      matterId?: number
      backendKind: ChatBackendKind
      backendModel?: string | null
      backendAgentPageId?: string | null
    }): Promise<ChatSession> {
      // POST /chat/sessions/new（单一真源；ai-sdk 的 onEnsureSession 会话创建走这里）。
      // throw Error&{code} 由 request() 透传（E_INVALID_ARG / E_DISPATCH）。
      // email 路径**逐字节零回归**：不带 anchorType（serve-api 默认 'email'）；'general'
      // 显式带 anchorType:'general' + emailId:null；'matter' 显式带 matterId 且绝不带 emailId。
      // serve-api _validate_session_opts 逐分支校验，createNewSession 始终无条件 INSERT。
      const base = {
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null
      }
      const body =
        input.anchorType === 'general'
          ? { anchorType: 'general', emailId: null, ...base }
          : input.anchorType === 'matter'
            ? { anchorType: 'matter', matterId: input.matterId, ...base }
          : { emailId: input.emailId ?? null, ...base }
      return request<ChatSession>(baseUrl, 'POST', '/chat/sessions/new', { body })
    },

    async saveToKos(input: {
      messageId: number
      slug?: string
      title?: string
    }): Promise<{ slug: string; status: string; contentBytes: number }> {
      // POST /chat/save-to-kos。throw Error&{code} 由 request() 透传
      // （E_NOT_FOUND / E_INVALID_ARG / E_KOS_*），renderer toast 兜底。
      return request(baseUrl, 'POST', '/chat/save-to-kos', { body: input })
    },

    async deleteSession(sessionId: number): Promise<void> {
      // DELETE /chat/sessions/{id}（其消息 + 工具调用经 FK CASCADE 连带删）。Awaited (P2-4,
      // was fire-and-forget) so useEmailChat.deleteSession can catch a failure to toast +
      // re-fetch sessions and undo its optimistic row removal. Callers that don't need
      // rollback attach their own `.catch` (see useGeneralChat.deleteSession).
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      await request(baseUrl, 'DELETE', `/chat/sessions/${sessionId}`)
    },

    async updateSessionTitle(sessionId: number, title: string): Promise<void> {
      // Phase 10 rename → PATCH /chat/sessions/{id}/title (serve-api → src/chat/db.py; no updated_at
      // bump → no reorder). Awaited so the caller can invalidate the history query after it lands.
      // Throws Error&{code} on failure (caller toasts / leaves the optimistic value).
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/title`, { body: { title } })
    },

    async updateSessionModel(sessionId: number, model: string | null): Promise<void> {
      // W8 (task 08-04) per-session 模型偏好 → PATCH /chat/sessions/{id}/model
      // (serve-api → src/chat/db.py update_session_model；不 bump updated_at → 不重排历史)。
      // Best-effort: NEVER throws —— 换模型这一下的**主效果**是本地 state 立刻生效，落库只是
      // 让下次重开这个会话还记得；serve-api 抖一下不该弹错误打断对话。
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      try {
        await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/model`, { body: { model } })
      } catch {
        /* best-effort */
      }
    },

    async updateSessionArchived(sessionId: number, archived: boolean): Promise<void> {
      // dogfood-2 — soft-delete: PATCH /chat/sessions/{id}/archived (serve-api → src/chat/db.py;
      // no updated_at bump → no reorder). Awaited so the caller can refresh the history list.
      // Throws Error&{code} on failure (caller toasts / leaves the optimistic value).
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/archived`, {
        body: { archived }
      })
    },

    async updateSessionPinned(sessionId: number, pinned: boolean): Promise<void> {
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/pinned`, {
        body: { pinned }
      })
    },

    async updateSessionStarred(sessionId: number, starred: boolean): Promise<void> {
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/starred`, {
        body: { starred }
      })
    },

    async markSessionRead(sessionId: number): Promise<void> {
      // harness-chat lane A B4 — read watermark: PATCH /chat/sessions/{id}/read (serve-api →
      // src/chat/db.py update_session_last_read; no updated_at bump → no reorder). Best-effort:
      // NEVER throws — an unreachable serve-api / pre-v20 DB just leaves the badge until the next
      // successful mark.
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      try {
        await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/read`, { body: {} })
      } catch {
        /* best-effort */
      }
    },

    openPopout(_emailId: number): void {
      // Electron BrowserWindow 能力（开独立 chat 窗口）—— shared runtime 无第二窗口（web 无此
      // 场景）→ no-op。electron 由 ElectronApi override 注入真实 window:openChatPopout IPC。
    },

    // ── 读（直接 fetch baseUrl/chat/*，graceful 返 []/false）──────────
    async listMessages(sessionId: number): Promise<ChatMessage[]> {
      try {
        return await request<ChatMessage[]>(baseUrl, 'GET', `/chat/sessions/${sessionId}/messages`)
      } catch {
        return []
      }
    },

    async listSessions(emailId: number): Promise<ChatSession[]> {
      try {
        return await request<ChatSession[]>(baseUrl, 'GET', '/chat/sessions', {
          query: { emailId }
        })
      } catch {
        return []
      }
    },

    async getSession(sessionId: number): Promise<ChatSession | null> {
      if (!Number.isInteger(sessionId) || sessionId < 0) return null
      try {
        return await request<ChatSession | null>(baseUrl, 'GET', `/chat/sessions/${sessionId}`)
      } catch {
        return null
      }
    },

    async listAllSessions(options: ListAllSessionsOptions = {}): Promise<ChatSessionListItem[]> {
      try {
        const includeArchived = options.includeArchived ?? false
        const origin = options.origin ?? 'interactive'
        return await request<ChatSessionListItem[]>(baseUrl, 'GET', '/chat/sessions/all', {
          query: {
            ...(includeArchived ? { include_archived: 'true' } : {}),
            ...(origin === 'interactive' ? {} : { origin })
          }
        })
      } catch {
        return []
      }
    },

    async listGeneralSessions(): Promise<ChatSession[]> {
      // P2d — general (context-free) sessions. Direct fetch, graceful [].
      try {
        return await request<ChatSession[]>(baseUrl, 'GET', '/chat/sessions/general')
      } catch {
        return []
      }
    },

    async listToolCalls(messageId: number): Promise<ChatToolCall[]> {
      try {
        return await request<ChatToolCall[]>(
          baseUrl,
          'GET',
          `/chat/messages/${messageId}/tool-calls`
        )
      } catch {
        return []
      }
    },

    async kosAvailable(): Promise<boolean> {
      try {
        return await request<boolean>(baseUrl, 'GET', '/chat/kos-available')
      } catch {
        return false
      }
    },

    async kosDoctor(): Promise<KosDoctorCheck[]> {
      // POST /chat/kos-doctor（issue #54）。有意不吞错（对比 kosAvailable）：doctor 是
      // 显式动作，serve-api 不可达本身就是要暴露的结论，组件 catch 后 toast。
      return request<KosDoctorCheck[]>(baseUrl, 'POST', '/chat/kos-doctor')
    },

    async listSkills(): Promise<SkillSummary[]> {
      // PR5 — read the RESOLVED list from the backend (GET /agent/skills): manifest
      // skills (builtin + installed) ⋈ agent_config.db enable overrides + source_type.
      // Graceful [] when unreachable (the Settings section shows an empty state, never throws).
      try {
        const data = await request<{ skills: SkillSummary[] }>(baseUrl, 'GET', '/agent/skills')
        return data.skills ?? []
      } catch {
        return []
      }
    },

    async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
      // PR5 — persist the toggle to the backend (POST /agent/skills/{name}/enabled).
      // Throws Error&{code} on failure (request() 透传 E_NOT_FOUND / E_INVALID_ARG).
      // The gateway's skill→tool gating re-reads /chat/config on a 15s TTL, so the
      // toggle takes effect without any client-side cache invalidation.
      await request(baseUrl, 'POST', `/agent/skills/${encodeURIComponent(name)}/enabled`, {
        body: { enabled }
      })
    },

    async listSkillDrafts(): Promise<SkillDraftSummary[]> {
      const data = await request<{ drafts: SkillDraftSummary[] }>(baseUrl, 'GET', '/agent/skills/drafts')
      return data.drafts ?? []
    },

    async getSkillDraft(id: string): Promise<SkillDraftSummary> {
      return request(baseUrl, 'GET', `/agent/skills/drafts/${encodeURIComponent(id)}`)
    },

    async readSkillDraftFile(id: string, path: string): Promise<string> {
      const data = await request<{ content: string }>(
        baseUrl,
        'GET',
        `/agent/skills/drafts/${encodeURIComponent(id)}/file`,
        { query: { path } }
      )
      return data.content
    },

    async publishSkillDraft(id: string, enabled: boolean): Promise<void> {
      await request(baseUrl, 'POST', `/agent/skills/drafts/${encodeURIComponent(id)}/publish`, {
        body: { enabled }
      })
    },

    async discardSkillDraft(id: string): Promise<void> {
      await request(baseUrl, 'POST', `/agent/skills/drafts/${encodeURIComponent(id)}/discard`, { body: {} })
    },

    async importAgentPlugin(zipBase64: string): Promise<AgentPluginImportResult> {
      return request(baseUrl, 'POST', '/agent/skills/plugin/import', { body: { zipBase64 } })
    },

    async listSkillTrust(name: string): Promise<{ currentPackageHash: string | null; trusts: SkillTrustRule[] }> {
      return request(baseUrl, 'GET', `/agent/skills/${encodeURIComponent(name)}/trust`)
    },

    async grantSkillTrust(name: string, entrypoint: string, policy: SkillTrustRule['policy']): Promise<SkillTrustRule> {
      return request(baseUrl, 'POST', `/agent/skills/${encodeURIComponent(name)}/trust`, {
        body: { entrypoint, policy }
      })
    },

    async revokeSkillTrust(name: string, trustId: string): Promise<void> {
      await request(baseUrl, 'DELETE', `/agent/skills/${encodeURIComponent(name)}/trust/${encodeURIComponent(trustId)}`)
    },

    async getApprovalMode(): Promise<GlobalApprovalMode> {
      // 07-16 approval-mode switcher — read the owner-global mode (GET /agent/approval-mode).
      // 🔴 codex r1 P1-1: a transport failure THROWS (it must NOT fold to 'manual' — the chip
      // would claim Manual while the persisted mode could be bypass; the renderer store renders
      // an explicit "unknown" state + retries instead). A SUCCESSFUL envelope with an
      // out-of-domain value still folds to 'manual' (server semantics: dirty rows read as manual).
      const data = await request<{ mode: GlobalApprovalMode }>(
        baseUrl,
        'GET',
        '/agent/approval-mode'
      )
      // 08-05 WP-11 — 'acceptEdits' retired: only 'bypass' survives; legacy/dirty → 'manual'.
      return data.mode === 'bypass' ? data.mode : 'manual'
    },

    async setApprovalMode(mode: GlobalApprovalMode): Promise<GlobalApprovalMode> {
      // 07-16 — switch the owner-global mode (PUT /agent/approval-mode). Owner UI only; throws
      // Error&{code} on failure. Returns the SERVER-CANONICAL mode echoed by the PUT so the store
      // converges on what actually persisted (pessimistic UI, codex r1 P1-2) — an unexpected
      // response shape throws too (indeterminate persist → the store re-GETs to converge).
      const data = await request<{ mode: GlobalApprovalMode }>(
        baseUrl,
        'PUT',
        '/agent/approval-mode',
        { body: { mode } }
      )
      if (data.mode !== 'manual' && data.mode !== 'bypass') {
        throw new Error(`unexpected approval-mode response: ${String(data.mode)}`)
      }
      return data.mode
    },

    async getAutoCompact(): Promise<'on' | 'off'> {
      const data = await request<{ mode: string }>(baseUrl, 'GET', '/agent/auto-compact')
      return data.mode === 'off' ? 'off' : 'on'
    },

    async setAutoCompact(mode: 'on' | 'off'): Promise<'on' | 'off'> {
      const data = await request<{ mode: string }>(baseUrl, 'PUT', '/agent/auto-compact', {
        body: { mode }
      })
      if (data.mode !== 'on' && data.mode !== 'off') {
        throw new Error(`unexpected auto-compact response: ${String(data.mode)}`)
      }
      return data.mode
    },

    // ── 08-05 WP-11 — built-in 写工具的 per-tool 审批档（owner UI 专属写面）──────────────

    async getToolPrefs(): Promise<ToolApprovalPrefsPayload> {
      // Throws on transport failure（Settings section 渲染错误/重试态；不静默造默认值）。
      return await request<ToolApprovalPrefsPayload>(baseUrl, 'GET', '/agent/tool-prefs')
    },

    async setToolPref(
      toolName: string,
      tier: ToolApprovalTierValue | null
    ): Promise<ToolApprovalPrefsPayload> {
      return await request<ToolApprovalPrefsPayload>(
        baseUrl,
        'PUT',
        `/agent/tool-prefs/${encodeURIComponent(toolName)}`,
        { body: { tier } }
      )
    },

    async bulkSetToolPrefs(input: {
      tier: ToolApprovalTierValue | null
      group?: string
    }): Promise<ToolApprovalPrefsPayload> {
      return await request<ToolApprovalPrefsPayload>(baseUrl, 'POST', '/agent/tool-prefs/bulk', {
        body: { tier: input.tier, ...(input.group ? { group: input.group } : {}) }
      })
    },

    async applyToolPrefsPreset(): Promise<ToolApprovalPrefsPayload> {
      return await request<ToolApprovalPrefsPayload>(baseUrl, 'POST', '/agent/tool-prefs/preset', {
        body: { preset: 'acceptEdits' }
      })
    },

    async resetToolPrefs(): Promise<ToolApprovalPrefsPayload> {
      return await request<ToolApprovalPrefsPayload>(baseUrl, 'POST', '/agent/tool-prefs/reset', {
        body: {}
      })
    },

    async setSendWhitelist(recipients: string[]): Promise<string[]> {
      const data = await request<{ sendWhitelist: string[] }>(
        baseUrl,
        'PUT',
        '/agent/send-whitelist',
        { body: { recipients } }
      )
      return data.sendWhitelist ?? []
    },

    async listPolicyRules(params?: { agentId?: string }): Promise<ExecPolicyRule[]> {
      // S2 W1 — the Settings 「自动化策略」 page reads the exec whitelist rules (GET
      // /agent/policy/rules). Graceful [] when unreachable (the section shows an empty state).
      // S5 W5b — optional agentId narrows to one custom agent's per-agent rules.
      const qs = params?.agentId ? `?agentId=${encodeURIComponent(params.agentId)}` : ''
      try {
        const data = await request<{ rules: ExecPolicyRule[] }>(
          baseUrl,
          'GET',
          `/agent/policy/rules${qs}`
        )
        return data.rules ?? []
      } catch {
        return []
      }
    },

    async createPolicyRule(input: CreatePolicyRuleInput): Promise<ExecPolicyRule> {
      // S5 W5b — per-agent 免卡规则唯一创建通道（Settings 自动化策略表单，ADR-004 D5）。
      // Throws Error&{code}：后端形状闸/归属校验 400 detail 原样透传给表单展示。
      return request<ExecPolicyRule>(baseUrl, 'POST', '/agent/policy/rules', { body: input })
    },

    async listSkillEntrypoints(): Promise<SkillEntrypoints[]> {
      // S5 W5b — exec 规则构造器的 entrypoint 候选（GET /agent/skills/entrypoints）。
      // flag off（404）/ 不可达 → graceful []（构造器显示「无已安装 skill」空态）。
      try {
        const data = await request<{ skills: SkillEntrypoints[] }>(
          baseUrl,
          'GET',
          '/agent/skills/entrypoints'
        )
        return data.skills ?? []
      } catch {
        return []
      }
    },

    async setPolicyRuleEnabled(id: number, enabled: boolean): Promise<void> {
      // S2 W1 — enable/disable a rule (PATCH /agent/policy/rules/{id}). Throws Error&{code}.
      await request(baseUrl, 'PATCH', `/agent/policy/rules/${id}`, { body: { enabled } })
    },

    async deletePolicyRule(id: number): Promise<void> {
      // S2 W1 — delete a rule (DELETE /agent/policy/rules/{id}). Idempotent. Throws Error&{code}.
      await request(baseUrl, 'DELETE', `/agent/policy/rules/${id}`)
    },

    async compileUserMd() {
      // M3c — 手动触发 user.md 偏好编译（Settings 按钮）。
      // POST /api/chat/memory/compile-user-md → CompileUserMdResult。
      // flag-off → backend 403 E_DISABLED → request() throws → caller 捕获处理。
      return request<CompileUserMdResult>(baseUrl, 'POST', '/chat/memory/compile-user-md', {})
    },

    async rollbackProfileDoc({ name, toHash }: { name: string; toHash: string }) {
      // M3c — 把 profile doc 回滚到指定历史版本。
      // POST /api/agent/profile/docs/{name}/rollback，body = {targetHash, updatedBy}。
      // 用于编译结果的一键 rollback（toHash = CompileUserMdResult.beforeHash）。
      await request<object>(baseUrl, 'POST', `/agent/profile/docs/${name}/rollback`, {
        body: { targetHash: toHash, updatedBy: 'user' }
      })
    },

    async listProfileDocs(): Promise<AgentProfileDoc[]> {
      // Settings 身份文档编辑器 — list all profile docs.
      // GET /api/agent/profile/docs → {docs: AgentProfileDoc[]}.
      // Degrades to [] when unreachable (flag-gated section only calls when enabled).
      try {
        const data = await request<{ docs: AgentProfileDoc[] }>(
          baseUrl,
          'GET',
          '/agent/profile/docs'
        )
        return data.docs
      } catch {
        return []
      }
    },

    async readProfileDoc(name: string): Promise<AgentProfileDoc> {
      // Settings 身份文档编辑器 — read one profile doc (full content + hash).
      // GET /api/agent/profile/docs/{name} → AgentProfileDoc.
      return request<AgentProfileDoc>(
        baseUrl,
        'GET',
        `/agent/profile/docs/${encodeURIComponent(name)}`
      )
    },

    async setProfileDoc(input: {
      name: string
      content: string
      updatedBy?: string
      sessionId?: number
      messageId?: number
    }): Promise<AgentProfileDoc> {
      // Settings 身份文档编辑器 — write one profile doc.
      // POST /api/agent/profile/docs/{name} → AgentProfileDoc.
      // RULES may be rejected with E_INVALID_ARG; caller surfaces the error.
      const { name, ...body } = input
      return request<AgentProfileDoc>(
        baseUrl,
        'POST',
        `/agent/profile/docs/${encodeURIComponent(name)}`,
        { body }
      )
    },

    async listProfileHistory(docName?: string): Promise<AgentProfileHistoryEntry[]> {
      // Settings 身份文档编辑器 — version history for one doc, newest-first.
      // GET /api/agent/profile/history[?docName=] → {history: AgentProfileHistoryEntry[]}.
      // Degrades to [] when unreachable.
      try {
        const data = await request<{ history: AgentProfileHistoryEntry[] }>(
          baseUrl,
          'GET',
          '/agent/profile/history',
          docName ? { query: { docName } } : undefined
        )
        return data.history
      } catch {
        return []
      }
    },

    async fetchSkillPack(input): Promise<SkillPackPreview> {
      // S2 W4b — two-phase install phase 1 (POST /agent/skills/fetch): download/import →
      // quarantine + server-rendered preview. Business authority (SSRF hardening / safe
      // unpack / hash) lives in Python; this is a thin transport. Throws Error&{code}
      // (E_PACK_* / E_SSRF_BLOCKED / E_UPSTREAM) — the Settings dialog surfaces code+hint.
      return request<SkillPackPreview>(baseUrl, 'POST', '/agent/skills/fetch', { body: input })
    },

    async confirmSkillPack(input): Promise<SkillConfirmResult> {
      // S2 W4b — two-phase install phase 2 (POST /agent/skills/confirm). Echo the
      // preview's packageHash + files verbatim; backend re-hashes and throws 409
      // E_PACK_HASH_MISMATCH when the quarantine changed after preview (TOCTOU).
      return request<SkillConfirmResult>(baseUrl, 'POST', '/agent/skills/confirm', {
        body: input
      })
    },

    async uninstallSkillPack(name: string): Promise<SkillUninstallResult> {
      // S2 W4b — full-cleanup uninstall (POST /agent/skills/uninstall): row + dir +
      // secrets in one idempotent sweep. NEVER the legacy DELETE /agent/skills/{name}.
      return request<SkillUninstallResult>(baseUrl, 'POST', '/agent/skills/uninstall', {
        body: { name }
      })
    },

    async getSkillConfig(name: string): Promise<Record<string, unknown>> {
      // S2 W4b — read <skills>/<name>/config.json (GET /agent/skills/{name}/config).
      // Missing file → {} server-side. Throws Error&{code} (E_NOT_FOUND when not installed).
      const data = await request<{ name: string; config: Record<string, unknown> }>(
        baseUrl,
        'GET',
        `/agent/skills/${encodeURIComponent(name)}/config`
      )
      return data.config ?? {}
    },

    async putSkillConfig(name: string, config: Record<string, unknown>): Promise<void> {
      // S2 W4b — overwrite config.json (PUT /agent/skills/{name}/config, body = the
      // whole object, ≤64KB serialized server-side). Throws Error&{code}.
      await request(baseUrl, 'PUT', `/agent/skills/${encodeURIComponent(name)}/config`, {
        body: config
      })
    },

    async listSkillSecretMeta(name: string): Promise<SkillSecretMeta[]> {
      // S2 W3/W4b — stored secret names + ISO timestamps, NEVER values (GET
      // /agent/skills/{name}/secrets). Degrades to [] when unreachable (the Settings
      // drawer shows an empty state).
      try {
        const data = await request<{ secrets: SkillSecretMeta[] }>(
          baseUrl,
          'GET',
          `/agent/skills/${encodeURIComponent(name)}/secrets`
        )
        return data.secrets ?? []
      } catch {
        return []
      }
    },

    async putSkillSecret(name: string, secretName: string, value: string): Promise<void> {
      // S2 W3/W4b — write-only secret set/replace (PUT
      // /agent/skills/{name}/secrets/{secretName}, body = {value}). The response never
      // echoes the value; the caller clears its input on success. Throws Error&{code}
      // (E_INVALID_ARG for a bad name — env-regex + reserved deny live server-side).
      await request(
        baseUrl,
        'PUT',
        `/agent/skills/${encodeURIComponent(name)}/secrets/${encodeURIComponent(secretName)}`,
        { body: { value } }
      )
    },

    async deleteSkillSecret(name: string, secretName: string): Promise<void> {
      // S2 W3/W4b — delete one secret (idempotent). Throws Error&{code}.
      await request(
        baseUrl,
        'DELETE',
        `/agent/skills/${encodeURIComponent(name)}/secrets/${encodeURIComponent(secretName)}`
      )
    }
  }
}
