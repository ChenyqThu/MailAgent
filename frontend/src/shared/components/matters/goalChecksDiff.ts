// 完成标志（goal_checks）提案的 diff 摘要（S3，08-18）。
//
// 提案里的 goal_checks 是**整表替换**（agent 发的是完整目标清单，不是 delta），
// 但 owner 要判断的是「相对现在，动了什么」。这里把两份清单折成三组：
// 新增 / 删除 / 勾选态翻转。
//
// 🔴 判据是**文本**（`t`）而不是下标：agent 重排了顺序、或在中间插一条，
// 按下标比会把整份清单读成「全改了」。

import type { MatterGoalCheck } from '@shared/api/types/matter'

export interface GoalChecksDiff {
  added: MatterGoalCheck[]
  removed: MatterGoalCheck[]
  /** 文本没变、只是勾选态翻了的条目（带**新**状态）。 */
  toggled: MatterGoalCheck[]
  /** 两侧完全一致的条目数 —— 用来说明「其余 N 条不变」。 */
  unchanged: number
}

/** 提案 payload 里的值是 unknown（可能是坏数据 / 旧形状）—— 只取形状对的条目。 */
function normalize(value: unknown): MatterGoalCheck[] {
  if (!Array.isArray(value)) return []
  const out: MatterGoalCheck[] = []
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object') continue
    const text = (entry as { t?: unknown }).t
    if (typeof text !== 'string' || text.trim() === '') continue
    out.push({ t: text, done: Boolean((entry as { done?: unknown }).done) })
  }
  return out
}

export function diffGoalChecks(before: unknown, after: unknown): GoalChecksDiff {
  const beforeList = normalize(before)
  const afterList = normalize(after)
  const beforeByText = new Map(beforeList.map((check) => [check.t, check]))
  const afterByText = new Map(afterList.map((check) => [check.t, check]))

  const added = afterList.filter((check) => !beforeByText.has(check.t))
  const removed = beforeList.filter((check) => !afterByText.has(check.t))
  const toggled: MatterGoalCheck[] = []
  let unchanged = 0
  for (const check of afterList) {
    const previous = beforeByText.get(check.t)
    if (!previous) continue
    if (previous.done !== check.done) toggled.push(check)
    else unchanged += 1
  }
  return { added, removed, toggled, unchanged }
}
