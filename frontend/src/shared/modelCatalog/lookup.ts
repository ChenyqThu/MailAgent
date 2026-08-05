// 模型元数据目录 —— 查表层（**零依赖叶子模块**：只 import 类型 + 同目录 JSON 快照）。
//
// 存在的理由（task 08-04 收尾 / dogfood-3）：W8 精心做的「能力 badge + 上下文药丸」在 owner
// 机器上一个都没渲染 —— `llm_model` 表 90 行里 `capabilities_json` **全 NULL**、`display_name`
// **全 NULL**、`max_output` 只有 2 行有值。三条写入路径（merge_fetched_models /
// seed_default_from_env / Settings UI）没有一条会写这些字段，而 OpenAI / Anthropic 的
// `/v1/models` 响应里**本来就没有** context window 与能力标注 —— 所以这个功能从落地那天起
// 就是空的。补法只能是外挂一份开放元数据目录。
//
// 🔴 三条硬纪律：
//   ① **不能用 model id 做全局查表** —— 同一个 id 在不同 provider 下的 context 会不一致
//      （实测 `gpt-5.6-sol` 在两家差 3.9 倍）。必须按「protocol → 首选 provider 有序链」查。
//      全链未命中时才允许全局回退，且**只在该 id 全局唯一时**采纳（有歧义宁可不显示）。
//   ② **DB 行权威、目录兜底**（叠加发生在 useComposerModels 侧）：用户在 Settings 里手填过的
//      值必须赢，否则「改了没用」。
//   ③ **查不到就静默降级**（返回 null → 调用方不渲染药丸/badge/卡），绝不猜、绝不显示可能错的
//      数字。降级后那一行长得和引入目录之前一模一样。
//
// 🔴 目录名不带 `data` 段是**有意**的：仓库根 `.gitignore` 的 `data/` 没有前导斜杠，按
// gitignore 语义匹配任意层级的 data 目录 —— 放在 `src/shared/data/` 下的快照本机跑得好好的，
// 但 commit 即丢、CI 打出的 .app 里根本没有这个文件（元数据静默全灭，退回裸 id 列表）。
//
// 数据来源与授权见同目录 NOTICE.md（MIT © models.dev）；快照由
// `frontend/scripts/sync-model-catalog.mjs` 生成，手动跑、产物入库。

import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import catalogJson from './catalog.json'

// ── 快照的形状（镜像 sync-model-catalog.mjs 的 trimModel 输出）──────────────────────

/** 能力位。**缺席 = 上游未标注，不是 false** —— 这条语义与 `LlmModelCapabilities` 一致。 */
export interface CatalogCapabilities {
  tools?: boolean
  vision?: boolean
  reasoning?: boolean
  files?: boolean
}

