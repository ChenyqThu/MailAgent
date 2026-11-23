// S2 W0 (task 07-02-s2-exec-skill-install, ADR-001) — context-mode × tool-class policy matrix.
//
// Two orthogonal axes, both SERVER-asserted (never client input):
//   - AgentContextMode: run-level provenance — who initiated this run. Asserted by each trusted
//     entrypoint as an explicit prepareChatRun parameter (NEVER read from the request body);
//     absent/unknown normalizes fail-closed to 'untrusted_trigger' (the strictest mode), so a
//     future entrypoint that forgets to pass it can only be SAFER, never silently privileged.
//   - GatewayToolClass: what a tool can do (read / reversible domain write / capability change /
//     local exec / outbound web read / outbound send). Independent of the approval `tier`
//     (preview/edit/blocking), which keeps owning the approval-card UX — class owns POLICY
//     (ADR-001 D2: tier 管卡片, class 管策略).
//
// The matrix (ADR-001 D3; exec row revised by ADR-004 D2, web row by ADR-004 rev3.1):
//   - read + domain_write register in EVERY mode (domain writes stay HITL outside manual, because
//     mayAutoApprove requires manual_chat — see below).
//   - capability_change / exec / web / outbound are manual_chat-ONLY by default: outside a manual
//     session they are (a) not registered at all (applyContextModePolicy strips them from the
//     ToolSet — the model cannot see them), and (b) hard-rejected at execute time as a second line
//     of defense (types.ts) in case a future entrypoint misses the mode. exec and web each have a
//     per-agent grant key that lifts ONLY their own row; capability_change and outbound (send)
//     have no key — permanently floored.
//   - auto-approve (approvalMode 'auto-reversible' skipping the card) is a privilege of
//     REVERSIBLE DOMAIN writes in an owner-driven manual session ONLY: mayAutoApprove ⇔
//     class==='domain_write' && mode==='manual_chat'. This closes the set_skill_enabled escape
//     (preview tier alone no longer skips the card — a capability change always asks).
//   - im_chat (stage 0b matrix row; asserted by POST /api/ai/im-chat since stage 2 PR-1 — the
//     飞书 IM venue, grill Q10=A + the 08-04 拍板): read/artifact/domain_write register (domain
//     writes 恒 HITL), connector reads/writes register like manual (owner 拍板「全开放」— writes
//     stay 恒 HITL because mayAutoApprove is manual-only), web registers ONLY under the
//     MAILAGENT_IM_WEB_ENABLED venue switch (Q19=A — a Settings/env switch, NEVER a grant);
//     capability_change / exec / outbound are hard-denied and per-agent grants are NOT consulted.
//
// 🔴 GATEWAY_TOOL_CLASSES is the single source of truth for tool→class (types.ts resolves a
//    tool's class from here via classOfTool). A tool MISSING from the map fail-closes to 'exec'
//    (strictest: manual-only + never auto-approved), and the completeness test in policy.test.ts
//    forces every real gateway tool to be classified — a new tool without a class turns red, it
//    never silently registers loose.
//
// Pure functions + const data only (type-only `ai` import, fully erased) — directly unit-testable,
// and config.ts may type-import AgentContextMode without pulling the `ai` chunk (Phase 02
// invariant preserved).

import type { ToolSet } from 'ai'

import { GATEWAY_LIBRARY_WRITE_TOOL_NAMES } from '@shared/libraryConstants'

import { registerDynamicToolClass, resolveToolClass, type GatewayToolClass } from './policyRules'
import {
  evaluateToolAllowedInContext,
  filterToolsByContextMode,
  hasConnectorWriteGrant,
  type AgentModeGrants,
  type ImVenueSwitches
} from './policyEval'

export * from './policyRules'
export * from './policyEval'

