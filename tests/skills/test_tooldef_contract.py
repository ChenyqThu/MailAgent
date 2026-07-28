"""``src/skills/**`` 对外 ToolDef 面的**契约闸**（tier / input_schema / auth_scopes / 配额）。

这个面（REST ``/api/skills/invoke`` + MCP stdio + skill pack）此前**零对账**，2026-07-28 镜像
审计在其上一口气找出 5 个契约缺陷（issue #66），其中一半是同一类：*声明的东西没人兑现*。
本文件把这几条病根变成机械断言，让下一次同类漂移在 CI 里红，而不是被外部 agent 撞见。

每节都标了它对应的真实病根。**没有为闸而闸的断言** —— 一条规则若说不出它挡住过什么，
就不该在这里。

### 建闸纪律（台账「三种失效形态」，逐条自查）

① **焊死漂移**：闸不得持有任何一侧的期望值副本。这里所有集合都从真源现算 ——
   scope 目录取 ``KNOWN_SCOPES``、消费集从 ``code_builtin_skills()`` 现扫、tier 强制集从
   ``invoke.py`` **源码**抽（那是唯一真在 runtime 挡人的地方）。
   ⚠️ 这不是假想的风险：``tests/skills/test_email_draft.py::test_email_send_internal_id_still_required``
   曾把「``email_send`` schema 仍 required internalId」写成期望，而那**正是** issue #66 第 2 条
   要修的 bug —— 恒绿、且拦着修复。（同一形态在 P0 preview 门那批里发生过三次。）
② **自指**：不比 ``expect(X).toBe(X)``。凡两侧本可合成一份的，先合并再说 —— 本批就把
   ``email_body.format`` 与 ``_BODY_FORMATS``、compose 三处 ``mode`` 枚举各自并成了单源
   （见 ``src/skills/builtin/email.py``），于是这里不再有那两对镜像可钉。留在这里的都是
   **消灭不掉**的关系：schema ↔ handler 行为、目录 ↔ 消费者、声明 ↔ 强制点。
③ **单侧**：每条跨面断言两边都现取；抽取器抽不到一律 **assert 失败**（不是静默空集恒真），
   并在消息里点名「改了写法的人回来更新抽取器」。反向用例用**合成**输入证明闸真会红。

姊妹闸：``tests/api/test_skill_manifest.py``（工具清单 snapshot + 字段完整性）只锁「有哪些
tool」，本文件锁「这些 tool 的声明彼此以及与实现是否自洽」。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable, get_args

import pytest

from src.security.api_keys import (
    DRAFTER_SCOPES,
    HANDOFF_SCOPES,
    KNOWN_SCOPES,
    READ_ONLY_SCOPES,
    WRITER_SCOPES,
)
from src.skills import rate_limit
from src.skills.builtin.email import _COMPOSE_MODES, _compose_request
from src.skills.errors import SkillError

# 私有 import 是有意的（同 tests/api/test_trigger_kind_parity.py 对 ``_RULE_KEYS`` 的处理）：
# ``_validate_input`` 就是 invoke chokepoint 真正拿 ``required`` 做判定的那一个函数 —— 用它，
# 比在闸里重写一份「我以为的 required 语义」更接近运行时真相。
from src.skills.invoke import _validate_input
from src.skills.models import ConfirmationTier, SideEffect, ToolDef, ToolHandler
from src.skills.registry import BoundTool, code_builtin_skills

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INVOKE_SOURCE = _REPO_ROOT / "src/skills/invoke.py"


# ── 真源扫描 ────────────────────────────────────────────────────────────────


def _all_tools() -> dict[str, BoundTool]:
    """``{"<skill>.<tool>": BoundTool}`` 全量 —— **只取 code builtin**：这是产品出厂的对外面。

    有意不走 ``all_skills()``：那份会把本机 ``agent_config.db`` 里 owner 装的 skill 也读进来，
    闸就成了「跑测试的这台机器上装了什么」的函数。用户安装 skill 的授权面另有其闸
    （``src/skills/installed.py`` 的 ``granted_scopes`` 校验 + ``tests/api/test_agent_skill_supply.py``）。
    """
    out = {f"{s.name}.{t.definition.name}": t for s in code_builtin_skills() for t in s.tools}
    assert out, "一个 builtin tool 都没扫到 —— registry 变形了，本闸的入口失效"
    return out


_TOOL_IDS = sorted(_all_tools())


def _tool(tool_id: str) -> BoundTool:
    return _all_tools()[tool_id]


def _consumed_scopes() -> set[str]:
    return {sc for t in _all_tools().values() for sc in t.definition.auth_scopes}


def _props(tool: BoundTool) -> dict[str, Any]:
    return tool.definition.input_schema.get("properties") or {}


def _required(tool: BoundTool) -> list[str]:
    return list(tool.definition.input_schema.get("required") or [])


class _CtxTouched(Exception):
    """探针 ctx 被碰到了 —— 说明校验没能在访问数据之前拦住这次调用。"""


class _ExplodingCtx:
    """任何数据访问（``repo()`` / ``report_store()`` / ``calendar_service()`` / ``service_ctx()``）
    都当场炸的 ctx。用它跑 handler，就能把「参数校验」与「真去干活」两个阶段分开观察。"""

    def __init__(self) -> None:
        self.confirm = True  # 写工具的 confirm 复核不是本节的观察对象，先放行

    def __getattr__(self, name: str):
        def _boom(*_a: Any, **_kw: Any):
            raise _CtxTouched(name)

        return _boom


_SYNTH_BY_TYPE: dict[str, Any] = {
    "integer": 1,
    "number": 1,
    "string": "x",
    "boolean": True,
    "array": ["x"],
    "object": {},
}


def _synth_params(tool: BoundTool, **overrides: Any) -> dict[str, Any]:
    """按 schema 造一份「刚好满足 required」的合法参数（枚举取第一个值）。"""
    props = _props(tool)
    params: dict[str, Any] = {}
    for key in _required(tool):
        spec = props.get(key) or {}
        params[key] = spec["enum"][0] if spec.get("enum") else _SYNTH_BY_TYPE.get(spec.get("type"), "x")
    params.update(overrides)
    return params


def _fake_tool(schema: dict[str, Any], handler=None, **kw: Any) -> BoundTool:
    """反向用例专用的合成 tool（真漂移在场时改真源说不清是闸红了还是源坏了）。"""
    base: dict[str, Any] = dict(
        name="fake_tool",
        description="synthetic",
        input_schema=schema,
        output_schema={"type": "object"},
        confirmation_tier="none",
        side_effect="read",
        auth_scopes=["email:read"],
        mcp_exposed=False,
        handler=ToolHandler(kind="repository", target="x"),
    )
    base.update(kw)
    return BoundTool(ToolDef(**base), handler or (lambda ctx, p: {}))


# ── §A 结构自洽 ─────────────────────────────────────────────────────────────
# 病根类：schema 自相矛盾 → 工具被宣传出去却结构性不可用。issue #66 第 2 条
# （``required:["internalId"]`` vs ``mode:"new"``）是这一类里最贵的一种。


def _assert_schema_sound(tool_id: str, tool: BoundTool) -> None:
    schema = tool.definition.input_schema
    assert schema.get("type") == "object", f"{tool_id}: input_schema 必须是 object"
    props = _props(tool)
    for key in _required(tool):
        assert key in props, (
            f"{tool_id}: required 里的 {key!r} 不在 properties —— 调用方无从得知它的类型，"
            "这个 tool 对外等于恒 400"
        )
    for name, spec in props.items():
        assert isinstance(spec, dict) and spec.get("type"), f"{tool_id}: 属性 {name!r} 没声明 type"
        if spec.get("enum") is not None:
            assert spec["enum"], f"{tool_id}: 属性 {name!r} 的 enum 是空的"


@pytest.mark.parametrize("tool_id", _TOOL_IDS)
def test_input_schema_is_structurally_sound(tool_id: str):
    _assert_schema_sound(tool_id, _tool(tool_id))


# ── §B compose 家族：每个宣称的 mode 都必须真能走通 ──────────────────────────
# 病根 = issue #66 第 2 条。``email_draft`` 与 ``email_send`` 共用 ``_compose_request``，
# 但各写各的 schema；改动前 send 的 ``required:["internalId"]`` 与它自己 enum 里的
# ``"new"`` 直接打架 —— 按文档发一封全新邮件必吃 400，唯一通路是猜一个注释里写明
# 「对外 schema 不暴露」的哨兵 ``-1``。
# 闸的两侧：**schema 的 required**（invoke 的 ``_validate_input`` 真判据）↔ **handler 对该
# mode 真正需要的参数**（``_compose_request`` 真跑一次）。任一侧单改就红。


def _compose_tools() -> dict[str, BoundTool]:
    """靠 schema 里的 mode 枚举认亲 —— 将来第三个 compose 工具自动进闸，无需改这里。"""
    found = {
        tid: t
        for tid, t in _all_tools().items()
        if set((_props(t).get("mode") or {}).get("enum") or []) == set(_COMPOSE_MODES)
    }
    assert len(found) >= 2, (
        f"只认出 {len(found)} 个 compose 工具（期望 ≥2：email_draft + email_send）—— "
        "mode 枚举的写法变了？更新本闸的认亲规则"
    )
    return found


def _minimal_params_for_mode(mode: str) -> dict[str, Any]:
    """handler 侧的真相：``new`` 无源邮件（哨兵由 handler 自己补），其余模式要源 id。"""
    return {"mode": mode} if mode == "new" else {"mode": mode, "internalId": 1}


@pytest.mark.parametrize("mode", _COMPOSE_MODES)
def test_handler_accepts_minimal_params_for_every_mode(mode: str):
    """先立住「handler 侧真相」这一边：每个 mode 的最小参数集都能构造出请求。"""
    assert _compose_request(_minimal_params_for_mode(mode)).mode == mode


@pytest.mark.parametrize("mode", _COMPOSE_MODES)
@pytest.mark.parametrize("tool_id", sorted(_compose_tools()))
def test_every_advertised_mode_survives_schema_validation(tool_id: str, mode: str):
    """再对撞另一边：schema 不得比 handler 更严 —— 否则那个 mode 是宣传出去的死路。"""
    _validate_input(_tool(tool_id).definition.input_schema, _minimal_params_for_mode(mode))


def test_compose_tools_agree_on_requiredness():
    """两份 schema 对同一批共享字段不得给出矛盾的必填性（它们背后是同一个 handler）。"""
    shared = {"internalId", "to", "cc", "bcc", "subject", "bodyHtml", "bodyText"}
    reqs = {tid: shared & set(_required(t)) for tid, t in _compose_tools().items()}
    assert len({frozenset(v) for v in reqs.values()}) == 1, (
        f"compose 家族的 required 分裂：{reqs} —— 同一个 _compose_request 背后不该有两套必填规则"
    )


# ── §C scope 目录 ↔ 消费者（双向）───────────────────────────────────────────
# 病根 = issue #66 第 4 条：``calendar:write`` 在册、零消费者，却已经可以
# ``api-key create --scopes calendar:write`` 发出去并存进 DB；``verify()`` 读回时**不**校验
# 值域 → 未来第一个消费它的 ToolDef 上线即静默武装所有历史 key。
# 既有的 ``test_manifest_scopes_within_known_catalog`` 只钉了 ⊆ 的一半（防不可授权的 tool），
# 这里补上反向的一半（防不可兑现的 scope）。


def test_known_scopes_equals_consumed_scopes():
    consumed = _consumed_scopes()
    missing = consumed - set(KNOWN_SCOPES)
    dangling = set(KNOWN_SCOPES) - consumed
    assert not missing, (
        f"tool 用了不可授权的 scope {sorted(missing)} —— 任何 key 都拿不到它，该 tool 恒 403"
    )
    assert not dangling, (
        f"悬空 scope {sorted(dangling)}：在 KNOWN_SCOPES 里（= 已可发放并存进 agent_api_keys），"
        "却没有任何 builtin ToolDef 消费它。这不是无害的占位 —— 等第一个消费者落地，所有历史 key "
        "会在没有任何一次显式授权动作的情况下获得该能力。要么现在删掉这个名字，要么把消费它的 "
        "ToolDef 放进同一个 commit。"
    )


@pytest.mark.parametrize(
    "preset_name,preset",
    [
        ("readonly", READ_ONLY_SCOPES),
        ("handoff", HANDOFF_SCOPES),
        ("drafter", DRAFTER_SCOPES),
        ("writer", WRITER_SCOPES),
    ],
)
def test_presets_only_contain_grantable_scopes(preset_name: str, preset: Iterable[str]):
    unknown = set(preset) - set(KNOWN_SCOPES)
    assert not unknown, f"preset {preset_name} 含未知 scope {sorted(unknown)} → create 时 ValueError"


def test_readonly_preset_is_actually_read_only():
    """``READ_ONLY_SCOPES`` 是 ``create_key`` 的**默认**（不传 scopes 就是它）。

    只要有人给某个只读 scope 挂上一个有副作用的 tool，所有「默认最小权限」的历史 key 就当场
    获得写能力 —— 与悬空 scope 同一种静默扩权，只是入口更宽。
    """
    offenders = [
        (tid, t.definition.side_effect)
        for tid, t in _all_tools().items()
        if set(t.definition.auth_scopes) & set(READ_ONLY_SCOPES) and t.definition.side_effect != "read"
    ]
    assert not offenders, (
        f"READ_ONLY_SCOPES 覆盖到了非只读 tool {offenders} —— 默认 key 会静默获得副作用能力；"
        "给它一个专属 scope，别挂在只读 scope 上"
    )


# ── §D 确认层：声明域 ⊆ 强制域 ──────────────────────────────────────────────
# 病根 = 本批 P0（v1.22.0 已修 invoke 侧）：chokepoint 当时只判 ``== "edit"``，于是
# ``preview`` 这一档在直调面**等于无门**（``confirmation_tier`` 全仓再无第二个 gating 读点）。
# 那次是「多了一档没人管的 tier」。这里把「声明了几档」与「强制了几档」焊在一起。

_TIER_GATE_RE = re.compile(r"tdef\.confirmation_tier in \(([^)]*)\)")


def _enforced_tiers(src: str, *, origin: str) -> set[str]:
    m = _TIER_GATE_RE.search(src)
    assert m, (
        f"{origin}: 没抽到 confirmation gate 的 tier 元组 —— 判定写法变了"
        "（换成 set / 抽成常量 / 挪出 invoke_skill？），回来更新本闸的抽取器并核对强制面仍完整"
    )
    tiers = set(re.findall(r'"([a-z]+)"', m.group(1)))
    assert tiers, f"{origin}: tier 元组里一个字面量都没抽到 —— 习语变了，更新本闸"
    return tiers


def test_every_non_none_tier_is_enforced_at_the_chokepoint():
    declared = set(get_args(ConfirmationTier)) - {"none"}
    enforced = _enforced_tiers(_INVOKE_SOURCE.read_text(encoding="utf-8"), origin=str(_INVOKE_SOURCE))
    assert declared <= enforced, (
        f"声明了 {sorted(declared)} 档需确认的 tier，chokepoint 只强制 {sorted(enforced)} —— "
        f"差集 {sorted(declared - enforced)} 在 /api/skills/invoke 上等于无门（P0 病根重演）"
    )


@pytest.mark.parametrize("tool_id", _TOOL_IDS)
def test_side_effecting_tools_require_confirmation(tool_id: str):
    tdef = _tool(tool_id).definition
    assert tdef.side_effect in set(get_args(SideEffect))
    if tdef.side_effect in ("write", "send", "external_call"):
        assert tdef.confirmation_tier != "none", (
            f"{tool_id}: side_effect={tdef.side_effect} 却 tier=none —— 外部 key 可无确认直调"
        )


# ── §E 配额声明必须真的生效 ─────────────────────────────────────────────────
# 病根近亲 = issue #66 第 5 条那类「声明了却没兑现」。``rate_limit._parse`` 对形状不合法的
# spec **静默返回 None = 直接放行**（有意，为了让未声明配额的 tool 零开销），代价是一个写错的
# 配额声明看起来一切正常、实则毫无配额。


@pytest.mark.parametrize("tool_id", _TOOL_IDS)
def test_declared_rate_limit_is_effective(tool_id: str):
    spec = _tool(tool_id).definition.rate_limit
    if spec is None:
        return
    assert rate_limit._parse(spec) is not None, (
        f"{tool_id}: 声明了 rate_limit={spec} 但 _parse 认不出（limit/per_seconds 缺失或 ≤0）"
        " —— 这条配额是哑的，看起来有实则放行"
    )
    assert spec.get("scope", "principal") == "principal", (
        f"{tool_id}: rate_limit.scope={spec.get('scope')!r} 不受支持 —— 未知值被当 principal "
        "静默处理，分桶语义与声明不符"
    )


# ── §F 每个 limit 参数都必须有上界 ──────────────────────────────────────────
# 病根 = issue #66 第 3 条：``report_list`` 是对外读面唯一未封顶的 limit（且 SQLite 的
# ``LIMIT -1`` 意为不限 → 负数还能一次拉全表）。行为断言而非静态比对：直接拿一个荒谬的
# limit 打 handler，用「炸 ctx」证明它在**碰数据之前**就被拦住了。


def _limit_tools() -> dict[str, BoundTool]:
    return {tid: t for tid, t in _all_tools().items() if "limit" in _props(t)}


def _assert_limit_is_bounded(tool_id: str, tool: BoundTool) -> None:
    with pytest.raises((SkillError, _CtxTouched)) as ei:
        tool.handler(_ExplodingCtx(), _synth_params(tool, limit=10**9))
    if isinstance(ei.value, _CtxTouched):
        pytest.fail(
            f"{tool_id}: limit=10**9 一路走到了数据访问（{ei.value}）—— 没有上界，"
            "一次调用即可拉全表；照 search/calendar 的写法在 handler 开头加 1..MAX 判定"
        )
    assert ei.value.code == "E_INVALID_ARG", (
        f"{tool_id}: 越界 limit 应报 E_INVALID_ARG，实得 {ei.value.code}"
    )


@pytest.mark.parametrize("tool_id", sorted(_limit_tools()))
def test_every_limit_param_is_bounded(tool_id: str):
    _assert_limit_is_bounded(tool_id, _tool(tool_id))


def test_limit_tools_cover_the_known_paginated_reads():
    """认亲规则失效（比如 limit 改名 top_k）时先红，而不是悄悄退化成零覆盖。"""
    ids = set(_limit_tools())
    assert ids >= {
        "search.email_search",
        "search.attachment_search",
        "report.report_list",
        "calendar.calendar_events",
    }, f"带 limit 的读工具集合缩水了：{sorted(ids)} —— 改名了？更新本闸"


# ── §G SKILL.md ↔ ToolDef ───────────────────────────────────────────────────
# 病根：这几份 SKILL.md **也是对外契约**（skill pack 把它们连同 manifest 一起发出去，MCP 客户端
# 和外部 agent 照着它调），但它们是手写的，而同一份事实在 ToolDef 里由代码持有 —— 典型的消灭
# 不掉的镜像。实测本批就抓到两处已漂的：``notion_agent_chat`` 的表格写 ``preview``（codex
# HIGH-2 把代码提到 ``edit`` 后没跟）、``email_body`` 的 ``format`` 还在教人用 ``raw``。
# 只钉**能机械比对**的三件：工具是否被记载 / scope / tier 首词。散文部分不钉（钉不动，也不该钉）。

_TABLE_ROW_RE = re.compile(r"^\|\s*`(?P<tool>\w+)`\s*\|\s*`(?P<scope>[^`]+)`\s*\|(?P<rest>.*)$", re.M)
_EMPHASIS = str.maketrans("", "", "*_")


# 源文件按 **skill 名** 寻址 —— 与 ``scripts/export_skill_pack.py`` 的 ``_DOCS_DIR / name /
# "SKILL.md"` 同一套寻址（``SkillDef.docs_path`` 是 pack **内**的相对路径，不是仓库路径）。
_DOCS_DIR = _REPO_ROOT / "src" / "skills" / "docs"


def _skill_md_rows(skill_name: str, docs_path: str) -> dict[str, tuple[str, str | None]]:
    """SKILL.md 工具表 → ``{tool: (scope, tier_token|None)}``。

    表格有两种列形态（4 列带 confirm / 3 列不带），故 tier 是可选的：**只在有第 4 列时**才比对，
    不强迫两份纯读 skill 补一列没有信息量的 ``none``。
    """
    assert docs_path == f"skills/{skill_name}/SKILL.md", (
        f"{skill_name}: docs_path={docs_path!r} 与 skill pack 的布局对不上 —— 导出器按 skill 名"
        f" 拷到 skills/{skill_name}/SKILL.md，manifest 却让消费者去别处找"
    )
    path = _DOCS_DIR / skill_name / "SKILL.md"
    assert path.exists(), f"{skill_name}: SKILL.md 找不到（{path}）—— 文件搬家了？导出器也会同时炸"
    rows: dict[str, tuple[str, str | None]] = {}
    for m in _TABLE_ROW_RE.finditer(path.read_text(encoding="utf-8")):
        cells = [c.strip() for c in m.group("rest").split("|")]
        tier = None
        if len(cells) >= 3 and cells[1]:  # [effect, confirm, 行尾空串]
            tier = cells[1].translate(_EMPHASIS).split()[0].split("(")[0].strip().lower()
        rows[m.group("tool")] = (m.group("scope"), tier)
    assert rows, (
        f"{skill_name}: SKILL.md 的工具表一行都没抽到 —— 表格写法变了（列序 / 反引号 / 表头？），"
        "回来更新本闸的抽取器，顺手核对文档与 ToolDef 仍一致"
    )
    return rows


def test_skill_md_documents_every_tool_with_matching_scope_and_tier():
    for skill in code_builtin_skills():
        documented = _skill_md_rows(skill.name, skill.docs_path)
        for bt in skill.tools:
            tdef = bt.definition
            assert tdef.name in documented, (
                f"{skill.name}.{tdef.name} 不在 {skill.docs_path} 的工具表里 —— 这份文档随 skill pack "
                "发给外部 agent，缺一行 = 那个 tool 对使用者不存在"
            )
            scope, tier = documented[tdef.name]
            assert scope in tdef.auth_scopes, (
                f"{skill.name}.{tdef.name}: SKILL.md 写 scope={scope!r}，ToolDef 是 "
                f"{tdef.auth_scopes} —— 照文档申请的 key 会调不动"
            )
            if tier is not None:
                assert tier == tdef.confirmation_tier, (
                    f"{skill.name}.{tdef.name}: SKILL.md 的 confirm 列首词是 {tier!r}，"
                    f"ToolDef 是 {tdef.confirmation_tier!r} —— 文档在教人用一个会被 gate 拒的调法"
                )


def test_skill_md_has_no_phantom_tools():
    """反向：文档里不得有代码中不存在的 tool（写了、外部照着调、然后 404）。"""
    for skill in code_builtin_skills():
        real = {bt.definition.name for bt in skill.tools}
        phantom = set(_skill_md_rows(skill.name, skill.docs_path)) - real
        assert not phantom, f"{skill.name}: SKILL.md 记载了不存在的 tool {sorted(phantom)}"


# ── 反向用例：合成输入证明上面每条闸真的会红 ────────────────────────────────


def test_gate_schema_required_drift_would_go_red():
    """issue #66 修复前的 email_send 形状（mode 含 new + internalId 必填）必须被 §B 判红。"""
    broken = _fake_tool(
        {
            "type": "object",
            "properties": {
                "internalId": {"type": "integer"},
                "mode": {"type": "string", "enum": list(_COMPOSE_MODES)},
            },
            "required": ["internalId"],
        }
    )
    with pytest.raises(SkillError):
        _validate_input(broken.definition.input_schema, _minimal_params_for_mode("new"))


