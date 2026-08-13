// 灵动 bot 头像 —— 随机 / agent_id 确定性派生 / legacy oreo→bot 确定性映射（prd §5.1）。
// 三条纪律：
//   1. 全部确定性可测：hash 是纯函数，随机路径的随机源可注入；
//   2. avatar_json = NULL 的语义（按 agent_id 派生默认外观）由 deriveBotAvatar 承担，
//      后端不回填、不迁移 —— 派生/映射的单源在这里（前端），golden 测试钉死防换脸；
//   3. 本模块零外部依赖（域无关），hash/shuffle 语义对齐
//      shared/components/agents/agentAvatarIdentity.ts（WP3 将把消费点迁过来；
//      那边 import 着待移除的 @oreo-design/avatar，不能反向依赖，故 FNV-1a 就地一份）。

import { BOT_AVATAR_COLORS } from './colors'
import { BOT_AVATAR_SHAPES } from './shapes'
import type { BotAvatarBotConfig, BotColor, BotShape } from './types'

/** FNV-1a 32-bit（与 agentAvatarIdentity.ts::hashText 逐字同源，语义契约见文件头） */
function hashText(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 空 id 的兜底种子文本（对齐 resolveAgentAvatar 的 `agentId || 'mailagent'`） */
const FALLBACK_SEED_TEXT = 'mailagent'

function fromSeed(seed: number): BotAvatarBotConfig {
  return {
    type: 'bot',
    shape: BOT_AVATAR_SHAPES[seed % BOT_AVATAR_SHAPES.length],
    // 除法去相关：直接双取模会让 shape 与 color 强相关（同余耦合）
    color: BOT_AVATAR_COLORS[Math.floor(seed / BOT_AVATAR_SHAPES.length) % BOT_AVATAR_COLORS.length]
  }
}

/**
 * agent_id → 默认外观（avatar_json = NULL 行）。同 id 恒同结果；
 * golden 值钉在 tests/shared/bot-avatar/random.test.ts，重构不得静默换脸。
 */
export function deriveBotAvatar(agentId: string): BotAvatarBotConfig {
  return fromSeed(hashText(agentId || FALLBACK_SEED_TEXT))
}

/** legacy oreo 生成式行的最小形状（wire.py 生成式分支的三键；variant_id 可缺省） */
export interface LegacyGeneratedAvatarLike {
  shape: string
  palette: string
  variant_id?: string | null
}

/**
 * legacy oreo `{shape, palette}` → bot 外观的确定性映射（渲染期换脸，存量行不迁移）。
 * variant_id 有意不进 hash：oreo 的 variant 只是同 shape/palette 内的几何微扰，
 * 让同一 shape+palette 的 agent 映射后同脸，符合「换版本外观稳定」（prd §5.1）。
 */
export function mapLegacyGeneratedToBot(config: LegacyGeneratedAvatarLike): BotAvatarBotConfig {
  return fromSeed(hashText(`${config.shape}:${config.palette}`))
}

/** 均匀随机（编辑器骰子按钮）。随机源可注入 —— 测试用确定性序列复现。 */
export function randomBotAvatar(random: () => number = Math.random): BotAvatarBotConfig {
  return {
    type: 'bot',
    shape: pick(BOT_AVATAR_SHAPES, random),
    color: pick(BOT_AVATAR_COLORS, random)
  }
}

function pick<T>(values: readonly T[], random: () => number): T {
  // random() 契约上 < 1，但注入源可能顶到 1：收边防越界
  return values[Math.min(values.length - 1, Math.max(0, Math.floor(random() * values.length)))]
}

/**
 * 「换一换」：从当前外观确定性递进到下一个（同起点恒同下一个，对齐 shuffledAgentAvatar
 * 的语义），且保证 ≠ 起点。current 非法/缺省时起点回落 id 派生基底。
 */
export function shuffleBotAvatar(
  current: { shape?: string; color?: string } | null | undefined,
  agentId: string
): BotAvatarBotConfig {
  const base = normalizeBotConfig(current) ?? deriveBotAvatar(agentId)
  const seed = hashText(`${agentId || FALLBACK_SEED_TEXT}:${base.shape}:${base.color}:next`)
  const shapeCount = BOT_AVATAR_SHAPES.length
  const colorCount = BOT_AVATAR_COLORS.length
  const shape = BOT_AVATAR_SHAPES[(BOT_AVATAR_SHAPES.indexOf(base.shape) + 1 + seed) % shapeCount]
  let color = BOT_AVATAR_COLORS[(BOT_AVATAR_COLORS.indexOf(base.color) + 7 + seed) % colorCount]
  if (shape === base.shape && color === base.color) {
    // 步长 (1+seed, 7+seed) 在 seed ≡ 7 (mod 8) 且 ≡ 4 (mod 11) 时会转回原点：错开一格颜色
    color = BOT_AVATAR_COLORS[(BOT_AVATAR_COLORS.indexOf(base.color) + 8 + seed) % colorCount]
  }
  return { type: 'bot', shape, color }
}

function normalizeBotConfig(
  value: { shape?: string; color?: string } | null | undefined
): BotAvatarBotConfig | null {
  if (!value) return null
  const { shape, color } = value
  if (!shape || !color) return null
  if (!(BOT_AVATAR_SHAPES as readonly string[]).includes(shape)) return null
  if (!(BOT_AVATAR_COLORS as readonly string[]).includes(color)) return null
  return { type: 'bot', shape: shape as BotShape, color: color as BotColor }
}