/** Run-level provenance of a chat run (ADR-001 D1). Order of severity: manual_chat is the only
 *  human-in-front-of-screen mode; the other two exist for S4 (email-triggered / scheduled runs)
 *  and are already enforced here so S4 cannot forget them.
 *
 *  'im_chat' (stage 0b, harness-expansion epic — grill Q10=A): the FOURTH venue, the owner talking
 *  through an IM bridge (阶段 2 飞书对话). 盗号 ≠ 盗机 — a stolen IM account must never reach this
 *  machine's execution surface, so the row is STRICTER than manual_chat: reads free; domain writes
 *  恒 HITL (mayAutoApprove still requires manual_chat, and the bypass overlay is
 *  manual-gated at consumption); connector tools open like manual (08-04 拍板「全开放」; 08-05
 *  WP-10: write approval follows the per-tool tier — ask → Feishu card, auto → card-free, off →
 *  not registered); web gated by the MAILAGENT_IM_WEB_ENABLED venue switch
 *  (Q19=A — a Settings switch, NOT a grant; default off); exec / capability_change / outbound
 *  permanently denied, per-agent grants never consulted. Asserted in trusted code by
 *  POST /api/ai/im-chat (stage 2 PR-1, MAILAGENT_IM_FEISHU-gated).
 *
 *  'matter_followup' (Matters MVP P4, decisions D5; widened by the 0812 owner拍板): the FIFTH
 *  venue — a Matter follow-up run (观察 + 建议, never 执行). The boundary is BY CLASS, not by
 *  resource scope: every 'read' tool registers (the run's whole point is discovering NEW
 *  evidence, so it reads the full library), 'artifact' ONLY under the one propose NAME
 *  (MATTER_RUN_PROPOSE_TOOL — 0812 codex修复批: report_write shares the class and is a local
 *  write, whole-class admission was a hole), plus 'web' under the SPEC-authored read grant
 *  (run_spec.py writes grantWeb — the outbound-network-READ class; connector READS are class
 *  'read' and ride the grantConnectors read ceilings at registration). Every write-capable class
 *  — domain_write / connector_write / exec / capability_change / outbound — is denied, and 🔴 the
 *  exec grant + im venue switches are NOT consulted at all: binding a Matter to a
 *  strongly-granted Agent Profile (grant_exec / connector write ceilings) can never widen the
 *  face — the profile contributes model/persona only (D2), and the grants this row DOES read
 *  (web) are authored solely by the server-side spec assembler, never copied from a profile.
 *  The run's single output channel is the artifact-class `matter_update_propose`; every state
 *  change goes through the owner's review (matter_review_update in a manual/im session). The
 *  wrapCfgForAgentRun read-face exemption (agentRun.ts) is the SECOND, independent belt — this
 *  matrix row is the first. Asserted in trusted code by POST /api/ai/agent-run when the
 *  SERVER-assembled spec carries runKind==='matter_followup' (agentRun.ts deriveContextMode),
 *  never from a request body.
 *  🔴 L4 批次3 (task 08-25) — runKind==='matter_item_run' (一条行动项的派发 run) asserts THIS
 *  SAME mode rather than minting a seventh one: the venue posture is identical (unattended, no
 *  write class, propose-only, connector ceiling pinned 'read' server-side), so a separate mode
 *  would duplicate the row and split the owner's per-venue policy rules in two. The only
 *  difference is WHICH artifact name is admitted, and that is already a by-name decision
 *  (MATTER_RUN_ARTIFACT_TOOLS). The two runs stay apart structurally through their anchors:
 *  each output tool registers only under its own (tools/index.ts).
 *
 *  'contact_governance' (Contact Directory WP7): the SIXTH venue — the nightly contact-directory
 *  governance scan (读邮件与通讯录 → 提建议, never 直写). It is deliberately NOT cron_headless:
 *  that row admits the WHOLE domain_write class, so a governance run would inherit every email /
 *  matter / calendar write and lose the propose-only structural guarantee its whole design rests
 *  on (identity fields may only ever be SUGGESTED — src/contacts/governance.py, guard rule 1).
 *  The boundary is BY CLASS like matter_followup, but one notch TIGHTER: every 'read' registers
 *  (the scan has to read mail to cite evidence), 'artifact' ONLY under the three propose NAMES
 *  (CONTACT_PROPOSE_TOOLS — report_write / matter_update_propose share the class and are other
 *  domains' write channels), and 'web' is NOT admitted at all — a directory scan has no business
 *  on the network, and the spec assembler authors no web grant. Every write-capable class
 *  (domain_write / connector_write / exec / capability_change / outbound) is denied, and the exec
 *  grant + im venue switches are never consulted. Asserted in trusted code by POST
 *  /api/ai/agent-run when the SERVER-assembled spec carries runKind==='contact_governance'
 *  (agentRun.ts deriveContextMode), never from a request body; wrapCfgForAgentRun's contact
 *  read-face belt is the SECOND, independent belt. */
export const AGENT_CONTEXT_MODES = [
  'manual_chat',
  'untrusted_trigger',
  'cron_headless',
  'im_chat',
  'matter_followup',
  'contact_governance'
] as const
export type AgentContextMode = (typeof AGENT_CONTEXT_MODES)[number]

/** Fail-closed normalization: only the five known modes pass through; absent / unknown / any
 *  client-supplied junk → 'untrusted_trigger' (the strictest of the general-purpose modes). This
 *  is the ONLY way a mode enters the policy layer, so "forgot to pass the mode" always degrades
 *  toward safety. */
/** tool name → policy class, per ADR-001 §4. Single source of truth: types.ts resolves each
 *  audited write/send tool's class from this map, and applyContextModePolicy filters the assembled
 *  ToolSet by it. Mirrored into tests/agent_eval/tool_catalog.json as `tool_class` (policy.test.ts
 *  asserts the two stay in sync). */
