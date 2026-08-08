// W8 模型选择器（task 08-04 WP2）— composer 侧的「可选模型 + 富元数据」数据层。
//
// 数据接法（PRD §W8「数据接法（实现时二选一，倾向前者）」取前者）：
//   **哪些模型可选** 仍单源 `useEnabledModels()`（/chat/config.enabledModels，热读 .env /
//   provider 表；两个 composer 与 Settings 共用同一 React Query key，不另开请求）。
//   **每个模型长什么样**（displayName / capabilities / maxOutput / 属于哪个 provider）来自
//   已有的 `GET /llm/providers` + `GET /llm/providers/{id}/models`（verify_cf_access，远程
//   web 天然可用），此前只有 Settings 消费。
//
// 为什么不走「扩展 /chat/config.enabledModels 为对象数组」：那是 breaking 的双端契约改动
// （Python 产、Node gateway 与两处前端消费），而这里要的字段后端**已经**在另一条读端点上
// 备齐了，白拿。代价 = 打开 chat 时多 1 + N 个 loopback GET（N = 被引用到的 provider 数，
// 通常 1-3），staleTime 5min + 与 Settings 同 queryKey 去重，实测只在首帧各发一次。
//
// 🔴 capabilities === null 是「上游未标注」，不是「全 false」（prd §4.3b 注记②）——渲染侧
// 必须区分这两者，别把未知说成不支持。
//
// ── 08-04 收尾：外挂模型元数据目录（models.dev 快照）──────────────────────────────
// 上面那句「后端已经在另一条读端点上备齐了」**只对了一半**：provider 行是齐的，model 行
// 的 `display_name` / `capabilities_json` / `max_output` 在真实机器上几乎全 NULL（owner 机
// 器 90 行：0 / 0 / 2 有值），且三条写入路径没有一条会写它们 —— OpenAI / Anthropic 的
// `/v1/models` 响应里本来就没有 context window 与能力标注。故这里叠一层**只读目录**。
//
// 🔴 优先级恒为 **DB 行 > 目录 > 裸 id**：用户在 Settings 里手填过的值必须赢，否则「改了
// 没用」。目录只填 DB 行留白的那些字段；contextWindow 本轮也遵守同一优先级。
// 🔴 目录查不到 → 静默降级（不写 '?'、不写 0、不猜），那一行长得和引入目录之前逐字一样。

import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'
import { lookupModelMeta, type CatalogModelMeta } from '@shared/modelCatalog/lookup'

import { useEnabledModels } from './useLlmModels'
import {
  DEFAULT_PROVIDER_ID,
  listLlmProviderModels,
  listLlmProviders,
  refProviderId,
  stripProviderPrefix,
  type LlmModelCapabilities,
  type LlmProviderProtocol
} from './useLlmProviders'

/** 元数据 query 的 staleTime：provider/model 行只在 Settings 手改时变，5min 足够新。 */
const METADATA_STALE_MS = 5 * 60_000

export interface ComposerModelOption {
  /** 完整 providerRef —— 发给 gateway 的值（`controls.model` / `onModelChange` 的词汇）。 */
  ref: string
  /** 第一个 ':' 之前的段；裸 id → 'default'（legacy 兼容，与 groupModelRefs 同口径）。 */
  providerId: string
  /** provider 行的 displayName；没有对应行时 null（渲染侧决定兜底文案）。 */
  providerLabel: string | null
  /** provider 行的 protocol；没有对应行时 null（图标解析的第二级依据）。 */
  protocol: LlmProviderProtocol | null
  /** 去掉 provider 前缀的 model id。 */
  modelId: string
  /** 展示名：model 行的 displayName → 目录全名 → 裸 modelId。 */
  displayName: string
  /** null = 上游与目录都未标注（不渲染 badge）；对象里只有显式 true 的位才算支持。 */
  capabilities: LlmModelCapabilities | null
  /** 该模型单次回答的最大输出 token 数（llm_model.max_output → 目录）；null = 未标注。 */
  maxOutput: number | null
  /** 上下文窗口 token 数（llm_model.context_window → 目录）；null = 未标注。 */
  contextWindow: number | null
  /** 目录命中结果的原件，hover 能力卡的数据源；null = 未命中（卡不挂、静默降级）。 */
  catalogMeta: CatalogModelMeta | null
}

