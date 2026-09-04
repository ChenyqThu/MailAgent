// L4 群聊 g1 — 群 run 的地板 / 预算常量 + 停止原因 / 值域词表 + 两个纯判定（零依赖叶子）。
//
// 🔴 地板不许为「优雅」删除（Cumora COORDINATION.md §6：地板被以优雅为由删过两次，两次回归）。
//    递归有界在 g1 之后不再是「结构不可能」，而是「结构 + 服务端地板」——每条地板在
//    tests/ai-gateway/group_orchestrator.test.ts 有一正例 + 一变异用例（把常量改 Infinity 断言必红）。
//    改数值先改父设计 §5 数值表；改词表必同步 src/chat/group_limits.py 与 connection.ts v31 的
//    CHECK 字符串（闸 tests/config/test_group_constants_parity.py 正则抽取本文件）。
//
// 🔴 零依赖：本文件被 renderer（GroupChatWorkspace 的成员上限）与 gateway 两侧直引，
//    不得 import 任何运行时模块（照 groupChat.ts / modelCatalog/lookup.ts 的叶子纪律）。

/** 群成员上限（含所有 realtime / mention 成员）。 */
export const MAX_GROUP_MEMBERS = 8

/** 主 agent 作为群成员 / 主持人时的保留 id（members_json、ai_chat_group_member.agent_id、
 *  judgeAgentId 共用）。它没有 report_agent 行 —— 成员事实由 resolveGroupSession 合成，
 *  serve-api 的成员校验对它短路放行。 */
export const MAIN_AGENT_MEMBER_ID = 'main'

// ── 链 / run 级地板（「run」= 一个链根引发的连续处理，chain_id 是它的键）──────────────────

/** 一条链最多几次唤醒（spoke / silent / held_dup 计入；skipped 不计）。owner 可在群设置里改。 */
export const CHAIN_CAP_DEFAULT = 12
/** 群设置里 chainCap 允许的上限。 */
export const CHAIN_CAP_MAX = 60
/** 非法官成员在同一 run 里最多发言几次（A↔B 乒乓 ≤ 6 回合）。 */
export const PER_AGENT_RUN_CAP = 3
/** 法官在同一 run 里的发言份额 = chainCap / JUDGE_RUN_SHARE_DIVISOR。 */
export const JUDGE_RUN_SHARE_DIVISOR = 2
/** 无法官群的 lapping 判据：run 内发言数 > LAPPING_FACTOR × run 内发过言的成员数 → 停。 */
export const LAPPING_FACTOR = 2
/** 一个 run 的墙钟上限（自有墙钟，与 activeRuns.STALE_RUN_MS 无关）。 */
export const RUN_WALL_MS = 20 * 60 * 1000
/** 连续几次 failed turn 后按 'error' 停 run。 */
export const CONSECUTIVE_FAILED_STOP = 3

// ── 节拍（人类 append 永不经过这两项）──────────────────────────────────────────────────

/** 两次成员 turn 之间的最小间隔。 */
export const MIN_TURN_GAP_MS = 500
/** 全 gateway 成员 turn 令牌桶：每分钟最多几次。 */
export const RATE_PER_MINUTE = 30

// ── 小时预算（按 family 滚动窗口；owner 可在群设置里改）────────────────────────────────

export const HOURLY_WINDOW_MS = 60 * 60 * 1000
export const HOURLY_TURNS_DEFAULT = 60
export const HOURLY_TOKENS_DEFAULT = 300_000
/** cost_usd 全 NULL 时本地板不生效，靠 tokens 地板兜底。 */
export const HOURLY_USD_DEFAULT = 1.0
/** 会话累计 turn 上限；null = 不设。 */
export const SESSION_TURN_CAP_DEFAULT: number | null = null

// ── 近期消息窗口 ────────────────────────────────────────────────────────────────────

/** seen 游标之前保留的尾部行数（给模型一点上文）。 */
export const WINDOW_TAIL = 6
/** 窗口最多几行（首轮 = 最后 WINDOW_MAX_ROWS 行）。 */
export const WINDOW_MAX_ROWS = 40
/** 窗口字符上限（≈ 6k token），从旧端裁剪。 */
export const WINDOW_MAX_CHARS = 12_000
/** 逐字重复 HOLD 回看的他人消息条数。 */
export const DUP_LOOKBACK = 8

// ── g2 / g3 预留（g1 不消费，单源先落）──────────────────────────────────────────────

/** 法官一个 turn 里最多 group_post 几次。 */
export const POSTS_PER_TURN_CAP = 2
/** 一个 family 最多几个子群。 */
export const SUBGROUPS_PER_FAMILY_CAP = 6
/** g2 `group_history` 一页最多几行（消费点：tools/schemas.ts 的 zod `limit` 上限）。 */
export const GROUP_HISTORY_LIMIT_MAX = 50
/** g2 `group_post` / `group_create` 开场白的文本字符上限（消费点：tools/schemas.ts）。 */
export const GROUP_POST_TEXT_MAX_CHARS = 4000

// ── 词表（三处共用：system 行 metadata.reason / turn 台账 / i18n groupChat.stopped.<reason>）──

export const GROUP_STOP_REASONS = [
  'chain_cap',
  'per_agent_cap',
  'lapping',
  'hourly_turns',
  'hourly_tokens',
  'hourly_budget',
  'session_cap',
  'wall',
  // 🔴 g1 无生产者：令牌桶（RATE_PER_MINUTE）满时是「等」不是「停」。词表位与 i18n 文案先落，
  //    留给 g2/g3 真需要以「太频繁」为由停 run 时用 —— 别照着这一项去代码里找停止分支。
  'rate',
  'owner_stop',
  'labs_off',
  'error'
] as const
export type GroupStopReason = (typeof GROUP_STOP_REASONS)[number]

export const RESPONSE_MODES = ['realtime', 'mention'] as const
export type GroupResponseMode = (typeof RESPONSE_MODES)[number]

export const GROUP_TURN_OUTCOMES = [
  'spoke',
  'silent',
  'held_dup',
  'skipped',
  'failed',
  'stopped'
] as const
export type GroupTurnOutcome = (typeof GROUP_TURN_OUTCOMES)[number]

export const GROUP_TRIGGER_KINDS = ['human', 'main_agent', 'agent', 'judge_post'] as const
export type GroupTriggerKind = (typeof GROUP_TRIGGER_KINDS)[number]

// ── 沉默哨兵 + 逐字重复 ─────────────────────────────────────────────────────────────

/** 成员这轮不发言时回复的文本哨兵（进 prompt 的沉默契约与本常量逐字一致）。 */
export const SILENCE_SENTINEL = '[沉默]'
/** 哨兵后允许的尾巴长度（模型偶尔会补一句「（无需补充）」）。 */
export const SILENCE_TRAILING_MAX = 20

/** 沉默判定：trim 后为空、或以哨兵开头且余下 ≤ SILENCE_TRAILING_MAX 字符。 */
export function isSilence(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  if (!trimmed.startsWith(SILENCE_SENTINEL)) return false
  return trimmed.slice(SILENCE_SENTINEL.length).trim().length <= SILENCE_TRAILING_MAX
}

/** 逐字重复比对用的归一：去空白 / 标点 / 符号，小写。 */
export function normalizeForDup(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}
