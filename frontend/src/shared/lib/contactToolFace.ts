// 通讯录 Agent（WP7 治理台抽屉「它能做什么」tab）如实列出来的那份**工具面清单**。
//
// 🔴 零依赖叶子：本文件只导出常量与类型，不 import 任何 electron / store / AI SDK / i18n
// / gateway 模块。抽屉从这里渲染，**不许**把清单硬编码在 tsx 里 —— 硬编码的清单没有任何
// 东西盯着它，gateway 那边加一件工具，界面就开始少说一件事（而少说 = 界面在撒谎）。
// 反方向同理：这里多写一个名字，界面就在向 owner 承诺一件不存在的能力。
//
// 🔴 这不是权威。权威是 gateway 真实装配出来的 ToolSet（tools/index.ts 的
// `contactToolsEnabled` 三个 create* 块 + policy.ts 按 CLASS 推导的场地矩阵）。本表是那份
// ToolSet 的**说明书**，二者的相等关系由 `frontend/tests/ai-gateway/contact_tool_face_leaf.test.ts`
// 三向钉死：
//   (a) 表里的每个名字都真的在**主对话**工具面里（不许有幽灵条目）；
//   (b) 主对话工具面里的每个 `contact_*` 名字都落在某个分组里（不许有藏起来的能力）；
//   (c) 真实 `contact_governance` run 里的 `contact_*` 面 == 本表标了 `governance: true`
//       的那批（不许把「扫描其实拿不到」的工具说成它能用，也不许漏说它真拿得到的）。
// 那条闸跑的是真实的 buildGatewayTools / runHeadlessAgent，不是另一份手抄名单。
//
// 🔴 工具名用**真实 snake_case**（`contact_search`），不照抄原型 `cagent.jsx` 的
// `contacts.search` 点号写法 —— 那是展示层遗留（PRD §4.8 明文），照抄等于印一份对不上
// 实现的说明书。
//
// 分组顺序 = 界面渲染顺序（读 → 建议 → 写，与权限档由松到紧同向）。

/** 权限档 —— 与设计 §2.7 的三类标记一一对应（读 / 建议 / 写（轻））。 */
export type ContactToolPermission = 'read' | 'propose' | 'write'

export interface ContactToolGroup {
  /** i18n key 后缀（`contacts.agent.perm.<permission>`）与分组标识。 */
  permission: ContactToolPermission
  /** gateway 工具名（标识符，不翻译 —— 界面按等宽 chip 原样呈现）。
   *  每件的一句说明走 `contacts.agent.desc.<tool>`。 */
  tools: readonly string[]
  /**
   * 每天那轮 **headless 治理扫描**（`contact_governance` 场地）拿得到这一组吗。
   *
   * 🔴 `false` 不是「没配」而是**结构上拿不到**：policy.ts 的 `contact_governance` 行
   * 只放行 class `read` + 三个 propose 名字，`domain_write` 在到达 grant 阶梯之前就被拒。
   * 界面必须把这一档标出来 —— 抽屉副标写着「它读、它提议，你确认」，同一屏却列着三件
   * 写工具而不说清场地，就是在撒谎。（这三件在**主对话**里确实可用，出厂 `ask` 弹卡。）
   */
  governance: boolean
}

export const CONTACT_TOOL_FACE_GROUPS: readonly ContactToolGroup[] = [
  {
    permission: 'read',
    governance: true,
    tools: ['contact_search', 'contact_get', 'contact_list_mails']
  },
  {
    permission: 'propose',
    governance: true,
    // 治理扫描唯一的产出通道：写的是 `contact_suggestion` 的 pending 行，不动正式字段。
    tools: ['contact_propose_update', 'contact_propose_merge', 'contact_propose_relation']
  },
  {
    permission: 'write',
    governance: false,
    // 后两件是「chat 里直接改身份字段 / 上级」（owner 拍板）。它们走的就是通讯录界面手动编辑
    // 那两个端点，出厂同样 `ask` 弹卡；`governance: false` 对它们尤其要紧 —— 治理扫描能提议
    // 改身份字段，但结构上永远改不了。
    tools: [
      'contact_set_kind',
      'contact_mark_former_email',
      'contact_refresh_profile',
      'contact_update_fields',
      'contact_set_manager'
    ]
  }
]

/** 清单里出现过的全部工具名（闸的比对面）。 */
export const CONTACT_TOOL_FACE_TOOLS: readonly string[] = CONTACT_TOOL_FACE_GROUPS.flatMap(
  (group) => group.tools
)

/** `contact_*` 前缀 —— 闸 (b)/(c) 用它把「通讯录族」从整个工具面里圈出来：治理 run 里还有
 *  邮件/检索/日历等一大批读工具，它们不归本清单管（本 tab 讲的是「通讯录这件事被做成了
 *  哪几件工具」，不是那次 run 的全集）。 */
export const CONTACT_TOOL_NAME_PREFIX = 'contact_'
