/**
 * 行动项执行契约的**外观**单源（L4 批次 3）：执行态 → 色调 / 图标，执行档 → UI 选项。
 * 状态语义住在服务端（`matter_item_dispatch.state` 由 CAS 推进），这里只管它长什么样。
 *
 * 🔴 导出的是**表**不是查表函数 —— eslint `react-hooks/static-components` 不接受
 * `const Icon = someFn(...)`（同 `matterVocab.ts` / `matterProgressVocab.ts` 的先例）。
 *
 * 🔴「等你回答」与「失败」必须一眼分得开（设计 D 卡）：前者 warn（琥珀 · 沙漏，还能推进），
 * 后者 critical（红 · 三角，这一轮死了）。两者共用一档色 = 用户分不出「agent 在等我」和
 * 「agent 挂了」，正是这一整批要终结的失效形态。
 */

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  FileCheck,
  Loader,
  MessageCircleQuestion,
  Ban,
  type LucideIcon
} from 'lucide-react'

import type { MatterItemDispatchState, MatterItemExecProfile } from '@shared/api/types/matter'

import type { MatterTone } from './matterVocab'

export const MATTER_DISPATCH_STATE_TONES: Record<MatterItemDispatchState, MatterTone> = {
  queued: 'neutral',
  running: 'info',
  awaiting_input: 'warn',
  proposed: 'info',
  done: 'success',
  failed: 'critical',
  canceled: 'neutral'
}

export const MATTER_DISPATCH_STATE_ICONS: Record<MatterItemDispatchState, LucideIcon> = {
  queued: CircleDashed,
  running: Loader,
  awaiting_input: MessageCircleQuestion,
  proposed: FileCheck,
  done: CheckCircle2,
  failed: AlertTriangle,
  canceled: Ban
}

/** 「这一轮还在进行」= 行上出 live badge、不许再派一次（服务端也有 partial unique 兜底）。 */
export const MATTER_DISPATCH_LIVE_STATES = [
  'queued',
  'running',
  'awaiting_input',
  'proposed'
] as const

export function isLiveDispatchState(state: MatterItemDispatchState): boolean {
  return (MATTER_DISPATCH_LIVE_STATES as readonly string[]).includes(state)
}

/**
 * 执行档的**可选项**（v1）。
 *
 * 🔴 `edit_with_approval` 在词表（`MATTER_ITEM_EXEC_PROFILES`）里但**不在这张表**：在提案制
 * 引擎里它与 `propose_only` 行为暂无差异，摆出来就是一个假选项 —— 而「渲染正常、功能是假的」
 * 比缺一个选项毒得多（design K5；同 `MANAGED_ENV_KEYS` 漏白名单那次的教训）。词表留着是
 * 因为它是跨批契约（动态审批分级要用）。
 */
export const MATTER_EXEC_PROFILE_OPTIONS: readonly MatterItemExecProfile[] = [
  'propose_only',
  'autonomous'
]
