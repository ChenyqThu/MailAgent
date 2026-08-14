from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from src.api.routers import chat
from src.api.routers.matters import MatterPatchWithScheduleRequest
from src.api.schemas.matters import MatterCreateRequest, MatterProposalNewResource
from src.mail import sync_store
from src.matters import models, resource_proposal, service, triggers


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
GATEWAY_MATTER_TOOLS_TS = ROOT / "frontend/src/ai-gateway/tools/matters.ts"

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


# ── 「提案新建资料」形状的五层一致性闸（批 M6 / V3-28）──────────────────────────
# 病根形状与上面的 PATCH 闸同款，但后果更隐蔽：`matterProposalNewResource` 这一份 schema
# 被手抄了**五处**（gateway zod / 工具描述 / REST DTO / 域校验层归一 / 前端读类型），而
#   - REST DTO 是 `StrictModel`(extra=forbid) ⇒ zod 加了字段而 DTO 没加 = 每一条「发现资料」
#     的提案在边界上 **422**，propose 整个失败；
#   - 域校验层 `normalize_new_resource` 不在键集里的字段**静默丢弃** ⇒ DTO 收了它也照样丢；
#   - 而 zod / pydantic / TS 各自的单测与 typecheck **全绿**。
# 🔴 五条腿全部从**真实对象**取（zod 源码抽取 / pydantic model_fields / 跑一遍 normalize /
# TS interface 抽取 / 工具描述里那份给模型看的清单），这里不手抄第六份期望清单。


#: `/` 起头的是正则字面量还是除号，只看它前面那个有效字符（TS 里正则只出现在表达式起始位）。
_REGEX_START_PRECEDERS = ("", "\n", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";")


def _mask_ts_literals_and_comments(source: str) -> str:
    """把 TS 源码里的字符串 / 模板串 / 正则字面量 / 注释整段替换成空格（换行保留）。

    🔴 抽取器纪律里最毒的一种失败：`// summary: …` 注释掉的字段仍被正则抽到 ⇒ 闸恒绿，
    而模型侧那个字段已经没了。所以字段名抽取**必须**在这一步之后做。
    正则字面量也得屏蔽 —— zod 的 `provider` 用了 `/^[a-z][a-z0-9_-]{0,63}$/`，里面的
    `{0,63}` 会被花括号配平逻辑当成嵌套对象。
    """
    out: list[str] = []
    idx = 0
    length = len(source)
    prev_significant = ""

    def blank(chunk: str) -> None:
        out.append("".join("\n" if ch == "\n" else " " for ch in chunk))

    while idx < length:
        char = source[idx]
        pair = source[idx : idx + 2]
        if pair == "//":
            end = source.find("\n", idx)
            end = length if end == -1 else end
            blank(source[idx:end])
            idx = end
            continue
        if pair == "/*":
            end = source.find("*/", idx + 2)
            end = length if end == -1 else end + 2
            blank(source[idx:end])
            idx = end
            continue
        if char in "'\"`":
            end = idx + 1
            while end < length:
                if source[end] == "\\":
                    end += 2
                    continue
                if source[end] == char:
                    end += 1
                    break
                end += 1
            blank(source[idx:end])
            idx = end
            prev_significant = "x"
            continue
        # 正则字面量：只在「表达式起始位」才可能出现（否则那个 `/` 是除号）。
        if char == "/" and prev_significant in _REGEX_START_PRECEDERS:
            end = idx + 1
            in_class = False
            while end < length and source[end] != "\n":
                if source[end] == "\\":
                    end += 2
                    continue
                if source[end] == "[":
                    in_class = True
                elif source[end] == "]":
                    in_class = False
                elif source[end] == "/" and not in_class:
                    end += 1
                    break
                end += 1
            blank(source[idx:end])
            idx = end
            prev_significant = "x"
            continue
        out.append(char)
        if not char.isspace():
            prev_significant = char
        elif char == "\n":
            prev_significant = "\n"
        idx += 1
    return "".join(out)