/** $ / 百万 token（models.dev 的 cost 单位）。各键独立可缺。 */
export interface CatalogCost {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

interface RawCatalogModel {
  name?: string
  description?: string
  context?: number
  output?: number
  caps?: string[]
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  released?: string
  knowledge?: string
  deprecated?: boolean
}

interface RawCatalogProvider {
  name: string
  models: Record<string, RawCatalogModel>
}

export interface ModelCatalogSnapshot {
  source: string
  generatedAt: string
  providers: Record<string, RawCatalogProvider>
}

/** 查表结果。`match === 'normalized'` = 元数据是**按归一化后的 id 推断**的，不是逐字命中 ——
 *  展示侧要如实注明（owner 的中转把档位写进 id，如 `claude-opus-5[1m]`；抹掉后缀后拿到的是
 *  厂商官方值，碰巧对得上，但不该假装是精确事实）。 */
export interface CatalogModelMeta {
  displayName: string
  description: string | null
  contextWindow: number | null
  maxOutput: number | null
  capabilities: CatalogCapabilities | null
  cost: CatalogCost | null
  releasedAt: string | null
  knowledgeCutoff: string | null
  deprecated: boolean
  /** 命中的目录 provider（**不是**用户的 providerId）—— 卡上注明来源用。 */
  catalogProviderId: string
  catalogProviderName: string
  match: 'exact' | 'normalized'
  /** 真正查到的那个目录 id（normalized 命中时与传入 id 不同）。 */
  matchedModelId: string
}

const CATALOG = catalogJson as unknown as ModelCatalogSnapshot

export const MODEL_CATALOG_SOURCE = CATALOG.source
export const MODEL_CATALOG_GENERATED_AT = CATALOG.generatedAt

// ── 本地覆盖表（扩展位）────────────────────────────────────────────────────────────

/** models.dev 覆盖不到的模型在这里补 —— 形状与 catalog.json 的 `providers` 逐字一致，
 *  查表时**叠在快照之上**（同 provider 同 id 时覆盖表赢），并同样参与有序链与全局回退。
 *
 *  现在是空的。已知的唯一硬缺口是**豆包 / 火山**（models.dev 无第一方条目），owner 当前不用，
 *  故有意不补。要补时往这里加，**不要**改 catalog.json（那是生成物，下次 sync 会被覆写）。 */
export const LOCAL_CATALOG_OVERRIDES: Record<string, RawCatalogProvider> = {}

// ── 匹配策略 ──────────────────────────────────────────────────────────────────────

/** protocol → 首选目录 provider 的**有序**链。顺序即优先级：同一个 id 在多家出现时，排在
 *  前面的那家赢。`openai-compatible` 是「随便什么中转」的意思，故链最长（背后什么都可能是），
 *  但仍按「最可能 → 次可能」排，不做全局乱猜。
 *
 *  🔴 `openrouter` 链里**没有 openrouter 自己** —— 快照有意不收聚合器（见 sync 脚本的白名单
 *  注释）。它的 wire id `vendor/model` 会被归一化剥掉前缀后落到厂商自己那家。 */
export const PREFERRED_CATALOG_PROVIDERS: Record<LlmProviderProtocol, readonly string[]> = {
  anthropic: ['anthropic'],
  openai: ['openai'],
  deepseek: ['deepseek'],
  google: ['google'],
  openrouter: ['openai', 'anthropic', 'google', 'deepseek', 'alibaba', 'mistral', 'xai'],
  'openai-compatible': [
    'openai',
    'anthropic',
    'deepseek',
    'google',
    'zhipuai',
    'zai',
    'moonshotai',
    'alibaba',
    'alibaba-cn',
    'minimax',
    'xai',
    'mistral',
    'siliconflow',
    'groq',
    'togetherai',
    'fireworks-ai',
    'cohere',
    'perplexity'
  ]
}

/** id 归一化 —— 两条规则，都是从 owner 真实数据反推的，不是臆想：
 *   ① 去掉尾部方括号后缀（`claude-opus-5[1m]` —— 中转用它表示 1M 上下文档位）
 *   ② 去掉 `vendor/` 前缀（`openai/gpt-4o` —— OpenRouter 的 wire id 形状）
 *  🔴 只归一化**我们这一侧**的 id，不归一化目录里的 id：目录侧也归一会让同一家里的
 *  `foo/bar` 与 `baz/bar` 撞成一个键。 */
export function normalizeCatalogModelId(modelId: string): string {
  let s = modelId.trim().toLowerCase()
  s = s.replace(/\[[^\]]*\]\s*$/, '')
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return s.trim()
}

// ── 索引（懒建 + 缓存）────────────────────────────────────────────────────────────

interface ProviderIndex {
  name: string
  byId: Map<string, RawCatalogModel>
}

const providerIndexCache = new Map<string, ProviderIndex | null>()

function providerIndex(providerId: string): ProviderIndex | null {
  const cached = providerIndexCache.get(providerId)
  if (cached !== undefined) return cached
  const base = CATALOG.providers[providerId]
  const override = LOCAL_CATALOG_OVERRIDES[providerId]
  if (!base && !override) {
    providerIndexCache.set(providerId, null)
    return null
  }
  const byId = new Map<string, RawCatalogModel>()
  for (const [id, m] of Object.entries(base?.models ?? {})) byId.set(id.toLowerCase(), m)
  // 覆盖表后写 → 同 id 时它赢。
  for (const [id, m] of Object.entries(override?.models ?? {})) byId.set(id.toLowerCase(), m)
  const index: ProviderIndex = { name: override?.name ?? base?.name ?? providerId, byId }
  providerIndexCache.set(providerId, index)
  return index
}

