// 模型元数据目录（models.dev）快照生成器 —— **产物入库**。
//
//   pnpm catalog:models        # 拉最新快照并覆写 src/shared/modelCatalog/catalog.json
//
// 除手动跑外，`.github/workflows/sync-model-catalog.yml` 每周一在 CI 跑同一条命令，有 diff
// 就开一个同步 PR（出网只在 runner 上；不自动合，价格 / context 漂移要人扫一眼）。
//
// 🔴 为什么是「生成物入库」而不是运行时联网拉：
//   - 桌面 App 可能离线；远程 web 在 CF Access 后面。运行时拉取会把「模型名显示不出来」
//     变成一个网络故障面（而它本来只是个展示增强）。
//   - 与本仓 `requirements.lock.txt` 同一条纪律：生成物入库，保打包再现性。
//   - 快照过期的后果是**降级**（新模型查不到 → 只显示裸 id，和引入目录之前一模一样），不是崩。
//
// 更新节奏：CI 每周一开同步 PR；发版前想更稳可以再手动跑一次。
//
// 授权：上游 anomalyco/models.dev 是 **MIT**（见 src/shared/modelCatalog/NOTICE.md）。
// 🔴 有意**不用** lobehub 的 `model-bank`：那个包继承 LobeHub Community License，
//    其 1(b) 对「基于 LobeChat 的衍生作品分发」要求商业许可，而我们是公开分发的桌面 App。
//    （我们手拷 lobe 的 icon 是另一回事 —— icon 来自 lobehub/lobe-icons 仓库，MIT。）

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = 'https://models.dev/api.json'
// 🔴 目录名不带 `data` 段是**有意**的：仓库根 `.gitignore` 的 `data/` 没有前导斜杠，按
// gitignore 语义匹配**任意层级**的 data 目录 —— 放在 `src/shared/data/` 下的快照本机跑得好
// 好的，但 commit 即丢、CI 打出的 .app 里根本没有这个文件（模型元数据静默全灭，退回裸 id）。
const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/shared/modelCatalog/catalog.json'
)

/** provider 白名单 —— **路由型聚合器一家不留**。
 *
 *  🔴 这是本快照最重要的一个决定：models.dev 全量 180 provider / 6100+ 模型里，绝大多数是
 *  中转商，同一个 model id 在它们之间的 context / pricing **不一致**（实测 `gpt-5.6-sol`
 *  在两家差 3.9 倍）。把中转商放进来 = 查表随机命中一家、显示一个可能错 4 倍的数字。
 *  故只收厂商自己那份，再由 lookup.ts 的「protocol → 首选 provider 有序链」定位。
 *
 *  🔴 界线是「**是不是路由到别家**」，不是「是不是模型作者」：下面 groq / togetherai /
 *  fireworks-ai / siliconflow 是**开放权重模型的自营推理商**，收；它们的 id 自带 `vendor/`
 *  命名空间，不会与厂商官方 id 相撞。残留代价是同一个开放权重 id 在这几家之间价格仍可能
 *  差几倍（`deepseek-ai/DeepSeek-R1`：siliconflow $0.50 vs togetherai $3.00）—— 由有序链
 *  钉死命中哪一家（确定，不随机）+ 能力卡上如实印出来源承担，不靠白名单挡。
 *
 *  🔴 **openrouter 也不收**（它是我们 `LlmProviderProtocol` 的一等值，但同样是聚合器）：
 *  ① 一致性 —— 留一个聚合器就是给自己开一个「值可能与厂商官方不符」的口子；
 *  ② 体积 —— 它一家 337 行 ≈ 95KB，占白名单总量的四成；
 *  ③ 覆盖 —— 它的 wire id 形如 `vendor/model`，lookup 的归一化会剥掉 `vendor/` 前缀后落到
 *     厂商自己那家（`openai/gpt-4o` → openai 的 `gpt-4o`），主流模型照样命中，只是 match
 *     标成 'normalized'（如实）。真正丢的只有「OpenRouter 独有的小众模型」，那是设计内的降级。
 *
 *  全量精简后 2.4MB 太大；这份白名单实测 ~466 行 / 131KB raw / 18KB gzip，`shared/` 会同时
 *  进桌面 renderer 与远程 web 两个 bundle，所以宁可窄不要宽。缺哪家往这里加一行即可。 */
