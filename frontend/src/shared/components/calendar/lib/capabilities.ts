// 阶段 3 (#11) — 日历能力表, 替换阶段 1·1.6 (F14/Q9) 的 IS_WEB_BUILD 粗门控。
//
// 阶段 3.1 起 serve-api 具备 calendar 写端点 (create/update/delete/rsvp/replay),
// HttpApi 对应方法已接真实现 → 远程 web 与桌面同样具备写能力, write/rsvp/replay
// 三位两端恒 true。保留按端差异化的结构: recurringDiscover/expand (legacy
// Notion-mirror 运维面) 在 HttpApi 仍是 notImplemented stub → web 下 discover=false,
// 对应 UI 入口 (CalendarPage 扫描按钮) 继续隐藏 (能力缺失不是状态问题, 隐藏而非禁用)。
//
// 探针跟随仓内既有惯例 (agents/shared.ts IS_WEB / CommandPalette
// resolveBuildTarget): 生产读 import.meta.env (vite.web.config.ts define),
// vitest 回退 process.env (vi.stubEnv 只进 process.env 不进 import.meta.env)。
function resolveBuildTarget(): string | undefined {
  const metaTarget = (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
    ?.VITE_BUILD_TARGET
  if (metaTarget) return metaTarget
  if (typeof process !== 'undefined') return process.env?.VITE_BUILD_TARGET
  return undefined
}

export interface CalendarCapabilities {
  /** 新建/编辑/删除事件 (CalDAV PUT/DELETE — IPC fork CLI 或 serve-api 写端点)。 */
  write: boolean
  /** RSVP iTIP REPLY 三键 (接受/暂定/拒绝)。 */
  rsvp: boolean
  /** 单事件重导出 Notion mirror (eventReplay)。 */
  replay: boolean
  /** recurring 扫描 (recurringDiscover/expand) — HttpApi 仍 stub, web 下 false。 */
  discover: boolean
}

/** 当前 build target 的日历能力表 (build-time 常量性质, 模块级消费)。 */
export function calendarCapabilities(): CalendarCapabilities {
  const isWeb = resolveBuildTarget() === 'web'
  return {
    write: true,
    rsvp: true,
    replay: true,
    discover: !isWeb
  }
}