export interface ComposerModelGroup {
  providerId: string
  providerLabel: string | null
  options: ComposerModelOption[]
}

/** 按 provider 分组，组内保持 enabledModels 的原始顺序；default 组恒排最前
 *  （与 Settings/抽屉的 groupModelRefs 同一排序契约，切分走同一个 `refProviderId`）。 */
export function groupComposerModels(options: ComposerModelOption[]): ComposerModelGroup[] {
  const order: string[] = []
  const byProvider = new Map<string, ComposerModelOption[]>()
  for (const opt of options) {
    let bucket = byProvider.get(opt.providerId)
    if (!bucket) {
      bucket = []
      byProvider.set(opt.providerId, bucket)
      order.push(opt.providerId)
    }
    bucket.push(opt)
  }
  order.sort((a, b) => (a === DEFAULT_PROVIDER_ID ? -1 : b === DEFAULT_PROVIDER_ID ? 1 : 0))
  return order.map((providerId) => {
    const opts = byProvider.get(providerId) ?? []
    return { providerId, providerLabel: opts[0]?.providerLabel ?? null, options: opts }
  })
}

/** 元数据查表的形状：providerId → (modelId → 行)。**刻意用嵌套 Map 而不是拼一个
 *  `providerId + 分隔符 + modelId` 的复合 key** —— OpenRouter 的 wire id 含 '/'、
 *  自建中转的 id 什么字符都可能有，任何分隔符都可能撞进 id 里。 */
export type ComposerModelMeta = Map<
  string,
  Map<
    string,
    {
      displayName: string | null
      capabilities: LlmModelCapabilities | null
      maxOutput: number | null
      contextWindow: number | null
    }
  >
>

export type ComposerProviderMeta = Map<
  string,
  { displayName: string; protocol: LlmProviderProtocol }
>

/** 目录查表的注入点 —— 生产恒是 `lookupModelMeta`；测试传桩以免断言跟着快照内容漂移
 *  （快照是生成物，会随 `sync-model-catalog.mjs` 定期更新）。 */
export type ModelCatalogLookup = typeof lookupModelMeta

/** DB 行 + 目录 → 最终选项。**行权威、目录兜底**（见文件头）。
 *
 *  🔴 `capabilities` 是**整体**二选一，不做逐键合并：行里有对象 = 用户/上游显式标注过，
 *  逐键并进目录值会让「未知 / false / true」三态糊成一团（正是 prd §4.3b 注记②要防的）。 */
export function composeComposerModelOption(
  base: {
    ref: string
    providerId: string
    providerLabel: string | null
    protocol: LlmProviderProtocol | null
    modelId: string
    rowDisplayName: string | null
    rowCapabilities: LlmModelCapabilities | null
    rowMaxOutput: number | null
    rowContextWindow: number | null
  },
  lookup: ModelCatalogLookup = lookupModelMeta
): ComposerModelOption {
  const meta = lookup(base.modelId, base.protocol)
  return {
    ref: base.ref,
    providerId: base.providerId,
    providerLabel: base.providerLabel,
    protocol: base.protocol,
    modelId: base.modelId,
    displayName: base.rowDisplayName ?? meta?.displayName ?? base.modelId,
    capabilities: base.rowCapabilities ?? meta?.capabilities ?? null,
    maxOutput: base.rowMaxOutput ?? meta?.maxOutput ?? null,
    contextWindow: base.rowContextWindow ?? meta?.contextWindow ?? null,
    catalogMeta: meta
  }
}

