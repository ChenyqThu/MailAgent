// SystemCapabilitiesSection「核心邮件操作」toolCount 漂移守护（prd 07-27 加 draft_compose/
// draft_update 后 6→8 件的收尾批，小件1）。
//
// 真源 = src/ai-gateway/tools/skill_gating.ts 的 CORE_UNGATED_GATEWAY_TOOLS —— 该 Set 内所有
// `email_` 前缀条目恰好等于「核心邮件操作」写族（email 家族的只读工具走 GATEWAY_SKILL_TOOLS.email，
// 不进 CORE_UNGATED，故前缀过滤不会误收）。CORE_EMAIL_TOOL_COUNT 是 SystemCapabilitiesSection.tsx
// 里的手抄值（未直接 import skill_gating.ts —— 那是 main-process AI Gateway 代码，renderer 侧无
// alias，不为省一次手抄引入跨进程耦合）；改任一边漏改另一边，本测试变红。

import { describe, expect, test } from 'vitest'

import { CORE_EMAIL_TOOL_COUNT } from '../../src/shared/components/settings/custom-ai/SystemCapabilitiesSection'
import { CORE_UNGATED_GATEWAY_TOOLS } from '../../src/ai-gateway/tools/skill_gating'

describe('SystemCapabilitiesSection — coreEmail toolCount parity guard', () => {
  test('CORE_EMAIL_TOOL_COUNT matches the email_-prefixed subset of CORE_UNGATED_GATEWAY_TOOLS', () => {
    const emailCoreTools = [...CORE_UNGATED_GATEWAY_TOOLS].filter((name) =>
      name.startsWith('email_')
    )
    expect(CORE_EMAIL_TOOL_COUNT).toBe(emailCoreTools.length)
  })
})
