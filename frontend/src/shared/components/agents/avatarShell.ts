// 0813 dogfood —— 头像「承载容器」的单源口径：**圆角方形**，不是圆。
//
// owner 反馈原话：「头像要变成方的，圆的会截断一些地方」。追问后确认他说的是头像的
// **承载容器**（不是把 bot 形状本身改方），要的是**圆角**方形 —— 故容器 = 圆角方形，
// 圆角取仓内既有 v3 token（DESIGN.md v3：--r-ctl 8 控件档 / --r-card 12 卡片档），
// 不做直角、不自绘 squircle。
//
// 🔴 换容器**只**解决圆裁这一层。cube/cylinder/cone 的投影轮廓本身就冲出 viewBox
// （`BOT_VIEW_BOX = '-150 -150 300 300'`，实测 cube |max|=204、cone 176、cylinder 167），
// SVG 视口自己那层硬裁照旧存在 —— 那要靠形状几何调参根治（另一批），本模块**不**用缩放
// 头像内容的办法去掩盖它。
//
// 为什么是一个模块而不是各处照抄一份 class 串：此前口径本来就是分裂的 ——
// `AgentAvatar`（列表/卡片/抽屉全部位点）一律 `rounded-full` 圆裁，而 chat 侧
// `TurnPresence` 的 bot **完全没有外壳**、只有上传图是 `rounded-full`。两棵子树各自为政，
// 抄常量必分叉。零依赖叶子模块，两侧 import 同一份（CLAUDE.md「跨边界手抄常量」纪律）。

/** 圆角方形的两档半径。
 *
 *  🔴 恒 `min(token, 22%)`：token 是给 28-40px 控件定的**绝对** px 值，直接套到 18-24px
 *  的小位点上 8px ≈ 边长的 33%-44% ≈ 又变回圆，削角照旧（= owner 反馈的病根原样复现）。
 *  22% 是 app-icon 式比例，保证 18px 与 48px 上「圆角方形」是同一个观感，而不是
 *  「大的方、小的圆」；在 40/48px 这两个主力尺寸上 22% 恰好落在 token 值附近
 *  （40×22%=8.8 vs --r-ctl 8；48×22%=10.6 vs --r-card 12），故上限只在小位点起作用。
 *
 *  两个串必须是**字面量**：tailwind JIT 只扫源码里出现的完整 class 串，拼出来的不算。 */
const RADIUS_CTL = 'rounded-[min(var(--r-ctl),22%)]'
const RADIUS_CARD = 'rounded-[min(var(--r-card),22%)]'

/** 同一个比例的**数值**形态，给交不出 CSS 圆角的位点用（FAB 的光环要沿同一条边界描 path，
 *  纯 CSS 圆角描不出来 —— 见 `assistant/modal/ChatFabAvatar.tsx`）。
 *
 *  🔴 它与上面两个 class 串里的 `22%` 是**同一个值的两种载体**，且这处镜像**消灭不掉**：
 *  tailwind JIT 只扫源码里出现的完整 class 串，`rounded-[min(var(--r-ctl),${x}%)]` 拼不出样式。
 *  故按本仓「跨边界手抄必建闸」纪律配一致性断言（`tests/components/AgentAvatar.test.tsx`），
 *  改任一处而不改另一处必红。 */
export const AVATAR_SHELL_RADIUS_RATIO = 0.22

/** 闸用：把两个 class 串交出去，让测试从**真串**里抠百分数，而不是再抄一遍。 */
export const AVATAR_SHELL_RADIUS_CLASSES = [RADIUS_CTL, RADIUS_CARD] as const

/** 卡片档起点（px）：48px 的抽屉身份头部 / 编辑器预览走 --r-card，其余走控件档。 */
export const AVATAR_SHELL_CARD_SIZE = 44

/** 只要圆角（已有外壳的位点，如 TurnPresence 的面板头 span）。 */
export function avatarShellRadiusClass(size: number): string {
  return size >= AVATAR_SHELL_CARD_SIZE ? RADIUS_CARD : RADIUS_CTL
}

/** 完整外壳：定尺 inline-flex + 裁切 + 圆角方形。宽高由调用方以 style 给（size 是变量，
 *  写不成 tailwind 字面量）。 */
export function avatarShellClass(size: number): string {
  return `inline-flex shrink-0 overflow-hidden ${avatarShellRadiusClass(size)}`
}