/** 把一个 providerRef 拼成「元数据尽力而为」的选项：查不到 provider / model 行时，
 *  退化成目录兜底；目录也未命中才退回今天扁平列表那份信息（ref + 去前缀 id）。 */
export function buildComposerModelOption(
  ref: string,
  providers: ComposerProviderMeta,
  models: ComposerModelMeta,
  lookup: ModelCatalogLookup = lookupModelMeta
): ComposerModelOption {
  const providerId = refProviderId(ref)
  const modelId = stripProviderPrefix(ref)
  const provider = providers.get(providerId)
  const model = models.get(providerId)?.get(modelId)
  return composeComposerModelOption(
    {
      ref,
      providerId,
      providerLabel: provider?.displayName?.trim() ? provider.displayName.trim() : null,
      protocol: provider?.protocol ?? null,
      modelId,
      rowDisplayName: model?.displayName?.trim() ? model.displayName.trim() : null,
      rowCapabilities: model?.capabilities ?? null,
      rowMaxOutput: model?.maxOutput ?? null,
      rowContextWindow: model?.contextWindow ?? null
    },
    lookup
  )
}

/** composer 模型选择器的数据源：可选模型（enabledModels 单源）× 富元数据（provider 表）。 */
export function useComposerModels(): ComposerModelOption[] {
  const { models: refs } = useEnabledModels()

  const providersQ = useQuery({
    queryKey: qk.llm.providers(),
    queryFn: listLlmProviders,
    staleTime: METADATA_STALE_MS,
    retry: false
  })

  // 只拉「真的被引用到」的 provider —— N 由 enabledModels 决定，不是表里全部行。
  const providerIds = useMemo(() => {
    const seen = new Set<string>()
    for (const ref of refs) seen.add(refProviderId(ref))
    return [...seen].sort()
  }, [refs])

  const modelQueries = useQueries({
    queries: providerIds.map((pid) => ({
      queryKey: qk.llm.providerModels(pid),
      queryFn: () => listLlmProviderModels(pid),
      staleTime: METADATA_STALE_MS,
      retry: false
    }))
  })

  // useQueries 每次都返回**新的**结果数组，直接当 memo 依赖 = 每帧重算 → 每帧新的
  // options 数组 → 上游 composerControls 的 useMemo 也跟着每帧失效（整个 thread 重渲染）。
  // 故用 `provider:dataUpdatedAt` 拼一个内容指纹当依赖：只有真的 fetch 成功过才会变
  // （🔴 只拼 provider 名不行 —— Settings 改完 maxOutput 后 refetch 回来名字没变，
  // 徽标会永远停在旧值）。
  const modelRows = modelQueries.map((q) => q.data)
  const modelsKey = modelQueries
    .map((q) => `${q.data?.provider ?? ''}@${q.dataUpdatedAt}`)
    .join('|')
  const providerRows = providersQ.data?.providers

  return useMemo(() => {
    const providers: ComposerProviderMeta = new Map()
    for (const p of providerRows ?? []) {
      providers.set(p.id, { displayName: p.displayName, protocol: p.protocol })
    }
    const models: ComposerModelMeta = new Map()
    for (const data of modelRows) {
      if (!data) continue
      let bucket = models.get(data.provider)
      if (!bucket) {
        bucket = new Map()
        models.set(data.provider, bucket)
      }
      for (const m of data.models) {
        bucket.set(m.id, {
          displayName: m.displayName,
          capabilities: m.capabilities,
          maxOutput: m.maxOutput,
          contextWindow: m.contextWindow
        })
      }
    }
    return refs.map((ref) => buildComposerModelOption(ref, providers, models))
    // modelRows 每帧都是新数组，故有意不入依赖；modelsKey（provider@dataUpdatedAt）才是
    // 它的内容指纹。providerRows 是 query 的稳定 data 引用，可以直接入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, providerRows, modelsKey])
}
