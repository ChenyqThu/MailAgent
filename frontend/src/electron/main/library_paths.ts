// 资料库主进程侧的路径 jail（design §2.5 / §2.6 / §8.2）。`library:openPath` / `library:showInFolder`
// 两个 IPC 与 `libpreview://` 协议共用这一套解析，任何一条通往磁盘的路径都从这里过：
//
//   · 只收虚拟路径 `<根 slug>/<相对路径>`；拒 `..` / 绝对 / NUL / 空段；
//   · 根分三类：内置根（`DATA_ROOT/data/library/<slug>`）、挂载根（`@label` → serve-api 报的
//     `abs_path`）、投影（`mail-attachments/<attachment_id>/<文件名或同目录相对路径>` →
//     `email_attachment.local_path` 所在目录）；
//   · 与 Python `src/library/paths.py` 同一条纪律：`realpath` 必须与拼出来的路径**逐字相等**
//     —— 路径里任何 symlink 成分（指向根外**或根内**）一律拒，根目录本身先 realpath 化，
//     `/tmp` → `/private/tmp` 这类系统 symlink 不误伤；
//   · 真正 open 时（协议 handler）再 `O_NOFOLLOW` + `fstat` 复核（resolve → open 之间被换成
//     symlink 的 TOCTOU 窗）。
//
// 纯 node 模块：不 import electron，方便单测拿临时目录直接打。

import { realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'

import { PROJECTION_SLUG, TOP_LEVEL_SLUGS } from '@shared/libraryConstants'
import { LIBRARY_OPEN_BLOCKED_EXTENSIONS } from '@shared/libraryIpcContract'

export type LibraryPathErrorCode = 'E_INVALID_ARG' | 'E_NOT_FOUND' | 'E_AUTH_FAILED'

export class LibraryPathError extends Error {
  readonly code: LibraryPathErrorCode

  constructor(code: LibraryPathErrorCode, message: string) {
    super(message)
    this.name = 'LibraryPathError'
    this.code = code
  }
}

export interface AttachmentLocation {
  /** 附件文件的绝对路径（`email_attachment.local_path` 解析后）。 */
  absPath: string
  /** `email_attachment.filename`（投影行显示名；磁盘上的 basename 可能被 sanitize / 去重过）。 */
  filename: string
}

export interface LibraryPathContext {
  /** `DATA_ROOT/data/library` */
  libraryRoot: string
  /** `DATA_ROOT/data/attachments` */
  attachmentsRoot: string
  /** 挂载根 label → 绝对路径（只含 `status === 'ok'` 的）。 */
  mountRoots: ReadonlyMap<string, string>
  attachmentLocation(attachmentId: number): Promise<AttachmentLocation | null>
}

export interface ResolvedLibraryPath {
  absPath: string
}

const BUILT_IN_ROOTS: ReadonlySet<string> = new Set(
  TOP_LEVEL_SLUGS.filter((slug) => slug !== PROJECTION_SLUG)
)

/** 校验 + 切段。空串 / `.` / `..` / 含 NUL / 绝对路径一律 400。 */
export function splitVirtualPath(virtual: string): string[] {
  if (typeof virtual !== 'string' || virtual.length === 0) {
    throw new LibraryPathError('E_INVALID_ARG', 'path is required')
  }
  if (virtual.includes('\0')) throw new LibraryPathError('E_INVALID_ARG', 'path contains NUL')
  if (virtual.startsWith('/') || /^[A-Za-z]:[\\/]/.test(virtual)) {
    throw new LibraryPathError('E_INVALID_ARG', 'absolute paths are not allowed')
  }
  const segments = virtual.split(/[\\/]/)
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new LibraryPathError('E_INVALID_ARG', `bad path segment in ${JSON.stringify(virtual)}`)
    }
  }
  return segments
}

async function realpathOrNotFound(candidate: string): Promise<string> {
  try {
    return await realpath(candidate)
  } catch {
    throw new LibraryPathError('E_NOT_FOUND', `not found: ${basename(candidate)}`)
  }
}

/** 把 `segments` 钉在 `root` 之下：root 先 realpath 化；拼出来的路径 realpath 后必须逐字相等
 *  （任何 symlink 成分都拒），且落在 root 内。 */
export async function jailUnder(root: string, segments: readonly string[]): Promise<string> {
  const realRoot = await realpathOrNotFound(root)
  const candidate = join(realRoot, ...segments)
  const real = await realpathOrNotFound(candidate)
  if (real !== candidate) {
    throw new LibraryPathError('E_AUTH_FAILED', 'symlink components are not allowed')
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new LibraryPathError('E_AUTH_FAILED', 'path escapes its root')
  }
  return real
}

async function resolveProjection(
  rest: readonly string[],
  ctx: LibraryPathContext
): Promise<ResolvedLibraryPath> {
  const [idSegment, ...tail] = rest
  const attachmentId = Number(idSegment)
  if (!Number.isInteger(attachmentId) || attachmentId < 0 || tail.length === 0) {
    throw new LibraryPathError('E_INVALID_ARG', 'projection path must be mail-attachments/<id>/<name>')
  }
  const location = await ctx.attachmentLocation(attachmentId)
  if (location === null) throw new LibraryPathError('E_NOT_FOUND', `attachment ${attachmentId} has no file`)
  const realAttachmentsRoot = await realpathOrNotFound(ctx.attachmentsRoot)
  const realFile = await realpathOrNotFound(location.absPath)
  if (!realFile.startsWith(realAttachmentsRoot + sep)) {
    throw new LibraryPathError('E_AUTH_FAILED', 'attachment lives outside the attachments root')
  }
  // 末段 = 附件自己（按显示名或磁盘名都认）；否则当作同目录里的相对引用（HTML 里的 ./img.png）。
  if (tail.length === 1 && (tail[0] === location.filename || tail[0] === basename(realFile))) {
    return { absPath: realFile }
  }
  return { absPath: await jailUnder(dirname(realFile), tail) }
}

/** 虚拟路径 → 绝对路径。三类根各自一座 jail。 */
export async function resolveVirtualPath(
  virtual: string,
  ctx: LibraryPathContext
): Promise<ResolvedLibraryPath> {
  const [top, ...rest] = splitVirtualPath(virtual)
  if (top === PROJECTION_SLUG) return resolveProjection(rest, ctx)
  if (top.startsWith('@')) {
    const root = ctx.mountRoots.get(top.slice(1))
    if (root === undefined) throw new LibraryPathError('E_NOT_FOUND', `unknown or unavailable mount ${top}`)
    return { absPath: await jailUnder(root, rest) }
  }
  if (!BUILT_IN_ROOTS.has(top)) {
    throw new LibraryPathError('E_NOT_FOUND', `unknown top-level folder ${top}`)
  }
  return { absPath: await jailUnder(ctx.libraryRoot, [top, ...rest]) }
}

/** `shell.openPath` 黑名单：按末段扩展名判，目录 bundle（`.app`）也在内。 */
export function isBlockedForOpen(absPath: string): boolean {
  const ext = extname(absPath).toLowerCase()
  return (LIBRARY_OPEN_BLOCKED_EXTENSIONS as readonly string[]).includes(ext)
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf'
}

/** 协议响应的 Content-Type（网页与它的静态资源）；不认识的一律 octet-stream。 */
export function mimeForPath(absPath: string): string {
  return MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
}
