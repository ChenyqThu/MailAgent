// serve-api base URL 解析 —— **零依赖叶子**（只用 import.meta.env + window.location，
// 不 import 任何 electron / store / 组件），故任何 renderer 侧模块都能安全 import。
//
// 背景：这段逻辑此前在 renderer 里被手抄了四份（CustomAiSection、SkillInstallConfirmCard、
// CalendarApprovalCard、DraftComposeCard），每份都带一句「intentionally duplicated to
// avoid coupling」的注释。CLAUDE.md 的纪律是：要在第二处手抄一个常量/派生逻辑，先问能
// 不能消灭镜像——「不能 import 因为对方顶层拉了重依赖」的正解是**下沉**，不是再抄一份。
//
// 本模块就是那个下沉点。新代码一律 import 这里。
// ⚠️ 上述四处既有副本**有意不在本次改动范围内**（它们是预存债，不是这次引入的；顺手
// 改无关文件会把一次功能改动的 diff 撑大）。后续收敛时把它们逐个换成本模块即可，
// 行为完全一致——本函数就是从它们逐字提取的。

/**
 * 当前构建目标下 serve-api 的 base URL。
 *
 * - web（远程 `mail.chenge.ink/app`）：同源 `/api`（经 CF Access cookie 鉴权），
 *   可被 `VITE_API_BASE_URL` 覆盖。
 * - 桌面 renderer：loopback `http://127.0.0.1:<port>/api`。端口从 URL 的 `apiPort`
 *   查询参数读（主进程启动时带上），拿不到就退默认 8200。
 *   token 与 CORS 由主进程的 webRequest 桥透明注入（见 chat_local_bridge.ts），
 *   renderer 自己不持有本地 token。
 */
export function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment — fall through to the default port */
  }
  return `http://127.0.0.1:${port}/api`
}
