export type ComputerUseSurface = 'desktop' | 'browser'

export interface ComputerUseActivityState {
  active: boolean
  runId: string | null
  surface: ComputerUseSurface | null
  actionLabel: string | null
  currentTarget: string | null
  stepCount: number
  startedAt: number | null
}

export const IDLE_COMPUTER_USE_ACTIVITY: ComputerUseActivityState = {
  active: false,
  runId: null,
  surface: null,
  actionLabel: null,
  currentTarget: null,
  stepCount: 0,
  startedAt: null
}

export const COMPUTER_USE_IPC = {
  getState: 'computer-use:get-state',
  stopActive: 'computer-use:stop-active',
  activityChanged: 'computer-use:activity-changed',
  overlaySetInteractive: 'computer-use:overlay-set-interactive'
} as const
