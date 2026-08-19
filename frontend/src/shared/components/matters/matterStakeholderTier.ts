// 干系人分组与重排 payload 的纯逻辑（S2，v60）。
//
// 与组件分家是为了让它可直测（`tests/components/matters/matterStakeholderTier.test.ts`），
// 也让 `MatterStakeholderSection.tsx` 只导出组件（react-refresh 要求）。

import type {
  MatterStakeholder,
  MatterStakeholderReorderItem,
  MatterStakeholderTier
} from '@shared/api/types/matter'
import { MATTER_STAKEHOLDER_DEFAULT_TIER } from '@shared/api/types/matter'

/** 服务端已按 `(tier='core') DESC, sort_order, id` 排好。
 *  🔴 读侧**不得**再 `sorted()` 覆盖（同 `SYNC_FOLDERS` 数组序那条纪律）——
 *  这里只按 tier 分桶，桶内**保持服务端给的相对顺序**。 */
export function splitStakeholdersByTier(stakeholders: readonly MatterStakeholder[]): {
  core: MatterStakeholder[]
  normal: MatterStakeholder[]
} {
  const core: MatterStakeholder[] = []
  const normal: MatterStakeholder[] = []
  for (const stakeholder of stakeholders) {
    // 旧后端不发 tier ⇒ 按 normal 兜底（不是「未知组」——那会凭空多一个分组）。
    if ((stakeholder.tier ?? MATTER_STAKEHOLDER_DEFAULT_TIER) === 'core') core.push(stakeholder)
    else normal.push(stakeholder)
  }
  return { core, normal }
}

/** 一次拖拽后的整批目标顺序：两组拼起来重新编号，被移动的那行带上新 tier。
 *
 *  🔴 **跨组统一编号**（不 per-tier 重置）：这样「拖到另一组」只需要改 tier 一列，
 *  组内相对次序天然保持；per-tier 编号会让每次跨组拖都要重排两个组。 */
export function buildReorderPayload(
  core: readonly MatterStakeholder[],
  normal: readonly MatterStakeholder[]
): MatterStakeholderReorderItem[] {
  return [
    ...core.map((stakeholder) => [stakeholder, 'core'] as const),
    ...normal.map((stakeholder) => [stakeholder, 'normal'] as const)
  ].map(([stakeholder, tier], index) => ({
    id: stakeholder.id,
    sort_order: index,
    tier: tier as MatterStakeholderTier
  }))
}
