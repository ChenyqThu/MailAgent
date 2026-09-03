// assistant-modal — sidebar 内嵌可调宽的宽度算法（范式同 InboxLayout 旧 AI 面板：clamp +
// localStorage + try-catch）。独立 key（不复用旧面板的 mailagent.chat.panelWidth）：dock 与旧面板
// 是两套不同实体。
//
// 自成一个文件（不留在 AssistantChatModal.tsx 里）：那边只导出组件，react-refresh 的
// only-export-components 不许再导出函数；而下限那两条闸要直驱纯函数，不该为了它渲染整个 dock。
// 同 sessionTitle.ts 的处置。

const SIDEBAR_WIDTH_DEFAULT = 400
//: 350 起（0903 dogfood：320 那一档窄到还会出显示问题）。抬下限也会把 localStorage 里
//: 存着的旧窄值抬上来 —— readSidebarWidthPref 读出来就 clamp，不需要迁移。
export const SIDEBAR_WIDTH_MIN = 350
export const SIDEBAR_WIDTH_MAX = 720
const SIDEBAR_WIDTH_PREF = 'mailagent.chat.dockSidebarWidth'
//: 侧栏最多吃掉视口的一半 —— 上界只有固定的 720px 时，窗口缩窄不会让侧栏让位，
//: 400px 的默认宽能把主内容区挤到几乎没有（0812 dogfood：「宽度很小时溢出」）。
//: 视口本身比 MIN 还窄时以 MIN 为准（那种尺寸下横向滚动已不可避免，不再叠加压缩）。
const SIDEBAR_VIEWPORT_SHARE = 0.5

function sidebarWidthCap(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_MAX
  return Math.max(SIDEBAR_WIDTH_MIN, Math.round(window.innerWidth * SIDEBAR_VIEWPORT_SHARE))
}

export function clampSidebarWidth(px: number): number {
  const upper = Math.min(SIDEBAR_WIDTH_MAX, sidebarWidthCap())
  return Math.min(upper, Math.max(SIDEBAR_WIDTH_MIN, px))
}

export function readSidebarWidthPref(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_PREF))
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_WIDTH_DEFAULT
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

export function writeSidebarWidthPref(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_PREF, String(px))
  } catch {
    /* localStorage 在 sandbox / privacy 模式可能拒写; 偏好丢失无伤大雅 */
  }
}
