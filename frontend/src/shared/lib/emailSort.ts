// 邮件列表排序的**词表单源**（零依赖叶子模块）。
//
// 排序键/方向这套词表要在四处出现：renderer 的 zustand store、`ListOpts` 契约类型、
// Electron 主进程 DAO 的 ORDER BY 白名单、以及 serve-api 的同款白名单。前三处是同一
// 个 TS 程序，能 import 就不该手抄 —— 故这里是**零依赖**叶子（一个 import 都没有，
// 主进程 handler 与 renderer 都直接吃它）。**唯一**留下的手抄镜像是 Python
// (`src/api/routers/email_views.py`)，由 `tests/config/test_email_sort_parity.py` 建闸。
//
// 🔴 `sortDir` 的语义是「降序 / 升序」而不是「新→旧」：
//   date       desc = 新 → 旧
//   importance desc = 高 → 低（critical 最先）
//   sender     desc = Z → A
//   subject    desc = Z → A
// 菜单里的方向文案按当前排序键切换（Outlook 同款），见 EmailListHeader。

export const EMAIL_SORT_KEYS = ['date', 'sender', 'subject', 'importance'] as const
export type EmailSortKey = (typeof EMAIL_SORT_KEYS)[number]

export const EMAIL_SORT_DIRS = ['desc', 'asc'] as const
export type EmailSortDir = (typeof EMAIL_SORT_DIRS)[number]

/** 出厂默认 = 历史行为（date DESC），任何一处解析失败都回落到它。 */
export const DEFAULT_SORT_KEY: EmailSortKey = 'date'
export const DEFAULT_SORT_DIR: EmailSortDir = 'desc'

export function normalizeSortKey(raw: unknown): EmailSortKey {
  return EMAIL_SORT_KEYS.includes(raw as EmailSortKey) ? (raw as EmailSortKey) : DEFAULT_SORT_KEY
}

export function normalizeSortDir(raw: unknown): EmailSortDir {
  return EMAIL_SORT_DIRS.includes(raw as EmailSortDir) ? (raw as EmailSortDir) : DEFAULT_SORT_DIR
}

/**
 * 「重要性」排序的名次表 —— 数字越大越重要，未分类 (`null` / 无 LLM 跑过) = 0。
 * SQL 侧 (handlers/email.ts + email_views.py) 的 CASE 映射必须给出同一组名次，
 * 否则「后端按重要性取前 N 封」与「前端把线程按重要性重排」会各排各的。
 *
 * 键集**故意不**从 `AIPriority` 类型来 —— 那会让本模块 import `@shared/api/types`，
 * 而后者的 `ListOpts` 又要 import 本模块的排序词表，绕成环。键集与 `ALL_PRIORITIES`
 * 的相等由 `tests/shared/emailSort.test.ts` 断言。
 */
export const PRIORITY_RANK = {
  critical: 5,
  urgent: 4,
  important: 3,
  normal: 2,
  low: 1
} as const

/** 未分类名次 —— 无论升序降序都必须沉到最末（见两侧 SQL 的 null-guard 首列）。 */
export const PRIORITY_RANK_UNKNOWN = 0

export function priorityRank(p: string | null | undefined): number {
  if (!p) return PRIORITY_RANK_UNKNOWN
  return (PRIORITY_RANK as Record<string, number>)[p] ?? PRIORITY_RANK_UNKNOWN
}

// ─── listEnriched 的 ORDER BY 白名单 ────────────────────────────────────
//
// SQL 片段放在 shared lib 而不是主进程 DAO 里，抄 `mailboxSemantics.ts` 的先例
// （`DRAFTS_EXCLUDE_SQL` 同样是给 handler 用的 SQL 常量）：这样它与词表同文件、
// 不可能各自漂移，也不必为了测一个纯字符串函数去把 better-sqlite3 拉进测试进程。
//
// 🔴 禁止把用户输入拼进 SQL：`orderBy` / `sortDir` 先经 normalize* 落到词表内，
// 再查这张**常量**表取整段模板，`{dir}` 只会被 'ASC' / 'DESC' 两个字面量替换。
//
// 「重要性」名次直接建在 `priority_raw` 输出别名上（SQLite 允许 ORDER BY 表达式
// 里引用结果列别名），所以它自动继承 SELECT 那边的 COALESCE(主表列, labels_json)
// 取数语义与 schema 降级 —— 不必在这里第二次描述「优先级从哪来」。中文子串匹配
// 顺序必须与 ai_mapping.ts::mapPriority 一致（'重要' 在 '一般' 之前）。
const PRIORITY_RANK_SQL = `CASE
      WHEN priority_raw LIKE '%紧急%' OR priority_raw LIKE '%Critical%' THEN ${PRIORITY_RANK.critical}
      WHEN priority_raw LIKE '%紧迫%' OR priority_raw LIKE '%严重%' OR priority_raw LIKE '%Urgent%' THEN ${PRIORITY_RANK.urgent}
      WHEN priority_raw LIKE '%重要%' OR priority_raw LIKE '%Important%' THEN ${PRIORITY_RANK.important}
      WHEN priority_raw LIKE '%一般%' OR priority_raw LIKE '%普通%' OR priority_raw LIKE '%Normal%' THEN ${PRIORITY_RANK.normal}
      WHEN priority_raw LIKE '%低%' OR priority_raw LIKE '%Low%' THEN ${PRIORITY_RANK.low}
      ELSE ${PRIORITY_RANK_UNKNOWN}
    END`

// 未分类（LLM 没跑过 / 值无法识别 → 名次 0）恒沉到最末：升序时若只按名次排，
// 「由低到高」会把一整片没跑过 AI 的邮件顶到最前面，用户看到的是「排序坏了」。
// 故 importance 的 ORDER BY 首列是与方向无关的 null-guard。
export const ENRICHED_ORDER_BY: Readonly<Record<EmailSortKey, string>> = {
  date: 'm.date_received {dir} NULLS LAST, m.internal_id {dir}',
  // 显示名优先、空串回落地址 —— 列表行显示的就是这个值，按「看到的字」排。
  sender: "COALESCE(NULLIF(m.sender_name, ''), m.sender) COLLATE NOCASE {dir}, m.internal_id {dir}",
  subject: 'm.subject COLLATE NOCASE {dir}, m.internal_id {dir}',
  importance: `(CASE WHEN (${PRIORITY_RANK_SQL}) = ${PRIORITY_RANK_UNKNOWN} THEN 1 ELSE 0 END) ASC, (${PRIORITY_RANK_SQL}) {dir}, m.internal_id {dir}`
}

const SQL_DIR: Readonly<Record<EmailSortDir, string>> = { asc: 'ASC', desc: 'DESC' }

/** (orderBy, sortDir) → listEnriched 的 ORDER BY 子句（含尾部稳定键）。 */
export function buildEnrichedOrderBy(orderBy?: unknown, sortDir?: unknown): string {
  const key = normalizeSortKey(orderBy)
  const dir = SQL_DIR[normalizeSortDir(sortDir)]
  return ENRICHED_ORDER_BY[key].replaceAll('{dir}', dir)
}
