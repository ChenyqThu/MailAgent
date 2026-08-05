import { palettes, shapes } from '@oreo-design/avatar'

import type { AgentAvatarConfig, AgentAvatarGenerated, AgentAvatarImage } from '@shared/api/types'

const SHAPE_IDS = new Set(shapes.map((shape) => shape.id))
const PALETTE_IDS = new Set(palettes.map((palette) => palette.id))

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

function hashText(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 生成式身份的解析。**恒返回生成式** —— 上传态（WP7）没有 shape/palette 可言，故回落到 id
 *  派生基底：编辑器的形状/配色网格与「换一换」需要一个可高亮、可递进的基底，且用户在上传态
 *  下点任一候选就是「切回生成式」，从 id 派生开始最符合直觉。上传态的渲染判别走
 *  ``isAgentAvatarImage``，与本函数正交。 */
export function resolveAgentAvatar(
  agentId: string,
  config?: AgentAvatarConfig | null
): AgentAvatarGenerated {
  const seed = hashText(agentId || 'mailagent')
  const fallback: AgentAvatarGenerated = {
    shape: shapes[seed % shapes.length].id,
    palette: palettes[Math.floor(seed / shapes.length) % palettes.length].id,
    variant_id: agentId || 'mailagent'
  }
  if (!config || config.type === 'image') return fallback
  if (!SHAPE_IDS.has(config.shape) || !PALETTE_IDS.has(config.palette)) return fallback
  return {
    shape: config.shape,
    palette: config.palette,
    variant_id: config.variant_id || agentId || 'mailagent'
  }
}

export function shuffledAgentAvatar(
  agentId: string,
  current?: AgentAvatarConfig | null
): AgentAvatarGenerated {
  const resolved = resolveAgentAvatar(agentId, current)
  const nonce = `${resolved.shape}:${resolved.palette}:${resolved.variant_id ?? agentId}`
  const seed = hashText(`${agentId}:${nonce}:next`)
  return {
    shape:
      shapes[(shapes.findIndex((shape) => shape.id === resolved.shape) + 1 + seed) % shapes.length]
        .id,
    palette:
      palettes[
        (palettes.findIndex((palette) => palette.id === resolved.palette) + 7 + seed) %
          palettes.length
      ].id,
    variant_id: `${agentId || 'mailagent'}:${seed.toString(36)}`
  }
}