def test_gate_required_not_in_properties_would_go_red():
    broken = _fake_tool(
        {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["b"]}
    )
    with pytest.raises(AssertionError):
        _assert_schema_sound("synthetic.broken", broken)


def test_gate_untyped_property_would_go_red():
    broken = _fake_tool({"type": "object", "properties": {"a": {"description": "no type"}}})
    with pytest.raises(AssertionError):
        _assert_schema_sound("synthetic.untyped", broken)


def test_gate_dangling_scope_would_go_red():
    """把一个无人消费的名字塞进目录副本，等式必须不成立。"""
    polluted = set(KNOWN_SCOPES) | {"calendar:write"}
    assert polluted != _consumed_scopes(), "合成的悬空 scope 竟与消费集相等 —— 本闸对漂移无感"


def test_gate_tier_extractor_failure_would_go_red():
    with pytest.raises(AssertionError):
        _enforced_tiers("if tdef.confirmation_tier in EDIT_TIERS:\n", origin="<synthetic>")
    with pytest.raises(AssertionError):
        _enforced_tiers("tdef.confirmation_tier in ()", origin="<synthetic>")


def test_gate_tier_gap_would_go_red():
    """合成一个只强制 edit 的 chokepoint（= P0 修复前的形状）→ preview 落在差集里。"""
    enforced = _enforced_tiers('if tdef.confirmation_tier in ("edit") and confirm:', origin="<synthetic>")
    assert not (set(get_args(ConfirmationTier)) - {"none"}) <= enforced, (
        "合成的单档 chokepoint 竟覆盖了全部声明档 —— 本闸对漂移无感"
    )


