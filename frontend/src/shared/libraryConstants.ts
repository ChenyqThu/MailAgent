/**
 * 资料库（library）的值域事实 —— TS 侧零依赖叶子。
 *
 * 与 Python 侧 `src/library/constants.py` 逐字同名同值，闸在
 * `tests/config/test_library_constants_parity.py`。
 *
 * 🔴 本文件**不许 import 任何东西**（renderer / main / ai-gateway 三处都要用它；
 * 一旦拉进 electron / keytar / store 就没法在 gateway 里 import）。
 * 加成员必须两侧同改，闸会红。
 */

/** 库根下的内置顶层文件夹（磁盘上是英文 slug，UI 走 i18n）。 */
export const TOP_LEVEL_SLUGS = [
  'mail-attachments',
  'chat-attachments',
  'agent-docs',
  'my-docs',
  '.trash',
] as const
export type TopLevelSlug = (typeof TOP_LEVEL_SLUGS)[number]

/** 邮件附件投影根 —— 不在磁盘上，只读。 */
export const PROJECTION_SLUG = 'mail-attachments'
/** 软删根。 */
export const TRASH_SLUG = '.trash'
/** agent 无人值守免卡的唯一目标前缀（design §5.3 的 B 通道）。 */
export const AGENT_DOCS_SLUG = 'agent-docs'

/** 文件类别（复用 anydoc lane 语义；`placeholder` = iCloud 未下载的 .icloud 占位）。 */
export const KINDS = [
  'markdown',
  'html',
  'pdf',
  'office',
  'image',
  'text',
  'placeholder',
  'other',
] as const
export type LibraryKind = (typeof KINDS)[number]

/** 抽取状态 —— 镜像附件表 `email_attachment_text.status` 词表。 */
export const TEXT_STATUS = ['pending', 'extracted', 'failed', 'unsupported'] as const
export type LibraryTextStatus = (typeof TEXT_STATUS)[number]

/** 文件行状态（`missing` 不删行 —— 跨模块引用永不悬空）。 */
export const FILE_STATUS = ['present', 'missing', 'trashed'] as const
export type LibraryFileStatus = (typeof FILE_STATUS)[number]

/** 文件来源。`derived` = 「另存解析版」生成的 markdown。 */
export const SOURCES = ['user', 'mail', 'chat', 'agent', 'derived'] as const
export type LibrarySource = (typeof SOURCES)[number]

/** 挂载根的读写档（用户侧总闸）。 */
export const MOUNT_MODES = ['ro', 'rw'] as const
export type LibraryMountMode = (typeof MOUNT_MODES)[number]

/** 挂载根状态：`unavailable` = 卷拔了 / 目录移走；`unmounted` = 用户卸载（行不删）。 */
export const MOUNT_STATUS = ['ok', 'unavailable', 'unmounted'] as const
export type LibraryMountStatus = (typeof MOUNT_STATUS)[number]

/** agent 写面的扩展名白名单（人上传不受此限）。 */
export const WRITE_EXT_ALLOWLIST = ['.md', '.markdown', '.html', '.txt', '.csv', '.json'] as const

/** 挂载根内额外拒读写的后缀 / 目录（exec 地板之外再加一层）。 */
export const MOUNT_DENY_SUFFIXES = ['.env', '.pem', '.key', '.db'] as const
export const MOUNT_DENY_DIRS = ['.git'] as const

/** 文本写入上限（agent / 编辑器走这条）。 */
export const TEXT_WRITE_MAX_BYTES = 1024 * 1024
/** 上传 / 入库单文件上限 —— 沿用 `attachment.py::_CONVERT_MAX_BYTES`。 */
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024
/** 抽取文本上限 —— 沿用 `attachment_text.ATTACHMENT_TEXT_MAX_BYTES`。 */
export const EXTRACT_MAX_BYTES = 256 * 1024
/** `library_read` 返回上限（工具层，与抽取上限是两层）。 */
export const READ_TOOL_MAX_CHARS = 12000
export const READ_TOOL_MAX_BYTES = 2 * 1024 * 1024
/** 历史保留：每文件条数 + 全库快照总量。 */
export const HISTORY_MAX_PER_FILE = 50
export const HISTORY_MAX_TOTAL_BYTES = 20 * 1024 * 1024
/** `.trash` 保留天数。 */
export const TRASH_TTL_DAYS = 30
/** 文件夹分页大小。 */
export const FOLDER_PAGE_SIZE = 200
/** 挂载文件数警戒线。 */
export const MOUNT_MAX_FILES = 20000
/** 单文件夹超过它就放弃 layoutId pill、退化成虚拟列表。 */
export const TREE_VIRTUALIZE_THRESHOLD = 500
/** 跨模块引用键前缀：`library:{file_id}`（design §9.0）。 */
export const RESOURCE_KEY_PREFIX = 'library:'

/** 读工具名单（class `read`、silent、`CORE_UNGATED`）。 */
export const GATEWAY_LIBRARY_READ_TOOL_NAMES = [
  'library_list',
  'library_read',
  'library_search',
] as const
/** 写工具名单（class `domain_write`、edit tier）。 */
export const GATEWAY_LIBRARY_WRITE_TOOL_NAMES = [
  'library_append',
  'library_write',
  'library_move',
  'library_delete',
] as const
