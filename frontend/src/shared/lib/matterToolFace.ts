// 跟进 Agent（matter_followup 场地）的**工具面清单** —— 全局配置弹窗如实列出来的那份表。
//
// 🔴 零依赖叶子：本文件只导出常量与类型，**不 import 任何 electron / store / AI SDK / i18n**
// （唯一的 import 是同为「纯 TS、零 import」的 connector 命名单源 mcpToolName.ts —— 见文件末尾，
// 那是「消灭镜像」而不是引入依赖）。
// 组件从这里渲染，不许把清单硬编码在 tsx 里 —— 硬编码的清单没有任何东西盯着它，
// gateway 那边加一个读工具，界面就开始少说一件事（而少说 = 界面在撒谎）。
//
// 🔴 这不是权威，权威是 gateway 真实装配出来的 ToolSet（agentRun.ts 的 matter 腰带 +
// policy.ts 的 matter_followup 矩阵行按 CLASS 推导）。本表是那份 ToolSet 的**说明书**，
// 二者的相等关系由 `frontend/tests/ai-gateway/matter_tool_face_leaf.test.ts` 双向钉死：
//   (a) 表里的每个名字都必须真的在工具面里（不许有幽灵条目）；
//   (b) 工具面里的每个名字都必须落在某个分组里（不许有藏起来的能力）。
// 那条闸跑的是真实的 runHeadlessAgent + buildGatewayTools，不是另一份手抄名单。
//
// 🔴 三个「看起来该在、实际不在」的名字，有意不列（列了闸就红 —— 这正是闸的价值）：
//   · `suggest_followups` —— class 'read'，但注册时另有 **manual_chat 场地门**
//     （tools/index.ts：追问 chips 离开 composer 没有意义，且它的 hasToolCall 停机条件
//     会提前结束无人值守 run）。跟进 run 结构上拿不到它。
//   · `agent_catalog_list` / `agent_catalog_get` —— 注册条件是
//     `allowedTools` 含 `chat_session_list`，而 matter spec 的 allowedTools 被
//     `agentRunContextFromSpec` **恒置 []**（0812 codex 修复批）。跟进 run 结构上拿不到。
//   · `report_write` —— 与 `matter_update_propose` 同为 artifact class，但 matter 腰带的
//     artifact 豁免是**按名**的，只放行提案通道这一个（report_write 是本地写）。
//
// 🔴 `fixed` ≠ 「一定拿得到」：带 `skill` 的那几组受 **skill 门控** —— owner 在
// 设置 → Custom AI → Skills 关掉某个 skill，跟进 run 真的一件都拿不到（gateway 两道
// applySkillGating：全局 advertisedSkills × per-agent MOUNT，交集才活）。`fixed` 说的是
// 「**事项级**不可改」，不是「全局关不掉」。界面必须按 advertisedSkills 把关掉的那组标出来
// （见 isMatterToolGroupAvailable），否则又是一句谎。
//
// 分组顺序 = 界面渲染顺序（事项自己的通道在最前，可改的网页档在最后）。

import { MCP_TOOL_PREFIX } from '../assistant/tools/mcpToolName'

/** 一个分组的档位：`fixed` = 系统固定、事项级不可改；`configurable` = owner 可在本弹窗里改。 */
export type MatterToolTier = 'fixed' | 'configurable'

export interface MatterToolGroup {
  /** i18n key 后缀（`matters.globalAgent.toolFace.groups.<id>.{label,desc}`）。 */
  id: string
  tier: MatterToolTier
  /** gateway 工具名（标识符，不翻译 —— 界面按等宽 chip 原样呈现）。 */
  tools: readonly string[]
  /**
   * 这一组归属的 **skill**（= 设置 → Custom AI → Skills 里那个开关的名字，也是
   * `/chat/config.advertisedSkills` 里会出现的名）。有值 ⇒ 整组受 skill 门控；
   * 缺省 ⇒ core（`CORE_UNGATED_GATEWAY_TOOLS`），永不被 skill 开关影响。
   *
   * 🔴 **一组只能归一个 skill** —— 组是界面上「可用 / 已关闭」的最小单位，一组横跨两个
   * skill 时「这一组是否可用」根本没有真值。所以邮件家族在这里**拆成两组**
   * （`email` = 邮件读；`search` = 全文检索），与 gateway `GATEWAY_SKILL_TOOLS` 的归属逐项
   * 对齐 —— 这份对齐由 `tests/ai-gateway/matter_tool_face_leaf.test.ts` 的「关掉一个 skill，
   * 真实工具面里消失的那批 == 叶子里标了该 skill 的那批」用例双向钉死（标错 / 漏标 / 多标
   * 都会红）。
   */
  skill?: string
}