export const GATEWAY_TOOL_CLASSES: Record<string, GatewayToolClass> = {
  // read — no side effects (silent tier; untrusted content in results is fenced at the tool).
  email_list_filter: 'read',
  email_search_fulltext: 'read',
  matter_find: 'read',
  matter_get: 'read',
  // 0813 轮 3 批 R — attention signals / run history / tag vocabulary. Class `read` is not a
  // convenience label here: it is what puts them inside a follow-up run's face (the
  // matter_followup row admits reads wholesale), which is the point — a run that cannot see its
  // own past conclusions re-derives them every round.
  matter_attention_list: 'read',
  matter_runs_list: 'read',
  matter_tags_list: 'read',
  // Contact Directory WP7 — the directory read face. Class `read` is what puts them inside a
  // governance run (the contact_governance row admits reads wholesale) AND keeps them out of
  // every approval ladder: none of the three touches a row.
  contact_search: 'read',
  contact_get: 'read',
  contact_list_mails: 'read',
  // 资料库 P1-L7 — the library read face. Class `read` is what keeps them out of every approval
  // ladder (none touches a file) AND what will put them inside an unattended run once the P2
  // capability card exists; the untrusted file text they return is fenced at the tool
  // (LIBRARY_FILE), exactly like email_attachment_text.
  library_list: 'read',
  library_read: 'read',
  library_search: 'read',
  // 资料库 P2-L1 — the four writes. domain_write on purpose: in-domain and cheap to undo (every
  // write leaves a full snapshot in library_history, delete is a .trash move with restore) — the
  // matter family's argument. The class is ALSO the headless boundary: a matter_followup /
  // contact_governance matrix row denies the whole class, so no belt admits them by accident
  // (P2-L3 opens library_append there by NAME, the MATTER_RUN_PROPOSE_TOOL precedent).
  library_append: 'domain_write',
  library_write: 'domain_write',
  library_move: 'domain_write',
  library_delete: 'domain_write',
  artifact_write: 'domain_write',
  artifact_publish_bundle: 'domain_write',
  email_get: 'read',
  email_body: 'read',
  email_list_thread: 'read',
  email_search_attachments: 'read',
  // attachment-awareness reads (thread attachment metadata + one attachment's extracted text —
  // the text is UNTRUSTED_ATTACHMENT_TEXT-fenced at the tool).
  email_thread_attachments: 'read',
  email_attachment_text: 'read',
  kos_query: 'read',
  // issue #57 — extra KOS read tools (keyword search / page read / expert lookup / page
  // listing / backlinks). All silent reads, same class as kos_query.
  kos_search: 'read',
  kos_get_page: 'read',
  kos_find_experts: 'read',
  kos_list_pages: 'read',
  kos_get_backlinks: 'read',
  report_list: 'read',
  report_get: 'read',
  // W6 — suggest_followups: a silent no-op the model calls at the end of a manual answer with
  // 2-3 next-question suggestions (renderer chips). Class 'read' (no side effects, never
  // approval-gated); registration is ADDITIONALLY venue-gated to manual_chat in
  // buildGatewayTools (interactive UI supply — the class matrix's "reads register everywhere"
  // does not apply to it; see the registration comment + policy.test.ts carve-out).
  suggest_followups: 'read',
  plan_update: 'read',
  skill_draft_create: 'capability_change',
  skill_draft_write_file: 'capability_change',
  skill_draft_read: 'capability_change',
  skill_draft_validate: 'capability_change',
  skill_draft_publish: 'capability_change',
  skill_draft_discard: 'capability_change',
  // artifact — local, deletable/replaceable output. It never leaves the machine and never needs
  // an approval card; unlike domain_write it is available silently in every context mode.
  report_write: 'artifact',
  // Matters MVP P4 (D6) — a Matter follow-up run's ONLY output channel: it writes a PENDING
  // proposal (matter_update row, review_status='pending'), never the Matter's own state. Same
  // artifact shape as report_write (silent, no guard, no card): the owner's later
  // matter_review_update is what commits anything, so the proposal itself is a local, reviewable,
  // discardable artifact. It is the ONE class the matter_followup row admits besides 'read', and
  // it only ever REGISTERS inside a matter-run context (tools/index.ts).
  matter_update_propose: 'artifact',
  // L4 批次3 (task 08-25) — an ITEM-dispatch run's ONLY output channel. Same artifact shape and
  // same reasoning as matter_update_propose: it writes either a PENDING proposal or a question
  // onto the dispatch row, never the Matter's own state (even the autonomous profile commits
  // through the ordinary accept kernel, server-side). It registers ONLY inside an item-run
  // context (tools/index.ts), and the matter_followup row admits it BY NAME
  // (MATTER_RUN_ARTIFACT_TOOLS) — never by class.
  matter_item_report: 'artifact',
  // Contact Directory WP7 — the governance scan's ONLY output channel: each writes a PENDING
  // `contact_suggestion` row (status='pending'), never the contact's own fields. Same artifact
  // shape as matter_update_propose (silent, no guard, no card): the owner's later adopt/ignore on
  // /api/contacts/suggestions is what commits anything, so the proposal itself is a local,
  // reviewable, discardable artifact. They are the ONE class the contact_governance row admits
  // besides 'read', and only under these exact NAMES (CONTACT_PROPOSE_TOOLS).
  contact_propose_update: 'artifact',
  contact_propose_merge: 'artifact',
  contact_propose_relation: 'artifact',
  chat_session_list: 'read',
  chat_session_search: 'read',
  chat_session_get: 'read',
  agent_catalog_list: 'read',
  agent_catalog_get: 'read',
  agent_profile_read: 'read',
  agent_profile_history: 'read',
  discover_skills: 'read',
  tool_search: 'read',
  // domain_write — reversible in-domain writes (cheap to undo); the only class auto-approve may
  // ever relax, and only in manual_chat.
  email_flag: 'domain_write',
  email_archive: 'domain_write',
  email_pin: 'domain_write',
  email_resync: 'domain_write',
  email_draft_reply: 'domain_write',
  // prd 07-27 — the other two draft writes (create new/forward, edit an existing draft). Same risk
  // face as email_draft_reply: they only write the Drafts folder, nothing leaves the machine.
  email_draft_compose: 'domain_write',
  email_draft_update: 'domain_write',
  matter_create: 'domain_write',
  matter_update: 'domain_write',
  matter_item_mutate: 'domain_write',
  // task 08-25 — curated 进展 lane 的写面。同 class 同理由：本地、可审计、软删可 restore。
  // 🔴 class 也是这里的**安全边界**：domain_write ⇒ 跟进 run 的矩阵行整类拒绝 ⇒ 那条无人值守
  // 的 run 结构上写不了进展，只能提案（changes_json 的 kind='progress'）等 owner 拍板。
  matter_progress_mutate: 'domain_write',
  matter_resource_mutate: 'domain_write',
  matter_stakeholder_mutate: 'domain_write',
  matter_relation_mutate: 'domain_write',
  matter_add_note: 'domain_write',
  // Matters MVP P4 (D8) — the two REVIEW-side tools an owner-present session uses to drive the
  // follow-up loop: start/cancel a run, and accept/reject a pending proposal. Both are
  // in-domain and reversible-by-compensation (a cancel does not roll back what a run已 observed;
  // an accepted Update is corrected by a new Manual Update), hence domain_write rather than
  // capability_change — the follow-up Agent's own capability face is fixed by the matter_followup
  // matrix row, not by these calls. 🔴 matter_review_update carries the DYNAMIC approval
  // (policyEvaluate, matters.ts): non-manual venues 恒卡, manual reject免卡, manual accept touching
  // a `field` change asks.
  matter_run_control: 'domain_write',
  matter_review_update: 'domain_write',
  // 0813 轮 3 批 R — the disposal half of the two read surfaces above. domain_write on purpose:
  // it keeps them out of a follow-up run (the matrix row denies the class outright), so a run can
  // surface an attention signal or a resource suggestion but never quietly clear it.
  matter_attention_triage: 'domain_write',
  matter_suggestion_resolve: 'domain_write',
  // Contact Directory WP7 — the 直写 contact tools. domain_write on purpose: each one writes
  // reversible columns on the owner's own directory (kind can be set back; a former-email
  // mark is undone by the same endpoint; a profile refresh only recomputes a derived document;
  // an identity field is re-editable and a manager link is re-settable/clearable).
  // The class is ALSO what keeps them out of a governance run — that row denies domain_write
  // outright, so the scan can propose a kind change but never apply one.
  contact_set_kind: 'domain_write',
  contact_mark_former_email: 'domain_write',
  contact_refresh_profile: 'domain_write',
  // The two direct-edit tools (owner 拍板「chat 里直接改字段」). Same class for the same reason:
  // they hit the SAME endpoints as the directory UI's manual edit (PATCH /contacts/{id} and
  // POST /contacts/{id}/manager) and are equally reversible — and the class is what keeps the
  // unattended governance scan structurally unable to reach them, so identity fields and the
  // reporting line remain propose-only for the scan even though a manual chat may now set them.
  contact_update_fields: 'domain_write',
  contact_set_manager: 'domain_write',
  // task 08-14 — 跟进配置的逐条编辑。🔴 有意**不是** domain_write：改的是一个无人值守、有网络
  // 出口的 run 的触发条件，与 internal_agent_update 同待遇（PRD D8）。代价是 im_chat 里改不了
  // 跟进节奏 —— owner 知情接受。两种 class 都挡住「跟进 run 改自己的跟进配置」。
  matter_followup_mutate: 'capability_change',
  // capability_change — changes the agent's own capability/identity surface. NEVER auto-approved
  // by the auto-reversible path, manual_chat-only, in every future mode permanently denied
  // (ADR-001 §9 red line).
  // 07-16 approval-mode 注记: the §9 red line describes the MANUAL default state; the owner-global
  // mode (agent_config.db, Settings/composer UI only — no gateway tool can switch it) is an
  // explicit owner-wide override applying ONLY in manual_chat.
  // 08-05 WP-11 注记: the by-name acceptEdits allow-list is retired — card-free execution in
  // manual is now decided by the owner's PER-TOOL approval tier (Python tool_prefs.py registry;
  // identity/memory/skill-toggle edits default 'ask' but are owner-configurable to 'auto';
  // skill_install/confirm + custom_agent create/update/delete stay non-configurable 恒 ask) and
  // by 'bypass' (auto-approves everything, D1=a). The headless "permanently denied outside
  // manual" half of the red line is untouched — prefs are never threaded into non-manual runs.
  set_skill_enabled: 'capability_change',
  update_system_md: 'capability_change',
  agent_profile_restore: 'capability_change',
  agent_memory_update: 'capability_change',
  // S2 W4 — the skill supply chain (install/uninstall) IS the capability surface. Two-step
  // install = two HITL cards; no whitelist hook exists for this class (unlike exec).
  skill_install: 'capability_change',
  skill_install_confirm: 'capability_change',
  skill_uninstall: 'capability_change',
  // S5 W3 — conversational custom-agent CRUD. Building/editing/running an agent that HOLDS tools is
  // a change to the assistant's own capability surface (ADR-004 P5): all six are capability_change,
  // so the matrix floor keeps them manual_chat-only (a headless run can never build/edit/run agents)
  // and they never auto-approve. list/get are silent reads but classed here so the WHOLE CRUD
  // surface (reads included) stays a manual-session capability face.
  custom_agent_list: 'capability_change',
  custom_agent_get: 'capability_change',
  custom_agent_create: 'capability_change',
  custom_agent_update: 'capability_change',
  custom_agent_delete: 'capability_change',
  custom_agent_run_now: 'capability_change',
  custom_agent_call: 'capability_change',
  // task 08-14 — 内建 agent（report/search/preprocess/project_progress）的工具面。与
  // custom_agent_* 同 class：改一个自动运行的 agent 的排程 / 模型 / prompt 同样是对助手能力面的
  // 改动。list/get 是 silent read，同样归入本 class，让整个 CRUD 面（含读）留在 manual 会话里。
  internal_agent_list: 'capability_change',
  internal_agent_get: 'capability_change',
  internal_agent_update: 'capability_change',
  // L4 群聊 g2 — 群工具面（labs labs_group_agents）。建群 / 投递直接改「哪些 agent 在跑、谁能
  // 收到什么」，与 custom_agent_* 同一条论证；两个读也归本 class（同 custom_agent_list/get 先例：
  // 让整个群面留在 manual 会话里）。class 只管 headless / im 的结构性缺席 —— 成员 / 法官工厂是
  // 群 run 内不经 buildGatewayTools 的第二条注册路径，它们的场地由服务端 identity.group 决定。
  group_history: 'capability_change',
  group_members: 'capability_change',
  group_post: 'capability_change',
  group_create: 'capability_change',
  // S2 W4 — skill_read is a silent read (its third-party content is SKILL_DOC-fenced at the tool).
  skill_read: 'read',
  skill_read_resource: 'read',
  // calendar epic 4.1 — calendar reads (event text is CALENDAR_EVENT-fenced at the tool).
  calendar_events_list: 'read',
  calendar_event_get: 'read',
  // calendar epic 4.2 — calendar writes: in-domain CalDAV/iTIP mutations of the owner's own
  // calendar. domain_write keeps them REGISTERED in headless runs where the always-ask edit tier
  // stashes → paused_handoff (the D4 headless semantics); they can never auto-approve because all
  // three are edit-tier (mayAutoApprove additionally requires preview) AND their factory wires no
  // policyEvaluate — no whitelist/免卡 channel exists (恒 HITL). The RSVP's outbound iTIP REPLY is
  // recipient-pinned server-side (organizer from the event row; the model has no recipient field),
  // which is why it is not class 'outbound' (that row would unregister it headless and remove the
  // paused_handoff path entirely).
  calendar_event_reschedule: 'domain_write',
  calendar_event_rsvp: 'domain_write',
  calendar_event_delete: 'domain_write',
  // web — outbound network reads (S6 W3, ADR-004 rev3.1 §3.1: migrated OUT of 'outbound' so the
  // per-agent `web` grant maps 1:1 to a class without ever admitting send). Both edit-tier
  // always-ask in manual; in a headless agent run they register only under grant_web∈{gated,open}
  // and the免卡 shape is per-tier (gated fetch = origin whitelist policyEvaluate; open fetch +
  // web_search = grant-level local verdict).
  web_fetch: 'web',
  web_search: 'web',
  // outbound — data irreversibly leaves the machine toward a chosen recipient (send). manual_chat
  // -only; send is blocking always-ask (its needsApproval hard-returns true regardless of anything
  // here) and has NO grants key — structurally un-grantable, same level as capability_change.
  email_prepare_send: 'outbound',
  // notion_agent_chat (task 07-21) — delegates the request (prompt, possibly carrying workspace
  // data) to an EXTERNAL AI (the notion-agent CLI) whose side effects land on the Notion side. It
  // is edit-tier always-ask in manual_chat (恒 HITL — the factory wires no policyEvaluate, so no
  // whitelist/免卡 channel exists). Class 'outbound' — data egresses the machine and there is NO
  // grants key, so a headless custom-agent run never gets it (放宽留给后续 grant 体系); that is the
  // MVP-safe default (mirrors the send row's un-grantable stance, not a recipient send).
  notion_agent_chat: 'outbound',
  // submit_feedback (task 08-27 P4a) — 一条反馈（含 owner 写的正文、可选邮箱、可选诊断包）
  // 离开本机进 owner 的 Notion 反馈库。class 'outbound' 是这里的**安全地板**：manual_chat
  // 之外既不注册也不执行，且 outbound 没有 grants key —— 结构上不可能被 per-agent grant
  // 放宽（与 email_prepare_send / notion_agent_chat 同一档）。edit-tier 恒 ask，工厂不接
  // policyEvaluate、不接 per-tool 档（tool_prefs configurable=False），所以「以后都自动」
  // 这条路在四个层面上都不存在。
  submit_feedback: 'outbound',
  // generate_image (task 09-02) — the prompt (and any source images the user attached / a prior
  // generation) leave the machine toward the configured image provider (IMAGE_GEN_MODEL). Class
  // 'outbound' for the same reason as notion_agent_chat: owner-authored content egresses to an
  // external service, there is NO grants key, so a headless / im run structurally never gets it
  // (the prd's「headless 排除」is this class row, not a venue gate). Unlike the send it is a local
  // artifact producer — tool_prefs.py ships it default auto (owner-configurable ask / deny).
  generate_image: 'outbound',
  // exec — local command / filesystem (S2 W1). manual_chat-only; all three are edit-tier always-ask
  // (never auto-approved by approvalMode) UNLESS a structured PolicyRule whitelist the owner set
  // matches (needsApproval consults /api/agent/policy/evaluate — auto_allow skips the card,
  // ask/error fail-closed to the card).
  run_command: 'exec',
  file_read: 'exec',
  file_write: 'exec',
  computer_use_run: 'exec'
}

