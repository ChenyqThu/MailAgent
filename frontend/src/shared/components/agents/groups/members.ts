// L4 群聊 — 群成员展示元数据 + members_json 解析（非组件叶子；react-refresh 规则要求
// 组件文件只导出组件，这两件共享物住在这里）。

import type { AgentAvatarConfig } from '@shared/api/types'

export interface GroupMemberMeta {
  title: string
  avatar?: AgentAvatarConfig | null
}

/** members_json → 成员 id 数组。单源 = gateway groupChat.ts 的 parseGroupMemberIds
 *  （该文件是显式纯叶子：零运行时依赖、type-only imports，renderer 直引不带进任何
 *  main 侧包袱）——不手抄第二份容错口径。 */
export { parseGroupMemberIds as parseMembersJson } from '../../../../ai-gateway/groupChat'