def test_gate_inert_rate_limit_would_go_red():
    for bad in ({"limit": 0, "per_seconds": 3600}, {"limit": 20}, {"per_seconds": -1, "limit": 20}):
        assert rate_limit._parse(bad) is None, f"{bad} 竟被 _parse 认下 —— 反向用例失效"


def test_gate_skill_md_extractor_failure_would_go_red(tmp_path):
    """表格写法被重构（换列序 / 去反引号）时必须断言失败，而不是静默返回空表恒真。"""
    (tmp_path / "x").mkdir()
    (tmp_path / "x" / "SKILL.md").write_text("# Skill: x\n\nno table here\n", encoding="utf-8")
    import tests.skills.test_tooldef_contract as mod

    original = mod._DOCS_DIR
    mod._DOCS_DIR = tmp_path
    try:
        with pytest.raises(AssertionError):
            _skill_md_rows("x", "skills/x/SKILL.md")
    finally:
        mod._DOCS_DIR = original


def test_gate_skill_md_tier_drift_would_go_red():
    """``notion_agent_chat`` 修复前的行（代码 edit / 文档 preview）必须比对不上。"""
    row = "| `notion_agent_chat` | `notion_agent:invoke` | external_call | preview (edit-tier / 恒 HITL) |"
    m = _TABLE_ROW_RE.search(row)
    assert m, "合成行都抽不到 —— 反向用例本身失效"
    cells = [c.strip() for c in m.group("rest").split("|")]
    tier = cells[1].translate(_EMPHASIS).split()[0].split("(")[0].strip().lower()
    assert tier == "preview", f"抽出的首词是 {tier!r}"
    real = next(
        t.definition for s in code_builtin_skills() for t in s.tools if t.definition.name == "notion_agent_chat"
    )
    assert tier != real.confirmation_tier, "合成的漂移行竟与代码 tier 相等 —— 本闸对漂移无感"


def test_gate_unbounded_limit_would_go_red():
    """一个不判上界的 handler 必须被 §F 抓住（而不是因为没碰数据而蒙混过关）。"""
    unbounded = _fake_tool(
        {"type": "object", "properties": {"limit": {"type": "integer"}}},
        handler=lambda ctx, p: ctx.repo().list_everything(p["limit"]),
    )
    with pytest.raises(pytest.fail.Exception):
        _assert_limit_is_bounded("synthetic.unbounded", unbounded)
