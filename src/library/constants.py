"""资料库（library）的值域事实 —— Python 侧**零依赖叶子**（只 stdlib typing，无 import 副作用）。

与 TS 侧 ``frontend/src/shared/libraryConstants.ts`` 逐字同名同值（同名常量 / 同成员 / 同顺序 /
同数值），闸 ``tests/config/test_library_constants_parity.py``（AST + 正则抽取两侧对账，
**抽不到任一侧必红**）。加成员必须两侧同批改。

serve-api 的校验、存储层的 CHECK 词表、路径 jail 的拒收后缀都引这里，**不手抄字符串**。
"""

from __future__ import annotations

from typing import Tuple

#: 库根下的内置顶层文件夹（磁盘上是英文 slug，UI 走 i18n）。
TOP_LEVEL_SLUGS: Tuple[str, ...] = (
    "mail-attachments",
    "chat-attachments",
    "agent-docs",
    "my-docs",
    ".trash",
)

#: 邮件附件投影根 —— 不在磁盘上，只读。
PROJECTION_SLUG: str = "mail-attachments"
#: 软删根。
TRASH_SLUG: str = ".trash"
#: agent 无人值守免卡的唯一目标前缀（design §5.3 的 B 通道）。
AGENT_DOCS_SLUG: str = "agent-docs"

#: 文件类别（复用 anydoc lane 语义；``placeholder`` = iCloud 未下载的 .icloud 占位）。
KINDS: Tuple[str, ...] = (
    "markdown",
    "html",
    "pdf",
    "office",
    "image",
    "text",
    "placeholder",
    "other",
)

#: 抽取状态 —— 镜像附件表 ``email_attachment_text.status`` 词表。
TEXT_STATUS: Tuple[str, ...] = ("pending", "extracted", "failed", "unsupported")

#: 文件行状态（``missing`` 不删行 —— 跨模块引用永不悬空）。
FILE_STATUS: Tuple[str, ...] = ("present", "missing", "trashed")

#: 文件来源。``derived`` = 「另存解析版」生成的 markdown。
SOURCES: Tuple[str, ...] = ("user", "mail", "chat", "agent", "derived")

#: 挂载根的读写档（用户侧总闸）。
MOUNT_MODES: Tuple[str, ...] = ("ro", "rw")

#: 挂载根状态：``unavailable`` = 卷拔了 / 目录移走；``unmounted`` = 用户卸载（行不删）。
MOUNT_STATUS: Tuple[str, ...] = ("ok", "unavailable", "unmounted")

#: agent 写面的扩展名白名单（人上传不受此限）。
WRITE_EXT_ALLOWLIST: Tuple[str, ...] = (".md", ".markdown", ".html", ".txt", ".csv", ".json")

#: 挂载根内额外拒读写的后缀 / 目录（exec 地板之外再加一层）。
MOUNT_DENY_SUFFIXES: Tuple[str, ...] = (".env", ".pem", ".key", ".db")
MOUNT_DENY_DIRS: Tuple[str, ...] = (".git",)

#: 文本写入上限（agent / 编辑器走这条）。
TEXT_WRITE_MAX_BYTES: int = 1024 * 1024
#: 上传 / 入库单文件上限 —— 沿用 ``attachment.py::_CONVERT_MAX_BYTES``。
UPLOAD_MAX_BYTES: int = 15 * 1024 * 1024
#: 抽取文本上限 —— 沿用 ``attachment_text.ATTACHMENT_TEXT_MAX_BYTES``。
EXTRACT_MAX_BYTES: int = 256 * 1024
#: ``library_read`` 返回上限（工具层，与抽取上限是两层）。
READ_TOOL_MAX_CHARS: int = 12000
READ_TOOL_MAX_BYTES: int = 2 * 1024 * 1024
#: 历史保留：每文件条数 + 全库快照总量。
HISTORY_MAX_PER_FILE: int = 50
HISTORY_MAX_TOTAL_BYTES: int = 20 * 1024 * 1024
#: ``.trash`` 保留天数。
TRASH_TTL_DAYS: int = 30
#: 文件夹分页大小。
FOLDER_PAGE_SIZE: int = 200
#: 挂载文件数警戒线。
MOUNT_MAX_FILES: int = 20000
#: 单文件夹超过它就放弃 layoutId pill、退化成虚拟列表。
TREE_VIRTUALIZE_THRESHOLD: int = 500
#: 跨模块引用键前缀：``library:{file_id}``（design §9.0）。
RESOURCE_KEY_PREFIX: str = "library:"

#: 读工具名单（class ``read``、silent、``CORE_UNGATED``）。
GATEWAY_LIBRARY_READ_TOOL_NAMES: Tuple[str, ...] = (
    "library_list",
    "library_read",
    "library_search",
)
#: 写工具名单（class ``domain_write``、edit tier）。
GATEWAY_LIBRARY_WRITE_TOOL_NAMES: Tuple[str, ...] = (
    "library_append",
    "library_write",
    "library_move",
    "library_delete",
)
