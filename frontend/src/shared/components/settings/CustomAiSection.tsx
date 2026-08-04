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

import { AI_TAB_ANCHOR_IDS, AI_TAB_ANCHOR_SCROLL_MT } from './aiTabAnchors'
import { SkillsSection } from './custom-ai/SkillsSection'
import { ConnectorsSection } from './custom-ai/ConnectorsSection'
import { MemorySection } from './custom-ai/MemorySection'
import { UserMdCompileSection } from './custom-ai/UserMdCompileSection'
import { MemoryCaptureModelSection } from './custom-ai/MemoryCaptureModelSection'
import { StandingDocsSection } from './custom-ai/StandingDocsSection'
import { ExecPolicySection } from './custom-ai/ExecPolicySection'
import { SkillPacksSection } from './custom-ai/SkillPacksSection'
import { SystemCapabilitiesSection } from './custom-ai/SystemCapabilitiesSection'

// Re-export the previously public symbols so external / historical import sites resolve
// unchanged (AgentsTab imports StandingDocsSection from this module).
export { StandingDocsSection } from './custom-ai/StandingDocsSection'
export { ExecPolicySection } from './custom-ai/ExecPolicySection'
export { SkillPacksSection } from './custom-ai/SkillPacksSection'
export { SystemCapabilitiesSection, WebCapabilityRow } from './custom-ai/SystemCapabilitiesSection'

export function CustomAiSection(): React.ReactElement {
  // 08-01 PR4 — 每个子区外裹一个 id wrapper 供右侧锚点导航跳转。id 单源在 ./aiTabAnchors
  // （其中 skillPacks / execPolicy 两个的值仍是存量的 SYSTEM_CAP_SCROLL_TARGETS，未改名 ——
  // SystemCapabilitiesSection 的交叉引用跳转在消费）。scroll-mt 补偿 sticky RestartBanner。
  const mt = AI_TAB_ANCHOR_SCROLL_MT
  return (
    <>
      <div id={AI_TAB_ANCHOR_IDS.skills} className={mt}>
        <SkillsSection />
      </div>
      {/* MCP 外部连接 —— owner 拍板与 Skills 并列（都是「AI 能用什么」的授权面）。 */}
      <div id={AI_TAB_ANCHOR_IDS.connectors} className={mt}>
        <ConnectorsSection />
      </div>
      <div id={AI_TAB_ANCHOR_IDS.systemCapabilities} className={mt}>
        <SystemCapabilitiesSection />
      </div>
      <div id={AI_TAB_ANCHOR_IDS.skillPacks} className={mt}>
        <SkillPacksSection />
      </div>
      {/* Lane 2 #8 — 记忆双开关放记忆家族之首 (编译偏好 / 抽取模型都以记忆开着为前提)。 */}
      <div id={AI_TAB_ANCHOR_IDS.memory} className={mt}>
        <MemorySection />
      </div>
      <div id={AI_TAB_ANCHOR_IDS.userMdCompile} className={mt}>
        <UserMdCompileSection />
      </div>
      <div id={AI_TAB_ANCHOR_IDS.memoryCaptureModel} className={mt}>
        <MemoryCaptureModelSection />
      </div>
      <div id={AI_TAB_ANCHOR_IDS.standingDocs} className={mt}>
        <StandingDocsSection />
      </div>
      <div id={AI_TAB_ANCHOR_IDS.execPolicy} className={mt}>
        <ExecPolicySection />
      </div>
    </>
  )
}
