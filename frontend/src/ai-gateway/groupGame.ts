// L4 群聊 g3 — 狼人杀身份事实的纯函数叶子（零运行时 import；只 type-only 依赖 @shared/chat_model）。
//
// <game_secret> 是服务端事实：从 group_config_json.game.roles 生成，不是 prompt 规则。
// 唯一生成点 = server.ts speakAsGroupMember（同时握有 facts.config.game 与 speaker 身份）；
// 非 werewolf 预设 / 无 game → null → 身份块字节不变（labs off 与 g2 基线同形）。

import type { GroupConfig } from '@shared/chat_model'

export type WerewolfGame = NonNullable<GroupConfig['game']>
export type WerewolfRole = WerewolfGame['roles'][string]

/** 角色词的中文映射只在本文件出现一次（模板与 prompt 里不再手抄）。 */
const ROLE_LABELS: Record<WerewolfRole, string> = {
  wolf: '狼人',
  seer: '预言家',
  villager: '村民'
}

/** 服务端事实 → 本 speaker 可见的身份字符串。非 werewolf / 无 game / speaker 既不在 roles 也非法官 → null。
 *
 *  法官 → `玩家甲=狼人；玩家乙=预言家；…`（按 roles 键序；取名顺序 game.titles → titleById → agentId，
 *  titleById 只有当前群名单，法官在子群里靠 game.titles 才认得全表）；
 *  狼人 → `你是狼人；队友：玩家丙`（多个队友用「、」连；无队友省略分号后半段）；
 *  预言家 / 村民 → `你是预言家` / `你是村民`。 */
export function buildGameSecret(
  game: WerewolfGame | undefined | null,
  speakerAgentId: string,
  judgeAgentId: string | null,
  titleById: ReadonlyMap<string, string>
): string | null {
  if (!game || game.kind !== 'werewolf') return null
  const roles = game.roles
  const nameOf = (agentId: string): string =>
    game.titles?.[agentId] ?? titleById.get(agentId) ?? agentId

  if (judgeAgentId != null && speakerAgentId === judgeAgentId) {
    return Object.entries(roles)
      .map(([agentId, role]) => `${nameOf(agentId)}=${ROLE_LABELS[role]}`)
      .join('；')
  }

  const role = roles[speakerAgentId]
  if (role === undefined) return null
  const self = `你是${ROLE_LABELS[role]}`
  if (role !== 'wolf') return self

  const mates = Object.entries(roles)
    .filter(([agentId, r]) => r === 'wolf' && agentId !== speakerAgentId)
    .map(([agentId]) => nameOf(agentId))
  return mates.length === 0 ? self : `${self}；队友：${mates.join('、')}`
}