/** 全局索引：id → 唯一拥有者 providerId；`null` = 多家都有（有歧义 → 不采纳）。 */
let globalIndex: Map<string, string | null> | null = null

function ensureGlobalIndex(): Map<string, string | null> {
  if (globalIndex) return globalIndex
  const idx = new Map<string, string | null>()
  const allIds = new Set([
    ...Object.keys(CATALOG.providers),
    ...Object.keys(LOCAL_CATALOG_OVERRIDES)
  ])
  for (const pid of allIds) {
    const p = providerIndex(pid)
    if (!p) continue
    for (const id of p.byId.keys()) idx.set(id, idx.has(id) ? null : pid)
  }
  globalIndex = idx
  return idx
}

/** 仅测试用：改过 LOCAL_CATALOG_OVERRIDES 后清缓存。生产代码不需要调（覆盖表是编译期常量）。 */
export function resetModelCatalogCaches(): void {
  providerIndexCache.clear()
  globalIndex = null
}

// ── 查表 ──────────────────────────────────────────────────────────────────────────

function toMeta(
  raw: RawCatalogModel,
  providerId: string,
  providerName: string,
  matchedModelId: string,
  match: 'exact' | 'normalized'
): CatalogModelMeta {
  const caps = raw.caps
  return {
    displayName: raw.name ?? matchedModelId,
    description: raw.description ?? null,
    contextWindow: raw.context ?? null,
    maxOutput: raw.output ?? null,
    capabilities:
      caps && caps.length > 0
        ? {
            tools: caps.includes('tools') || undefined,
            vision: caps.includes('vision') || undefined,
            reasoning: caps.includes('reasoning') || undefined,
            files: caps.includes('files') || undefined
          }
        : null,
    cost: raw.cost
      ? {
          input: raw.cost.input ?? null,
          output: raw.cost.output ?? null,
          cacheRead: raw.cost.cacheRead ?? null,
          cacheWrite: raw.cost.cacheWrite ?? null
        }
      : null,
    releasedAt: raw.released ?? null,
    knowledgeCutoff: raw.knowledge ?? null,
    deprecated: raw.deprecated === true,
    catalogProviderId: providerId,
    catalogProviderName: providerName,
    match,
    matchedModelId
  }
}

function findInChain(
  chain: readonly string[],
  key: string,
  match: 'exact' | 'normalized'
): CatalogModelMeta | null {
  for (const pid of chain) {
    const p = providerIndex(pid)
    const raw = p?.byId.get(key)
    if (p && raw) return toMeta(raw, pid, p.name, key, match)
  }
  return null
}

function findGlobalUnique(key: string, match: 'exact' | 'normalized'): CatalogModelMeta | null {
  const owner = ensureGlobalIndex().get(key)
  // undefined = 谁都没有；null = 多家都有（歧义）。两者都不采纳。
  if (!owner) return null
  const p = providerIndex(owner)
  const raw = p?.byId.get(key)
  return p && raw ? toMeta(raw, owner, p.name, key, match) : null
}

/** 按「protocol 有序链 → 全局唯一」查一个模型的展示元数据。查不到返回 null（静默降级）。
 *
 *  两遍扫：**先全链精确、再全链归一** —— 逐字命中恒优先于推断命中（若按「每级先精确再归一」
 *  逐级走，链上靠前那家的归一命中会盖掉靠后那家的逐字命中，那是把推断说成事实）。 */
export function lookupModelMeta(
  modelId: string,
  protocol: LlmProviderProtocol | null | undefined
): CatalogModelMeta | null {
  const exactKey = modelId.trim().toLowerCase()
  if (!exactKey) return null
  const normKey = normalizeCatalogModelId(modelId)
  const chain = protocol ? PREFERRED_CATALOG_PROVIDERS[protocol] : []

  const exactInChain = findInChain(chain, exactKey, 'exact')
  if (exactInChain) return exactInChain

  if (normKey && normKey !== exactKey) {
    const normInChain = findInChain(chain, normKey, 'normalized')
    if (normInChain) return normInChain
  }

  const exactGlobal = findGlobalUnique(exactKey, 'exact')
  if (exactGlobal) return exactGlobal

  if (normKey && normKey !== exactKey) return findGlobalUnique(normKey, 'normalized')
  return null
}
