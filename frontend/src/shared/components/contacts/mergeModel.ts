// 合并预览的默认值推导（纯函数，task 08-13 WP3 · PRD §3.7 / claude-code §4.3 🔒）。
//
// 🔴 两个默认值**都由 last_seen 推导，与「谁是保留方」无关** —— 换邮箱时往往历史
// 多的旧记录做保留方，而新地址在被并方；「来源于被并方 ⇒ 曾用」是被明文否决的
// 推断。服务端只按预览页勾选结果落库（`merge_contacts` docstring 钉死默认值是
// UI 职责），所以这里是这套语义的唯一实现，配 vitest 钉住换邮箱场景。

/** 曾用默认勾选的间隔条款：非主邮箱且 last_seen 比主邮箱早 60 天以上。 */
export const MERGE_FORMER_GAP_MS = 60 * 86400 * 1000

export interface MergeEmailCandidate {
  address: string
  mail_count: number
  last_seen_at: number | null
  former_at: number | null
}

/** 主邮箱默认 = 合并后所有地址里 last_seen 最新者。null（无账本）视为最旧；
 *  并列 → 往来多者 → 地址字典序（确定性，不随数组顺序漂）。 */
export function defaultMergePrimary(
  emails: readonly MergeEmailCandidate[]
): string | null {
  let best: MergeEmailCandidate | null = null
  for (const email of emails) {
    if (best === null) {
      best = email
      continue
    }
    const a = email.last_seen_at ?? Number.NEGATIVE_INFINITY
    const b = best.last_seen_at ?? Number.NEGATIVE_INFINITY
    if (
      a > b ||
      (a === b &&
        (email.mail_count > best.mail_count ||
          (email.mail_count === best.mail_count && email.address < best.address)))
    ) {
      best = email
    }
  }
  return best?.address ?? null
}

/** 曾用默认勾选 = 非主邮箱且（本来就是曾用 ∥ last_seen 比主邮箱早 60 天以上）。
 *
 *  - 60 天条款保证换邮箱场景里**新地址不被误标**（新地址通常就是主邮箱默认；
 *    即便 owner 手动把主邮箱改回旧地址，新地址的 last_seen 也比它新 → 不勾）。
 *  - 已是曾用的地址默认保持勾选：merge API 不会清 former，默认不勾会让界面
 *    与落库结果说两样话（owner 显式取消勾选 = 恢复在用，由 dialog 补一次
 *    unformer 调用）。
 *  - last_seen 为 null（无账本）不凭空标曾用 —— 没证据不猜。 */
export function defaultMergeFormer(
  emails: readonly MergeEmailCandidate[],
  primary: string | null
): string[] {
  const primaryLastSeen =
    emails.find((email) => email.address === primary)?.last_seen_at ?? null
  return emails
    .filter((email) => {
      if (email.address === primary) return false
      if (email.former_at != null) return true
      return (
        email.last_seen_at != null &&
        primaryLastSeen != null &&
        primaryLastSeen - email.last_seen_at > MERGE_FORMER_GAP_MS
      )
    })
    .map((email) => email.address)
}

export interface MergeKeepSide {
  id: number
  mail_count: number
  last_seen_at: number | null
}

/** 保留方默认 = mail_count 较大者；平手取 last_seen 较新者；再平取 a。
 *  显式可改（步骤 2 每列底部单选「保留这一条的姓名与身份字段」）。 */
export function defaultKeepContactId(a: MergeKeepSide, b: MergeKeepSide): number {
  if (a.mail_count !== b.mail_count) {
    return a.mail_count > b.mail_count ? a.id : b.id
  }
  const aLast = a.last_seen_at ?? Number.NEGATIVE_INFINITY
  const bLast = b.last_seen_at ?? Number.NEGATIVE_INFINITY
  return bLast > aLast ? b.id : a.id
}

export interface MergeMatterRef {
  matter_id: number
  public_id: string
  title: string
  role: string | null
}

/** 连带冲突 = 两侧事项交集（合并后同一事项会出现两行角色 → 黄色提示，逐个 matter）。 */
export function mergeMatterConflicts(
  a: readonly MergeMatterRef[],
  b: readonly MergeMatterRef[]
): MergeMatterRef[] {
  const ids = new Set(b.map((matter) => matter.matter_id))
  return a.filter((matter) => ids.has(matter.matter_id))
}

/** 事项并集（结果卡展示；按 matter_id 去重，a 先到先得保持稳定序）。 */
export function mergeMatterUnion(
  a: readonly MergeMatterRef[],
  b: readonly MergeMatterRef[]
): MergeMatterRef[] {
  const seen = new Set<number>()
  const union: MergeMatterRef[] = []
  for (const matter of [...a, ...b]) {
    if (seen.has(matter.matter_id)) continue
    seen.add(matter.matter_id)
    union.push(matter)
  }
  return union
}

/** 名字变体并集（去重保序）。 */
export function mergeVariantUnion(
  a: readonly string[],
  b: readonly string[]
): string[] {
  return [...new Set([...a, ...b])]
}
