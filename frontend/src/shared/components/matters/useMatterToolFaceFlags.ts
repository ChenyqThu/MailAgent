// 跟进 Agent 工具面板的**真实可用性信号**（0812 dogfood Lane D）。
//
// 起因：面板此前把 30 件工具一律列成「默认全部启用」，但其中带 skill 归属的那几组会被
// 设置 → Custom AI → Skills 的开关整族拿掉（gateway 两道 applySkillGating），网页那三档在
// `MAILAGENT_OPENNESS_WEB_TOOLS=false` 时更是一个死开关（工具压根不注册，档位存了也没有
// 消费者）。界面照旧渲染 = 又一句谎。
//
// 两个信号都取自 serve-api `/chat/config` —— 与喂给生产 gateway 的**同一份投影**
// （`ai_gateway_lifecycle.ts` 用 `_systemPromptCache.value.advertisedSkills` 调
// buildGatewayTools；`webToolsEnabled` 是 `MAILAGENT_OPENNESS_WEB_TOOLS` 的热读）。
// 一次请求取两个字段（`fetchOpennessFlags` 先例），不为一个面板打两发。

import { useQuery } from '@tanstack/react-query'

import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'
import { qk } from '@shared/lib/queryKeys'

export interface MatterToolFaceFlags {
  /** 当前对模型可见的 skill 名单。🔴 `null` = **未知**（还没回来 / 后端无此字段 / 不可达），
   *  消费侧一律 fail-open，与 buildGatewayTools 的 null 分支同语义。 */
  advertisedSkills: string[] | null
  /** `MAILAGENT_OPENNESS_WEB_TOOLS`。`false` = web 工具根本不注册（三档是死开关）；
   *  `undefined` = 未知 → 按现状渲染、不禁用（`flags.webToolsEnabled === false` 判据先例：
   *  CapabilityCards 的 webDisabled）。 */
  webToolsEnabled: boolean | undefined
}

/** 未知态：两个字段都「不知道」⇒ 消费侧一个都不降级。 */
const UNKNOWN: MatterToolFaceFlags = { advertisedSkills: null, webToolsEnabled: undefined }

async function fetchMatterToolFaceFlags(): Promise<MatterToolFaceFlags> {
  try {
    const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
    if (!response.ok) return UNKNOWN
    const body = (await response.json()) as { data?: Record<string, unknown> }
    const skills = body?.data?.advertisedSkills
    const web = body?.data?.webToolsEnabled
    return {
      // Python 在投影出岔时**有意**下发 null（gateway 据此 fail-open）—— 非数组一律当未知，
      // 不要把它收成 []（[] 的语义是「一个 skill 都没开」，会让整面板变灰）。
      advertisedSkills: Array.isArray(skills)
        ? skills.filter((name): name is string => typeof name === 'string')
        : null,
      webToolsEnabled: typeof web === 'boolean' ? web : undefined
    }
  } catch {
    return UNKNOWN
  }
}

export function useMatterToolFaceFlags(): MatterToolFaceFlags {
  const query = useQuery({
    queryKey: qk.chat.config('matterToolFace'),
    queryFn: fetchMatterToolFaceFlags,
    staleTime: 30_000,
    retry: false
  })
  return query.data ?? UNKNOWN
}
