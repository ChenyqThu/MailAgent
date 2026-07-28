// P3 (task 06-18-custom-ai-harness-agent Phase 3) — Settings "Custom AI" section.
//
// This file is the thin composition layer: it wires the custom-ai/* subfiles together
// into the CustomAiSection mounted near the bottom of AiTab, and re-exports the symbols
// other surfaces import (StandingDocsSection is inlined by the AgentsTab preprocess drawer).
//
// The individual sub-sections live in ./custom-ai/*:
//   SkillsSection · UserMdCompileSection · MemoryCaptureModelSection · StandingDocsSection ·
//   ExecPolicySection · SkillPacksSection · SystemCapabilitiesSection (+ WebCapabilityRow).

import * as React from 'react'

import { SkillsSection } from './custom-ai/SkillsSection'
import { MemorySection } from './custom-ai/MemorySection'
import { UserMdCompileSection } from './custom-ai/UserMdCompileSection'
import { MemoryCaptureModelSection } from './custom-ai/MemoryCaptureModelSection'
import { StandingDocsSection } from './custom-ai/StandingDocsSection'
import { ExecPolicySection } from './custom-ai/ExecPolicySection'
import { SkillPacksSection } from './custom-ai/SkillPacksSection'
import {
  SystemCapabilitiesSection,
  SYSTEM_CAP_SCROLL_TARGETS
} from './custom-ai/SystemCapabilitiesSection'

// Re-export the previously public symbols so external / historical import sites resolve
// unchanged (AgentsTab imports StandingDocsSection from this module).
export { StandingDocsSection } from './custom-ai/StandingDocsSection'
export { ExecPolicySection } from './custom-ai/ExecPolicySection'
export { SkillPacksSection } from './custom-ai/SkillPacksSection'
export { SystemCapabilitiesSection, WebCapabilityRow } from './custom-ai/SystemCapabilitiesSection'

export function CustomAiSection(): React.ReactElement {
  return (
    <>
      <SkillsSection />
      <SystemCapabilitiesSection />
      <div id={SYSTEM_CAP_SCROLL_TARGETS.skillPacks}>
        <SkillPacksSection />
      </div>
      {/* Lane 2 #8 — 记忆双开关放记忆家族之首 (编译偏好 / 抽取模型都以记忆开着为前提)。 */}
      <MemorySection />
      <UserMdCompileSection />
      <MemoryCaptureModelSection />
      <StandingDocsSection />
      <div id={SYSTEM_CAP_SCROLL_TARGETS.exec}>
        <ExecPolicySection />
      </div>
    </>
  )
}
