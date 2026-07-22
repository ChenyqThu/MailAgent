// D1 — main 进程本机 daemon 写客户端 (loopback serve-api + per-session 本地 token)。
//
// 写操作收编 (plan §D1 / docs/reference/architecture/backend-service-migration-matrix.md): write_ops /
// draft / chat 写工具不再 fork `mailagent` CLI / 直写 SQLite, 统一经此转发到本机
// serve-api (127.0.0.1:8200) 的 in-process service 层。写源从 4 (TS 直写 outbox /
// TS fork CLI / serve-api fork CLI / reverse_sync) 收敛到 1 (daemon service)。
//
// 复用 web SPA 同款 `http_client.request()` (plan 钦定「统一客户端」), 注入 C2 的
// 本地 token header `X-MailAgent-Local-Token` —— serve-api auth.py 的本地腿据此放行
// (本机 Electron 身份)。远程 web 走 CF Access cookie 不带此 header, 两路鉴权并存。
//
// request() 返回 envelope.data 块**原样** (不做 renderer-unwrap): IPC handler 把它
// 经 envelopeFromCli 回传 renderer, ElectronApi 那侧的 unwrap (含 pin 的
// `data.is_pinned` 二次取字段) 继续工作, 与原 CLI data 块 parity 一致 —— 因 A2-A4 已
// 保证 serve-api service 输出 == 旧 fork-CLI golden。故各写操作 (除 flag 单行原走
// IPC 直写) renderer 形状零变化。
//
// 各 daemonRequest 的 path/body/query 严格 mirror `@shared/api/HttpApi` 对应方法
// (raw-data 视角 vs renderer-unwrap 视角), 两路 wire 零漂移; parity 由
// tests/cli/test_schema_contract (Python data 形状) + write_ops/compose 转发测试 (TS)
// 锁。改 HttpApi 端点 wire 时必须同步此文件 (反之亦然)。
//
// 前提: serve-api 在跑。打包态由 BackendLifecycleManager flip 后恒起 (本地 token 即可
// 起, 不再强制 CF_AUDIENCE; C2 已放宽 auth.py import 守卫 + 加崩溃自拉起作安全网);
// dev/pm2 态需手动起 `mailagent serve-api`, 否则写抛 E_NETWORK (诚实降级: 读仍 IPC 直读
// SQLite → "能看不能改", plan §D1 不做本地 outbox 暂存)。

import { request, requestRaw, requestWithMeta, type RequestOptions } from '@shared/api/http_client'

import { getLocalApiToken, LOCAL_TOKEN_HEADER } from './local_token'

/** serve-api 默认端口 (与 backend_lifecycle.DEFAULT_API_PORT / cloudflared ingress /
 *  auth 同源 8200)。独立读 env 而非 import backend_lifecycle —— 后者顶层 `import { app }
 *  from 'electron'`, 拉进来会逼 daemon_api 单测 mock electron。8200 是稳定常量, 此注释
 *  钉死同源。 */
const DEFAULT_API_PORT = 8200

function resolveDaemonBaseUrl(): string {
  const raw = process.env.MAILAGENT_API_PORT
  const n = raw != null ? Number.parseInt(raw, 10) : NaN
  const port = Number.isFinite(n) && n > 0 ? n : DEFAULT_API_PORT
  return `http://127.0.0.1:${port}/api`
}

/**
 * 调本机 serve-api, 带本地 token header, 返回 envelope.data 块原样
 * (success → data, error → throw ApiError{code,hint}; 与 http_client.request 语义一致)。
 *
 * baseUrl 每次现算 (不缓存) —— MAILAGENT_API_PORT 进程内稳定, 现算成本可忽略, 且便于
 * 单测注入端口。caller 传的 opts.headers 与本地 token 合并 (token 优先级在前, caller
 * 一般不传 header)。
 */
export function daemonRequest<T>(
  method: string,
  path: string,
  opts: RequestOptions = {}
): Promise<T> {
  return request<T>(resolveDaemonBaseUrl(), method, path, {
    ...opts,
    headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken(), ...(opts.headers ?? {}) }
  })
}

/** task 07-21 — `daemonRequest` 的分页变体：不丢弃 envelope.meta（如 `total`/`limit`/
 *  `offset`），供 `report:listRuns` IPC 透传给 renderer 做滚动加载/总数展示。 */
export function daemonRequestWithMeta<T>(
  method: string,
  path: string,
  opts: RequestOptions = {}
): Promise<{ data: T; meta: Record<string, unknown> }> {
  return requestWithMeta<T>(resolveDaemonBaseUrl(), method, path, {
    ...opts,
    headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken(), ...(opts.headers ?? {}) }
  })
}

/** Raw-body 变体 (D1 compose 附件 staging 上传: PUT raw bytes, 非 JSON)。
 *  同 daemonRequest 的 token 注入 + envelope 语义, body 原样透传。 */
export function daemonRequestRaw<T>(
  method: string,
  path: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string,
  opts: Omit<RequestOptions, 'body'> = {}
): Promise<T> {
  return requestRaw<T>(resolveDaemonBaseUrl(), method, path, body, contentType, {
    ...opts,
    headers: { [LOCAL_TOKEN_HEADER]: getLocalApiToken(), ...(opts.headers ?? {}) }
  })
}