export const MATTER_TOOL_FACE_GROUPS: readonly MatterToolGroup[] = [
  {
    id: 'matter',
    tier: 'fixed',
    // 读五件 + 唯一产出通道（提案）。少了它跟进 run 连自己这条事项都读不到，故恒启用。
    tools: [
      'matter_find',
      'matter_get',
      'matter_attention_list',
      'matter_runs_list',
      'matter_tags_list',
      'matter_update_propose'
    ]
  },
  {
    id: 'contacts',
    tier: 'fixed',
    tools: ['contact_search', 'contact_get', 'contact_list_mails']
  },
  {
    id: 'email',
    tier: 'fixed',
    skill: 'email',
    tools: [
      'email_list_filter',
      'email_get',
      'email_body',
      'email_list_thread',
      'email_thread_attachments',
      'email_attachment_text'
    ]
  },
  {
    id: 'search',
    tier: 'fixed',
    // 🔴 与上一组同为「邮件」，但归 **search** skill（gateway GATEWAY_SKILL_TOOLS.search）——
    // 关掉 search 只掉这两件，邮件读族照常。合成一组就说不清是哪个开关关掉了它们。
    skill: 'search',
    tools: ['email_search_fulltext', 'email_search_attachments']
  },
  { id: 'calendar', tier: 'fixed', tools: ['calendar_events_list', 'calendar_event_get'] },
  {
    id: 'session',
    tier: 'fixed',
    tools: ['chat_session_list', 'chat_session_search', 'chat_session_get']
  },
  {
    id: 'kos',
    tier: 'fixed',
    tools: [
      'kos_search',
      'kos_query',
      'kos_get_page',
      'kos_list_pages',
      'kos_get_backlinks',
      'kos_find_experts'
    ]
  },
  { id: 'report', tier: 'fixed', skill: 'report', tools: ['report_list', 'report_get'] },
  {
    id: 'introspection',
    tier: 'fixed',
    tools: [
      'discover_skills',
      'skill_read',
      'agent_profile_read',
      'agent_profile_history',
      'plan_update'
    ]
  },
  {
    id: 'web',
    tier: 'configurable',
    // 唯一可改的一组 —— 三档由 owner_settings `matter_run_web_face` 决定
    // （MATTER_RUN_WEB_FACES / agentRun.ts 的 matterRunAdmitsWeb 腰带）。
    tools: ['web_search', 'web_fetch']
  }
]

/** 已连接 connector 的只读工具名前缀 —— 运行时按 `grantConnectors` 动态注册，
 *  名字来自远端 manifest，结构上不可能出现在任何静态清单里。界面按「已连接哪几家」
 *  动态渲染这一组；闸也按这个前缀把它们排除在静态比对之外。
 *
 *  🔴 **不手抄 `'mcp__'` 字面量** —— 命名单源是 `assistant/tools/mcpToolName.ts`
 *  （`isMcpToolName` / `mcpGatewayToolName` 都从它出）。抄一份的后果不是「闸静默变绿」而是
 *  更隐蔽的一种：前缀一改，闸 (b) 会把所有 connector 工具报成「藏起来的能力」，红得莫名其妙，
 *  而界面那一组还照旧渲染。它本身零 import、纯 TS，import 它不破坏本文件的零依赖叶子属性。 */
export const MATTER_TOOL_FACE_DYNAMIC_PREFIX = MCP_TOOL_PREFIX

/** 静态分组里出现过的全部工具名（闸的比对面）。 */
export const MATTER_TOOL_FACE_STATIC_TOOLS: readonly string[] = MATTER_TOOL_FACE_GROUPS.flatMap(
  (group) => group.tools
)

/**
 * 这一组现在**真的挂得上**吗（= 界面该不该把它标成「已关闭」）。
 *
 * `advertisedSkills` = `/chat/config.advertisedSkills`，与喂给生产 `buildGatewayTools` 的是同
 * 一份投影（`ai_gateway_lifecycle.ts` 的 `_systemPromptCache.value.advertisedSkills`）。
 *
 * 🔴 **null / undefined 一律判可用（fail-open）** —— 与 buildGatewayTools 的 null 分支同语义
 * （那边根本不调 applySkillGating）。这里必须跟着 fail-open：投影还没回来 / Python 打了个嗝
 * 时把一半工具标成「已关闭」，是把「不知道」说成了「关了」—— 同样是撒谎，而且更吓人。
 * 无 `skill` 的组是 core，任何时候都可用。
 */
export function isMatterToolGroupAvailable(
  group: MatterToolGroup,
  advertisedSkills: readonly string[] | null | undefined
): boolean {
  if (group.skill === undefined) return true
  if (advertisedSkills == null) return true
  return advertisedSkills.includes(group.skill)
}
