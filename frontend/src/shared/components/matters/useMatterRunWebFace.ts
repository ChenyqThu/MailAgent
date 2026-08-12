import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'

// 🔴 类型来自词表单源（`src/ai-gateway/tools/policy.ts` 的 MATTER_RUN_WEB_FACES / 与
// `src/api/routers/agent.py` 有跨语言闸 `tests/config/test_matter_web_face_parity.py`）。
// **type-only import**：编译期就被擦掉，renderer 不会因此把 gateway 那一坨拉进 bundle
// （先例 `assistant/components/CompactCard.tsx` 的 CompactMessageMetadata）。
//
// 🔴 代价说清楚：type-only import 换来的是**运行时词表在本模块被手抄了第三份**
// （下面的 WEB_FACE_ORDER / WEB_FACE_DEFAULT）。typecheck 只挡得住**减少**一档
// （字面量不再可赋值）与**改名**；**新增**一档不会红 —— `readonly MatterRunWebFace[]` 对
// 子集是合法的，于是新档不会出现在 radio 里，而 parseFace 会把服务端存的新档当脏值收成
// 'keep' ⇒ 「界面显示全给、实际生效另一档」，正是这个开关最不该出现的失败形态。
// 消费侧 `Record<MatterRunWebFace, …>`（MatterToolFacePanel）只保证 i18n 文案不缺键，
// 保不住这一条。故三份副本（Python 端点 / policy.ts / 本模块）统一由
// `tests/config/test_matter_web_face_parity.py` 逐项对账 —— 改词表必须三处一起改。
import type { MatterRunWebFace } from '../../../ai-gateway/tools/policy'

export type { MatterRunWebFace }

export const MATTER_RUN_WEB_FACE_KEY = ['matters', 'run-web-face'] as const

/** 三档的渲染顺序（宽 → 窄）。🔴 同时是本模块 `parseFace` 的**收窄词表** —— 与 Python
 *  `MATTER_RUN_WEB_FACES` 逐项对账，闸见文件头。 */
export const WEB_FACE_ORDER: readonly MatterRunWebFace[] = ['keep', 'search_only', 'off']

/** 服务端缺省（= gateway 侧同一个默认，读失败也 fail-safe 到它）。同样入闸对账。 */
export const WEB_FACE_DEFAULT: MatterRunWebFace = 'keep'

function parseFace(value: unknown): MatterRunWebFace | null {
  return (WEB_FACE_ORDER as readonly unknown[]).includes(value) ? (value as MatterRunWebFace) : null
}

const ENDPOINT = '/agent/matter-web-face'

/**
 * 跟进 run 的网页检索档（owner_settings `matter_run_web_face`）。
 *
 * 🔴 「显示的档」必须恒等于「存进去的档」—— 一个显示 X、实际生效 Y 的安全开关比没有开关
 * 更危险。所以：保存失败**不留**乐观值（`pending` 清掉 → 立刻退回服务端事实 + toast 报错），
 * 保存成功才把返回的 mode 写进缓存（写回的是**服务端返回值**，不是我们发过去的那个）。
 */
export function useMatterRunWebFace(options?: {
  /** 保存失败的报错通道（文案要 i18n，故由组件给）。UI 侧的回滚是自动的，见下。 */
  onSaveError?(error: unknown): void
}): {
  /** 当前该显示的档（保存中显示乐观值；未取到时 undefined —— 调用侧据此显示加载态）。 */
  face: MatterRunWebFace | undefined
  isLoading: boolean
  isError: boolean
  isSaving: boolean
  save(next: MatterRunWebFace): void
} {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: MATTER_RUN_WEB_FACE_KEY,
    queryFn: async (): Promise<MatterRunWebFace> => {
      const response = await fetch(`${resolveApiBaseUrl()}${ENDPOINT}`, {
        credentials: 'include'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { data?: { mode?: unknown } }
      return parseFace(payload.data?.mode) ?? WEB_FACE_DEFAULT
    },
    staleTime: 30_000
  })

  const save = useMutation({
    mutationFn: async (mode: MatterRunWebFace): Promise<MatterRunWebFace> => {
      const response = await fetch(`${resolveApiBaseUrl()}${ENDPOINT}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { data?: { mode?: unknown } }
      // 越域值服务端一律 400（绝不静默回落），所以这里能解析出来的就是真正落库的那个。
      const stored = parseFace(payload.data?.mode)
      if (stored === null) throw new Error('unexpected matter-web-face response')
      return stored
    },
    onSuccess: (stored) => {
      queryClient.setQueryData(MATTER_RUN_WEB_FACE_KEY, stored)
    },
    onError: (error) => options?.onSaveError?.(error)
  })

  return {
    // 🔴 失败时 `save.variables` 仍留着刚点的那一档，但 `isPending` 已为 false ⇒ 不再显示它，
    // 界面自动退回 query 里的服务端事实（= 回滚）。
    face: save.isPending ? save.variables : query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    isSaving: save.isPending,
    save: (next) => save.mutate(next)
  }
}
