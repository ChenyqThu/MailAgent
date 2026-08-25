"""Canonical Matter domain vocabulary and pure validation helpers."""

from __future__ import annotations

from enum import StrEnum
from typing import Iterable, TypeAlias
import uuid


class MatterStatus(StrEnum):
    INBOX = "inbox"
    PLANNED = "planned"
    ACTIVE = "active"
    WAITING = "waiting"
    BLOCKED = "blocked"
    MONITORING = "monitoring"
    DONE = "done"
    CANCELED = "canceled"


class MatterHealth(StrEnum):
    UNKNOWN = "unknown"
    ON_TRACK = "on_track"
    AT_RISK = "at_risk"
    OFF_TRACK = "off_track"


class MatterPriority(StrEnum):
    P0 = "p0"
    P1 = "p1"
    P2 = "p2"
    P3 = "p3"


class MatterItemKind(StrEnum):
    ACTION = "action"
    MILESTONE = "milestone"
    DECISION = "decision"
    BLOCKER = "blocker"
    QUESTION = "question"
    NOTE = "note"


class MatterItemStatus(StrEnum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING = "waiting"
    BLOCKED = "blocked"
    DONE = "done"
    CANCELED = "canceled"


class MatterStakeholderTier(StrEnum):
    """干系人在**这件事**里的重要度（v60）。

    只有两档，有意的：三档以上会让 owner 每次都要想「这算重要还是一般」，而这个字段
    唯一的消费点是「非核心默认折叠」—— 折叠只需要一条线。

    🔴 与 `sort_order` 是**两个独立维度**：tier 决定分到哪一组，`sort_order` 决定组内
    先后。合成一个「优先级数字」会让「把人从核心拖到非核心」和「在核心组里往上挪一位」
    变成同一个操作。

    🔴 这是**在这件事里**的重要度，不是人的全局属性 —— 同一个人在别的事项里可能是路人，
    所以它长在 `matter_stakeholder` 而不是通讯录 `contact`。
    """

    CORE = "core"
    NORMAL = "normal"


class MatterResourceKind(StrEnum):
    EMAIL = "email"
    THREAD = "thread"
    EVENT = "event"
    DOC = "doc"
    FILE = "file"
    URL = "url"


class MatterRelationType(StrEnum):
    RELATED_TO = "related_to"
    DEPENDS_ON = "depends_on"
    BLOCKS = "blocks"
    FOLLOW_UP_OF = "follow_up_of"
    SUPERSEDES = "supersedes"


class MatterAttentionKind(StrEnum):
    WAIT_OVERDUE = "wait_overdue"
    ACTION_OVERDUE = "action_overdue"
    DEADLINE_NEAR = "deadline_near"
    HEALTH_DOWN = "health_down"
    NEEDS_REVIEW = "needs_review"
    RUN_FAILED = "run_failed"
    CONTEXT_GAP = "context_gap"


class MatterAttentionState(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"
    SNOOZED = "snoozed"
    DISMISSED = "dismissed"


class MatterAttentionSeverity(StrEnum):
    INFO = "info"
    WARN = "warn"
    CRITICAL = "critical"


class MatterProgressKind(StrEnum):
    """curated 进展条目的叙事类型（task 08-25）。

    🔴 与 `MatterItemKind` 的 `milestone` / `decision` 是**两回事**，同名不同物：
    item 是**工作对象**（可勾、可改状态、可指派），progress 是**叙事节点**（发生过的一件事，
    写给未来读者看）。一个重要决议可以既是 item 也值一条 progress —— 别互相复制。

    图标 / 色调是**表现层词汇，只活在 TS**（`matterVocab.ts`）；Python 一个字都不存样式。
    """

    #: 目标设定 / 修订。
    GOAL = "goal"
    #: 里程碑达成。
    MILESTONE = "milestone"
    #: 关键进展（默认档：回邮 / 推进 / 交付）。
    PROGRESS = "progress"
    #: 关键信号 / 风险。
    SIGNAL = "signal"
    #: 决议确定。
    DECISION = "decision"


class MatterChangeKind(StrEnum):
    FACT = "fact"
    INFERENCE = "inference"
    FIELD = "field"
    ACTION = "action"
    RESOURCE = "resource"
    #: 跟进 run 提案里的「记一条进展」（task 08-25）。跟进 run 拿不到进展写工具（红线），
    #: 它对进展的维护**只有**提案这一条通道，owner 接受时才落成 `matter_progress` 行。
    PROGRESS = "progress"


class MatterRunStatus(StrEnum):
    OK = "ok"
    NOOP = "noop"
    WARN = "warn"
    FAIL = "fail"


class MatterRunTrigger(StrEnum):
    MANUAL = "manual"
    SCHEDULE = "schedule"
    EVENT = "event"
    CONDITION = "condition"


class MatterTagColor(StrEnum):
    """标签色，取值是既有主题 token 名 —— 不新增颜色（P6-B D4）。"""

    ACCENT = "--c-accent"
    INFO = "--c-info"
    OK = "--c-ok"
    WARN = "--c-warn"
    CRIT = "--c-crit"
    AI = "--c-ai"


class MatterTagShape(StrEnum):
    """标签形状。与颜色是两个独立维度：同色可靠形状区分，同形可靠颜色区分。"""

    CIRCLE = "circle"
    RING = "ring"
    SQUARE = "square"
    DIAMOND = "diamond"
    BAR = "bar"


class MatterAccessPolicy(StrEnum):
    ALLOWED = "allowed"
    METADATA_ONLY = "metadata_only"
    EXCLUDED = "excluded"


class MatterUpdateReviewStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class MatterActorKind(StrEnum):
    USER = "user"
    AGENT = "agent"
    SYSTEM = "system"


class MatterResourceSubscriptionState(StrEnum):
    NONE = "none"
    ACTIVE = "active"
    PAUSED = "paused"


class MatterResourceSummarySource(StrEnum):
    """资料摘要（`resource.sum`）的来源（v56，设计稿 H3§6）。

    - ``mail``：沿用邮件侧已有的 AI 摘要（`llm_processing.labels_json.$.ai_summary`），
      **不重新调用模型** —— 邮件类资料没有 excerpt（只有 URL 类写 `cached_excerpt`），
      在「摘要只允许来自缓存摘录与元数据、不得编造」的约束下这是邮件摘要唯一可行来源。
    - ``agent``：跟进 Agent 生成（发现资料的提案阶段带入，批 M6 接线）。
    - 无摘要 = 三列全 NULL（空态），不存在第三个来源值。
    """

    MAIL = "mail"
    AGENT = "agent"


class MatterSuggestionBulkAction(StrEnum):
    """批量处置资料建议的两个动作（0812 dogfood：Agent 一轮挂十几份，逐条点会连着推进
    十几次版本号，中间任何一次错位就触发冲突）。逐条口保持不变，这是整批口。"""

    CONFIRM = "confirm"
    REJECT = "reject"


class MatterSuggestionBulkSkipReason(StrEnum):
    """整批里**没做**的那些条各自的原因 —— 混成一个数字正是「不知道到底成了几条」的病根。"""

    #: 同一个 idempotency_key 已经处置过这一条（重放）。
    ALREADY_APPLIED = "already_applied"
    #: 这条已经是确认态：confirm 无事可做，reject 也不允许（与逐条口同判据）。
    ALREADY_CONFIRMED = "already_confirmed"
    #: 资料不存在 / 不属于本事项 / link 已软删。
    NOT_LINKED = "not_linked"


EnumValues: TypeAlias = type[StrEnum] | Iterable[str]


def _values(enum_or_values: EnumValues) -> tuple[str, ...]:
    if isinstance(enum_or_values, type) and issubclass(enum_or_values, StrEnum):
        return tuple(member.value for member in enum_or_values)
    return tuple(str(value) for value in enum_or_values)


MATTER_STATUSES = _values(MatterStatus)
MATTER_HEALTH_VALUES = _values(MatterHealth)
MATTER_PRIORITIES = _values(MatterPriority)
MATTER_ITEM_KINDS = _values(MatterItemKind)
MATTER_ITEM_STATUSES = _values(MatterItemStatus)
MATTER_PROGRESS_KINDS = _values(MatterProgressKind)
#: 进展主句 / 正文的长度护栏。主句与 item 标题同量级（一句话）；正文比 item 描述宽一档 ——
#: 它承载的是「发生了什么」的完整叙述，被截断的进展等于把脉络讲一半。
MATTER_PROGRESS_TITLE_MAX_CHARS = 500
MATTER_PROGRESS_BODY_MAX_CHARS = 4000
#: 一条进展最多挂几条证据链引用。存在的意义与 `MATTER_SUGGESTION_BULK_MAX` 同源：挡住
#: 构造出来的超长数组，不是业务语义（一条进展引用十来份证据已经极端）。
MATTER_PROGRESS_MAX_REFS = 20
MATTER_STAKEHOLDER_TIERS = _values(MatterStakeholderTier)
#: 一次批量重排最多带多少行。一个事项的干系人上百已经极端；上限存在的意义是挡住
#: 构造出来的超长列表把单个事务撑爆（同 `MATTER_SUGGESTION_BULK_MAX` 的理由）。
#: 🔴 单源：REST schema（`src/api/schemas/matters.py`）import 它，不要在那边再写一遍数字。
MATTER_STAKEHOLDER_REORDER_MAX = 200
#: 新建干系人的默认档。🔴 拿不准一律 `normal` —— 核心组是给 owner 一眼扫的短名单，
#: 默认进核心会让它当场失去意义。
MATTER_STAKEHOLDER_DEFAULT_TIER = MatterStakeholderTier.NORMAL
MATTER_RESOURCE_KINDS = _values(MatterResourceKind)
MATTER_RELATION_TYPES = _values(MatterRelationType)
MATTER_ATTENTION_KINDS = _values(MatterAttentionKind)
MATTER_ATTENTION_STATES = _values(MatterAttentionState)
MATTER_ATTENTION_SEVERITIES = _values(MatterAttentionSeverity)
MATTER_CHANGE_KINDS = _values(MatterChangeKind)
MATTER_RUN_STATUSES = _values(MatterRunStatus)
MATTER_RUN_TRIGGERS = _values(MatterRunTrigger)
MATTER_ACCESS_POLICIES = _values(MatterAccessPolicy)
MATTER_UPDATE_REVIEW_STATUSES = _values(MatterUpdateReviewStatus)
MATTER_ACTOR_KINDS = _values(MatterActorKind)
MATTER_RESOURCE_SUBSCRIPTION_STATES = _values(MatterResourceSubscriptionState)
MATTER_RESOURCE_SUMMARY_SOURCES = _values(MatterResourceSummarySource)
#: `resource.sum` 的长度护栏。邮件侧 ai_summary 单字段截 3500（llm store `_truncate_long_fields`），
#: 设计语义是「一到三句」—— 2000 足够容纳并留出多语言余量；超长一律尾截不报错（摘要是
#: 增强信息，不该因为长了一截把关联事务掀掉）。
MATTER_RESOURCE_SUMMARY_MAX_CHARS = 2000
MATTER_SUGGESTION_BULK_ACTIONS = _values(MatterSuggestionBulkAction)
MATTER_SUGGESTION_BULK_SKIP_REASONS = _values(MatterSuggestionBulkSkipReason)
#: 一次批量处置的资料建议上限。取 discovery 单轮候选上限（50）的 4 倍 —— 界面上的
#: 「全部确认」只可能对着当前列表里的建议按，比一轮 discovery 多几轮积压也够用；上限
#: 存在的意义是挡住构造出来的超长 id 列表把单个事务撑爆。
#: 🔴 单源：REST schema（`src/api/schemas/matters.py`）import 它，不要在那边再写一遍 200。
MATTER_SUGGESTION_BULK_MAX = 200
MATTER_TAG_COLORS = _values(MatterTagColor)
MATTER_TAG_SHAPES = _values(MatterTagShape)
BUILTIN_MATTER_TYPES = ("客户交付", "商务", "售前", "问题", "内部", "产品")
#: FTS 投影的字段名（`matched_fields` 的值域，前端 `MATTER_SEARCH_FIELDS` 手抄同一份）。
#: 🔴 这里的 `description` **不是** matter 行的列名（v61 已拆成 background + goal），而是
#: 检索投影里「背景 + 目标」合成的那个文本桶 —— 改名要重建 fts5 虚表并打断这层对外契约，
#: 有意不改。投影单源 `repository.refresh_search_projection`。
MATTER_SEARCH_FIELDS = (
    "title",
    "description",
    "current_summary",
    "status",
    "items",
    "stakeholders",
    "notes",
)
MATTER_PERSON_NS = uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")

MAX_TAGS = 20
MAX_TAG_LENGTH = 64

# `matter.tags_json` 里出现、但 `matter_tag` 定义表里没有的名字（存量数据、或别处
# 直接 patch 进来的）按这两个默认值渲染 —— 定义表缺行不让标签变成孤儿（D4）。
MATTER_TAG_DEFAULT_COLOR = MatterTagColor.ACCENT
MATTER_TAG_DEFAULT_SHAPE = MatterTagShape.CIRCLE

# 完成标志（goal_checks_json）的护栏，量级与 tags 对齐。
MAX_GOAL_CHECKS = 20
MAX_GOAL_CHECK_LENGTH = 200


def format_public_id(seq: int) -> str:
    if seq < 1:
        raise ValueError("Matter sequence must be positive")
    return f"MAT-{seq:04d}"


def person_key_for_email(email: str | None) -> str:
    normalized = str(email or "").strip().lower()
    if normalized:
        return str(uuid.uuid5(MATTER_PERSON_NS, normalized))
    return str(uuid.uuid4())


def normalize_tags(tags: Iterable[str] | None) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags or ():
        tag = str(raw_tag).strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_LENGTH:
            raise ValueError(f"tag exceeds {MAX_TAG_LENGTH} characters")
        if tag not in seen:
            seen.add(tag)
            normalized.append(tag)
        if len(normalized) > MAX_TAGS:
            raise ValueError(f"at most {MAX_TAGS} tags are allowed")
    return tuple(normalized)


def normalize_goal_checks(entries: Iterable[object] | None) -> tuple[dict[str, object], ...]:
    """完成标志清单归一化：``[{"t": str, "done": bool}]``（D5）。

    空文本行直接丢弃（前端加一行再删文字的中间态不该落库）；其余非法形状一律
    ``ValueError`` —— 这个字段会渲染成可勾选清单，静默吞掉坏数据会让用户以为存上了。
    """
    normalized: list[dict[str, object]] = []
    for raw in entries or ():
        if not isinstance(raw, dict):
            raise ValueError("goal check must be an object")
        text = str(raw.get("t", "")).strip()
        if not text:
            continue
        if len(text) > MAX_GOAL_CHECK_LENGTH:
            raise ValueError(f"goal check exceeds {MAX_GOAL_CHECK_LENGTH} characters")
        normalized.append({"t": text, "done": bool(raw.get("done", False))})
        if len(normalized) > MAX_GOAL_CHECKS:
            raise ValueError(f"at most {MAX_GOAL_CHECKS} goal checks are allowed")
    return tuple(normalized)


def normalize_progress_refs(refs: Iterable[object] | None) -> tuple[dict[str, object], ...]:
    """进展条目的证据链归一（task 08-25）：``[{"type": str, ...}]``。

    🔴 **有意宽松**：只校验「是一组对象、条数有上限、`type` 是非空字符串」。设计里列的三种
    形状（``email`` / ``resource`` / ``url``）各带各的键，把它们写死在这里就是第二处契约 ——
    前端加一种引用形态要改两边，而漏改的表现是「Agent 写了但存不进去」。渲染侧本来就得对
    认不出的形态兜底（存量行、未来形态），所以这里不做形状裁决。

    条数超限 / 条目不是对象 / 缺 ``type`` 一律 ``ValueError``：证据链是给人点开验证用的，
    静默吞掉坏引用会让「有证据」变成一句谎。
    """
    normalized: list[dict[str, object]] = []
    for raw in refs or ():
        if not isinstance(raw, dict):
            raise ValueError("progress ref must be an object")
        ref_type = str(raw.get("type", "")).strip()
        if not ref_type:
            raise ValueError("progress ref requires a non-empty type")
        normalized.append({**raw, "type": ref_type})
        if len(normalized) > MATTER_PROGRESS_MAX_REFS:
            raise ValueError(f"at most {MATTER_PROGRESS_MAX_REFS} progress refs are allowed")
    return tuple(normalized)


def sql_check_clause(enum_or_values: EnumValues) -> str:
    values = _values(enum_or_values)
    if not values:
        raise ValueError("SQL CHECK values cannot be empty")
    quoted = ", ".join("'" + value.replace("'", "''") + "'" for value in values)
    return f"IN ({quoted})"
