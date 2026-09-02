// L4 群聊 — 群成员展示元数据 + members_json 解析（非组件叶子；react-refresh 规则要求
// 组件文件只导出组件，这两件共享物住在这里）。

import type { AgentAvatarConfig } from '@shared/api/types'

export interface GroupMemberMeta {
  title: string
  avatar?: AgentAvatarConfig | null
}

/** 可入群成员（建群对话框勾选清单 + 详情面「加人」共用）。
 *
 *  🔴 **不是** `ReportAgentConfig`：主 Agent 也是候选，而它没有 `report_agent` 行
 *  （身份在 `owner_settings.assistant_identity`）。给它伪造一条配置行会让「主 agent 身份
 *  单源」当场破掉，所以这里只留三个消费点真的会读的四个字段。 */
export interface GroupCandidate {
  id: string
  /** 已归一（空 title 回落 id）：消费点直接渲染，不再各自 `?.trim() || id`。 */
  title: string
  avatar: AgentAvatarConfig | null
  /** 详情面成员行第二行的模型名。主 Agent 没有自己的模型（吃群级 modelOverride 或全局
   *  默认）→ null，显示为「—」。 */
  model: string | null
}

/** members_json → 成员 id 数组。单源 = gateway groupChat.ts 的 parseGroupMemberIds
 *  （该文件是显式纯叶子：type-only imports 之外只引 groupFloors 常量，同样零依赖，
 *  renderer 直引不带进任何 main 侧包袱）——不手抄第二份容错口径。 */
export { parseGroupMemberIds as parseMembersJson } from '../../../../ai-gateway/groupChat'
