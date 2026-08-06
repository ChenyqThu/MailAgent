// WP-15「context 环」的纯函数面（task 08-05）—— composer 右下 Send 旁那个「上下文占用」指示器
// 的全部判定逻辑。单独一个 `.ts` 抄 `modelDetailCard.lib.ts` 的先例：`.tsx` 只许导出组件
// （react-refresh/only-export-components），且判定脱离渲染可直接断言。
//
// 🔴 三条纪律（决定了这个控件在「不知道」时长什么样）：
//   ① **没有 usage 就不渲染** —— 老会话 / 首轮未完成 / 模型没报 usage 时整个控件消失，长得和
//      引入本功能之前逐字一样。绝不写 0、绝不写 '?'。
//   ② **上限未知就不画环** —— 目录（models.dev 快照）没命中这个模型时退化成中性 token 药丸
//      （`~91K`）。拿猜的上限画环比不画更糟：它会诱导用户误判「还能塞多少」。
//   ③ **数字来自上一轮请求**，不是实时值。本功能刻意走「回合间刷新」（零 wire 改动），文案因此
//      说的是「上一轮请求的输入占用」而不是「当前上下文」。
//
// 语义提醒：`used` 是**末 step 的 inputTokens**（gateway `lastStepContextTokens` 取的那个），
// 不是 `usage.inputTokens` 的多 step 求和 —— 详见 ai_chat_messages.context_tokens 的列注释。

/** 读侧只需要这几个字段 —— 结构化形参而不是 import ChatMessage：两条 wire（Electron IPC 与远程
 *  web 的 serve-api）各有一份 ChatMessage 投影，且 `context_tokens` 在 API 投影上是 optional
 *  （未迁移的库整字段缺席，见 api/types/chat.ts 的注释）。
 *
 *  `content` / `ui_message_json` 是 WP-22 分段明细用的（聊天消息段的字符量），同样 optional：
 *  老行没有 ui_message_json（reload 时才从 content 合成）。 */
export interface ContextUsageRow {
  role: string
  context_tokens?: number | null
  content?: string | null
  ui_message_json?: string | null
}

/** 会话里**最后一条**带占用的 assistant 行的 token 数；没有则 null（= 不渲染）。
 *
 *  从尾往前找而不是直接取 `at(-1)`：末条可能是 user 行（刚发出、回复还没落库），也可能是审批
 *  暂停的 assistant 行（那一段早退不落库 → context_tokens 为 NULL，resume 时才补写）。这两种
 *  情况都应该继续显示**上一轮**的值，而不是让控件闪一下消失。 */
export function latestContextTokens(rows: readonly ContextUsageRow[] | undefined): number | null {
  if (!Array.isArray(rows)) return null
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role !== 'assistant') continue
    const n = row.context_tokens
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
  }
  return null
}

export type ContextUsageTone = 'normal' | 'warn' | 'danger'

export interface ContextUsageView {
  /** 已用 token（末 step 的 inputTokens）。 */
  used: number
  /** 上下文上限；null = 目录未命中 → `variant:'pill'`。 */
  limit: number | null
  /** 0..1，钳在 [0,1]（超限时为 1，环画满）；limit 未知时 null。 */
  ratio: number | null
  /** 四舍五入的整数百分比（文案用），**不钳** —— 超限时如实显示 >100。limit 未知时 null。 */
  percent: number | null
  /** 'ring' = 有上限画比例环；'pill' = 上限未知，只报绝对值。 */
  variant: 'ring' | 'pill'
  /** used > limit：目录记的上限比模型实报的小（中转的 1M 档 / 目录过时）。环钉满 + 文案注明。 */
  overflow: boolean
  tone: ContextUsageTone
}

/** 进入告警/危险色的比例阈值。挑 0.75 / 0.9 是「还剩 1/4」与「快满了」的直觉分界，无外部依据。 */
const WARN_RATIO = 0.75
const DANGER_RATIO = 0.9

/** (占用, 上限) → 视图模型；`used` 为 null（拿不到）时返回 null = **整个控件不渲染**。
 *
 *  `limit` 非正数（0 / 负数 / NaN —— 目录里理论上不会有，但它是外部快照）一律当作「未知」走
 *  药丸档：用 0 当分母会得到 Infinity%，画出一个满环的谎。 */
export function buildContextUsageView(
  used: number | null | undefined,
  limit: number | null | undefined
): ContextUsageView | null {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
  if (!hasLimit) {
    return {
      used,
      limit: null,
      ratio: null,
      percent: null,
      variant: 'pill',
      overflow: false,
      tone: 'normal'
    }
  }
  const raw = used / limit
  const ratio = Math.min(1, Math.max(0, raw))
  return {
    used,
    limit,
    ratio,
    percent: Math.round(raw * 100),
    variant: 'ring',
    overflow: raw > 1,
    tone: raw >= DANGER_RATIO ? 'danger' : raw >= WARN_RATIO ? 'warn' : 'normal'
  }
}

