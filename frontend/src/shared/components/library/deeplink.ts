// 资料库深链（design §9.5）：`/library?file={id}`，落地 = 进域 + 展开所在文件夹 + 选中文件
// （`LibraryWorkspace` 消费）。F3：一切「进了资料库」的回执恒带一个「打开」动作指向它 ——
// 另存 / 另存解析版 / 附件行另存 三处共用这里，没有去处的回执一律视为缺陷。
//
// 走 `router.history.push` 而不是 `router.navigate({ to: '/library' })`：路由本身由 P1-L8
// 单独一个 commit 注册，注册前这里的 `to` 字面量过不了 typecheck；history 是路由器的公开面，
// push 之后照常走匹配。

import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { useToastStore, type ToastInput } from '@shared/state/toast'

export function libraryFileHref(fileId: number): string {
  return `/library?file=${fileId}`
}

/** 从 `location.href` 里读 `?file=`。
 *  🔴 走 href 字符串而不是 `useSearch({ from: '/library' })`：路由由 P1-L8 单独注册，
 *  注册前那个 `from` 字面量不存在、过不了 typecheck；href 是路由器恒有的公开面。 */
export function parseLibraryFileParam(href: string): number | null {
  const q = href.indexOf('?')
  if (q < 0) return null
  const raw = new URLSearchParams(href.slice(q + 1)).get('file')
  if (raw === null) return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

interface HistoryLike {
  history: { push(path: string): void }
}

export function navigateToLibraryFile(router: HistoryLike | null | undefined, fileId: number): void {
  router?.history.push(libraryFileHref(fileId))
}

/** 「已进资料库」的成功 toast：标题由调用方给，动作恒为「打开」。 */
export function useLibraryOpenToast(): (title: string, fileId: number, detail?: string) => number {
  const { t } = useTranslation()
  // `warn: false`：这个 toast 挂在邮件详情的附件行上，那条渲染路径（以及它的组件测试）
  // 不保证有 RouterProvider。没有 router 时 push 静默跳过，toast 本身照出。
  const router = useRouter({ warn: false }) as unknown as HistoryLike | null
  return useCallback(
    (title, fileId, detail) => {
      const input: ToastInput = {
        variant: 'success',
        title,
        detail,
        action: {
          label: t('library.toast.openAction'),
          onClick: () => navigateToLibraryFile(router, fileId)
        }
      }
      return useToastStore.getState().push(input)
    },
    [router, t]
  )
}
