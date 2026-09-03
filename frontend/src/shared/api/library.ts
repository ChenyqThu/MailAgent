// 资料库 REST client（design §3 端点全表）。照 `api/contacts.ts` / `api/notifications.ts` 的
// 工厂形状 `createLibraryApi(baseUrl)`，请求全部走 `shared/api/http_client` 的 envelope 解包
// （baseUrl 已含 `/api`，所以这里的 path 是 `/library…`）。
//
// 鉴权：router 用 `verify_local_token`。renderer 自己不持有本地 token —— main 进程的
// `chat_local_bridge` 在 webRequest 层给发往 loopback serve-api 的请求透明注入
// `X-MailAgent-Local-Token`。所以本文件**一个 header 都不用加**，与 contacts / notifications
// 同姿态；远程 web 构建打不到 loopback（域整个隐藏，design §2.5）。
//
// 🔴 wire 字段一律 snake_case；形状是 2026-09-03 与 serve-api lane 逐条对过的最终契约，
// 见 `api/types/library.ts` 的头注。

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
 *  🔴 服务端在 409 的 `data` 里确实带了 `{content_hash, content}`（agent 工具那条腿要用），
 *  但 `http_client` 在 `status==='error'` 上是**抛出**，只把 `{code,message,hint}` 带进
 *  ApiError，`data` 到不了这里。UI 这条腿撞冲突后再拉一次 `file(id)` 取当前版本。 */
export function isLibraryVersionConflict(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === LIBRARY_VERSION_CONFLICT
}

/** 文件夹内容区的排序维度（design §2.3）。🔴 排序是**服务端**做的：分页 200 之后
 *  客户端排序只能排当前这一页。 */
export type LibraryFolderSort = 'name' | 'size' | 'type' | 'date'
export type LibrarySortDirection = 'asc' | 'desc'

export interface LibraryFolderQuery {
  /** 默认走服务端的 `FOLDER_PAGE_SIZE`（200）。 */
  limit?: number
  offset?: number
  /** 文件夹内过滤（服务端 LIKE；投影区同时匹配文件名与来源列）。 */
  q?: string
  /** 缺省 `name`。🔴 投影文件夹忽略它，固定按邮件日期倒序。 */
  sort?: LibraryFolderSort
  /** 缺省 `asc`。 */
  dir?: LibrarySortDirection
}

export interface LibraryCreateTextFile {
  parent_path: string
  filename: string
  content: string
  /** 缺省 `user`（人在 UI 里新建）。 */
  source?: LibrarySource
  /** 派生来源 —— 「另存解析版为 markdown」传原文件 id 的字符串形式（design §2.3 F2 的
   *  「派生自 X」回链靠它）。不传就不发：`CreateTextRequest` 是 `extra="forbid"`，
   *  发一个服务端没声明的键会被 422 打回，不是被忽略。 */
  source_ref?: string
  change_note?: string
}

export interface LibraryUploadFile {
  parent_path: string
  filename: string
  bytes: ArrayBuffer | Uint8Array
  source?: LibrarySource
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

  // ── 邮件附件投影行（`id: null`）的三条只读兄弟端点 ────────────────────────────
  // 形状与上面的 `file` / `text` / `inlineUrl` 一一对应，只是按 `attachment_id` 寻址。
  /** 行对象（`is_projection: true`；文本类附件带 `content`）。 */
  attachment(attachmentId: number, maxBytes?: number): Promise<LibraryFileDetail>
  /** 解析文本 —— 直接读 `email_attachment_text`，**不重抽**（返回体 `file_id` 为 null）。 */
  attachmentText(attachmentId: number, maxBytes?: number): Promise<LibraryFileText>
  attachmentInlineUrl(attachmentId: number): string

  search(q: string, limit?: number): Promise<LibrarySearchResponse>
  createTextFile(input: LibraryCreateTextFile): Promise<LibraryFile>
  uploadFile(input: LibraryUploadFile): Promise<LibraryFile>
  writeFile(fileId: number, input: LibraryWrite): Promise<LibraryFile>
  moveFile(fileId: number, targetPath: string): Promise<LibraryFile>
  /** 软删 → `.trash`（挂载区走系统废纸篓，由服务端按 mount 分流）。 */
  trashFile(fileId: number): Promise<LibraryFile>
  /** 立即永久删除（mockup F11）。🔴 只对**已在废纸篓**的行成立，服务端会拒别的行。 */
  purgeFile(fileId: number): Promise<LibraryFile>
  restoreFile(fileId: number): Promise<LibraryFile>
  history(fileId: number): Promise<LibraryHistoryEntry[]>
  /** 回滚 = 用那条快照做一次普通写（享受同一道 CAS 校验，见 design §4）。 */
  rollback(fileId: number, historyId: number): Promise<LibraryFile>
  /** 邮件附件「另存到资料库」：真复制，从此与邮件解耦（design §1.1）。 */
  keepAttachment(attachmentId: number, targetPath: string): Promise<LibraryFile>
  /** 不传 `mountId` = 全库对账。 */
  rescan(mountId?: number): Promise<LibraryRescanResult>
  mounts(): Promise<LibraryMount[]>
  addMount(absPath: string, label?: string, mode?: LibraryMountMode): Promise<LibraryMount>
  patchMount(
    mountId: number,
    patch: { label?: string; mode?: LibraryMountMode }
  ): Promise<LibraryMount>
  /** 卸载：挂载行标 `unmounted`、其下文件行标 `missing`，**不删行、不动磁盘**（§8.2）。 */
  removeMount(mountId: number): Promise<LibraryMount>
}

export function createLibraryApi(baseUrl: string): LibraryApi {
  return {
    tree(): Promise<LibraryTreeResponse> {
      return request(baseUrl, 'GET', '/library/tree')
    },

    folder(path: string, query: LibraryFolderQuery = {}): Promise<LibraryFolderPage> {
      return request(baseUrl, 'GET', '/library/folder', {
        query: {
          path,
          limit: query.limit,
          offset: query.offset,
          q: query.q,
          sort: query.sort,
          dir: query.dir
        }
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

    attachment(attachmentId: number, maxBytes?: number): Promise<LibraryFileDetail> {
      return request(baseUrl, 'GET', `/library/attachment/${attachmentId}`, {
        query: { max_bytes: maxBytes }
      })
    },

    attachmentText(attachmentId: number, maxBytes?: number): Promise<LibraryFileText> {
      return request(baseUrl, 'GET', `/library/attachment/${attachmentId}/text`, {
        query: { max_bytes: maxBytes }
      })
    },

    attachmentInlineUrl(attachmentId: number): string {
      return `${baseUrl}/library/attachment/${attachmentId}/inline`
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
      // mime 不发 —— 服务端按扩展名猜，发了也是被忽略。
      const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
      return requestRaw(baseUrl, 'POST', '/library/files', bytes, 'application/octet-stream', {
        query: {
          parent_path: input.parent_path,
          filename: input.filename,
          source: input.source
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

    purgeFile(fileId: number): Promise<LibraryFile> {
      return request(baseUrl, 'DELETE', `/library/file/${fileId}`, { query: { purge: true } })
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

    rescan(mountId?: number): Promise<LibraryRescanResult> {
      return request(baseUrl, 'POST', '/library/rescan', {
        body: mountId != null ? { mount_id: mountId } : {}
      })
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

    removeMount(mountId: number): Promise<LibraryMount> {
      return request(baseUrl, 'DELETE', `/library/mounts/${mountId}`)
    }
  }
}
