// Attention 信号的展示元数据（tone + 图标）。
//
// 这些是非组件导出，必须留在 `.ts` 而不是与组件同住 `attention.tsx`——react-refresh
// 的 only-export-components 规则要求组件文件只导出组件，否则整个模块的热更新会退化成
// 整页刷新。词表本身照 design-handoff 附录 A 的 ATTN_META。

import type { ComponentType } from 'react'
import {
  CalendarClock,
  CircleAlert,
  CircleHelp,
  HeartPulse,
  Hourglass,
  PlayCircle,
  Sparkles
} from 'lucide-react'

import type { MatterAttentionKind, MatterAttentionSignal } from '@shared/api/types/matter'

export type AttentionTone = 'info' | 'warn' | 'critical'

export const ATTENTION_META: Record<
  MatterAttentionKind,
  { tone: AttentionTone; icon: ComponentType<{ size?: number; className?: string }> }
> = {
  wait_overdue: { tone: 'critical', icon: Hourglass },
  action_overdue: { tone: 'critical', icon: CircleAlert },
  deadline_near: { tone: 'warn', icon: CalendarClock },
  health_down: { tone: 'critical', icon: HeartPulse },
  needs_review: { tone: 'info', icon: Sparkles },
  run_failed: { tone: 'critical', icon: PlayCircle },
  context_gap: { tone: 'warn', icon: CircleHelp }
}

/** 实例 severity 优先于 kind 的默认 tone —— health_down 会在 at_risk/off_track 之间升降档。 */
export function attentionTone(signal: MatterAttentionSignal): AttentionTone {
  return signal.severity === 'critical'
    ? 'critical'
    : signal.severity === 'warn'
      ? 'warn'
      : ATTENTION_META[signal.kind].tone
}
