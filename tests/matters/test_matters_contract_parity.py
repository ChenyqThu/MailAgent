from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from src.api.routers import chat
from src.api.routers.matters import MatterPatchWithScheduleRequest
from src.api.schemas.matters import MatterCreateRequest
from src.mail import sync_store
from src.matters import models, service, triggers


ENUMS = (
    models.MatterStatus,
    models.MatterHealth,
    models.MatterPriority,
    models.MatterItemKind,
    models.MatterItemStatus,
    models.MatterAttentionKind,
    models.MatterAttentionState,
    models.MatterAttentionSeverity,
    models.MatterUpdateReviewStatus,
    models.MatterActorKind,
    models.MatterResourceSummarySource,
)

ROOT = Path(__file__).resolve().parents[2]
MATTER_TS = ROOT / "frontend/src/shared/api/types/matter.ts"
#: effort 档位的 canonical 源（不在 matter.ts —— 它是 chat/gateway 共用的零依赖叶子）。
EFFORT_TIERS_TS = ROOT / "frontend/src/shared/modelCatalog/effortTiers.ts"
GATEWAY_SCHEMAS_TS = ROOT / "frontend/src/ai-gateway/tools/schemas.ts"

TS_ARRAYS = {
    "MATTER_STATUSES": models.MATTER_STATUSES,
    "MATTER_HEALTH_VALUES": models.MATTER_HEALTH_VALUES,
    "MATTER_PRIORITIES": models.MATTER_PRIORITIES,
    "MATTER_ITEM_KINDS": models.MATTER_ITEM_KINDS,
    "MATTER_ITEM_STATUSES": models.MATTER_ITEM_STATUSES,
    "MATTER_RESOURCE_KINDS": models.MATTER_RESOURCE_KINDS,
    "MATTER_RELATION_TYPES": models.MATTER_RELATION_TYPES,
    "MATTER_ATTENTION_KINDS": models.MATTER_ATTENTION_KINDS,
    "MATTER_ATTENTION_STATES": models.MATTER_ATTENTION_STATES,
    "MATTER_ATTENTION_SEVERITIES": models.MATTER_ATTENTION_SEVERITIES,
    "MATTER_CHANGE_KINDS": models.MATTER_CHANGE_KINDS,
    "MATTER_RUN_STATUSES": models.MATTER_RUN_STATUSES,
    "MATTER_RUN_TRIGGERS": models.MATTER_RUN_TRIGGERS,
    "MATTER_ACCESS_POLICIES": models.MATTER_ACCESS_POLICIES,
    "MATTER_UPDATE_REVIEW_STATUSES": models.MATTER_UPDATE_REVIEW_STATUSES,
    "MATTER_ACTOR_KINDS": models.MATTER_ACTOR_KINDS,
    "MATTER_RESOURCE_SUBSCRIPTION_STATES": models.MATTER_RESOURCE_SUBSCRIPTION_STATES,
    "MATTER_RESOURCE_SUMMARY_SOURCES": models.MATTER_RESOURCE_SUMMARY_SOURCES,
    "MATTER_SUGGESTION_BULK_ACTIONS": models.MATTER_SUGGESTION_BULK_ACTIONS,
    "MATTER_SUGGESTION_BULK_SKIP_REASONS": models.MATTER_SUGGESTION_BULK_SKIP_REASONS,
    "MATTER_EVENT_TRIGGER_TYPES": triggers.EVENT_TRIGGER_TYPES,
    "MATTER_CONDITION_TRIGGER_TYPES": triggers.CONDITION_TRIGGER_TYPES,
    "MATTER_RUN_ACTIONS": triggers.RUN_ACTIONS,
    "MATTER_DEFAULT_RUN_ACTIONS": triggers.DEFAULT_RUN_ACTIONS,
    "MATTER_TAG_COLORS": models.MATTER_TAG_COLORS,
    "MATTER_TAG_SHAPES": models.MATTER_TAG_SHAPES,
    "MATTER_SEARCH_FIELDS": models.MATTER_SEARCH_FIELDS,
    "BUILTIN_MATTER_TYPES": models.BUILTIN_MATTER_TYPES,
}