export function registerRuntimeToolClass(
  name: string,
  toolClass: GatewayToolClass,
  destructive?: boolean
): void {
  registerDynamicToolClass(GATEWAY_TOOL_CLASSES, name, toolClass, destructive)
}

export function classOfTool(name: string): GatewayToolClass {
  return resolveToolClass(GATEWAY_TOOL_CLASSES, name)
}

export function normalizeContextMode(value: unknown): AgentContextMode {
  return (AGENT_CONTEXT_MODES as readonly unknown[]).includes(value)
    ? (value as AgentContextMode)
    : 'untrusted_trigger'
}

/** task 09-02 — the per-agent chat-history READ RADIUS of the three chat_session_* tools (which
 *  register in every custom-agent run regardless of allowed_tools): 'own' = only sessions whose
 *  agent_id is this agent (default), 'all' = every agent's history. NOT a matrix input (the tools
 *  are class 'read' and always admitted) — it only decides the X-MailAgent-Allow-All-History header
 *  the serve-api enforces. */
export type SessionsGrant = 'own' | 'all'

/** Stage 1 PR3 (harness-expansion epic, grill Q2/Q3=B) — a per-connector crud CEILING of a
 *  headless custom-agent run. 🔴 The vocabulary is read < write < update and deliberately has NO
 *  'delete' member (grill Q3=B: the ceiling value-domain excludes delete; Python rejects it at
 *  store time, this type makes it unrepresentable gateway-side). */
