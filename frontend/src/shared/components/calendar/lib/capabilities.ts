// 阶段1·1.6 (F14/Q9) — 远程 web build 粗门控. HttpApi 的 calendar 写/派生路径
// (eventCreate / eventUpdate / eventDelete / eventRsvp / eventReplay /
// recurringDiscover / recurringReplay / expand) 均为 notImplemented stub,
// 对应 UI 入口在 web 下整个隐藏 (能力缺失不是状态问题, 隐藏而非禁用).
//
// ⚠️ 阶段 3 (#11 serve-api calendar 写端点) 落地后, 由 per-method capabilities
// 能力表替换本 build-target 粗门控.
//
// 探针跟随仓内既有惯例 (agents/shared.ts IS_WEB / CommandPalette
// resolveBuildTarget): 生产读 import.meta.env (vite.web.config.ts define),
// vitest 回退 process.env (vi.stubEnv 只进 process.env 不进 import.meta.env).
function resolveBuildTarget(): string | undefined {
  const metaTarget = (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
    ?.VITE_BUILD_TARGET
  if (metaTarget) return metaTarget
  if (typeof process !== 'undefined') return process.env?.VITE_BUILD_TARGET
  return undefined
}

/** True = 远程 web (SPA) build — calendar 写入口 (新建/编辑/删除/RSVP/扫描/Replay) 隐藏. */
export const IS_WEB_BUILD = resolveBuildTarget() === 'web'
