// 资料库内容区的数据层（design §3 端点全表）：一把 API 单例 + 本域 query key + 按 ref 选端点。
//
// 🔴 投影行（`id: null`）走 `/library/attachment/{attachment_id}` 三条兄弟端点，形状与
// `/library/file/{id}` 家族逐字同形（主 session 09-03 拍板）—— 端点选择只在这里做一次，
// 预览面的子视图一律吃 `LibraryFileRef`，不分支。
//
// 排序 / 过滤都发给服务端（`q` / `sort` / `dir`）：分页 200 之后客户端只能排当前页。

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  createLibraryApi,
  type LibraryApi,
  type LibraryFolderQuery,
  type LibraryFolderSort,
  type LibrarySortDirection
} from '@shared/api/library'
import type {
  LibraryFile,
  LibraryFileDetail,
  LibraryFileText,
  LibraryFolderPage,
  LibraryHistoryEntry,
  LibraryMountSummary,
  LibraryTreeResponse
} from '@shared/api/types/library'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { UPLOAD_MAX_BYTES } from '@shared/libraryConstants'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { refKey, type LibraryFileRef } from './fileMeta'

export function useLibraryApi(): LibraryApi {
  return useMemo(() => createLibraryApi(resolveApiBaseUrl()), [])
}

/** 本域的 query key。前缀 `['library']` 一刀失效整域（写操作后用）。 */
export const libQk = {
  all: () => ['library'] as const,
  tree: () => ['library', 'tree'] as const,
  folder: (path: string, query: Pick<LibraryFolderQuery, 'q' | 'sort' | 'dir'>) =>
    ['library', 'folder', path, query.q ?? '', query.sort ?? 'name', query.dir ?? 'asc'] as const,
  file: (ref: LibraryFileRef) => ['library', 'file', refKey(ref)] as const,
  text: (ref: LibraryFileRef) => ['library', 'text', refKey(ref)] as const,
  history: (fileId: number) => ['library', 'history', fileId] as const
}

export function fetchDetail(api: LibraryApi, ref: LibraryFileRef): Promise<LibraryFileDetail> {
  return 'id' in ref ? api.file(ref.id) : api.attachment(ref.attachmentId)
}

export function fetchText(api: LibraryApi, ref: LibraryFileRef): Promise<LibraryFileText> {
  return 'id' in ref ? api.text(ref.id) : api.attachmentText(ref.attachmentId)
}

/** 原件字节的 URL。🔴 不能直接当 `<img src>`：renderer 的 CSP `img-src` 不含 loopback，
 *  只能 fetch 回来转 blob:（connect-src 放行 127.0.0.1）。 */
export function inlineUrlOf(api: LibraryApi, ref: LibraryFileRef): string {
  return 'id' in ref ? api.inlineUrl(ref.id) : api.attachmentInlineUrl(ref.attachmentId)
}

export function useLibraryTreeQuery(enabled = true) {
  const api = useLibraryApi()
  return useQuery<LibraryTreeResponse>({
    queryKey: libQk.tree(),
    queryFn: () => api.tree(),
    enabled,
    staleTime: 15_000
  })
}

export interface FolderListOptions {
  q?: string
  sort: LibraryFolderSort
  dir: LibrarySortDirection
}

/** 文件夹内容分页（`FOLDER_PAGE_SIZE`）；`offset` 是 pageParam，换过滤 / 排序换 key 重头拉。 */
export function useLibraryFolderPages(path: string | null, options: FolderListOptions) {
  const api = useLibraryApi()
  const trimmed = options.q?.trim() ?? ''
  const base: Pick<LibraryFolderQuery, 'q' | 'sort' | 'dir'> = {
    q: trimmed === '' ? undefined : trimmed,
    sort: options.sort,
    dir: options.dir
  }
  return useInfiniteQuery<LibraryFolderPage>({
    queryKey: libQk.folder(path ?? '', base),
    queryFn: ({ pageParam }) => api.folder(path ?? '', { ...base, offset: pageParam as number }),
    initialPageParam: 0,
    // 🔴 翻页判据是服务端算好的 `has_more`，不是 `offset + files.length < total`：
    // 投影行与库内行来自两个数据源，`total` 与本页长度不保证同口径。
    getNextPageParam: (last) => (last.has_more ? last.offset + last.files.length : undefined),
    enabled: path !== null,
    // 换过滤词 / 排序时保留上一份数据，避免列表闪一下骨架。
    placeholderData: keepPreviousData,
    staleTime: 10_000
  })
}

