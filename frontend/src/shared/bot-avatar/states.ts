// 灵动 bot 头像 —— 状态表 + MailAgent 状态映射。
// GROUPS/POOLS/EXPR_CADENCE/BLINK 四张表 1:1 移植自原型 index.html L3455-3622
// （组名从法语意译，成员值逐字照抄），改值前先对 grokbot-engine-analysis.md §3。
// 本文件 framework-agnostic：只允许 type-only import，不得引入任何运行时依赖。

import type { AgentCallProjectedState } from '../lib/agentCallState'
import type { TurnStage } from '../assistant/runtime/useTurnStage'

// 原型组名：'Cycle de vie' / 'Réactions' / 'Morphes agent' / 'Cycle produit'
export const GROUPS = {
  lifecycle: ['sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching', 'working'],
  reactions: [
    'excited',
    'surprised',
    'suspicious',
    'angry',
    'drowsy',
    'happy',
    'curious',
    'confused',
    'bored',
    'proud',
    'shy',
    'sad',
    'laughing',
    'scared',
    'playful',
    'celebrate'
  ],
  agentMorphs: ['orbit', 'radar', 'progress'],
  productCycle: [
    'spawning',
    'humming',
    'loading',
    'dictating',
    'writing',
    'sending',
    'receiving',
    'uploading',
    'notifying',
    'alerting',
    'dragging',
    'bouncing',
    'powering-down'
  ]
} as const

export type BotState = (typeof GROUPS)[keyof typeof GROUPS][number]

export const BOT_STATES: readonly BotState[] = Object.values(GROUPS).flat()

/** [minMs, maxMs] —— 调度器在区间内均匀随机取下一次触发延迟 */
export type CadenceRange = readonly [number, number]

/** 状态 → 表情索引池；池首是 setState 立即切换的帧，其余由调度器随机轮换 */
export const POOLS: Record<BotState, readonly number[]> = {
  sleeping: [13, 22, 4],
  waking: [13],
  idle: [0, 8],
  listening: [10, 1, 19],
  thinking: [8, 16, 14, 17, 5],
  searching: [15, 9, 3, 20, 12, 18],
  working: [7, 16, 11, 10],
  excited: [2, 17, 21, 3, 11],
  surprised: [3, 21],
  suspicious: [14, 5, 23],
  angry: [7, 16],
  drowsy: [4, 22, 13],
  happy: [2, 11, 17, 19],
  curious: [3, 21, 0, 15],
  confused: [14, 5, 8],
  bored: [4, 22, 0],
  proud: [15, 8, 2],
  shy: [0, 24, 13],
  sad: [4, 13, 22],
  laughing: [2, 11, 17],
  scared: [3, 21],
  playful: [2, 17, 11, 8],
  celebrate: [2, 8, 17],
  orbit: [0, 8],
  radar: [0, 8],
  progress: [0, 8],
  spawning: [3, 0],
  humming: [0, 8],
  loading: [0, 8],
  dictating: [10, 1, 19],
  sending: [0, 8],
  receiving: [19, 0, 8],
  uploading: [15, 9, 8],
  writing: [15, 9],
  notifying: [3, 21, 0],
  alerting: [3, 21],
  bouncing: [2, 17],
  dragging: [3, 15, 0],
  'powering-down': [13, 22]
}

/** 状态 → 表情自动切换节奏 */
export const EXPR_CADENCE: Record<BotState, CadenceRange> = {
  sleeping: [6000, 10000],
  waking: [800, 800],
  idle: [9000, 16000],
  listening: [2800, 5000],
  thinking: [2000, 3600],
  searching: [1000, 1800],
  working: [1800, 3200],
  excited: [1100, 2000],
  surprised: [2500, 4000],
  suspicious: [2600, 4500],
  angry: [2200, 3800],
  drowsy: [4000, 8000],
  happy: [2500, 4500],
  curious: [1800, 3200],
  confused: [2200, 3800],
  bored: [3500, 6000],
  proud: [3500, 6000],
  shy: [3000, 5500],
  sad: [4000, 7000],
  laughing: [1200, 2400],
  scared: [900, 1800],
  playful: [1500, 3000],
  celebrate: [1400, 2600],
  orbit: [4000, 8000],
  radar: [4000, 8000],
  progress: [4000, 8000],
  spawning: [1200, 1200],
  humming: [5000, 9000],
  loading: [6000, 10000],
  dictating: [4000, 8000],
  sending: [4000, 8000],
  receiving: [4000, 8000],
  uploading: [4000, 8000],
  writing: [4000, 8000],
  notifying: [1500, 2600],
  alerting: [2000, 3600],
  bouncing: [3000, 6000],
  dragging: [1600, 3000],
  'powering-down': [6000, 9000]
}

/** 状态 → 眨眼节奏；null = 该状态不眨眼（sleeping/loading 等闭眼或机械态） */
export const BLINK: Record<BotState, CadenceRange | null> = {
  sleeping: null,
  waking: null,
  idle: [6000, 14000],
  listening: [3000, 7000],
  thinking: [3500, 7000],
  searching: [1600, 4000],
  working: [2800, 5500],
  excited: [2000, 4000],
  surprised: [1800, 3500],
  suspicious: [4500, 8000],
  angry: [3500, 7000],
  drowsy: null,
  happy: [2500, 5000],
  curious: [2500, 5500],
  confused: [2800, 5500],
  bored: [4000, 8000],
  proud: [3500, 7000],
  shy: [3000, 6000],
  sad: [4000, 8000],
  laughing: [2500, 5000],
  scared: [1200, 3000],
  playful: [2000, 4500],
  celebrate: [2200, 4500],
  orbit: null,
  radar: null,
  progress: null,
  spawning: null,
  humming: [4000, 8000],
  loading: null,
  dictating: null,
  sending: null,
  receiving: null,
  uploading: null,
  writing: null,
  notifying: [2000, 4000],
  alerting: null,
  bouncing: null,
  dragging: [2200, 4500],
  'powering-down': null
}

// ---------------------------------------------------------------------------
// MailAgent 状态映射（prd §6.4 状态映射总表）。
// Record 形式强制穷尽：上游 union 加值时这里编译期就红，不会静默漏映射。

const TURN_STAGE_TO_BOT_STATE: Record<TurnStage, BotState> = {
  idle: 'idle',
  connecting: 'waking',
  thinking: 'thinking',
  'calling-tool': 'searching',
  writing: 'writing',
  'awaiting-approval': 'notifying',
  stalled: 'drowsy',
  error: 'sad'
}

/** interactive chat 回合阶段（deriveTurnStage 8 值）→ 引擎状态 */
export function turnStageToBotState(stage: TurnStage): BotState {
  return TURN_STAGE_TO_BOT_STATE[stage]
}

type AgentRunStatus = AgentCallProjectedState['status']

const RUN_STATE_TO_BOT_STATE: Record<AgentRunStatus, BotState> = {
  queued: 'loading',
  running: 'working',
  waiting_approval: 'notifying',
  completed: 'idle',
  failed: 'sad',
  stopped: 'powering-down'
}

/** headless run 前端 6 值投影（projectAgentCallState）→ 引擎状态（静态位点离散换帧用） */
export function runStateToBotState(status: AgentRunStatus): BotState {
  return RUN_STATE_TO_BOT_STATE[status]
}