export type ConnectorGrant = 'read' | 'write' | 'update'

/** The ceiling ORDER (PR3 contract: read=1 < write=2 < update=3). A connector tool registers in a
 *  headless run iff rank(crud_type) ≤ rank(ceiling); delete/unknown cruds never rank (they are
 *  skipped before ranking — Q16=A). Shared by the registration filter (connector.ts) so the order
 *  can never fork into two hand-copies. */
export const CONNECTOR_CRUD_RANK: Record<ConnectorGrant, 1 | 2 | 3> = {
  read: 1,
  write: 2,
  update: 3
}

/** 0812 dogfood — the three tiers of a Matter follow-up run's web tool face. Declared as a
 *  RUNTIME array (type derived from it) rather than a bare literal union so the two narrowing
 *  sites — agentRun's resolver funnel and the lifecycle's wire read — share ONE vocabulary
 *  instead of each hand-copying the three literals. The belt that interprets a tier lives in
 *  agentRun.ts (matterRunAdmitsWeb); the Python value domain that persists it is
 *  `MATTER_RUN_WEB_FACES` in src/api/routers/agent.py — that ONE cross-language copy is what
 *  tests/config/test_matter_web_face_parity.py pins. */
export const MATTER_RUN_WEB_FACES = ['keep', 'search_only', 'off'] as const
export type MatterRunWebFace = (typeof MATTER_RUN_WEB_FACES)[number]

