// 资料库 REST client（design §3 端点全表）。照 `api/contacts.ts` / `api/notifications.ts` 的
// 工厂形状 `createLibraryApi(baseUrl)`，请求全部走 `shared/api/http_client` 的 envelope 解包
// （baseUrl 已含 `/api`，所以这里的 path 是 `/library…`）。
//
// 鉴权：router 用 `verify_local_token`。renderer 自己不持有本地 token —— main 进程的
// `chat_local_bridge` 在 webRequest 层给发往 loopback serve-api 的请求透明注入
// `X-MailAgent-Local-Token`。所以本文件**一个 header 都不用加**，与 contacts / notifications
// 同姿态；远程 web 构建打不到 loopback（域整个隐藏，design §2.5）。
//
// 🔴 wire 字段一律 snake_case，见 `api/types/library.ts` 的头注。

import { request, requestRaw } from './http_client'
import type {
  LibraryFile,
  LibraryFileDetail,
  LibraryFileText,
  LibraryHistoryEntry,
  LibraryFolderPage,
  LibraryMount,
  LibraryRescanResult,
  LibrarySearchResponse,
  LibraryTreeResponse
} from './types/library'
import type { LibraryMountMode, LibrarySource } from '@shared/libraryConstants'

/** 写入撞上并发改动时服务端回的 code（design §4；`src/api/app.py` 里映射到 HTTP 409）。 */
export const LIBRARY_VERSION_CONFLICT = 'E_VERSION_CONFLICT'

/** 冲突判据单点 —— 编辑器要据此切「已被改动 / 显示当前版本 / 保留我的文本」三态。
 *  🔴 冲突时的**当前版本**要靠再拉一次 `getFile(id)`：envelope 的 error 只有
 *  `{code,message,hint}`，`http_client` 的解包不会把额外字段带出来，服务端即便在 409 body
 *  里塞了 hash + content 也到不了这里。 */
export function isLibraryVersionConflict(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === LIBRARY_VERSION_CONFLICT
}

export interface LibraryFolderQuery {
  /** 默认走服务端的 `FOLDER_PAGE_SIZE`（200）。 */
  limit?: number
  offset?: number
}

export interface LibraryCreateTextFile {
  parent_path: string
  filename: string
  content: string
  /** 缺省 `user`（人在 UI 里新建）。 */
  source?: LibrarySource
}

export interface LibraryUploadFile {
  parent_path: string
  filename: string
  mime: string
  bytes: ArrayBuffer | Uint8Array
}

export interface LibraryWrite {
  content: string
  /** 乐观锁：读到的 `content_hash`；`null` = 期望是新建，已存在则 409。 */
  expected_hash: string | null
  change_note?: string
}

export interface LibraryApi {
  tree(): Promise<LibraryTreeResponse>
  folder(path: string, query?: LibraryFolderQuery): Promise<LibraryFolderPage>
  file(fileId: number): Promise<LibraryFileDetail>
  /** 原件字节的 URL（iframe / img 直接用；不经 envelope，服务端支持 Range 206）。 */
  inlineUrl(fileId: number): string
  text(fileId: number): Promise<LibraryFileText>
  search(q: string, limit?: number): Promise<LibrarySearchResponse>
  createTextFile(input: LibraryCreateTextFile): Promise<LibraryFile>
  uploadFile(input: LibraryUploadFile): Promise<LibraryFile>
  writeFile(fileId: number, input: LibraryWrite): Promise<LibraryFile>
  moveFile(fileId: number, targetPath: string): Promise<LibraryFile>
  /** 软删 → `.trash`（挂载区走系统废纸篓，由服务端按 mount 分流）。 */
  trashFile(fileId: number): Promise<LibraryFile>
  restoreFile(fileId: number): Promise<LibraryFile>
  history(fileId: number): Promise<LibraryHistoryEntry[]>
  /** 回滚 = 用那条快照做一次普通写（享受同一道 CAS 校验，见 design §4）。 */
  rollback(fileId: number, historyId: number): Promise<LibraryFile>
  /** 邮件附件「另存到资料库」：真复制，从此与邮件解耦（design §1.1）。 */
  keepAttachment(attachmentId: number, targetPath: string): Promise<LibraryFile>
  rescan(): Promise<LibraryRescanResult>
  mounts(): Promise<LibraryMount[]>
  addMount(absPath: string, label?: string, mode?: LibraryMountMode): Promise<LibraryMount>
  patchMount(
    mountId: number,
    patch: { label?: string; mode?: LibraryMountMode }
  ): Promise<LibraryMount>
  /** 卸载：挂载行标 `unmounted`、其下文件行标 `missing`，**不删行、不动磁盘**（§8.2）。 */
  removeMount(mountId: number): Promise<void>
}

