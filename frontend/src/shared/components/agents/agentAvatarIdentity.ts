import { palettes, shapes } from '@oreo-design/avatar'

import type { AgentAvatarConfig } from '@shared/api/types'

const SHAPE_IDS = new Set(shapes.map((shape) => shape.id))
const PALETTE_IDS = new Set(palettes.map((palette) => palette.id))

function hashText(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function resolveAgentAvatar(
  agentId: string,
  config?: AgentAvatarConfig | null
): AgentAvatarConfig {
  const seed = hashText(agentId || 'mailagent')
  const fallback: AgentAvatarConfig = {
    shape: shapes[seed % shapes.length].id,
    palette: palettes[Math.floor(seed / shapes.length) % palettes.length].id,
    variant_id: agentId || 'mailagent'
  }
  if (!config) return fallback
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
): AgentAvatarConfig {
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
