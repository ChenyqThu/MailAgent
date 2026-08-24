// 速赢包 §4b/4c —— serve-api 就绪广播的 renderer 落点。
//
// serve-api（127.0.0.1:8200）是**软门控**：main 只在后台轮 /api/health，不阻塞开窗
// （backend_lifecycle.waitApiReady）。于是开窗那一瞬挂载的 serve-api 系 query（事项 /
// 通讯录 / 工作台 flag / 文件夹）可能全部打空。main 在软门控轮询成功处广播
// `mailagent:api-ready`，这里收到后失效那几族 query，让它们自己重来 —— 不用轮询、
// 不用把失败当事实缓存住。
//
// ipc.on 范式照抄 router-instance.tsx 的 deeplink 监听（含「返回值不是函数就退回
// removeListener」的兜底）：本仓有过 subscribe 不 dispose → listener 泄漏的前科。
// 非 Electron（web 构建 / 测试）没有 window.electron → 直接 no-op。

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { APP_CONFIG_QUERY_KEY } from '@shared/hooks/useAppConfig'
import { API_READY_CHANNEL } from '@shared/lib/ipcChannels'
import { qk } from '@shared/lib/queryKeys'

export function useApiReadyRefresh(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const ipc = (
      window as unknown as {
        electron?: {
          ipcRenderer?: {
            on(ch: string, fn: (...args: unknown[]) => void): (() => void) | void
            removeListener?(ch: string, fn: (...args: unknown[]) => void): void
          }
        }
      }
    ).electron?.ipcRenderer
    if (!ipc) return
    const handler = (): void => {
      // 四族都走 serve-api：工作台 flag（合并后的单 key）+ 事项 + 通讯录 + 文件夹。
      // 🔴 folder 是后补的：本 hook 引入时只盯着当时正在改的三族，而侧边栏文件夹树的
      // whitelist 才是挂载最早、最容易撞上 serve-api 未起的那个 —— 且它一失败整段树就
      // 不渲染，AppShell 单例化后 Sidebar 不再随路由 remount 自愈（就是本症状本身）。
      void queryClient.invalidateQueries({ queryKey: APP_CONFIG_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: qk.matters.all() })
      void queryClient.invalidateQueries({ queryKey: qk.contacts.all() })
      void queryClient.invalidateQueries({ queryKey: qk.folder.all() })
    }
    // @electron-toolkit ipcRenderer.on 返回 cleanup fn (removeListener wrapper)。
    const off = ipc.on(API_READY_CHANNEL, handler)
    return typeof off === 'function' ? off : () => ipc.removeListener?.(API_READY_CHANNEL, handler)
  }, [queryClient])
}
