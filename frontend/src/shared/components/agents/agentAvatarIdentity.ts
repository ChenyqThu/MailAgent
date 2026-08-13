import type { AgentAvatarBot, AgentAvatarConfig, AgentAvatarGenerated, AgentAvatarImage } from '@shared/api/types'
import { deriveBotAvatar, mapLegacyGeneratedToBot, shuffleBotAvatar } from '@shared/bot-avatar/random'
import { BOT_AVATAR_COLORS } from '@shared/bot-avatar/colors'
import { BOT_AVATAR_SHAPES } from '@shared/bot-avatar/shapes'

const BOT_SHAPE_IDS = new Set<string>(BOT_AVATAR_SHAPES)
const BOT_COLOR_IDS = new Set<string>(BOT_AVATAR_COLORS)

/** legacy oreo 生成式行的 shape 词表（wire.py 生成式分支的六值白名单，已冻结——
 *  oreo 渲染链退役后仅存量行判别用，不是 bot 词表的手抄）。 */
const LEGACY_OREO_SHAPES = new Set(['bloom', 'silk', 'flare', 'nova', 'void', 'jade'])

/** 上传态判别（WP7）。data URI 形状不对 = 当没有头像（回落生成式），绝不拿坏 src 去渲染
 *  图片元素 —— 那会在列表里留一排碎图占位框。 */
export function isAgentAvatarImage(config?: AgentAvatarConfig | null): config is AgentAvatarImage {
  return (
    !!config &&
    config.type === 'image' &&
    typeof config.data === 'string' &&
    /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(config.data)
  )
}

/** 存量 oreo 生成式行判别：无 type 键（或显式 'generated'）+ 合法六值 shape + 非空 palette。
 *  后端写侧（wire.py）保证存量行满足此形状；不满足即坏值，走 id 派生。 */
function isLegacyGenerated(config: AgentAvatarConfig): config is AgentAvatarGenerated {
  if (config.type !== undefined && config.type !== 'generated') return false
  const candidate = config as AgentAvatarGenerated
  return (
    typeof candidate.shape === 'string' &&
    LEGACY_OREO_SHAPES.has(candidate.shape) &&
    typeof candidate.palette === 'string' &&
    candidate.palette.length > 0
  )
}

/** 身份解析：**恒返回 bot config**（08-12 living-bot-avatar 起 oreo 渲染链退役）。
 *  - `type:'bot'` 合法原样返回；词表越域回落 id 派生；
 *  - legacy oreo 生成式行 → `mapLegacyGeneratedToBot` 确定性换脸（同 shape+palette 恒同脸）；
 *  - `type:'image'` / 坏值 / null → `deriveBotAvatar(agentId)`。上传态没有 shape/color 可言，
 *    编辑器的形状/配色网格与「换一换」需要一个可高亮、可递进的基底，从 id 派生最符合直觉；
 *    上传态的渲染判别走 ``isAgentAvatarImage``，与本函数正交。 */
export function resolveAgentAvatar(
  agentId: string,
  config?: AgentAvatarConfig | null
): AgentAvatarBot {
  if (config && config.type === 'bot') {
    if (BOT_SHAPE_IDS.has(config.shape) && BOT_COLOR_IDS.has(config.color)) return config
    return deriveBotAvatar(agentId)
  }
  if (config && config.type !== 'image' && isLegacyGenerated(config)) {
    return mapLegacyGeneratedToBot(config)
  }
  return deriveBotAvatar(agentId)
}

/** 「换一换」：从当前解析结果确定性递进到下一个外观（同起点恒同下一个，且 ≠ 起点）。 */
export function shuffledAgentAvatar(
  agentId: string,
  current?: AgentAvatarConfig | null
): AgentAvatarBot {
  return shuffleBotAvatar(resolveAgentAvatar(agentId, current), agentId)
}
