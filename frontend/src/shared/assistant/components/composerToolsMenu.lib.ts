// ComposerToolsMenu 的几何常量 + 「够不够并排」判据（task 08-05 WP-13）。
//
// 单独一个叶子模块的两个理由：
//   ① `react-refresh/only-export-components` —— 组件文件只出组件（ModelDetailCard 的
//      `modelDetailCard.lib.ts`、ContextUsageRing 的 `contextUsage.lib.ts` 同款拆法）；
//   ② 判据是纯算术，值得单测，而组件本身要 happy-dom + 一堆 mock 才跑得起来。
//
// 🔴 **宽度/偏移必须写成 Tailwind 字面量类**（`w-[208px]` / `left-[214px]`），不能用内联
// `style`：弹层挂在 `useExitAnimation` 的 GSAP scope 上，而它的 reduced-motion 分支会
// `gsap.set(el, { clearProps: 'all' })` —— **内联样式会被当场清空**（React 不会因为值没变而
// 重新写回去），于是「开了 reduce 的机器上二级面板叠在一级上面」。本文件的常量因此是
// 「算式的事实源 + 与那几个字面量类的一致性闸」（见 composer_tools_menu.test.tsx），不是
// 运行时样式来源。

/** 一级菜单宽度（px）—— 类字面量 `w-[208px]`。 */
export const TOOLS_MENU_W = 208
/** 二级面板宽度（px）—— 类字面量 `w-[268px]`；与收编前的 connector 面板逐字相同。 */
export const TOOLS_PANEL_W = 268
/** flyout 形态下一级与二级之间的间隙（px）。 */
export const TOOLS_FLYOUT_GAP = 6
/** 弹层右缘到容器右缘至少留的边距（px）。 */
export const TOOLS_EDGE_PAD = 12
/** 二级在 flyout 形态下的左偏移（px）—— 类字面量 `left-[214px]`。 */
export const TOOLS_FLYOUT_LEFT = TOOLS_MENU_W + TOOLS_FLYOUT_GAP
/** 走 flyout 的最小可用宽度 = 494（研究 §5.3 的空间账：一级 + 间隙 + 二级 + 边距）。 */
export const TOOLS_FLYOUT_MIN_ROOM = TOOLS_FLYOUT_LEFT + TOOLS_PANEL_W + TOOLS_EDGE_PAD

/** 从「弹层左锚点到 composer 容器右缘」的可用宽度判断能不能并排。
 *  量不到（happy-dom / 首帧 / 拿不到容器）→ 传 0 → false → 替换式（= 收编前的行为）。 */
export function toolsFlyoutFits(room: number): boolean {
  return room >= TOOLS_FLYOUT_MIN_ROOM
}