export function useLibraryFileQuery(ref: LibraryFileRef | null) {
  const api = useLibraryApi()
  return useQuery<LibraryFileDetail>({
    queryKey: ref ? libQk.file(ref) : ['library', 'file', 'none'],
    queryFn: () => fetchDetail(api, ref as LibraryFileRef),
    enabled: ref !== null,
    staleTime: 5_000
  })
}

export function useLibraryTextQuery(ref: LibraryFileRef | null, enabled = true) {
  const api = useLibraryApi()
  return useQuery<LibraryFileText>({
    queryKey: ref ? libQk.text(ref) : ['library', 'text', 'none'],
    queryFn: () => fetchText(api, ref as LibraryFileRef),
    enabled: ref !== null && enabled,
    staleTime: 30_000
  })
}

export function useLibraryHistoryQuery(fileId: number | null, enabled: boolean) {
  const api = useLibraryApi()
  return useQuery<LibraryHistoryEntry[]>({
    queryKey: fileId !== null ? libQk.history(fileId) : ['library', 'history', 'none'],
    queryFn: () => api.history(fileId as number),
    enabled: fileId !== null && enabled,
    staleTime: 5_000
  })
}

/** 挂载根的只读 / 不可用判据来自树响应里的挂载投影（服务端不在文件行上重复这两个布尔）。 */
export function useMountSummary(mountId: number): LibraryMountSummary | null {
  const tree = useLibraryTreeQuery(mountId > 0)
  if (mountId <= 0) return null
  return tree.data?.mounts.find((m) => m.id === mountId) ?? null
}

export function useInvalidateLibrary(): {
  all(): Promise<void>
  tree(): Promise<void>
  folder(path: string): Promise<void>
  file(ref: LibraryFileRef): Promise<void>
} {
  const qc = useQueryClient()
  return useMemo(
    () => ({
      all: () => qc.invalidateQueries({ queryKey: libQk.all() }),
      tree: () => qc.invalidateQueries({ queryKey: libQk.tree() }),
      folder: (path: string) =>
        qc.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === 'library' && q.queryKey[1] === 'folder' && q.queryKey[2] === path
        }),
      file: (ref: LibraryFileRef) =>
        Promise.all([
          qc.invalidateQueries({ queryKey: libQk.file(ref) }),
          qc.invalidateQueries({ queryKey: libQk.text(ref) })
        ]).then(() => undefined)
    }),
    [qc]
  )
}

/** 冲突态「重拉当前版本」（design §4：409 body 到不了 UI，靠再 GET 一次）。 */
export function useRefetchDetail(): (ref: LibraryFileRef) => Promise<LibraryFileDetail> {
  const api = useLibraryApi()
  const qc = useQueryClient()
  return useCallback(
    (ref: LibraryFileRef) =>
      qc.fetchQuery({
        queryKey: libQk.file(ref),
        queryFn: () => fetchDetail(api, ref),
        staleTime: 0
      }),
    [api, qc]
  )
}

/** 拖入 / 「导入文件…」共用的上传：逐个 `POST /library/files`（octet-stream），超 15 MiB 的跳过并
 *  单独提示；结束后整域失效（树的角标与文件夹列表都变了）。返回入库的文件对象。 */
export function useLibraryUpload(): (folderPath: string, files: readonly File[]) => Promise<LibraryFile[]> {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const invalidate = useInvalidateLibrary()
  return useCallback(
    async (folderPath, files) => {
      const uploaded: LibraryFile[] = []
      let failed = 0
      for (const file of files) {
        if (file.size > UPLOAD_MAX_BYTES) {
          toastError(t('library.folder.tooLargeToast', { name: file.name }))
          continue
        }
        try {
          uploaded.push(
            await api.uploadFile({
              parent_path: folderPath,
              filename: file.name,
              bytes: await file.arrayBuffer()
            })
          )
        } catch (err) {
          failed += 1
          toastError(t('library.folder.uploadFailedToast', { name: file.name }), errorMessage(err))
        }
      }
      if (uploaded.length > 0) {
        await invalidate.all()
        toastSuccess(
          t('library.folder.uploadedToast', {
            n: uploaded.length,
            folder: folderPath.split('/').pop() ?? folderPath
          })
        )
      }
      if (uploaded.length === 0 && failed === 0 && files.length > 0) await invalidate.all()
      return uploaded
    },
    [api, invalidate, t]
  )
}