def ts_zod_object_field_names(path: Path, name: str, *, src: str | None = None) -> tuple[str, ...]:
    """抽取 ``const <name> = z.object({ … })`` 的**顶层**字段名。

    与 ``ts_interface_field_names`` 同一条纪律：找不到 / 花括号不配平 / 抽出空集 / 丢了
    ``.strict()`` 一律断言失败 —— "抽不到" 绝不能表现成 "没有漂移"。
    🔴 锚点必须精确到 `const <name> = z…object({`：schemas.ts 里有几十个 `z.object({`，
    抓错一个就是在给另一份 schema 站岗（"同名结构不止一个" 那条实战坑）。
    """
    source = path.read_text(encoding="utf-8") if src is None else src
    masked = _mask_ts_literals_and_comments(source)
    match = re.search(
        rf"const\s+{re.escape(name)}\s*=\s*z\s*(?:\.\s*\w+\s*\([^()]*\)\s*)*\.\s*object\s*\(\s*\{{",
        masked,
    )
    assert match is not None, f"{path}: 找不到 const {name} = z.object({{"
    depth = 1
    top: list[str] = []
    end = match.end()
    for offset, char in enumerate(masked[match.end() :]):
        if char == "{":
            depth += 1
            top.append(" ")
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                end = match.end() + offset + 1
                break
            top.append(" ")
            continue
        top.append(char if depth == 1 else " ")
    else:
        raise AssertionError(f"{path}: {name} 花括号未配平（抽取不完整）")
    tail = masked[end : end + 80]
    assert ".strict()" in tail, (
        f"{path}: {name} 后面没有 .strict() —— 非严格 schema 会静默吃掉模型多写的字段，"
        "这条闸盯的正是「多一个键」的漂移"
    )
    names = tuple(re.findall(r"(?:^|[;,{\n])\s*(\w+)\s*\??\s*:", "".join(top), re.M))
    assert names, f"{path}: {name} 抽取结果为空"
    return names


def matters_tool_description_resource_fields(*, src: str | None = None) -> tuple[str, ...]:
    """模型真正读到的那份字段清单（matter_update_propose 的 description，第五份手抄）。

    它不是装饰：description 少列一个字段 ⇒ 模型不会用；多列一个 ⇒ 模型照着写、zod 当场拒。
    """
    source = (
        GATEWAY_MATTER_TOOLS_TS.read_text(encoding="utf-8") if src is None else src
    )
    anchor = source.find("carrying `resource`")
    assert anchor != -1, (
        f"{GATEWAY_MATTER_TOOLS_TS}: 找不到 matter_update_propose 描述里 "
        "「carrying `resource`」这个锚点（描述改写了？）"
    )
    match = re.search(r"\{([a-z_,\s]+)\}", source[anchor : anchor + 400])
    assert match is not None, f"{GATEWAY_MATTER_TOOLS_TS}: 锚点之后没有 {{字段清单}}"
    names = tuple(part.strip() for part in match.group(1).split(",") if part.strip())
    assert names, f"{GATEWAY_MATTER_TOOLS_TS}: resource 字段清单抽取结果为空"
    return names


def new_resource_normalized_keys() -> set[str]:
    """域校验层交出的键集 —— 跑一遍真函数，不正则抠它的 return 字面量。

    accept 侧读的是这份产物（propose 时回写进 ``changes_json``），所以它既是**输入**契约
    也是**输出**契约：键名一换，第二趟归一就静默丢字段。
    """
    normalized = resource_proposal.normalize_new_resource(
        {
            "provider": resource_proposal.WEB_PROVIDER,
            "kind": "url",
            "external_key": "https://example.test/doc",
            "title": "t",
            "canonical_url": "https://example.test/doc",
            "summary": "s",
        },
        allowed_providers=frozenset({resource_proposal.WEB_PROVIDER}),
    )
    assert normalized, "normalize_new_resource 交出空 dict（签名变了？）"
    return set(normalized)


