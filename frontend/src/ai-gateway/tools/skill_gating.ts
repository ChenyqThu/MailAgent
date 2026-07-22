// mem0/skill 核心重构 epic M4a — AI SDK Gateway 的 skill→tool 门控。
//
// 「发现4」真 bug 收口：v0.20.0 cutover 后 gateway 注册工具**不读** skill 启用态 —— 用户在
// Settings 关掉某 skill，模型经 capabilities 块被「告知」它关了，但其工具仍注册、仍可调。
// applySkillGating 据 Python /chat/config 下发的 advertisedSkills（= enabled(override ?? default)
// && available 的 skill 名）删掉「归属 skill 未 advertised」的工具，复刻 legacy
// legacy skill_enablement.computeSkillEnablement（S3 已删）的 advertised-owner-wins 语义。
//
// 数据所有权（计划档决策 1）：哪些 skill 对模型可见 = 业务态 = Python 拥有（advertisedSkills）；
// gateway-工具→skill 映射 + 据此过滤 = 工具集结构 = Node 拥有（本文件）。两边各管自己拥有的，
// 无谁硬编码对方清单。
//
// flag MAILAGENT_SKILL_SELF_MOUNT（default off，纯后端 main-process gateway，**不进 vite define**）
// 在 buildGatewayTools 处门 applySkillGating；flag-off / advertisedSkills 缺失 → 不调 → ToolSet
// 字节级同 cutover 集。

import type { ToolSet } from 'ai'

/** gateway-工具名 → 归属 skill（gateway 名贴工具定义，最不漂移；漂移由 skill_gating.test.ts 的
 *  完整性测试守护）。skill key 必须与 Python builtin skill 名一致（email/search/report —— 这是
 *  advertisedSkills 里会出现的名）。当前一个工具只归一个 skill（无共享），但 applySkillGating 仍
 *  实现 legacy 的「任一 advertised owner 即保留」通用语义，以防将来别名工具。
 *
 *  门控范围 = email/search/report 三 skill 的读工具 + notion_agent skill 的 notion_agent_chat（parity）。
 *  collision-exempt 的 email_search + 无 skill 归属的 core（kos/memory/write/send）永不门控（见下两个
 *  集合）；calendar skill 在 gateway 无工具，无需列。
 *
 *  🔴 notion_agent（task 07-21）不同于 CORE_UNGATED 的 web/calendar：它是**skill-gated** —— Settings →
 *  Custom AI → Skills 的 notion_agent 开关（advertisedSkills）就是用户的开/关。skill default_enabled=False，
 *  故默认不 advertised → 关掉即不注册（其余工具家族的 master flag 只是应急 kill-switch，此处同理由
 *  MAILAGENT_NOTION_AGENT_TOOL 兜底）。 */
export const GATEWAY_SKILL_TOOLS: Record<string, readonly string[]> = {
  email: ['email_get', 'email_body', 'email_list_thread'],
  search: ['email_search_fulltext', 'email_search_attachments'],
  report: ['report_list', 'report_get'],
  notion_agent: ['notion_agent_chat']
}

/** 跨 skill 同名异义、不可被 skill toggle 误删的工具（复刻 legacy COLLISION_EXEMPT_TOOL_NAMES）：
 *  builtin email_search 是元数据过滤（agent 主「找邮件」工具），manifest search skill 的 email_search
 *  是 FTS body —— 关 search skill 不该殃及 builtin 元数据搜索。 */
export const COLLISION_EXEMPT_GATEWAY_TOOLS: ReadonlySet<string> = new Set(['email_search'])

/** 不属于任何 skill 的 core 工具，永不被 skill→tool 门控。write/send 另有 writeToolsEnabled/sendToolEnabled
 *  + 审批独立保护，本就不在门控论域。本集合是 skill_gating.test 完整性守护的「显式 core 白名单」一腿：
 *  每个 gateway 工具必须 ∈ GATEWAY_SKILL_TOOLS ∪ COLLISION_EXEMPT ∪ CORE_UNGATED，否则测试红，
 *  强制新增 gateway 工具时有意识归类（防「新读工具漏门控」复发本 bug —— review M2）。 */
