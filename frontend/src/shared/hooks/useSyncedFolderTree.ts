// 已同步自定义文件夹的树（whitelist × discover，含 discover 未就绪时的本地 seed）。
//
// 原址是 `components/layout/SidebarFolderTree.tsx` 组件内部；task 08-27 P1 Lane B 把常驻
// 文件夹树换成列表头的文件夹选择器后，同一棵树有两个消费点（列表头的 pin 图标要解析
// 名字/图标，下拉面板要渲染整棵树），故拆成 hook。**查询配方逐字保留** —— 下面两条
// retry / enabled 的理由是踩过的坑，别顺手简化。

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { usePollingFallback } from '@shared/hooks/usePollingFallback'
import { buildFolderTree, buildSeedFolderInfos, type FolderNode } from '@shared/lib/folderTree'
import { qk } from '@shared/lib/queryKeys'

export interface SyncedFolderTree {
  /** 顶层节点（同层级按 SYNC_FOLDERS 数组序）。whitelist 空 → 空数组。 */
  tree: readonly FolderNode[]
  /** SYNC_FOLDERS 非空 —— 隔离不变量：为空时调用方整段不渲染。 */
  hasWhitelist: boolean
}

export function useSyncedFolderTree(): SyncedFolderTree {
  const mailApi = useMailApi()

  // connectedIntervalMs — SSE 连上后不归零而留 5min 保险轮询 (邮件主列表 a5953a13
  // 同纪律)。whitelist 一旦打空整棵树就消失, 而 SSE 秒级连上就会把兜底轮询清掉,
  // 于是「等下一次轮询」这条退路在自定义文件夹这里原本是不存在的。
  const pollingInterval = usePollingFallback({ connectedIntervalMs: 300_000 })

  // whitelist — 轻量 (.env 读), 常拉。空 → 不发 discover (省 IMAP LIST/STATUS)。
  //
  // 🔴 retry 按错误码: 它是开窗那一瞬最早发出的 serve-api query, 冷启时 renderer 常比
  // serve-api 先起 → 首拉 E_NETWORK, 而全局 retry:1 一秒内两发就废完; 失败即整棵树不
  // 渲染, AppShell 单例化后也不再随路由 remount 自愈。业务错误 (非 davmail 后端的
  // E_INVALID_ARG) 重试结果一样, 只会把门控态拖慢 → 不重。
  const { data: whitelistData } = useQuery({
    queryKey: qk.folder.whitelist(),
    queryFn: () => mailApi.folder.getWhitelist(),
    staleTime: 30_000,
    retry: (failureCount, error) =>
      (error as { code?: string } | null)?.code === 'E_NETWORK' && failureCount < 5,
    refetchInterval: pollingInterval,
    refetchIntervalInBackground: false
  })
  // 🔴 保留数组序 —— SYNC_FOLDERS 数组序 = 用户自定义显示顺序 (排序 task)。
  // Set 化会丢序, 只在需要成员判定的地方局部构造。
  const whitelist = React.useMemo(() => whitelistData?.folders ?? [], [whitelistData])
  const hasWhitelist = whitelist.length > 0

  // discover — 仅在有白名单时拉 (enabled 判据是 whitelist query 的 data, 缓存有值
  // **首帧即真** → 重挂载不再等一轮 whitelist 网络往返, 冷启动才有真串行), 长缓存。
  // 失败/门控静默 (seed 树仍在场, 见下)。counts:false (issue #45) — 大邮箱逐文件夹
  // STATUS 分钟级; 树只需 display_name/层级, count 缺失 null-safe。与 FolderPicker
  // 共用缓存 key (它发的请求带 refresh=true 穿透服务端 60s TTL; 这里缺省 false 吃缓存)。
  const { data: discoverData } = useQuery({
    queryKey: qk.folder.discover(),
    queryFn: () => mailApi.folder.discover({ counts: false }),
    enabled: hasWhitelist,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: false
  })

  const tree = React.useMemo<FolderNode[]>(() => {
    if (!hasWhitelist) return []
    const folders = discoverData?.folders
    if (folders && folders.length > 0) {
      return buildFolderTree(folders, whitelist)
    }
    // discover 未就绪/失败 — 本地 seed 树 (§③): whitelist 逐项 decodeImapUtf7 合成
    // display_name (与 email_metadata.mailbox 同源同值 → **可点**, 过滤 key 正确),
    // 走同一条 buildFolderTree 路径 (🔴 同 orderIndex 排序, discover 回来零跳变)。
    return buildFolderTree(buildSeedFolderInfos(whitelist), whitelist)
  }, [hasWhitelist, discoverData, whitelist])

  return { tree, hasWhitelist }
}
