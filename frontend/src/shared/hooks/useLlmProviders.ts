// task 07-12 P3 — LLM provider 管理（Settings「模型服务」区）数据层。
//
// 传输：直连 loopback serve-api（零新 IPC，同 ElectronApi.listUpstreamModels 先例）。
// 写端点（POST/PATCH/DELETE + /test + model PUT/DELETE）后端挂 verify_local_token：
// Electron renderer 的请求由 chat_local_bridge 的 webRequest.onBeforeSendHeaders 注入
// X-MailAgent-Local-Token 放行；远程 web 仅 CF cookie → 403（prd「远程对 provider
// 配置只读」的 API 层落点），UI 侧 isWeb 同时只读渲染，双保险。
//
// providerRef 词汇（prd §4.3b，双端一致）：'providerId:modelId'，按第一个 ':' 切分；
// 无 ':' → default provider（legacy 裸 model id 兼容）。

import { useQuery } from '@tanstack/react-query'

import { request } from '@shared/api/http_client'
import { qk } from '@shared/lib/queryKeys'

import { fetchChatConfigModelsProbe, resolveApiBaseUrl } from './useLlmModels'

// ── wire 类型（镜像 llm_providers.py 的 _masked_provider_dict / _model_dict）──────────

export type LlmProviderProtocol =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'google'
  | 'deepseek'
  | 'openrouter'

