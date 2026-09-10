// OpenCode 会话 ID 生成（网关侧，node:crypto）。判据与头名在 shared/lib/opencodeSession.ts。
// 独立成轻模块：chatRun.ts 不得在顶层值导入 providers.ts（重型 provider SDK 懒加载闸）。

import { createHash, randomUUID } from 'node:crypto'

/** 进程级随机盐兼兜底值：同一会话在本次运行内得到固定 ID，不同安装之间不会撞。 */
export const OPENCODE_PROCESS_SESSION = randomUUID()

/** 会话 → 稳定的 `x-opencode-session` 值（UUID 形状）。首发前还没有会话 id 的那一轮用随机值。 */
export function opencodeSessionId(sessionId: number | null): string {
  if (sessionId == null) return randomUUID()
  const hex = createHash('sha256').update(`${OPENCODE_PROCESS_SESSION}:${sessionId}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}
