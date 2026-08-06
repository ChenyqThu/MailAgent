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

/** 读侧只需要这两个字段 —— 结构化形参而不是 import ChatMessage：两条 wire（Electron IPC 与远程
 *  web 的 serve-api）各有一份 ChatMessage 投影，且 `context_tokens` 在 API 投影上是 optional
 *  （未迁移的库整字段缺席，见 api/types/chat.ts 的注释）。 */
export interface ContextUsageRow {
  role: string
  context_tokens?: number | null
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