def ts_const_string_array(
    path: Path, name: str, *, src: str | None = None
) -> tuple[str, ...]:
    source = path.read_text(encoding="utf-8") if src is None else src
    match = re.search(
        rf"export\s+const\s+{re.escape(name)}\s*=\s*\[(?P<body>.*?)\]\s+as\s+const",
        source,
        re.DOTALL,
    )
    assert match is not None, f"{path}: 找不到 export const {name} = [...] as const"
    body = match.group("body")
    values = tuple(re.findall(r"(['\"])(.*?)\1", body))
    extracted = tuple(value for _, value in values)
    scrubbed = re.sub(r"(['\"])(.*?)\1", "", body)
    scrubbed = re.sub(r"[\s,]", "", scrubbed)
    assert not scrubbed, f"{path}: {name} 含非字符串字面量或部分抽取: {scrubbed!r}"
    assert extracted, f"{path}: {name} 抽取结果为空"
    return extracted


def test_migration_ddl_uses_canonical_sql_check_helper():
    source = inspect.getsource(sync_store)
    assert "sql_check_clause(MatterStatus)" in source
    assert "sql_check_clause(MatterItemKind)" in source
    assert "sql_check_clause(MatterUpdateReviewStatus)" in source


def test_python_values_equal_sql_check_value_sets():
    ddl = "\n".join(sync_store.MATTER_TABLE_DDLS)
    for enum_type in ENUMS:
        values = tuple(member.value for member in enum_type)
        clause = models.sql_check_clause(enum_type)
        assert clause in ddl, (
            f"DDL missing canonical CHECK for {enum_type.__name__}: {values}"
        )


def test_typescript_enum_mirrors_equal_python_canonical_values():
    for name, canonical in TS_ARRAYS.items():
        extracted = ts_const_string_array(MATTER_TS, name)
        assert len(extracted) == len(canonical), (
            f"{name} 成员数漂移: TS={len(extracted)} Python={len(canonical)}"
        )
        assert extracted == canonical, f"{name} 漂移: TS={extracted!r} Python={canonical!r}"


def test_effort_tier_value_set_matches_the_typescript_canonical_ladder():
    """事项级 effort 覆盖的值域（0813 轮 3 #10）。

    canonical 源是 TS 的 `EFFORT_TIERS`（wire 形状由 gateway `thinking.ts::effortCallOptions`
    按协议产出，Python 只把 owner 选的档位原样投进 spec）。两边都手抄一份**顺序也要一致** ——
    档位是有序阶梯，顺序漂了「向下取最近可选档」就选错档。
    """
    extracted = ts_const_string_array(EFFORT_TIERS_TS, "EFFORT_TIERS")
    assert extracted == triggers.MATTER_AGENT_EFFORT_TIERS, (
        f"effort 档位漂移: TS={extracted!r} Python={triggers.MATTER_AGENT_EFFORT_TIERS!r}"
    )


def test_typescript_extractor_failure_and_partial_extraction_are_red():
    with pytest.raises(AssertionError, match="找不到"):
        ts_const_string_array(MATTER_TS, "MATTER_STATUSES", src="export const X = [] as const")
    with pytest.raises(AssertionError, match="抽取结果为空"):
        ts_const_string_array(
            MATTER_TS, "MATTER_STATUSES", src="export const MATTER_STATUSES = [] as const"
        )