/** Narrow an untrusted value (an owner-setting wire string, an injected resolver's return) to a
 *  tier; anything else → null and the CALLER picks the fallback. Mirrors parseWebGrant's
 *  discipline — one narrowing funnel, never a literal chain per call site — but deliberately
 *  returns null instead of collapsing to a tier: unlike a grant, the safe fallback here is the
 *  DEFAULT ('keep'), and that decision belongs at the call site where the 🔴 fail-safe rationale
 *  is written, not buried in a parser. */
export function parseMatterRunWebFace(value: unknown): MatterRunWebFace | null {
  return (MATTER_RUN_WEB_FACES as readonly unknown[]).includes(value)
    ? (value as MatterRunWebFace)
    : null
}

/** 0812 codex修复批 — the ONE artifact NAME the matter_followup row admits (not report_write). */
export const MATTER_RUN_PROPOSE_TOOL = 'matter_update_propose'

/** L4 批次3 (task 08-25) — the item-dispatch run's delivery channel. */
export const MATTER_ITEM_REPORT_TOOL = 'matter_item_report'

/** P2-L3 (task 09-03) — the ONE library write the three unattended belts admit, BY NAME. */
export const LIBRARY_RUN_APPEND_TOOL: (typeof GATEWAY_LIBRARY_WRITE_TOOL_NAMES)[number] =
  'library_append'

