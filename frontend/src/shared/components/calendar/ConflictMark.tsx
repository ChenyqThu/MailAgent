// task 08-27 P5 —— 时间冲突的轻量标识 (日/周事件块 + 议程行共用同一个渲染)。
//
// 🔴 手法有意选「时间行里多一枚警示 icon」: `.evt` / `.m-evt` 家族刚在 P4e 统一成
// 「去 border + wash 底 + inset 状态环」, 并建了文本级防回加闸
// (tests/shared/calendar-event-block-border.test.ts)。冲突标识**不加任何描边、
// 不改底色**, 只占用块内既有的 icon 槽 (Join/Teams 图标同一条 flex 行), 因此既
// 不撞那道闸, 也不与「暂定斜纹 / 待回复内环 / 拒绝取消删除线」四种状态形态化抢
// 表达位 —— 一场会可以既是「暂定」又「有冲突」, 两层信息互不覆盖。
//
// 文案复用邀请卡的既有键 calendar.invite.conflictCount (同一件事只有一种说法)。

import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  /** 冲突对手数 (≥1; 0 时调用方不渲染本组件)。 */
  count: number
}

export function ConflictMark({ count }: Props): React.ReactElement {
  const { t } = useTranslation()
  const label = t('calendar.invite.conflictCount', '与 {n} 场日程重叠', { n: count })
  return (
    <span className="cal-conflict inline-flex shrink-0 text-warn" title={label} aria-label={label}>
      <AlertTriangle size={11} strokeWidth={2.2} aria-hidden />
    </span>
  )
}