def ts_interface_field_names(
    path: Path, name: str, *, src: str | None = None
) -> tuple[str, ...]:
    """抽取 ``export interface <name> { … }`` 的**顶层**字段名。

    与 ``ts_const_string_array`` 同一条纪律：抽取失败必须红（找不到接口 / 花括号不配平 /
    抽出空集都断言失败）—— "抽不到" 绝不能表现成 "没有漂移"。嵌套对象字面量里的字段按
    括号深度屏蔽掉，避免部分抽取把内层字段当成顶层字段。
    """
    source = path.read_text(encoding="utf-8") if src is None else src
    match = re.search(rf"export\s+interface\s+{re.escape(name)}\s*\{{", source)
    assert match is not None, f"{path}: 找不到 export interface {name} {{"
    depth = 1
    top: list[str] = []
    for char in source[match.end() :]:
        if char == "{":
            depth += 1
            top.append(" ")
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                break
            top.append(" ")
            continue
        top.append(char if depth == 1 else " ")
    else:
        raise AssertionError(f"{path}: interface {name} 花括号未配平（抽取不完整）")
    body = re.sub(r"/\*.*?\*/", " ", "".join(top), flags=re.DOTALL)
    body = re.sub(r"//[^\n]*", " ", body)
    names = tuple(re.findall(r"(?:^|[;,\n])\s*(\w+)\s*\??\s*:", body, re.M))
    assert names, f"{path}: interface {name} 抽取结果为空"
    return names


# ── PATCH 白名单三层一致性闸（0813 dogfood 轮 3）────────────────────────────────
# 病根：同一份「一个 Matter 允许 PATCH 哪些字段」被抄了三处 —— service 的三个消费集合、
# REST DTO、前端 TS 输入类型。中间那层漏了 priority / goal_checks，于是详情页改优先级、
# 存完成标志、gateway matter_update 带 priority 一律 422 extra_forbidden，而 typecheck 与
# 任何单侧单测都恒绿（TS 抄的是 service 的形状，不是 DTO 的）。
# 🔴 两条腿都从**真实对象**抽取（pydantic model_fields / service 常量 / TS 源码），绝不在
# 这里手抄第四份期望清单 —— 那只会把漏抄推迟到下一次。
PATCH_ENVELOPE_FIELDS = {"mutation"}


def matter_patch_dto_fields() -> set[str]:
    """REST 真正收下的 patch 字段 = 路由 body 模型（含 schedule_json 的子类）减信封。"""
    return set(MatterPatchWithScheduleRequest.model_fields) - PATCH_ENVELOPE_FIELDS


def matter_patch_service_fields() -> set[str]:
    """service.patch_matter 会消费的字段（它自己的 unknown 判据就是这三个集合的并）。"""
    return (
        service.DIRECT_PATCH_FIELDS
        | service.MANUAL_UPDATE_FIELDS
        | service.BINDING_PATCH_FIELDS
    )


def test_matter_patch_dto_accepts_exactly_the_fields_the_service_consumes():
    dto = matter_patch_dto_fields()
    consumed = matter_patch_service_fields()
    assert dto == consumed, (
        "PATCH 白名单劈叉："
        f"DTO 缺 {sorted(consumed - dto)}（前端/gateway 发这些字段必 422 extra_forbidden）；"
        f"DTO 多 {sorted(dto - consumed)}（收下了但 service 会 E_INVALID_ARG 拒）"
    )


def test_service_patch_guard_is_still_the_union_of_those_three_sets():
    # 上一条闸的前提。判据换了写法而闸没跟上 = 闸恒绿却什么都不保。
    source = " ".join(inspect.getsource(service.MatterService.patch_matter).split())
    assert (
        "set(patch) - DIRECT_PATCH_FIELDS - MANUAL_UPDATE_FIELDS - BINDING_PATCH_FIELDS"
        in source
    ), "patch_matter 的 unknown 判据变了，PATCH 白名单闸的取并方式需要同步"


# ── CREATE 白名单一致性闸（0813 轮 3 O2，照 PATCH 闸的样式）────────────────────────
# create 面加 goal_checks 时的同款风险：DTO（extra=forbid）漏一个字段，gateway matter_create
# 带上它就 422，而 TS/单侧测试恒绿。两条腿同样从真实对象抽取，不手抄第三份清单。


def matter_create_dto_fields() -> set[str]:
    """REST create 真正收下的字段 = body 模型减信封。"""
    return set(MatterCreateRequest.model_fields) - PATCH_ENVELOPE_FIELDS