export interface LlmProviderSummary {
  id: string
  protocol: LlmProviderProtocol
  displayName: string
  baseUrl: string
  /** 自定义 header 只回名不回值（批 2 review HIGH-1：header 值按 secret 纪律 write-only，
   *  明文仅在 snapshot（verify_local_token）面）。改值 = PATCH headers 明文 map 全量替换。 */
  headerNames: string[]
  enabled: boolean
  sortOrder: number
  hasKey: boolean
  /** 掩码尾 4 位（识别是哪把 key）；解密失败/无 key → null。明文永不出 wire。 */
  keyLast4: string | null
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface LlmModelCapabilities {
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
}

export interface LlmProviderModel {
  id: string
  displayName: string | null
  groupName: string | null
  enabled: boolean
  /** null = 上游未标注（snapshot 不臆造能力位）——渲染时区分「未知」与 false。 */
  capabilities: LlmModelCapabilities | null
  maxOutput: number | null
  contextWindow: number | null
  source: 'fetched' | 'manual'
  fetchedAt: number | null
}

export interface LlmProviderModelsData {
  provider: string
  models: LlmProviderModel[]
  fetchedNew: number
  /** 上游拉取失败的可读消息（恒 200 + error 字段；现存行照常返回）。 */
  error: string | null
}

/** `POST /llm/providers/{id}/test` 的 serve-api 响应（settings 侧 HTTP 直连）。
 *
 *  两个字段都必填是**对的**：`src/api/routers/llm_providers.py:736-771` 的两条分支
 *  （配置问题早返回 / 正常探测）都恒发 `latencyMs`（前者 0）与 `error`（成功时 null）。
 *
 *  🔴 与 `@shared/onboarding/llmProviderTemplates` 里那个同名类型**不是**一回事：那条是
 *  onboarding 的 IPC 通道，main 会插入自己的护栏返回（缺 id / 非本次引导保存的 id / catch
 *  兜底），那几条压根没到上游、没有 latency，故那边两个字段都 optional。同名不同契约，
 *  合并会把其中一侧变成谎（issue #67 item 6）。 */
export interface LlmProviderTestResult {
  ok: boolean
  latencyMs: number
  error: string | null
}

// ── CRUD 客户端（request() 统一 envelope unwrap；错误 throw Error&{code}）────────────

export async function listLlmProviders(): Promise<{
  providers: LlmProviderSummary[]
  version: number
}> {
  return request(resolveApiBaseUrl(), 'GET', '/llm/providers')
}

export async function createLlmProvider(input: {
  id: string
  protocol: LlmProviderProtocol
  displayName?: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
}): Promise<LlmProviderSummary> {
  return request(resolveApiBaseUrl(), 'POST', '/llm/providers', { body: input })
}

export async function updateLlmProvider(
  providerId: string,
  patch: {
    displayName?: string
    baseUrl?: string
    /** 非空 = 轮换；'' / null = 清除（后端语义）。 */
    apiKey?: string | null
    /** write-only 明文 map，全量替换：省略 = 不改，{} = 清空（跨 lane 契约）。 */
    headers?: Record<string, string>
    enabled?: boolean
    sortOrder?: number
  }
): Promise<LlmProviderSummary> {
  return request(resolveApiBaseUrl(), 'PATCH', `/llm/providers/${encodeURIComponent(providerId)}`, {
    body: patch
  })
}

export async function deleteLlmProvider(providerId: string): Promise<void> {
  await request(resolveApiBaseUrl(), 'DELETE', `/llm/providers/${encodeURIComponent(providerId)}`)
}

/** 纯读现存 model 行（批 2 review HIGH-2 后 GET 不再带 refresh —— 读端点不出网不写库）。 */
export async function listLlmProviderModels(providerId: string): Promise<LlmProviderModelsData> {
  return request(
    resolveApiBaseUrl(),
    'GET',
    `/llm/providers/${encodeURIComponent(providerId)}/models`
  )
}

/** 上游拉取（出网 + merge 写库）→ 独立写端点 POST /models/refresh（verify_local_token，
 *  远程 web 403 只读）。响应形状同旧 refresh=true（跨 lane 契约）。 */
export async function refreshLlmProviderModels(providerId: string): Promise<LlmProviderModelsData> {
  return request(
    resolveApiBaseUrl(),
    'POST',
    `/llm/providers/${encodeURIComponent(providerId)}/models/refresh`
  )
}

export async function testLlmProvider(providerId: string): Promise<LlmProviderTestResult> {
  return request(
    resolveApiBaseUrl(),
    'POST',
    `/llm/providers/${encodeURIComponent(providerId)}/test`
  )
}

/** model 行 upsert（启用勾选 / 手动添加 / maxOutput 编辑）。merge 语义在后端：
 *  body 出现的键才动。model id 走 body 而非 path 段（OpenRouter wire id 含 '/'）。 */
export async function upsertLlmProviderModel(
  providerId: string,
  input: {
    id: string
    displayName?: string | null
    enabled?: boolean
    capabilities?: LlmModelCapabilities | null
    maxOutput?: number | null
    contextWindow?: number | null
  }
): Promise<LlmProviderModel> {
  return request(
    resolveApiBaseUrl(),
    'PUT',
    `/llm/providers/${encodeURIComponent(providerId)}/models`,
    { body: input }
  )
}

export async function deleteLlmProviderModel(providerId: string, modelId: string): Promise<void> {
  await request(
    resolveApiBaseUrl(),
    'DELETE',
    `/llm/providers/${encodeURIComponent(providerId)}/models`,
    { query: { modelId } }
  )
}

// ── React Query hooks ────────────────────────────────────────────────────────────────

/** MAILAGENT_LLM_PROVIDER_REGISTRY 的前端可观测投影。false/加载中 → 旧 UI（字节级不变）。
 *  复用 useEnabledModels 的同一 /chat/config query（同 queryKey + queryFn，select 投影
 *  另一切片）——批 2 review LOW-7：flag off 打开 Settings/抽屉不得新增独立网络请求。 */
export function useProviderRegistryEnabled(): boolean {
  const q = useQuery({
    queryKey: qk.chat.config('enabledModels'),
    queryFn: fetchChatConfigModelsProbe,
    select: (d) => d.providerRegistryEnabled,
    staleTime: 30_000,
    retry: false
  })
  return q.data === true
}

export function useLlmProviders(enabled: boolean): {
  providers: LlmProviderSummary[]
  isLoading: boolean
  isError: boolean
} {
  const q = useQuery({
    queryKey: qk.llm.providers(),
    queryFn: listLlmProviders,
    enabled,
    staleTime: 10_000,
    retry: false
  })
  return {
    providers: q.data?.providers ?? [],
    isLoading: q.isLoading,
    isError: q.isError
  }
}

export function useLlmProviderModels(
  providerId: string,
  enabled: boolean
): {
  models: LlmProviderModel[]
  isLoading: boolean
} {
  const q = useQuery({
    queryKey: qk.llm.providerModels(providerId),
    queryFn: () => listLlmProviderModels(providerId),
    enabled,
    staleTime: 10_000,
    retry: false
  })
  return { models: q.data?.models ?? [], isLoading: q.isLoading }
}

// ── providerRef 分组（功能位选择器「按 provider 分组」展示）────────────────────────────

export const DEFAULT_PROVIDER_ID = 'default'

export interface ModelRefGroup {
  providerId: string
  /** 完整 providerRef（选择器 value 恒用全串；显示用 stripProviderPrefix）。 */
  refs: string[]
}

/** providerRef 显示名：组内展示去掉 'providerId:' 前缀（值仍是全串）。裸 id 原样。 */
export function stripProviderPrefix(ref: string): string {
  const i = ref.indexOf(':')
  return i > 0 ? ref.slice(i + 1) : ref
}

/** providerRef → providerId（`stripProviderPrefix` 的对偶）：第一个 ':' 之前的段；
 *  裸 id / ':' 开头的畸形值 → default。**切分规则的单源** —— composer 的
 *  `useComposerModels` 要在 query 之前先算「拉哪几个 provider」，也走这里，别再抄一份
 *  （抄一份 = Settings 与 composer 的分组口径会各自漂移）。 */
export function refProviderId(ref: string): string {
  const i = ref.indexOf(':')
  return i > 0 ? ref.slice(0, i) : DEFAULT_PROVIDER_ID
}

/** 按第一个 ':' 切分分组；裸 id → default 组。default 组恒排最前，其余按首现顺序。 */
export function groupModelRefs(refs: string[]): ModelRefGroup[] {
  const order: string[] = []
  const byProvider = new Map<string, string[]>()
  for (const ref of refs) {
    const pid = refProviderId(ref)
    let bucket = byProvider.get(pid)
    if (!bucket) {
      bucket = []
      byProvider.set(pid, bucket)
      order.push(pid)
    }
    bucket.push(ref)
  }
  // 稳定排序：仅把 default 提到最前，其余保持首现顺序。
  order.sort((a, b) => (a === DEFAULT_PROVIDER_ID ? -1 : b === DEFAULT_PROVIDER_ID ? 1 : 0))
  return order.map((pid) => ({ providerId: pid, refs: byProvider.get(pid) ?? [] }))
}