export function createLibraryApi(baseUrl: string): LibraryApi {
  return {
    tree(): Promise<LibraryTreeResponse> {
      return request(baseUrl, 'GET', '/library/tree')
    },

    folder(path: string, query: LibraryFolderQuery = {}): Promise<LibraryFolderPage> {
      return request(baseUrl, 'GET', '/library/folder', {
        query: { path, limit: query.limit, offset: query.offset }
      })
    },

    file(fileId: number): Promise<LibraryFileDetail> {
      return request(baseUrl, 'GET', `/library/file/${fileId}`)
    },

    inlineUrl(fileId: number): string {
      return `${baseUrl}/library/file/${fileId}/inline`
    },

    text(fileId: number): Promise<LibraryFileText> {
      return request(baseUrl, 'GET', `/library/file/${fileId}/text`)
    },

    search(q: string, limit?: number): Promise<LibrarySearchResponse> {
      return request(baseUrl, 'GET', '/library/search', { query: { q, limit } })
    },

    createTextFile(input: LibraryCreateTextFile): Promise<LibraryFile> {
      return request(baseUrl, 'POST', '/library/files', { body: input })
    },

    uploadFile(input: LibraryUploadFile): Promise<LibraryFile> {
      // 🔴 二进制走 `application/octet-stream` + query 元数据，不是 multipart ——
      // 与既有的 staging 上传（`HttpApi.uploadComposeAttachment` → `PUT
      // /email/compose-attachment`）同一姿态。多一条 multipart 路径就要在 renderer 侧
      // 复制一份 envelope 解包（`http_client` 的 request 恒 JSON.stringify body，
      // 解包函数不导出），而 envelope「只在一处解析」是那个文件的立身之本。
      const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
      return requestRaw(baseUrl, 'POST', '/library/files', bytes, 'application/octet-stream', {
        query: {
          parent_path: input.parent_path,
          filename: input.filename,
          mime: input.mime
        }
      })
    },

    writeFile(fileId: number, input: LibraryWrite): Promise<LibraryFile> {
      return request(baseUrl, 'PUT', `/library/file/${fileId}`, {
        body: {
          content: input.content,
          expected_hash: input.expected_hash,
          change_note: input.change_note ?? null
        }
      })
    },

    moveFile(fileId: number, targetPath: string): Promise<LibraryFile> {
      return request(baseUrl, 'POST', `/library/file/${fileId}/move`, {
        body: { target_path: targetPath }
      })
    },

    trashFile(fileId: number): Promise<LibraryFile> {
      return request(baseUrl, 'DELETE', `/library/file/${fileId}`)
    },

    restoreFile(fileId: number): Promise<LibraryFile> {
      return request(baseUrl, 'POST', `/library/file/${fileId}/restore`)
    },

    history(fileId: number): Promise<LibraryHistoryEntry[]> {
      return request(baseUrl, 'GET', `/library/file/${fileId}/history`)
    },

    rollback(fileId: number, historyId: number): Promise<LibraryFile> {
      return request(baseUrl, 'POST', `/library/file/${fileId}/rollback`, {
        body: { history_id: historyId }
      })
    },

    keepAttachment(attachmentId: number, targetPath: string): Promise<LibraryFile> {
      return request(baseUrl, 'POST', '/library/keep-attachment', {
        body: { attachment_id: attachmentId, target_path: targetPath }
      })
    },

    rescan(): Promise<LibraryRescanResult> {
      return request(baseUrl, 'POST', '/library/rescan')
    },

    mounts(): Promise<LibraryMount[]> {
      return request(baseUrl, 'GET', '/library/mounts')
    },

    addMount(absPath: string, label?: string, mode?: LibraryMountMode): Promise<LibraryMount> {
      return request(baseUrl, 'POST', '/library/mounts', {
        body: { abs_path: absPath, label: label ?? null, mode: mode ?? null }
      })
    },

    patchMount(
      mountId: number,
      patch: { label?: string; mode?: LibraryMountMode }
    ): Promise<LibraryMount> {
      return request(baseUrl, 'PATCH', `/library/mounts/${mountId}`, { body: patch })
    },

    removeMount(mountId: number): Promise<void> {
      return request(baseUrl, 'DELETE', `/library/mounts/${mountId}`)
    }
  }
}