def matter_create_service_reads() -> set[str]:
    """service.create_matter 从 data 里读的键（`data.get("x")` / `data["x"]` 两种写法都抽）。"""
    source = inspect.getsource(service.MatterService.create_matter)
    reads = set(re.findall(r'data(?:\.get\(|\[)\s*"(\w+)"', source))
    assert reads, "create_matter 的 data 读取抽取结果为空（判据写法变了？）"
    return reads


def test_matter_create_dto_accepts_exactly_the_fields_the_service_reads():
    dto = matter_create_dto_fields()
    consumed = matter_create_service_reads()
    assert dto == consumed, (
        "CREATE 白名单劈叉："
        f"DTO 缺 {sorted(consumed - dto)}（前端/gateway 发这些字段必 422 extra_forbidden）；"
        f"DTO 多 {sorted(dto - consumed)}（收下了但 service 静默丢弃 —— 假接口）"
    )


def test_typescript_matter_patch_input_mirrors_the_rest_dto():
    ts_fields = set(ts_interface_field_names(MATTER_TS, "MatterPatchInput"))
    dto = matter_patch_dto_fields()
    assert ts_fields == dto, (
        f"MatterPatchInput 与 REST DTO 漂移：TS 多 {sorted(ts_fields - dto)} / "
        f"TS 缺 {sorted(dto - ts_fields)}"
    )


def test_typescript_interface_extractor_failure_and_partial_extraction_are_red():
    with pytest.raises(AssertionError, match="找不到"):
        ts_interface_field_names(
            MATTER_TS, "MatterPatchInput", src="export interface Other { a?: string }"
        )
    with pytest.raises(AssertionError, match="抽取结果为空"):
        ts_interface_field_names(
            MATTER_TS, "MatterPatchInput", src="export interface MatterPatchInput { }"
        )
    with pytest.raises(AssertionError, match="未配平"):
        ts_interface_field_names(
            MATTER_TS, "MatterPatchInput", src="export interface MatterPatchInput { a?: string"
        )
    # 嵌套对象字面量的内层字段不算顶层字段（部分抽取的反面）。
    assert ts_interface_field_names(
        MATTER_TS,
        "MatterPatchInput",
        src="export interface MatterPatchInput {\n  a?: string\n  b?: { inner: number }\n}",
    ) == ("a", "b")


def test_gateway_matter_get_include_enum_covers_every_branch_the_service_serves():
    """matter_get 的 include 值域是 TS 手抄的 Python 分支名。缺一个值 = 那份数据在 gateway
    侧**结构性**取不到：0813 轮 3 的 enum 漏了 `updates`，而 matter_review_update 必填
    update_id 且这是唯一发号的读面 ⇒ 评审工具根本没法用，且两侧单测都绿。

    这里要求**相等**而不是包含：真要对模型藏起某个 include，就得显式地在这条闸上开口
    并写明理由，不能靠"忘了加"来实现。"""
    source = inspect.getsource(service.MatterService.get_matter)
    served = set(re.findall(r'if\s+"(\w+)"\s+in\s+include_set', source))
    assert served, "get_matter 的 include 分支抽取结果为空（判据写法变了？）"
    exposed = set(ts_const_string_array(GATEWAY_SCHEMAS_TS, "MATTER_GET_INCLUDES"))
    assert exposed == served, (
        f"matter_get include 值域漂移：TS 多 {sorted(exposed - served)} / "
        f"TS 缺 {sorted(served - exposed)}"
    )


def test_chat_config_projects_the_same_pydantic_matters_flag_as_the_router_gate():
    source = inspect.getsource(chat.chat_config)
    assert '"mattersEnabled": bool(getattr(cfg, "matters_enabled", False))' in source
    with pytest.raises(AssertionError, match="部分抽取"):
        ts_const_string_array(
            MATTER_TS,
            "MATTER_STATUSES",
            src="export const MATTER_STATUSES = ['inbox', SOME_VALUE] as const",
        )
