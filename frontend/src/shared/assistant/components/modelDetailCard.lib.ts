// ModelDetailCard / ModelPicker 的纯函数面（定位算式 + 数字格式化）。
//
// 单独一个 .ts 是为了 `react-refresh/only-export-components`（.tsx 只许导出组件，抄
// `_cardShell.lib.ts` 的既有先例），顺带让定位算式在 happy-dom 里可以脱离渲染直接断言 ——
// happy-dom 的 getBoundingClientRect 恒 0，只有把算式抽出来喂假 rect 才测得动。

/** 卡宽。lobe 是 400 —— 我们收到 300：最窄的消费场地（360px 邮件侧栏）里选择器弹层右缘
 *  已经贴到 340，右侧只剩不到 20px，必然走「翻到左边、盖在邮件列表上」那一档；300 比 400
 *  更容易在窄窗口里两侧都放得下，信息密度也够（内容比 lobe 少一节做不到的雷达图）。 */
export const MODEL_CARD_WIDTH = 300
/** 与选择器弹层的间距。 */
export const MODEL_CARD_GAP = 8
/** 视口安全边距。 */
export const MODEL_CARD_MARGIN = 12
/** 卡最高 —— 超出内部滚动。定位算式用它做上界，避免二次测量真实高度。 */
export const MODEL_CARD_MAX_H = 420

export interface ModelDetailAnchor {
  /** 选择器弹层的视口 rect（水平定位以它为准 —— 卡不该盖住弹层本身）。 */
  menu: { left: number; right: number; bottom: number }
}

export interface ModelDetailPlacement {
  left: number
  bottom: number
  maxHeight: number
}

/** 三档水平定位 + 一档垂直定位（全部只用弹层 rect，不需要测卡的真实高度）。
 *
 *  水平：右边放得下 → 右展开；放不下 → 翻左边；两边都放不下（很窄的窗口）→ 夹进视口，
 *  允许盖住弹层 —— 显示不全比不显示强。
 *
 *  垂直**锚到弹层底边**而不是 hover 行：行锚会让卡随光标上下跳（每换一行跳一次），而弹层
 *  是稳定的。`maxHeight` 同时兜住「弹层贴着视口底部时卡向上长出屏幕」。 */
export function placeDetailCard(
  anchor: ModelDetailAnchor,
  viewport: { width: number; height: number }
): ModelDetailPlacement {
  const { menu } = anchor
  let left = menu.right + MODEL_CARD_GAP
  if (left + MODEL_CARD_WIDTH > viewport.width - MODEL_CARD_MARGIN) {
    left = menu.left - MODEL_CARD_GAP - MODEL_CARD_WIDTH
  }
  if (left < MODEL_CARD_MARGIN) {
    left = Math.max(
      MODEL_CARD_MARGIN,
      Math.min(viewport.width - MODEL_CARD_MARGIN - MODEL_CARD_WIDTH, menu.left)
    )
  }
  const bottom = Math.max(MODEL_CARD_MARGIN, viewport.height - menu.bottom)
  const maxHeight = Math.max(
    120,
    Math.min(MODEL_CARD_MAX_H, viewport.height - bottom - MODEL_CARD_MARGIN)
  )
  return { left, bottom, maxHeight }
}

/** token 数 → 药丸/卡上的短文案：1000000 → '1M'、200000 → '200K'、512 → '512'。
 *  1.05M 这种非整数 M 保一位小数（owner 的中转就有 1_050_000 的档）。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** $ / 百万 token —— models.dev 的 cost 就是这个单位，**不做单位换算**（换算 = 又一处会错
 *  的地方）。小额保足位数：cache_read 常见 0.03 / 0.005 这种量级，两位小数会直接抹成 $0.00。 */
export function formatPrice(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}
