// 邮件 backend 值域 + 平台过滤单源（renderer 侧）。
//
// 值域手抄 config.py `MAILAGENT_BACKEND`（applescript | davmail | outlook_com）。
// 🔴 跨语言一致性闸由后续统一批建（config.py 由并发 agent 在改，本文件先做前端单源）；
// onboarding/ipc.ts 的 `BackendKind` 与 AccountsTab 的 SegmentedControl 都从这里取
// 定义与过滤逻辑，禁止再各写一份字面量表。
//
// 平台语义（owner 2026-08-13 拍板，task 08-12-win-mailagentwin-backend-eval prd §7）:
//   - mac  = applescript + davmail（不显示 outlook_com —— COM 是 Windows 专属）
//   - win  = outlook_com + davmail（不显示 applescript —— Mail.app 不存在），
//     outlook_com 排前 = onboarding 主推卡 / 设置面默认序
//   - 日历能力 Windows 恒隐藏（不论选了哪个 backend，拍板求简）；mac 不变。

/** 邮件 backend 值域 — mirrors config.py MAILAGENT_BACKEND value domain. */
export type MailBackendKind = 'applescript' | 'davmail' | 'outlook_com'

export const MAIL_BACKEND_KINDS: readonly MailBackendKind[] = [
  'applescript',
  'davmail',
  'outlook_com'
] as const

/** UI 平台二分。renderer 拿不到 Node process，凡 darwin 之外（含探测失败的
 *  兜底）都按各平台自己的 `window.electron.process.platform` 真值走；这里只
 *  区分「win32 与否」—— linux 等罕见形态按 mac 侧规则处理（不裁剪功能面，
 *  保守方向：宁多显示不误砍）。 */
export type UiPlatform = 'darwin' | 'win32' | 'other'

/** Node/preload 的 platform 字符串 → UiPlatform 归一。main 进程直接喂
 *  `process.platform`；renderer 走下面的 detectUiPlatform（读 preload 投影）。 */
export function toUiPlatform(p: string | undefined | null): UiPlatform {
  if (p === 'darwin') return 'darwin'
  if (p === 'win32') return 'win32'
  return 'other'
}

/** 读 preload (@electron-toolkit) 暴露的 `window.electron.process.platform`。
 *  preload 缺席（纯浏览器/node 测试环境）→ 'other'（按非 win 处理，mac 行为零回归）。 */
export function detectUiPlatform(): UiPlatform {
  const w = (typeof window === 'undefined' ? undefined : window) as
    | { electron?: { process?: { platform?: string } } }
    | undefined
  return toUiPlatform(w?.electron?.process?.platform)
}

/** 平台可选 backend 列表（顺序即 UI 展示顺序：首项为主推/默认）。
 *  - win32           → [outlook_com, davmail]
 *  - darwin / other  → [applescript, davmail]（与三值化之前的现状逐字节一致） */
export function availableBackendsForPlatform(platform: UiPlatform): readonly MailBackendKind[] {
  if (platform === 'win32') return ['outlook_com', 'davmail'] as const
  return ['applescript', 'davmail'] as const
}

/** 把（.env 里可能是任意字符串的）backend 值收敛到当前平台的合法选项：
 *  合法且平台可用 → 原值；否则 → 平台首选项。用于设置面/引导的选中态初始化，
 *  避免「win 上 .env 残留 applescript → SegmentedControl 选中一个不存在的段」。 */
export function coerceMailBackendForPlatform(
  raw: string | undefined | null,
  platform: UiPlatform
): MailBackendKind {
  const avail = availableBackendsForPlatform(platform)
  if (raw && (avail as readonly string[]).includes(raw)) return raw as MailBackendKind
  return avail[0]
}

/** 日历 UI（导航/设置/快捷键帮助/邮件详情跳转）是否启用。
 *  Windows 恒 false（拍板：日历整体出范围，不论 backend）；其余平台 true。 */
export function calendarUiEnabled(platform: UiPlatform): boolean {
  return platform !== 'win32'
}