/** The artifact NAMES the matter_followup row admits. */
export const MATTER_RUN_ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  MATTER_RUN_PROPOSE_TOOL,
  MATTER_ITEM_REPORT_TOOL
])

/** Contact Directory WP7 — the THREE artifact NAMES the contact_governance row admits. */
export const CONTACT_PROPOSE_TOOLS: ReadonlySet<string> = new Set([
  'contact_propose_update',
  'contact_propose_merge',
  'contact_propose_relation'
])

/** Registration-time matrix row (ADR-001 D3, exec row revised by ADR-004 D2, web row added by
 *  ADR-004 rev3.1 D2, im_chat row added by stage 0b — grill Q10=A — and opened by stage 2 PR-1
 *  — the 08-04 拍板): may a tool of this class exist in the ToolSet of a run in this mode?
 *  read/domain_write/artifact → every mode; capability_change/outbound → manual_chat only (permanently —
 *  no grant key exists for them); exec → manual_chat, OR a non-manual run whose per-agent grants
 *  carry exec===true; web → manual_chat, OR a non-manual run whose grants carry web∈{gated,open}
 *  (the owner's explicit opt-in, spec-derived — any other value incl. junk is 'off'), OR an
 *  im_chat run under the MAILAGENT_IM_WEB_ENABLED venue switch (Q19=A — `venue`, never a grant);
 *  connector_write (PR3) → manual_chat, OR a non-manual run whose grants carry a connectors record
 *  with ANY write-capable ceiling (coarse class gate — per-connector precision lives at
 *  registration, see the row comment below), OR im_chat (stage 2 PR-1: connector 全开放 —
 *  registered + 恒 HITL, grants not consulted). `grants` is
 *  only ever passed by the headless agent-run path; manual callers omit it (undefined = the
 *  pre-ADR-004 matrix, so a forgotten param is always SAFER, never wider).
 *  im_chat stays a hard floor for exec/capability_change/outbound: grants are deliberately NOT
 *  consulted in this mode (AgentModeGrants is the per-agent HEADLESS axis; the IM web opt-in is
 *  the separate `venue` switch), so a mis-threaded grants object can never widen an im run. */
