// mem0/skill 核心重构 epic M4b/M4c — AI SDK Gateway 自我挂载工具。
//
// 三个 meta 工具，让 agent 在对话内 (b) 提议改自己的 Standing Context 身份/规则文档，
// (c) 发现未激活的能力并提议挂载 —— 闭合「发现4」之上的「自我挂载」愿景：
//   - update_system_md (M4b, EDIT-tier 写)：提议覆写 soul/agent/rules/user 文档。EDIT-tier →
//     Manual/auto-reversible 下**恒人审**（edit-tier 在 auto-reversible 模式也不跳卡）；07-16 起
//     owner 全局 acceptEdits/bypass 模式（显式越权）下可自动执行（policy.ts allow-list）；
//     rules 内容由 Python 端点 validate_rules_content 服务端校验（jailbreak/越权措辞 → E_INVALID_ARG
//     → tool-error，模型读到被拒）；PRODUCT_SAFETY_FLOOR 结构上不可弱化。可经 Settings rollback。
//   - discover_skills (M4c, SILENT 读)：列所有 skill 的 enabled/available/unavailableReason/toolCount，
//     让 agent 自查关着的能力。无副作用 → 无审批。
//   - set_skill_enabled (M4c, PREVIEW 写)：启用/停用一个 skill（挂载/卸载其工具）。可逆 → preview 审批；
//     被挂载的 skill 工具仍各自带审批，启用绝不静默授予写权限。
//
// 🔴 全部 behind MAILAGENT_SKILL_SELF_MOUNT（buildGatewayTools skillGatingEnabled）—— off 默认 →
//    模型只在 flag 开时见到它们 → flag-off 字节级同 cutover。写工具的审批由 domain ApprovalGuard
//    （id/hash/expiry）把关，与 email 写工具同机制（auditedWriteTool 两调 needsApproval→verify）。
// 🔴 这三个工具无 skill 归属 → 在 skill_gating.ts 的 CORE_UNGATED_GATEWAY_TOOLS 里，applySkillGating
//    永不删它们。

import type { Tool } from 'ai'
import type { z } from 'zod'

import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard, ApprovalRisk } from '../security/approval'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolAuditCollector
} from './types'
import type { AgentContextMode } from './policy'
import { discoverSkillsSchema, setSkillEnabledSchema, updateSystemMdSchema } from './schemas'
// D1 (connector dogfood batch) — the run-scoped connector catalog (same projection the prompt
// block consumes), so discover_skills is no longer connector-blind: soul.md routes capability
// self-description here, and before this the tool "authoritatively" denied the mcp__* tools.
import type { ConnectorCatalogEntry } from '../prompts/stable_prompt'

/** Names of the self-mount tools the gateway exposes when MAILAGENT_SKILL_SELF_MOUNT is on. */
export const GATEWAY_SELF_MOUNT_TOOL_NAMES = [
  'update_system_md',
  'discover_skills',
  'set_skill_enabled'
] as const

/** Reject an invalid argument the same way the other gateway tools do (E_INVALID_ARG). */
function invalidArg(message: string): never {
  throw new DomainError('E_INVALID_ARG', message)
}

/**
 * Build the M4b/M4c self-mount tools bound to the injected domain client + audit collector +
 * approval guard. update_system_md / set_skill_enabled are approval-gated writes; discover_skills
 * is a silent read.
 */