def test_new_resource_proposal_shape_agrees_across_every_hand_copy():
    zod = set(ts_zod_object_field_names(GATEWAY_SCHEMAS_TS, "matterProposalNewResourceSchema"))
    dto = set(MatterProposalNewResource.model_fields)
    normalized = new_resource_normalized_keys()
    ts_type = set(ts_interface_field_names(MATTER_TS, "MatterProposalNewResource"))
    described = set(matters_tool_description_resource_fields())
    assert zod == dto, (
        "提案新建资料的形状劈叉："
        f"DTO 缺 {sorted(zod - dto)}（模型发了 → REST 边界 422 extra_forbidden，整条提案失败）；"
        f"DTO 多 {sorted(dto - zod)}（收下了但模型结构上发不出来 —— 假字段）"
    )
    assert zod == normalized, (
        "提案新建资料的形状劈叉："
        f"归一层缺 {sorted(zod - normalized)}（收到了但被**静默丢弃**，落库时字段凭空消失）；"
        f"归一层多 {sorted(normalized - zod)}（交出了模型给不了的键）"
    )
    assert zod == ts_type, (
        f"MatterProposalNewResource(TS) 与 gateway schema 漂移：TS 多 {sorted(ts_type - zod)} / "
        f"TS 缺 {sorted(zod - ts_type)}（审阅卡读不到该字段）"
    )
    assert zod == described, (
        f"工具描述里的字段清单漂移：描述多 {sorted(described - zod)}（模型照着写会被 zod 拒）/ "
        f"描述缺 {sorted(zod - described)}（模型不知道有这个字段，等于没落地）"
    )


def test_resource_summary_char_cap_is_one_number_on_both_sides():
    """摘要上限是第六份手抄的候选 —— 用常量而不是字面量，并在这里锁死数值。"""
    ts_source = MATTER_TS.read_text(encoding="utf-8")
    match = re.search(
        r"export\s+const\s+MATTER_RESOURCE_SUMMARY_MAX_CHARS\s*=\s*(\d+)", ts_source
    )
    assert match is not None, f"{MATTER_TS}: 找不到 MATTER_RESOURCE_SUMMARY_MAX_CHARS"
    assert int(match.group(1)) == models.MATTER_RESOURCE_SUMMARY_MAX_CHARS, (
        f"摘要上限漂移: TS={match.group(1)} Python={models.MATTER_RESOURCE_SUMMARY_MAX_CHARS}"
    )
    schemas_source = GATEWAY_SCHEMAS_TS.read_text(encoding="utf-8")
    assert "max(MATTER_RESOURCE_SUMMARY_MAX_CHARS)" in schemas_source, (
        "gateway zod 的 summary 上限又抄了一个字面量 —— 用 matter.ts 导出的常量"
    )


def test_zod_object_extractor_failure_partial_extraction_and_comments_are_red():
    good = (
        "const s = z\n"
        "  .object({\n"
        "    provider: z.string().regex(/^[a-z]{0,63}$/, 'a: b'),\n"
        "    kind: z.enum(['email', 'thread']),\n"
        "    nested: z.object({ inner: z.string() }),\n"
        "    summary: z.string().optional()\n"
        "  })\n"
        "  .strict()\n"
    )
    # 正则/字符串里的 `a: b`、嵌套对象里的 `inner` 都不是顶层字段。
    assert ts_zod_object_field_names(MATTER_TS, "s", src=good) == (
        "provider",
        "kind",
        "nested",
        "summary",
    )
    # 🔴 注释掉的字段**不算**在场 —— 少了这条，把 summary 注释掉闸依然绿。
    commented = good.replace("    summary: z.string().optional()\n", "    // summary: z.string()\n")
    assert "summary" not in ts_zod_object_field_names(MATTER_TS, "s", src=commented)
    block_commented = good.replace(
        "    summary: z.string().optional()\n", "    /* summary: z.string() */\n"
    )
    assert "summary" not in ts_zod_object_field_names(MATTER_TS, "s", src=block_commented)
    with pytest.raises(AssertionError, match="找不到"):
        ts_zod_object_field_names(MATTER_TS, "other", src=good)
    with pytest.raises(AssertionError, match="抽取结果为空"):
        ts_zod_object_field_names(MATTER_TS, "s", src="const s = z.object({}).strict()")
    with pytest.raises(AssertionError, match="未配平"):
        ts_zod_object_field_names(MATTER_TS, "s", src="const s = z.object({ a: z.string()")
    with pytest.raises(AssertionError, match="strict"):
        ts_zod_object_field_names(MATTER_TS, "s", src=good.replace("  .strict()\n", ""))


def test_tool_description_field_list_extractor_failure_is_red():
    with pytest.raises(AssertionError, match="找不到"):
        matters_tool_description_resource_fields(src="a description without the anchor")
    with pytest.raises(AssertionError, match="没有"):
        matters_tool_description_resource_fields(src="carrying `resource` but no field list")
    assert matters_tool_description_resource_fields(
        src="carrying `resource` ' +\n'{provider, kind}; the owner links it"
    ) == ("provider", "kind")
