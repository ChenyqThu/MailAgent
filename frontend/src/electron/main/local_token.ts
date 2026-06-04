// C2 — per-session 本地 ephemeral API token.
//
// 同机 Electron 客户端 (主进程 events_bridge → 9200 SSE; D1 起 renderer → 8200 写) 用自定义
// header X-MailAgent-Local-Token 向本机 daemon 证明「我是本会话的合法本地调用方」。
// loopback ≠ 安全 (同机任意进程都能打 127.0.0.1), 自定义 header 天然抗 CSRF (浏览器无法伪造 +
// CORS 白名单只放 mail.chenge.ink)。
//
// 进程内单例 (首次取用时 randomBytes 生成), 经 backend_lifecycle.buildBaseEnv 注入 serve +
// serve-api 子进程的 MAILAGENT_LOCAL_API_TOKEN env → Python 侧 (auth.py / sse_server.py) 据此
// 校验。同一单例既注入后端、又供 events_bridge 带 header → 两端天然同值, 无须二次同步。
//
// 🔴 ENV / HEADER 名必须与 src/api/auth.py + src/sse_server.py 一致 (那两处手抄同名字面量)。

import { randomBytes } from 'crypto'

/** 子进程 env key — Python auth.py / sse_server.py 读它取期望 token。 */
export const LOCAL_TOKEN_ENV = 'MAILAGENT_LOCAL_API_TOKEN'
/** 自定义鉴权 header — auth.py / sse_server.py 校验它。 */
export const LOCAL_TOKEN_HEADER = 'X-MailAgent-Local-Token'

let _token: string | null = null

/**
 * 进程内 per-session token (lazy 生成 + 缓存)。256-bit hex。
 *
 * 每次 app 启动是一把新 token (随进程而生而灭) —— 不落盘、不可被 enumerate, 比固定密钥
 * 更安全。dev / pm2 模式后端不由本进程 spawn (无注入) → 后端 token env 为空 → Python 侧
 * 门关 (向后兼容), 本函数仍可被 events_bridge 调用 (带个被忽略的 header 无害)。
 */
export function getLocalApiToken(): string {
  if (_token === null) _token = randomBytes(32).toString('hex')
  return _token
}

/** 单测重置 (避免跨用例单例状态串)。 */
export function _resetLocalApiTokenForTests(): void {
  _token = null
}