// ── WP-22：分段明细（点环弹层）─────────────────────────────────────────────────
//
// 🔴 **只有 Total Used 是权威值**（模型实报的 prompt tokens）。四个段全部是估算，且做法各不
// 相同 —— 弹层脚注与本段注释是同一句话的两个副本，改一处必须改另一处：
//   · 系统提示 = `/chat/config.standingContext`（身份文档 SOUL/AGENT/RULES/USER 的预 join 全文）
//     的字符数换算。**不含** PRODUCT_SAFETY_FLOOR / 技能片段 / 目录块 —— 那些是 gateway 侧
//     code-owned 的字符串，renderer 拿不到，一律落进残差段。
//   · 记忆 = `/chat/config.memorySummary`（memory.md 全文，恒注入的 MEMORY fence）。
//   · 聊天消息 = 会话消息行的字符量（见 estimateMessagesTokens）。
//   · 工具定义与其他 = **残差** = Total Used − 上面三段。这是 master plan §P3-2 明确推荐的做法：
//     工具 JSON schema 的真实占用在 provider 侧展开计费，本地不可精确复算；与其硬啃一个必错的
//     序列化估算，不如把「量不到的部分」诚实地聚成一段（因此它的标签是「工具定义与其他」而不是
//     「工具 schema」—— 安全地板、技能/连接器目录、KOS 指南也都在里面）。
//
// 为什么不让 gateway 落库各段：那要动 persist 通道 + CHAT_DB 加列 + 触发 agent_eval 回归网，
// 而分段本身**无论如何都是估算**（真值只有 provider 知道）。用一次已有的 `/chat/config` 读 +
// 已经在拉的消息行换来同样的诚实度，是本 WP 刻意选的零 wire 改动路径（与 WP-15 同源纪律）。

/** 字符 → token 的换算系数。renderer 里**没有** tokenizer（为一个弹层引 BPE 词表进包不成比例），
 *  所以每个段值在 UI 上都带 `≈`。
 *  · 拉丁/代码/标点 4 chars/token —— 沿用仓内既有的同一常数（gateway `server.ts` 的 tok/s 估算
 *    注释「~4 chars/token rough estimate」）。
 *  · CJK 1.5 chars/token —— 现代 BPE（cl100k / o200k / Claude）对汉字通常一个 token 覆盖 1~2 字，
 *    取中值。**不能**跟拉丁共用 4：那会把中文会话的消息段低估到 1/3，残差段跟着虚高，弹层就在
 *    撒「工具占了大头」的谎。
 *  两个系数只影响**分段**，不影响 Total Used。 */
export const CHARS_PER_TOKEN_LATIN = 4
export const CHARS_PER_TOKEN_CJK = 1.5

/** 粗判 CJK（含中日韩表意文字、假名、谚文、全角标点）。只用于长度估算，不需要严谨的 Unicode
 *  属性判定；按 UTF-16 code unit 扫（surrogate pair 落在 BMP 外，计成 2 个「非 CJK 字符」，
 *  在估算精度内可忽略）。 */
function isCjkCode(c: number): boolean {
  return (
    (c >= 0x2e80 && c <= 0xa4cf) || // CJK 部首 / 康熙 / CJK 标点 / 平假名 / 片假名 / 注音 / 统一表意文字
    (c >= 0xac00 && c <= 0xd7af) || // 谚文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意文字
    (c >= 0xff00 && c <= 0xffef) // 全角/半角形式
  )
}

/** 字符统计中间态：CJK 与其余分开累计，**最后换算一次**。逐段 Math.ceil 再相加会把每次的
 *  取整误差累计起来（一个几十行的会话能差出几十 token），所以估算面统一走「累计 → 一次换算」。 */
interface CharMix {
  cjk: number
  rest: number
}

function addText(mix: CharMix, text: string): void {
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) mix.cjk++
    else mix.rest++
  }
}

function tokensFromMix(mix: CharMix): number {
  return Math.ceil(mix.cjk / CHARS_PER_TOKEN_CJK + mix.rest / CHARS_PER_TOKEN_LATIN)
}

/** 文本 → 估算 token 数（CJK 与其余字符分开换算，见上面两个系数）。空/非字符串 → 0。 */
export function estimateTokens(text: string | null | undefined): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  const mix: CharMix = { cjk: 0, rest: 0 }
  addText(mix, text)
  return tokensFromMix(mix)
}

/** 累计 JSON 树里所有**字符串值**的字符（键名不算 —— 那是 UIMessage 的簿记字段：id / state /
 *  providerMetadata / 时间戳，模型看不到）。
 *
 *  🔴 跳过 `data:` 开头的字符串（粘贴进来的内联图片 base64）：一张 100KB 的 base64 按 4 chars/token
 *  会估出 25K token，而图片的真实计费按像素面积算（量级差一个数量级），计进去会把消息段撑爆、
 *  把残差压成 0，整个弹层当场变成谎话。代价 = 有图会话的消息段略低估（残差略高估），由脚注的
 *  「估算」兜住。 */
