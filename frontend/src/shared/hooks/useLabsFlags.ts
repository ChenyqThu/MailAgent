// L4 群聊 g1 — labs 实验开关的 renderer 读面（owner_settings，`GET /api/agent/labs`）。
//
// 🔴 fail-closed 到 off：读不到（后端没起 / 端点 404 / 传输失败）一律当**关着**——与 gateway 侧
// resolveLabsFlags 的兜底同向。反过来（读不到当开着）会让 UI 在 owner 完全不知情时切到
// 服务端编排形态。
//
// 设置页（LabsTab）与群聊视图共读同一个 query key（qk.labsFlags）：在实验室里一开，
// 切回群聊就是新模态，不需要重启也不需要刷新。

import { useQuery } from '@tanstack/react-query'

import { getLabs } from '@shared/api/groupSettings'
import { qk } from '@shared/lib/queryKeys'

export function useLabsFlags(): { groupAgents: boolean; loading: boolean } {
  const q = useQuery({
    queryKey: qk.labsFlags(),
    queryFn: getLabs,
    staleTime: 30_000,
    retry: false
  })
  return { groupAgents: q.data?.groupAgents === 'on', loading: q.isLoading }
}
