// DavMail 认证失效自助重连 —— serve-api `/api/davmail/reauth/*` 的 wire 形状（task 10-28）。
//
// 🔴 字段名保持服务端 snake_case 原样：对象整体来自 `src/api/routers/davmail.py` 的
// success_envelope，没有映射层。

export interface DavMailReauthStart {
  session_id: string
  /** 微软登录页地址，用系统默认浏览器打开。 */
  authorize_url: string
  /** 会话过期时间，epoch **秒**（10 分钟，与授权码有效期对齐）。 */
  expires_at: number
}

/** 失败停在哪一步。`session` = 会话不存在或已过期，需要重新获取链接。 */
export type DavMailReauthStage = 'session' | 'parse' | 'exchange' | 'write' | 'verify' | 'done'

export interface DavMailReauthResult {
  ok: boolean
  stage: DavMailReauthStage
  /** 成功为 `OK`；失败为 `E_*` 或微软的 `AADSTS<数字>`（如 `AADSTS70008` = 授权码过期）。 */
  code: string
  /** 可直接展示的中文说明。 */
  message: string
}

export interface DavMailApi {
  /** 非 davmail 后端或 DavMail 配置不支持时抛错（409 E_INVALID_STATE，message 可直接展示）。 */
  startReauth(): Promise<DavMailReauthStart>
  /** 业务失败不抛错，返回 `ok=false`；只有请求本身不合法或网络错误才抛。 */
  completeReauth(sessionId: string, callback: string): Promise<DavMailReauthResult>
}