export const CORE_UNGATED_GATEWAY_TOOLS: ReadonlySet<string> = new Set([
  'kos_query',
  'email_flag',
  'email_archive',
  'email_pin',
  'email_draft_reply',
  'email_resync',
  'email_prepare_send',
  // M4b/M4c self-mount meta 工具（behind MAILAGENT_SKILL_SELF_MOUNT）—— 无 skill 归属，永不 skill-gated。
  // 列于此让完整性守护（每个 gateway 工具必被分类）通过。
  'update_system_md',
  'discover_skills',
  'set_skill_enabled',
  // S1 R1 chat-session 读工具（behind MAILAGENT_OPENNESS_SESSION_TOOLS）—— 无 skill 归属，开关权
  // 在独立 flag（先例：kos_query + self-mount 三件套），永不 skill-gated。
  'chat_session_list',
  'chat_session_search',
  'chat_session_get',
  // S1 R2 profile-config 工具（behind MAILAGENT_OPENNESS_CONFIG_TOOLS）—— agent 自配置面，
  // 无 skill 归属，开关权在独立 flag，永不 skill-gated。
  'agent_profile_read',
  'agent_profile_history',
  'agent_profile_restore',
  'agent_memory_update',
  // S1 R3 web 工具（behind MAILAGENT_OPENNESS_WEB_TOOLS）—— 联网面，无 skill 归属，开关权在
  // 独立 flag，永不 skill-gated（edit-tier 恒人审 + Python SSRF 防护已是其保护面）。
  'web_fetch',
  'web_search',
  // S2 W1 exec 工具（behind MAILAGENT_OPENNESS_EXEC_TOOLS）—— 本机执行/文件面，无 skill 归属，
  // 开关权在独立 flag，永不 skill-gated（edit-tier 恒人审 + 结构化白名单 + Python inode deny 地板）。
  'run_command',
  'file_read',
  'file_write',
  // S2 W4 skill 供应链工具（behind MAILAGENT_OPENNESS_SKILL_INSTALL）—— agent 自身能力面，
  // 无 skill 归属（它们*管理* skill，不*属于*任何 skill），开关权在独立 flag，永不 skill-gated
  // （install/confirm/uninstall = edit-tier + capability_change 恒人审；skill_read 输出恒围栏）。
  'skill_install',
  'skill_install_confirm',
  'skill_uninstall',
  'skill_read',
  // S5 W3 custom-agent CRUD 工具（behind MAILAGENT_CUSTOM_AGENTS_ENABLED）—— agent 管理面，无 skill
  // 归属（它们*管理* custom agent，不*属于*任何 skill），开关权在独立 flag，永不 skill-gated
  // （list/get silent 读；create/update/delete/run_now = edit-tier + capability_change 恒人审）。
  'custom_agent_list',
  'custom_agent_get',
  'custom_agent_create',
  'custom_agent_update',
  'custom_agent_delete',
  'custom_agent_run_now',
  // calendar epic 4.1/4.2 日历工具（behind MAILAGENT_CALENDAR_AGENT_TOOLS）—— 开关权在独立 flag
  // 非 skill 门控（S1 openness 先例；Python builtin calendar skill 管的是 CLI/manifest 面，与
  // gateway 工具集无映射），永不 skill-gated（读输出恒 CALENDAR_EVENT 围栏；写 edit-tier 恒人审）。
  'calendar_events_list',
  'calendar_event_get',
  'calendar_event_reschedule',
  'calendar_event_rsvp',
  'calendar_event_delete'
])

/** 删掉「归属 skill ∉ advertisedSkills 且无任一 advertised skill 仍拥有它 且非 collision-exempt」的
 *  工具 key，返回新 ToolSet（不 mutate 入参）。复刻 legacy computeSkillEnablement 第二步：先按 advertised
 *  把工具名分区（一个名可能被多个 skill 拥有 → 任一 advertised owner 即保留，防别名误删），再删
 *  「无 advertised owner」的非豁免名。core 工具（不在 GATEWAY_SKILL_TOOLS）天然不入 nonAdvertised
 *  → 永不删。键顺序保留（Object.entries）。纯函数，可单测。
 *
 *  advertisedSkills=[]（全禁）→ 所有 mapped skill 工具皆 nonAdvertised → 全删（保留 exempt + core）。
 *  调用方（buildGatewayTools）在 advertisedSkills 为 null（Python hiccup）时 fail-open 不调本函数。 */
export function applySkillGating(tools: ToolSet, advertisedSkills: readonly string[]): ToolSet {
  const advertised = new Set(advertisedSkills)
  const advertisedToolNames = new Set<string>()
  const nonAdvertisedToolNames = new Set<string>()
  for (const [skill, toolNames] of Object.entries(GATEWAY_SKILL_TOOLS)) {
    const sink = advertised.has(skill) ? advertisedToolNames : nonAdvertisedToolNames
    for (const name of toolNames) sink.add(name)
  }
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    const drop =
      nonAdvertisedToolNames.has(name) &&
      !advertisedToolNames.has(name) &&
      !COLLISION_EXEMPT_GATEWAY_TOOLS.has(name)
    if (!drop) out[name] = t
  }
  return out
}
