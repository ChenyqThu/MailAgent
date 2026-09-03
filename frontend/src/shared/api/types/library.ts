// 资料库（library）serve-api 的 wire 类型（design §3 端点全表；表结构 §1.2 + 多根 §8.2）。
//
// 🔴 **字段名一律 snake_case 且与 `library_file` / `library_mount` 的列名逐字同名** ——
// 这是前后端两条 lane 唯一的对齐手段（router 与本文件同期在写，没有生成器也没有闸）。
// 想改名 = 两侧同改，别在读侧做映射把差异藏起来。
//
// 值域（kind / source / status / text_status / mount mode 与 status）不在这里重新声明，
// 直接用零依赖叶子 `@shared/libraryConstants` 的联合类型 —— 那份与 `src/library/constants.py`
// 有跨语言闸，多抄一份就多一处会漂的地方。

import type {
  LibraryFileStatus,
  LibraryKind,
  LibraryMountMode,
  LibraryMountStatus,
  LibrarySource,
  LibraryTextStatus
} from '@shared/libraryConstants'

/** `library_file` 的行投影。`rel_key`（casefold 比对键）是服务端内部键，不上 wire。 */
export interface LibraryFile {
  id: number
  /** 0 = 库根；>0 = `library_mount.id`（design §8.2 多根）。 */
  mount_id: number
  /** 虚拟路径 `<根 slug>/<相对路径>`；挂载根的 slug 是 `@<label>`。绝对路径永不上 wire。 */
  rel_path: string
  parent_path: string
  filename: string
  kind: LibraryKind
  size_bytes: number | null
  /** epoch 秒（`library_file.mtime` REAL）。 */
  mtime: number | null
  /** 乐观锁判据。写入必带（`PUT` 的 `expected_hash` 就是它）；未算出时 null。 */
  content_hash: string | null
  source: LibrarySource
  /** mail: attachment_id；chat: `{sessionId}:{uiMessageId}`；agent: agent_id；derived: 原文件 id。 */
  source_ref: string | null
  /** 'user' | agent_id。 */
  created_by: string | null
  status: LibraryFileStatus
  text_status: LibraryTextStatus | null
  created_at: number
  updated_at: number
  /** markdown frontmatter 的 title —— 列表「名称」列优先显示它（design §2.3），无则 null。 */
  title?: string | null
  /** 列表「来源」列的人类可读串：投影行 = 邮件主题 + 发件人；derived = 原文件名。 */
  source_label?: string | null
}

/** `GET /library/tree` 的一行。层级靠 `parent_path` 还原（根行 parent_path = null）。
 *  只读与不可用**不上 wire** —— 前端从投影根 slug 与挂载的 mode / status 推（单一判据，
 *  服务端多一个布尔就多一处会与 mode 打架的真相）。 */
export interface LibraryFolderNode {
  path: string
  parent_path: string | null
  /** 末段显示名。内置根返 slug（UI 走 i18n 换文案），挂载根返 `@<label>`。 */
  name: string
  mount_id: number
  /** 直接子文件数（树上的角标）。 */
  file_count: number
}

/** `library_mount` 行。`abs_path` 只在设置页「挂载的文件夹」列表里展示（design §8.2）。 */
export interface LibraryMount {
  id: number
  label: string
  abs_path: string
  mode: LibraryMountMode
  status: LibraryMountStatus
  file_count: number
  added_at: number
}

export interface LibraryTreeResponse {
  folders: LibraryFolderNode[]
  mounts: LibraryMount[]
}

/** `GET /library/folder?path=` —— 子文件夹 + 文件条目，文件侧分页（`FOLDER_PAGE_SIZE`）。 */
export interface LibraryFolderPage {
  path: string
  folders: LibraryFolderNode[]
  files: LibraryFile[]
  total: number
  limit: number
  offset: number
}

/** `GET /library/file/{id}` —— 行 + 正文。`content` 只对文本类（markdown / html / text）
 *  给，二进制为 null（它们的可读正文走 `/text` 的解析版）。 */
export interface LibraryFileDetail extends LibraryFile {
  content: string | null
}

/** `GET /library/file/{id}/text` —— 解析版（`library_text`），预览 / 搜索 / agent 读同一来源。 */
export interface LibraryFileText {
  file_id: number
  /** 三态未就绪时 null（看 `text_status`）。 */
  markdown: string | null
  /** `anydoc|pypdf|pdf_ocr|vision_ocr|plaintext|native…`，未抽取时 null。 */
  extractor: string | null
  truncated: boolean
  /** 生成这份文本时的 `content_hash`；≠ 当前 hash = 过期。 */
  source_hash: string | null
  text_status: LibraryTextStatus
}

export interface LibrarySearchHit {
  file: LibraryFile
  /** FTS5 snippet（含高亮标记），无正文时 null。 */
  snippet: string | null
  /** bm25 得分；trigram 表按 mtime 排时为 null。 */
  score: number | null
}

export interface LibrarySearchResponse {
  query: string
  hits: LibrarySearchHit[]
  total: number
  /** 1 字查询被拦下等「查了但没查成」的说明（repository 的 warning），正常时 null。 */
  warning: string | null
}

/** `GET /library/file/{id}/history` 的一行（`library_history` 全快照）。 */
export interface LibraryHistoryEntry {
  id: number
  file_id: number
  old_hash: string | null
  new_hash: string
  /** 全快照正文。超限被服务端省掉时 null（此时该行只能回滚不能预览）。 */
  content_snapshot: string | null
  /** 'user' | agent_id | 'external'。external 行天生没有 change_note。 */
  changed_by: string
  change_note: string | null
  session_id: number | null
  message_id: number | null
  created_at: number
}

/** `POST /library/rescan` 的回执。 */
export interface LibraryRescanResult {
  scanned: number
  added: number
  updated: number
  missing: number
}
