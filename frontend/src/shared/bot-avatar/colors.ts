/* eslint-disable mailagent/no-raw-hex --
 * bot 头像的身体色是模块自带的视觉资产（内联进 SVG fill 的主题双值，非全局 token 面），
 * 与 BorderGlow / emailComposerHtml 的既有豁免同类；是否收编进 index.css token
 * 待 WP2 全色盘评审后再定（prd §4.4）。 */
// 灵动 bot 头像 —— 色盘。v1 只有 orange（原型 --orange 双值）；WP2 扩到 11 色。
// 身体 fill = 主题双值实色；眼睛 fill = 页面背景变量 —— 眼睛与背景同色形成
// 「镂空」错觉，深浅主题自动适配（grokbot-engine-analysis.md §2）。
// 本文件是 WP4 跨语言 parity 闸的抽取源，BOT_COLORS 保持 `[...] as const` 字面量形式。

export const BOT_COLORS = ['orange'] as const

export type BotColor = (typeof BOT_COLORS)[number]

export interface BotColorValues {
  body: string
  eye: string
}

export interface BotColorDef {
  light: BotColorValues
  dark: BotColorValues
}

// 眼睛优先吃消费点显式覆盖（--bot-avatar-eye，如彩底卡片上想让眼睛跟卡片色），
// 否则跟 app 的 --background 走；末位 hex 是无变量环境（隔离渲染/单测）的兜底，
// 取原型 --background 双值。白/浅身体色需要深色眼睛保证对比的场景由 WP2 按色覆写 eye。
const EYE_LIGHT = 'var(--bot-avatar-eye, var(--background, #fffdf7))'
const EYE_DARK = 'var(--bot-avatar-eye, var(--background, #181a15))'

export const COLORS: Record<BotColor, BotColorDef> = {
  // 原型 --orange：light #e36f3d / dark #ff8b5e
  orange: {
    light: { body: '#e36f3d', eye: EYE_LIGHT },
    dark: { body: '#ff8b5e', eye: EYE_DARK }
  }
}