function addJson(mix: CharMix, node: unknown, depth = 0): void {
  if (typeof node === 'string') {
    if (!node.startsWith('data:')) addText(mix, node)
    return
  }
  if (depth > 20) return // 只防栈深（JSON.parse 的产物无环）
  if (Array.isArray(node)) {
    for (const v of node) addJson(mix, v, depth + 1)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) addJson(mix, v, depth + 1)
  }
}

/** 会话消息行 → 「聊天消息」段的估算 token 数。
 *
 *  取 `ui_message_json`（AI SDK 的 UIMessage 全文：正文 + 工具入参 + 工具返回 + reasoning，
 *  也就是下一轮真正会被透传回模型的东西 —— `chatRun.ts` 全量透传 rawMessages，本仓没有任何
 *  截断/摘要机制）；该列缺席（老行 / 未落库）或 JSON 坏掉时退回 `content` 纯文本。
 *
 *  已知偏差（有意不修）：末条 assistant 的**输出**并不属于它自己那一轮的输入，但这里照样计入 ——
 *  要精确排除得知道「哪一条是本轮的回复」并拆开它的 parts，换来的精度提升远小于系数本身的误差。 */
export function estimateMessagesTokens(rows: readonly ContextUsageRow[] | undefined): number {
  if (!Array.isArray(rows)) return 0
  const mix: CharMix = { cjk: 0, rest: 0 }
  for (const row of rows) {
    if (!row) continue
    const json = row.ui_message_json
    if (typeof json === 'string' && json.length > 0) {
      try {
        addJson(mix, JSON.parse(json))
        continue
      } catch {
        /* 坏 JSON → 落到 content 兜底 */
      }
    }
    if (typeof row.content === 'string') addText(mix, row.content)
  }
  return tokensFromMix(mix)
}

export type ContextSegmentKey = 'system' | 'tools' | 'memory' | 'messages'

export interface ContextSegment {
  key: ContextSegmentKey
  tokens: number
  /** 占分段总量的比例 0..1；各段相加恒 = 1（分母见 buildContextBreakdown）。 */
  share: number
}

/** 三个**可测**段的估算值（残差段由 buildContextBreakdown 自己推）。 */
export interface ContextMeasuredSegments {
  system: number
  memory: number
  messages: number
}

export interface ContextBreakdown {
  /** 权威值（模型实报），与 ContextUsageView.used 同源。 */
  used: number
  limit: number | null
  /** 上限已知时 max(0, limit − used)；未知 → null（**不编总量**）。 */
  remaining: number | null
  /** 固定顺序 system → tools → memory → messages，0 值段不出现（一行「0」只占地方不给信息）。 */
  segments: ContextSegment[]
  /** 可测段拉不到（/chat/config 不可达）或全为 0 → false = 只显示总量。 */
  hasSegments: boolean
  /** 估算之和 > 实报总量 → 残差钳 0，且弹层要说一句「分段仅供参考」。 */
  estimateExceedsTotal: boolean
}

/** (视图, 可测段) → 分段明细。`measured` 为 null（配置还没拉到 / 拉失败）时返回无段版本。
 *
 *  残差 = used − (system + memory + messages)，**钳 0**：估算系数偏高（或会话里全是 CJK）时
 *  它会算成负数，画一个负宽度的段没有意义。此时 `estimateExceedsTotal` 置真，且比例的分母改用
 *  「各段之和」而不是 used —— 否则条子会超出 100% 溢出容器，或者需要把某个段悄悄缩小（= 拿
 *  一个编出来的数字骗人）。 */
export function buildContextBreakdown(
  view: ContextUsageView,
  measured: ContextMeasuredSegments | null
): ContextBreakdown {
  const { used, limit } = view
  const remaining = typeof limit === 'number' ? Math.max(0, limit - used) : null
  if (!measured) {
    return { used, limit, remaining, segments: [], hasSegments: false, estimateExceedsTotal: false }
  }
  const system = Math.max(0, Math.round(measured.system))
  const memory = Math.max(0, Math.round(measured.memory))
  const messages = Math.max(0, Math.round(measured.messages))
  const sumMeasured = system + memory + messages
  const tools = Math.max(0, used - sumMeasured)
  const denom = sumMeasured + tools // = max(used, sumMeasured)
  const raw: Array<[ContextSegmentKey, number]> = [
    ['system', system],
    ['tools', tools],
    ['memory', memory],
    ['messages', messages]
  ]
  const segments = raw
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ key, tokens, share: denom > 0 ? tokens / denom : 0 }))
  return {
    used,
    limit,
    remaining,
    segments,
    hasSegments: segments.length > 0,
    estimateExceedsTotal: sumMeasured > used
  }
}