export function createSelfMountTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    oneShot?: boolean
    contextMode?: AgentContextMode
    /** D1 — the run-scoped MCP connector catalog (lifecycle: connectorCatalogForRun over the
     *  manifest cache). Absent / null / [] → discover_skills output byte-identical to before. */
    connectorCatalog?: ConnectorCatalogEntry[] | null
  } = {}
): Record<string, Tool> {
  const makeWrite = <I>(toolOpts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    risk: Exclude<ApprovalRisk, 'blocking'>
    editableFields?: readonly string[]
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined }
    ) => Promise<unknown>
  }): Tool =>
    auditedWriteTool(
      {
        ...toolOpts,
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        oneShot: opts.oneShot, // Part B — one-shot claim across island + renderer resume
        // S2 W0 — both writes here are class capability_change (policy.ts): they never
        // auto-approve, and outside manual_chat they neither register nor execute.
        contextMode: opts.contextMode
      },
      collector,
      guard
    )

  // M4b — propose an edit to a Standing Context doc. EDIT tier → always asks under
  // Manual/auto-reversible (edit tier never auto-approves there) → the user reviews every change
  // to the agent's identity/rules. 07-16: the owner-global acceptEdits/bypass modes (explicit
  // owner override) may auto-execute it — see ACCEPT_EDITS_AUTO_APPROVE_TOOLS (policy.ts).
  const update_system_md = makeWrite({
    name: 'update_system_md',
    description:
      'Propose an edit to one of your own Standing Context documents — soul (identity / voice), ' +
      'agent (operating notes / self-maintained working memory), rules (hard behavioural ' +
      "constraints), or user (the user's identity / explicit long-term preferences). " +
      'ONLY call this when the user EXPLICITLY asks you to edit or update one of these ' +
      'Standing Context documents. Do NOT use this to save casual preferences or facts ' +
      'mentioned in conversation — those are automatically captured into memory.md. ' +
      'The FULL new markdown content REPLACES the current doc, so include everything you ' +
      'want kept. The user sees your proposed content in a confirmation card and approves ' +
      'or rejects it; nothing changes without their approval. Editing `rules` is high-risk: ' +
      'jailbreak / safety-override phrasing is rejected by a server-side validator and the ' +
      'product safety floor can never be weakened. Reversible (the user can roll back from ' +
      'Settings). Edit tier — always asks under the Manual/auto-reversible modes; only the ' +
      'owner-set global acceptEdits/bypass permission mode can auto-execute it.',
    inputSchema: updateSystemMdSchema,
    risk: 'edit',
    // No editableFields → the card is approve/reject only (no edit UI); doc_name AND content are both
    // pinned. risk:'edit' keeps it ALWAYS-ask under Manual/auto-reversible (edit tier never
    // auto-approves there) — the safety property for an identity / rules change; the owner-global
    // acceptEdits/bypass modes are the only (explicit, owner-set) auto-execute path.
    run: async (input, { userEdited, signal }) => {
      if (input.content.trim().length === 0) invalidArg('content required (non-empty)')
      const data = await domain.setProfileDoc(
        input.doc_name,
        { content: input.content, updatedBy: 'agent_proposed' },
        signal
      )
      return {
        doc_name: data.docName,
        content_hash: data.contentHash,
        updated_by: data.updatedBy,
        updated_at: data.updatedAt,
        user_edited: userEdited
      }
    }
  })

  // M4c — enable/disable a skill (mount/unmount its tools for the model). PREVIEW tier — reversible
  // (toggle back); the user approves the capability change. The skill's own tools keep their
  // independent approval, so enabling never silently grants a write.
  const set_skill_enabled = makeWrite({
    name: 'set_skill_enabled',
    description:
      'Enable or disable one of your skills (enabled=true to mount its tools, false to unmount ' +
      'them). Enabling a skill exposes its tools to you on the NEXT turn (each still subject to its ' +
      'own approval); disabling removes them. Use after discover_skills reveals a capability the ' +
      'current task needs that is currently off — propose enabling it. The user approves the change ' +
      '(preview tier, reversible). An unavailable skill (missing credentials / preconditions) cannot ' +
      'be usefully enabled — surface that to the user instead.',
    inputSchema: setSkillEnabledSchema,
    risk: 'preview',
    run: async (input, { userEdited, signal }) => {
      if (input.skill_name.trim().length === 0) invalidArg('skill_name required (non-empty)')
      const data = await domain.setSkillEnabled(input.skill_name, input.enabled, signal)
      // M4b review LOW-4 — enabling does NOT guarantee mounting: a skill advertises its tools only
      // when enabled AND available. Surface availability so the result never claims a capability
      // appeared when it did not (best-effort — the enable/disable already applied server-side).
      let available: boolean | undefined
      let unavailableReason: string | null = null
      try {
        const resolved = await domain.listResolvedSkills(signal)
        const s = resolved.find((x) => x.name === data.name)
        available = s?.available
        unavailableReason = s?.unavailableReason ?? null
      } catch {
        /* availability is advisory; the enable/disable already applied */
      }
      return {
        name: data.name,
        enabled: data.enabled,
        available,
        unavailable_reason: unavailableReason,
        mounted: data.enabled && available === true,
        user_edited: userEdited
      }
    }
  })

  // M4c — discover_skills: SILENT read. Lists every skill with its enabled/available state +
  // unavailableReason + toolCount, so the agent can self-discover capabilities that are off and
  // propose mounting them (set_skill_enabled). No side-effects → no approval.
  const discover_skills = auditedReadTool(
    {
      name: 'discover_skills',
      description:
        'List your skills and their current state: name, description, whether each is enabled, ' +
        'whether it is available (preconditions / credentials met), why it is unavailable if not, ' +
        'how many tools it owns, and install_dir (absolute on-disk directory for installed script ' +
        'skills, null for built-ins). Use this to discover a capability the current task needs that ' +
        'is turned off, then propose enabling it with set_skill_enabled. When running a script ' +
        'skill, build run_command from install_dir as an ABSOLUTE path argv — never `cd` into it ' +
        'via a shell, which the exec endpoint rejects. Skills and external MCP connector tools ' +
        '(names starting mcp__) are two SEPARATE systems: connectors appear under ' +
        'external_connectors in this result, are already registered when listed, and are not ' +
        'toggled by set_skill_enabled. Read-only — no approval.',
      inputSchema: discoverSkillsSchema,
      run: async (_input, signal) => {
        const skills = await domain.listResolvedSkills(signal)
        // D1 — External connectors summary rides along ONLY when the run actually holds connector
        // tools (opts.connectorCatalog is the run-scoped projection). Absent / empty → the key is
        // not added at all, keeping the pre-D1 output byte-identical.
        const connectors = opts.connectorCatalog
        return {
          count: skills.length,
          skills: skills.map((s) => ({
            name: s.name,
            title: s.title,
            description: s.description,
            enabled: s.enabled,
            available: s.available,
            unavailable_reason: s.unavailableReason,
            tool_count: s.toolCount,
            // issue #62 — absolute install path so the model never has to infer a `cd <dir> && …`
            // shell wrapper (that shape silently loses integrity checking + secret injection).
            install_dir: s.installDir ?? null
          })),
          ...(connectors && connectors.length > 0
            ? {
                external_connectors: {
                  note:
                    'Direct MCP connector tools, named mcp__<connector>__<tool> — a separate ' +
                    'system from the skills above. They are registered and callable right now; ' +
                    'read tools run without approval, write tools follow the approval rule in ' +
                    'their own descriptions. Not toggleable via set_skill_enabled (owner manages ' +
                    'them in Settings → Custom AI → External connections).',
                  connectors: connectors.map((c) => ({
                    connector_id: c.connectorId,
                    display_name: c.displayName,
                    tool_prefix: `mcp__${c.connectorId}__`,
                    read_tool_count: c.readToolCount,
                    write_tool_count: c.writeToolCount + c.updateToolCount,
                    tool_count: c.readToolCount + c.writeToolCount + c.updateToolCount
                  }))
                }
              }
            : {})
        }
      }
    },
    collector
  )

  return { update_system_md, discover_skills, set_skill_enabled }
}
