// 收编自 beui.dev（MIT）ease.ts，作为 motion/react 声明式动效的统一 token 层。
//
// 边界：只供获批的 motion 组件 import；GSAP 动效继续走 @shared/lib/gsap，
// 禁止在业务组件内联 spring 参数或借此扩张动效用途。详见 docs/motion-gsap.md。

export const EASE_OUT = [0.16, 1, 0.3, 1] as const
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const

/** EASE_OUT 的 CSS 字符串形式，供内联 transition 使用。 */
export const EASE_OUT_CSS = 'cubic-bezier(0.16, 1, 0.3, 1)'

/** 按钮与其他可点击表面的按压反馈。 */
export const SPRING_PRESS = {
  type: 'spring',
  stiffness: 500,
  damping: 30,
  mass: 0.6
} as const

/** 控件内部标签或图标槽位的内容切换。 */
export const SPRING_SWAP = {
  type: 'spring',
  stiffness: 460,
  damping: 30,
  mass: 0.55
} as const

/** 由指针或显式操作召出的模态与抽屉面板。 */
export const SPRING_PANEL = {
  type: 'spring',
  stiffness: 420,
  damping: 40,
  mass: 0.5
} as const

/** pill、indicator 与面板之间的 shared-layout 位移。 */
export const SPRING_LAYOUT = {
  type: 'spring',
  stiffness: 360,
  damping: 32,
  mass: 0.6
} as const

/** magnetic、tilt、dock 等装饰性鼠标跟随。 */
export const SPRING_MOUSE = {
  stiffness: 200,
  damping: 15,
  mass: 0.3
} as const
