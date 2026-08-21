// 启动预热挂点的 hook 层 (task 08-20-perf-shell-prefetch-sidebar §①)。
//
// 只做装配: queryClient + router 单例 → lib/startupPrefetch 的编排器。时序 / 门控 /
// 数据预热逻辑全在 lib 层 (可用假 IO 测试, 不拉起 router 依赖树); 这里薄到没有
// 值得测的分支。StrictMode 双挂安全: effect cleanup 即 dispose, 重跑幂等
// (preloadRoute 自去重, prefetch 命中缓存即 no-op)。

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { makeStartupPrefetchIo, startStartupPrefetch } from '@shared/lib/startupPrefetch'
import { router } from '@shared/router-instance'

export function useStartupPrefetch(): void {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      startStartupPrefetch(makeStartupPrefetchIo(queryClient, (to) => router.preloadRoute({ to }))),
    [queryClient]
  )
}