const PROVIDERS = [
  // 协议链上的 canonical 四家
  'openai',
  'anthropic',
  'google',
  'deepseek',
  // 国内厂商（openai-compatible 中转背后最常见的真身）
  'alibaba',
  'alibaba-cn',
  'zhipuai',
  'zai',
  'moonshotai',
  'minimax',
  'siliconflow',
  // 其余常见自建/兼容目标
  'xai',
  'mistral',
  'groq',
  'togetherai',
  'fireworks-ai',
  'cohere',
  'perplexity'
]

/** 上游一行 → 我们要的字段（字段白名单，不整行照搬）。返回 null = 这行没有任何可展示信息。 */
function trimModel(m) {
  const out = {}
  if (typeof m.name === 'string' && m.name.trim()) out.name = m.name.trim()
  if (typeof m.description === 'string' && m.description.trim()) {
    out.description = m.description.trim()
  }
  if (Number.isFinite(m.limit?.context) && m.limit.context > 0) out.context = m.limit.context
  if (Number.isFinite(m.limit?.output) && m.limit.output > 0) out.output = m.limit.output

  // 能力位：只收显式 true。上游没有这个键 = 未标注，**不是** false（渲染侧靠这个区分）。
  const caps = []
  if (m.tool_call === true) caps.push('tools')
  if (m.reasoning === true) caps.push('reasoning')
  if (Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'))
    caps.push('vision')
  if (m.attachment === true) caps.push('files')
  if (caps.length > 0) out.caps = caps

  // 定价：$ / 百万 token（models.dev 的 cost 单位）。四个键各自可缺。
  const cost = {}
  if (Number.isFinite(m.cost?.input)) cost.input = m.cost.input
  if (Number.isFinite(m.cost?.output)) cost.output = m.cost.output
  if (Number.isFinite(m.cost?.cache_read)) cost.cacheRead = m.cost.cache_read
  if (Number.isFinite(m.cost?.cache_write)) cost.cacheWrite = m.cost.cache_write
  if (Object.keys(cost).length > 0) out.cost = cost

  if (typeof m.release_date === 'string' && m.release_date) out.released = m.release_date
  if (typeof m.knowledge === 'string' && m.knowledge) out.knowledge = m.knowledge
  // 只收 'deprecated'（能力卡上标「已弃用」）。'beta' / 'alpha' 对用户没有行动含义，不收。
  if (m.status === 'deprecated') out.deprecated = true

  return Object.keys(out).length > 0 ? out : null
}

/** key 排序 —— 快照要能 diff。无序的 JSON.stringify 会让每次 sync 都产生噪声 diff。 */
function sortedObject(obj) {
  const out = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

async function main() {
  process.stdout.write(`fetching ${SOURCE_URL} …\n`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`models.dev responded ${res.status}`)
  const upstream = await res.json()

  const providers = {}
  const missing = []
  let modelCount = 0
  for (const pid of PROVIDERS) {
    const p = upstream[pid]
    if (!p) {
      missing.push(pid)
      continue
    }
    const models = {}
    for (const [id, m] of Object.entries(p.models ?? {})) {
      const trimmed = trimModel(m)
      if (trimmed) models[id] = trimmed
    }
    modelCount += Object.keys(models).length
    providers[pid] = { name: p.name ?? pid, models: sortedObject(models) }
  }
  // 🔴 白名单里的 provider 上游改名/下线 = 静默丢一整家的元数据。抽取失败必须响，不许静默。
  if (missing.length > 0) {
    throw new Error(
      `models.dev 里找不到这些 provider（上游改名或下线？）：${missing.join(', ')}\n` +
        '修好白名单再跑 —— 静默跳过会让一整家厂商的元数据无声消失。'
    )
  }

  const snapshot = {
    // 头部元信息也是 NOTICE 的一部分：谁生成的、什么时候、怎么再生成一次。
    source: SOURCE_URL,
    sourceRepo: 'https://github.com/anomalyco/models.dev',
    license: 'MIT',
    generatedAt: new Date().toISOString().slice(0, 10),
    generatedBy: 'frontend/scripts/sync-model-catalog.mjs',
    providers: sortedObject(providers)
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8')
  process.stdout.write(
    `wrote ${OUT_PATH}\n  ${PROVIDERS.length} providers · ${modelCount} models · ` +
      `${(JSON.stringify(snapshot).length / 1024).toFixed(0)}KB\n`
  )
}

await main()
