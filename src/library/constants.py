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

# ── 语义检索（P3-L1，design §9.1）────────────────────────────────────────────
# 权重不进 .app：设置页按需下载到 ``DATA_ROOT/library/embed_cache/``。
# 🔴 **没下载 = 纯 FTS**，模型在不在就是开关 —— 不加 ``MAILAGENT_*`` 灰度变量。

#: 权重仓库与文件（onnx-community 的 Qwen3-Embedding-0.6B ONNX 导出）。
EMBED_MODEL_REPO: str = "onnx-community/Qwen3-Embedding-0.6B-ONNX"
EMBED_MODEL_FILE: str = "onnx/model_int8.onnx"
#: ``library_chunk.model`` 的值。换模型 = 换这个 id，旧向量被查询的 ``WHERE model=?`` 自然排除。
EMBED_MODEL_ID: str = "qwen3-embedding-0.6b-int8"
#: 向量维度（int8 量化后 1 KB / 块）。
EMBED_DIM: int = 1024
#: 权重目录名（挂在库根下；库根的树 / 扫描只走 ROOT_WRITABLE_TOP，因此天然不被索引）。
EMBED_CACHE_DIRNAME: str = "embed_cache"
#: query 侧指令前缀的 task 描述（``Instruct: {task}\nQuery: {q}``）；**文档侧不带前缀**。
EMBED_QUERY_TASK: str = "Given a search query, retrieve relevant documents from the personal library"
#: 权重体积 —— 「下载语义模型（614 MB）」这句文案的单源。
EMBED_MODEL_APPROX_BYTES: int = 614 * 1024 * 1024

#: 切块：约 400 token 一块、15% 重叠（60 token）；比 CHUNK_MIN_TOKENS 还短的尾块并进上一块。
CHUNK_TARGET_TOKENS: int = 400
CHUNK_OVERLAP_TOKENS: int = 60
CHUNK_MIN_TOKENS: int = 24
#: 单文件块数上限（256 KB 抽取上限下的自然天花板，外加防病态文本）。
CHUNK_MAX_PER_FILE: int = 400
#: 模型上下文里给一块留的 token 上限（前缀 + 正文；超出由 tokenizer 截断）。
CHUNK_MAX_MODEL_TOKENS: int = 640

#: 混合检索：两条 lane 各取 top-N 再 RRF。
SEARCH_LANE_TOP_K: int = 50
#: 🔴 与 ``src/repository/email_repository.py::_RRF_K`` 同值（那边是 60.0 float）。
SEARCH_RRF_K: int = 60
#: 向量腿的**噪声地板**（余弦，向量已 L2 归一）。**没有地板 = 任何 query 都恒返满额**
#: （点积排序没有「不相关」这个概念），搜 `asdfgh` 也会出一屏结果。
#:
#: 🔴 它是噪声地板，**不是相关度阈值** —— 2026-09-03 用真权重实测过，绝对余弦分不开信号与噪声：
#:
#:     asdfgh 0.107/0.232 · zxcvbnm qwerty 0.105/0.183 · ％＄＃＠ 0.220/0.192   ← 乱码，上限 0.232
#:     法务 0.148 · 续约条款 0.290 · 渠道投放 0.579                              ← 文档里原样有的词
#:     上季度花了多少钱 0.512（零关键词重叠但相关） · 狗 0.545                     ← 语义命中
#:     今天天气怎么样 0.397                                                   ← 完全无关却比 0.29 高
#:
#: 真命中区间（0.148–0.579）与噪声区间（0.105–0.397）**重叠**，所以任何绝对阈值都同时误杀误放。
#: 取 0.25 的理由只有一条：它压在实测乱码上限（0.232）之上、压在向量腿真正负责的最低真命中
#: （0.290「续约条款」）之下。旧值 0.3 恰好卡在那条真命中上 —— 文档里**原样出现**的词组被挡掉。
#: 落在地板下的短词（如 0.148 的「法务」）本就归关键词腿：CJK 两字走 LIKE，实测能命中。
#: ⚠️ 校准集只有 2 份文档，样本很薄；真实库跑起来后应按同一方法重测。
VECTOR_MIN_SCORE: float = 0.25
#: 暴力点积的块数警戒线；超过它再考虑 faiss（design §9.1 「10 万块以内不上 faiss」）。
VECTOR_BRUTE_FORCE_MAX_CHUNKS: int = 100000

#: 后台低速队列：一批几个文件 + 批间隔秒数（低速 = 不跟前台抢 CPU）。
EMBED_BATCH_FILES: int = 4
EMBED_BATCH_SLEEP_SEC: int = 1

#: 检索模式（``GET /library/search`` 的 ``mode`` 入参）。
SEARCH_MODES: Tuple[str, ...] = ("fts", "hybrid")
#: 命中来自哪条 lane（响应体 ``lane``）。
#: 🔴 与 P1 的 ``match: 'filename'|'text'`` **不是一回事**，两个字段各自独立。
SEARCH_LANES: Tuple[str, ...] = ("fts", "vec", "both")
