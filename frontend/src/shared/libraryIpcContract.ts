/**
 * 资料库主进程接口的跨进程契约 —— IPC 键名 / 载荷形状 / 预览协议 URL 形状（design §2.5 / §2.6）。
 *
 * 🔴 零依赖叶子：main（`electron/main/handlers/library.ts`、`library_preview_protocol.ts`）与
 * renderer（`components/library/libraryIpc.ts`）都从这里 import，键名与 URL 只写一次 ——
 * 跨进程键名两侧手抄过一次就漂过一次（09-02 话题批 check 抓到 groupId/sessionId 两侧不一致，
 * 三闸全绿静默失效）。
 */

export const LIBRARY_IPC = {
  /** `shell.openPath`：主进程按目标解析绝对路径，renderer 永不拿到路径。 */
  openPath: 'library:openPath',
  /** `shell.showItemInFolder`，同上。 */
  showInFolder: 'library:showInFolder'
} as const

/** 打开 / 访达显示的目标。三种寻址各有来源：
 *  - `file`：`library_file.id`（库内文件，含挂载根）；
 *  - `attachment`：邮件附件投影行（`id` 为 null，靠 `attachment_id`）；
 *  - `folder`：文件夹的虚拟路径（树节点「在访达中显示」）。 */
export type LibraryOpenTarget =
  | { kind: 'file'; fileId: number }
  | { kind: 'attachment'; attachmentId: number }
  | { kind: 'folder'; path: string }

export type LibraryOpenResult = { ok: true } | { ok: false; code: string; message: string }

/** 自定义协议：`libpreview://library/<根 slug>/<相对路径>`。页面里的相对引用能在同一个根内解析。 */
export const LIBRARY_PREVIEW_SCHEME = 'libpreview'
export const LIBRARY_PREVIEW_HOST = 'library'

/** `shell.openPath` 一律拒开的扩展名（design §2.5）。`.app` 是目录 bundle，按末段名判、不看是不是文件。 */
export const LIBRARY_OPEN_BLOCKED_EXTENSIONS = [
  '.app',
  '.command',
  '.scpt',
  '.sh',
  '.pkg',
  '.dmg',
  '.jar',
  '.exe'
] as const

/** 虚拟路径 → 预览 URL。逐段 percent-encode（中文 / 空格 / `#`），`@label` 的 `@` 编码后主进程再解回。 */
export function buildLibraryPreviewUrl(virtualPath: string): string {
  const segments = virtualPath.split('/').filter(Boolean).map(encodeURIComponent)
  return `${LIBRARY_PREVIEW_SCHEME}://${LIBRARY_PREVIEW_HOST}/${segments.join('/')}`
}
