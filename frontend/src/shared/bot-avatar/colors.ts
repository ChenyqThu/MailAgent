/* eslint-disable mailagent/no-raw-hex --
 * bot 头像的身体色是模块自带的视觉资产（内联进 SVG fill 的主题双值，非全局 token 面），
 * 与 BorderGlow / emailComposerHtml 的既有豁免同类；是否收编进 index.css token
 * 待 WP2 全色盘评审后再定（prd §4.4）。 */
// 灵动 bot 头像 —— 色盘（WP2：11 色齐全，对齐 Grok 截图色数）。
// 身体 fill = 主题双值实色（dark 侧略提亮，参照原型 orange 对 #e36f3d→#ff8b5e 的关系）；
// 眼睛 fill = 页面背景变量 —— 眼睛与背景同色形成「镂空」错觉，深浅主题自动适配
// （grokbot-engine-analysis.md §2）。浅色身体（white/yellow/gray）覆写 eye 为固定深色：
// 浅色主题下背景色眼睛会与身体融成一片（隐形）。
// 本文件是 WP4 跨语言 parity 闸的抽取源，BOT_AVATAR_COLORS 保持 `[...] as const` 字面量形式。

export const BOT_AVATAR_COLORS = [
  'white',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray'
] as const

export type BotColor = (typeof BOT_AVATAR_COLORS)[number]

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
// 取原型 --background 双值。
const EYE_LIGHT = 'var(--bot-avatar-eye, var(--background, #fffdf7))'
const EYE_DARK = 'var(--bot-avatar-eye, var(--background, #181a15))'

// 浅色身体的固定深色眼睛：保留 --bot-avatar-eye 显式覆盖口，但不再跟 --background
// （跟了就隐形），兜底取原型暗色背景值 —— 与深色主题的 app 底色一致，观感仍像镂空。
const EYE_ON_LIGHT_BODY = 'var(--bot-avatar-eye, #181a15)'

export const COLORS: Record<BotColor, BotColorDef> = {
  white: {
    light: { body: '#f2efe6', eye: EYE_ON_LIGHT_BODY },
    dark: { body: '#faf7ee', eye: EYE_ON_LIGHT_BODY }
  },
  brown: {
    light: { body: '#9a6a4f', eye: EYE_LIGHT },
    dark: { body: '#b9855f', eye: EYE_DARK }
  },
  red: {
    light: { body: '#d4574e', eye: EYE_LIGHT },
    dark: { body: '#f07168', eye: EYE_DARK }
  },
  // 原型 --orange：light #e36f3d / dark #ff8b5e
  orange: {
    light: { body: '#e36f3d', eye: EYE_LIGHT },
    dark: { body: '#ff8b5e', eye: EYE_DARK }
  },
  yellow: {
    light: { body: '#e5b63c', eye: EYE_ON_LIGHT_BODY },
    dark: { body: '#f3cb59', eye: EYE_ON_LIGHT_BODY }
  },
  green: {
    light: { body: '#6da05b', eye: EYE_LIGHT },
    dark: { body: '#86bd72', eye: EYE_DARK }
  },
  teal: {
    light: { body: '#4a9d97', eye: EYE_LIGHT },
    dark: { body: '#63bcb4', eye: EYE_DARK }
  },
  blue: {
    light: { body: '#5583d0', eye: EYE_LIGHT },
    dark: { body: '#6f9ee8', eye: EYE_DARK }
  },
  purple: {
    light: { body: '#8a6cc8', eye: EYE_LIGHT },
    dark: { body: '#a487e0', eye: EYE_DARK }
  },
  pink: {
    light: { body: '#d876a8', eye: EYE_LIGHT },
    dark: { body: '#ef93c1', eye: EYE_DARK }
  },
  gray: {
    light: { body: '#98958c', eye: EYE_ON_LIGHT_BODY },
    dark: { body: '#b1aea5', eye: EYE_ON_LIGHT_BODY }
  }
}
