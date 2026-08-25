import { CheckCircle2, Flag, Gavel, Send, TriangleAlert, type LucideIcon } from 'lucide-react'

import type { MatterProgressKind } from '@shared/api/types/matter'

/**
 * curated 进展五类的**外观**单源（task 08-25）。
 *
 * 词表本身（成员与顺序）的 canonical 在 Python `src/matters/models.py::MatterProgressKind`，
 * TS 镜像在 `api/types/matter.ts::MATTER_PROGRESS_KINDS`，跨语言闸
 * `tests/matters/test_matters_contract_parity.py`。**图标 / 色调只活在这里** —— 服务端一个字
 * 都不存样式，所以这一层不需要跨语言闸，靠 `Record<MatterProgressKind, …>` 的类型完备性
 * 兜底（少一个 kind 直接 typecheck 红）。
 *
 * 🔴 导出的是**表**不是查表函数 —— eslint `react-hooks/static-components` 不接受
 * `const Icon = someFn(...)`（调用表达式证明不了每次 render 返回同一个组件身份），
 * 成员索引 `MAP[key]` 可以。同 `matterVocab.ts` / `matterResource.ts` 的先例。
 *
 * 符号取自事项域已有的词汇，不发明新的：`milestone`/`decision` 与
 * `MATTER_ITEM_KIND_ICONS` 同符号（同名不同物，但用户读到的语义是一致的）；
 * `signal` 与 `MATTER_HEALTH_ICONS.at_risk`、`ATTN_META` 同用 alert；
 * `progress` 用设计 `PROG_KIND` 的 push（我方推进）符号 send。
 */
export const MATTER_PROGRESS_KIND_ICONS: Record<MatterProgressKind, LucideIcon> = {
  goal: Flag, // 目标设定 / 修订
  milestone: CheckCircle2, // 里程碑达成
  progress: Send, // 关键进展（默认档：回邮 / 推进 / 交付）
  signal: TriangleAlert, // 关键信号 / 风险
  decision: Gavel // 决议确定
}

/**
 * 节点色（`PROGRESS_TONE` 同一套 token）。
 *
 * 🔴 **只上色，不描边**（D13）：详情壳是半透的 `bg-ink-0/35`，圆底是实打实的一块色，
 * 叠描边就是 owner 报过的「图标多了外圈」。圆底留着盖住贯穿竖线，去掉的是描边那一层。
 */
export const MATTER_PROGRESS_KIND_TONE_CLASS: Record<MatterProgressKind, string> = {
  goal: 'text-ink-fg-3',
  milestone: 'text-ok',
  progress: 'text-info',
  signal: 'text-warn',
  decision: 'text-ai'
}
