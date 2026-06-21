// P3 (task 06-18-custom-ai-harness-agent Phase 3) — React-reactive wrapper over
// the skill-enablement override store. The persistence + pure compute SSoT lives
// in shared/chat/skill_enablement.ts (so the chat runtime can read overrides
// without depending on this zustand module); this store is just the React seam
// the Settings "Skills" toggle subscribes to, keeping localStorage + the in-memory
// view in lock-step.

import { create } from 'zustand'

import {
  readSkillOverrides,
  setSkillOverride as persistSkillOverride
} from '@shared/chat/skill_enablement'

interface SkillEnablementStore {
  /** Per-skill enabled overrides (skillName → boolean). Absent → manifest default. */
  overrides: Record<string, boolean>
  /** Set one skill's override (persists to localStorage + updates the view). */
  setEnabled(name: string, enabled: boolean): void
}

export const useSkillEnablement = create<SkillEnablementStore>((set) => ({
  overrides: readSkillOverrides(),
  setEnabled(name, enabled) {
    const next = persistSkillOverride(name, enabled)
    set({ overrides: next })
  }
}))