export function isToolClassAllowedInMode(
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches,
  /** 0812 codex修复批 — read ONLY by the two propose-only rows (matter_followup /
   *  contact_governance), where artifact admission is BY NAME (MATTER_RUN_PROPOSE_TOOL /
   *  CONTACT_PROPOSE_TOOLS); every other mode ignores it, so an omitted argument (types.ts's
   *  runtime modeDenied belt, every existing caller/test) is byte-identical outside those runs and
   *  FAIL-CLOSED inside them (no name → no artifact). */
  toolName?: string
): boolean {
  if (mode === 'manual_chat') return true
  // Matters MVP P4 (D5) — 🔴 this row MUST stay ABOVE the generic read/domain_write/artifact line
  // below: that line admits domain writes in every non-manual mode, so a matter_followup branch
  // placed after it could no longer deny them. A follow-up run observes and PROPOSES; the classes
  // it may hold are 'read' + 'artifact' — and 'artifact' ONLY under the one propose NAME (0812
  // codex修复批: the class also contains report_write, a LOCAL WRITE — whole-class admission was
  // the hole that let an allowedTools list pull it into an unattended run) — + since the 0812
  // owner拍板 (「全部只读工具，一个写工具都不给」) 'web' under the spec-authored read grant (the
  // same gated/open literals as the generic headless row; run_spec.py is the only author of that
  // grant, a profile's grants are never copied into a matter spec). Everything write-capable
  // (domain_write / connector_write / exec / capability_change / outbound) returns false BEFORE
  // the grant ladder below — grant_exec can never lift exec here, and venue switches are never
  // consulted (connector READS are class 'read', already admitted; connector WRITES stay denied
  // even under a tampered write/update ceiling).
  if (mode === 'matter_followup') {
    if (toolClass === 'read') return true
    if (toolClass === 'artifact')
      return toolName !== undefined && MATTER_RUN_ARTIFACT_TOOLS.has(toolName)
    if (toolClass === 'web') return grants?.web === 'gated' || grants?.web === 'open'
    return false
  }
  // Contact Directory WP7 — 🔴 this row MUST stay ABOVE the generic read/domain_write/artifact
  // line below for the same reason the matter row does: that line admits domain writes in every
  // non-manual mode, so a contact_governance branch placed after it could no longer deny them and
  // the scan would inherit contact_set_kind / email_flag / every other reversible write. The scan
  // observes and PROPOSES; the classes it may hold are 'read' + 'artifact' under the three propose
  // NAMES. 'web' is deliberately NOT admitted (one notch tighter than matter_followup): a
  // directory scan has no network job, and src/contacts/governance.py authors no web grant — so
  // even a tampered grants object lifts nothing here. Everything write-capable (domain_write /
  // connector_write / exec / capability_change / outbound) returns false BEFORE the grant ladder
  // below, and venue switches are never consulted (connector READS are class 'read' and already
  // admitted; connector WRITES stay denied under any tampered ceiling).
  if (mode === 'contact_governance') {
    if (toolClass === 'read') return true
    if (toolClass === 'artifact')
      return toolName !== undefined && CONTACT_PROPOSE_TOOLS.has(toolName)
    return false
  }
  if (toolClass === 'read' || toolClass === 'domain_write' || toolClass === 'artifact') return true
  // Stage 2 PR-1 (08-04 拍板) — im_chat: connector tools fully open (write approval follows the
  // 08-05 per-tool tier: ask → Feishu card, auto → card-free — decided at the connector factory,
  // not here); web only under the venue switch (Q19=A — exact `=== true`, never
  // a grant); exec / capability_change / outbound 直接不给. Grants can lift NOTHING in this mode.
  if (mode === 'im_chat') {
    if (toolClass === 'connector_write') return true
    if (toolClass === 'web') return venue?.imWebEnabled === true
    return false
  }
  if (toolClass === 'exec') return grants?.exec === true
  if (toolClass === 'web') return grants?.web === 'gated' || grants?.web === 'open'
  // connector_write (stage 1 PR3, grill Q2): lifted when the per-agent connector grants carry ANY
  // write-capable ceiling ('write'/'update'; re-parsed fail-closed — junk/'read'-only/empty deny).
  // 🔴 This row is deliberately a COARSE class-level gate: it cannot see WHICH connector a tool
  // belongs to (class is per-tool-class, not per-tool). The per-connector / per-tool precision is
  // guaranteed at REGISTRATION (createConnectorTools only ever builds tools whose connector is in
  // the grants AND whose crud rank ≤ that connector's ceiling), so a ToolSet reaching this row can
  // only contain grant-covered connector writes — the row exists so applyContextModePolicy doesn't
  // strip them wholesale. A leaked/forged connector write outside that construction still hits the
  // registration whitelist server-side (Python rejects unsynced/undisclosed names).
  if (toolClass === 'connector_write') return hasConnectorWriteGrant(grants?.connectors)
  // capability_change + outbound: false under ANY grants (structurally un-grantable).
  return false
}

/** WS-5 — tool-name-aware context admission consumed by BOTH `applyContextModePolicy` and
 *  `auditedWriteTool` (`types.ts`). Keeps `isToolClassAllowedInMode('exec', 'matter_followup', ...)`
 *  strictly `false` so `run_command`/general `exec` stay locked while admitting `computer_use_run`
 *  exclusively when `matterItemComputerUse` or `customAgentComputerUse` is verified. */
export function isToolAllowedInContext(
  toolName: string,
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches
): boolean {
  return evaluateToolAllowedInContext(
    toolName,
    toolClass,
    mode,
    isToolClassAllowedInMode,
    grants,
    venue
  )
}

/** Filter an assembled ToolSet by the context mode — the LAST step of buildGatewayTools. */
export function applyContextModePolicy(
  tools: ToolSet,
  mode: AgentContextMode,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches
): ToolSet {
  return filterToolsByContextMode(tools, mode, isToolClassAllowedInMode, classOfTool, grants, venue)
}
