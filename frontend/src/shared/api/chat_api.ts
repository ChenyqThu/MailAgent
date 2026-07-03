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
  AgentProfileHistoryEntry,
  ChatAnchorType,
  ChatApi,
  ChatBackendKind,
  ChatMessage,
  ChatSession,
  ChatSessionListItem,
  ChatToolCall,
  CompileUserMdResult,
  ExecPolicyRule,
  SkillConfirmResult,
  SkillPackPreview,
  SkillSecretMeta,
  SkillSummary,
  SkillUninstallResult
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
      backendKind: ChatBackendKind
      backendModel?: string | null
      backendAgentPageId?: string | null
    }): Promise<ChatSession> {
      // POST /chat/sessions/new（单一真源；ai-sdk 的 onEnsureSession 会话创建走这里）。
      // throw Error&{code} 由 request() 透传（E_INVALID_ARG / E_DISPATCH）。
      // email 路径**逐字节零回归**：不带 anchorType（serve-api 默认 'email'）；仅 'general'
      // 显式带 anchorType:'general' + emailId:null（serve-api _validate_session_opts 拒
      // general 携 emailId），createNewSession 无条件 INSERT 新 general 行。
      const base = {
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null
      }
      const body =
        input.anchorType === 'general'
          ? { anchorType: 'general', emailId: null, ...base }
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

    deleteSession(sessionId: number): void {
      // fire-and-forget（ChatApi.deleteSession 返 void）。DELETE /chat/sessions/{id}（其消息 +
      // 工具调用经 FK CASCADE 连带删）。renderer 已乐观移除该行；失败 warn 不回滚。
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      void request(baseUrl, 'DELETE', `/chat/sessions/${sessionId}`).catch((err) =>
        console.warn('[chat] runtime deleteSession failed', err)
      )
    },

    async updateSessionTitle(sessionId: number, title: string): Promise<void> {
      // Phase 10 rename → PATCH /chat/sessions/{id}/title (serve-api → src/chat/db.py; no updated_at
      // bump → no reorder). Awaited so the caller can invalidate the history query after it lands.
      // Throws Error&{code} on failure (caller toasts / leaves the optimistic value).
      if (!Number.isInteger(sessionId) || sessionId < 0) return
      await request(baseUrl, 'PATCH', `/chat/sessions/${sessionId}/title`, { body: { title } })
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

    async listAllSessions(includeArchived = false): Promise<ChatSessionListItem[]> {
      try {
        // dogfood-3 — includeArchived=true also returns archived sessions (the agent view's "归档" group);
        // default false is byte-identical (active only).
        return await request<ChatSessionListItem[]>(
          baseUrl,
          'GET',
          '/chat/sessions/all',
          includeArchived ? { query: { include_archived: 'true' } } : undefined
        )
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

    async listPolicyRules(): Promise<ExecPolicyRule[]> {
      // S2 W1 — the Settings 「自动化策略」 page reads the exec whitelist rules (GET
      // /agent/policy/rules). Graceful [] when unreachable (the section shows an empty state).
      try {
        const data = await request<{ rules: ExecPolicyRule[] }>(
          baseUrl,
          'GET',
          '/agent/policy/rules'
        )
        return data.rules ?? []
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
