// Monogram 色相锚（D10）：8 档色相环 + 固定亮饱和，hueOf(主邮箱) —— 主邮箱做锚点
// 所以合并/改名都不跳色。独立模块（react-refresh 规则不许组件文件兼职导出函数）。

const HUE_RING = [16, 58, 100, 145, 190, 235, 280, 325] as const

export function hueOf(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return HUE_RING[hash % HUE_RING.length]!
}
