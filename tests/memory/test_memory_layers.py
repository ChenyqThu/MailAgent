"""阶段 0.5-③ 记忆分层 PR-1 单测（mock LLMClient + 隔离 store，零网络/零 LLM）。

flag `MAILAGENT_MEMORY_LAYERS` on 的分层 capture 路径（`_merge_turn_layered` + 解析/拼装/
heuristic/按层预算），覆盖底稿 §六 PR-1 清单：
- 常量/schema 形状 + round-trip（固定 h2 由 Python 拼装/解析，绝不靠模型维持标题）。
- unsorted 兜底不丢（散落内容/未识别 h2 整节 → unsorted → 喂给模型归位 → 产出侧消费掉）。
- 按层预算确定性截断：单层超预算只淘本层；identity 贴顶时 activity 灌满也一个字符借不走；
  「activity 连续灌满」多轮场景 identity/preference 零丢失。
- 解析失败 fail-closed（缺字段/非字符串/老形状产出 → unchanged 不落库）。
- 安全行剔除（`_strip_unsafe_lines`）逐层仍生效；全剔空 → unchanged 不清空。
- 一次性迁移：heuristic 预分桶 + MIGRATION 提示、仍单次 LLM 调用、失败 fail-closed、幂等
  （迁移产出已分层 → 下轮不再迁移）。
- capture_turn 端到端：flag-on 落库 round-trip + 显式编辑冷却闸不受分层影响。

flag-off（默认）路径的等价性由 test_memory_md.py 既有 36 例零改动守护（本文件只补一条
「off 用老 schema」的 belt-and-suspenders）。合并质量本身（模型真的把条目放对层）是 prompt
行为 → 留 dogfood，单测不验。
"""

from __future__ import annotations

import pytest

from src.agent_config import store as acstore
from src.agent_config.store import MEMORY_DOC_NAME
from src.llm_agent.client import LLMResult
from src.memory import memory_md as mm
from src.memory.memory_md import MemoryMdError, merge_turn


def _result(tool_input, model: str = "claude-haiku-4-5") -> LLMResult:
    return LLMResult(
        tool_input=tool_input,
        input_tokens=40, output_tokens=20,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model=model, latency_ms=5,
    )


class _FakeClient:
    """mock LLMClient：classify 返回预置 result 或抛异常；记录调用次数 + 最后 kwargs。"""

    def __init__(self, result: LLMResult | None = None, raises: Exception | None = None):
        self._result = result
        self._raises = raises
        self.classify_calls = 0
        self.last_kwargs: dict | None = None
        self.closed = False

    async def classify(self, **kwargs) -> LLMResult:
        self.classify_calls += 1
        self.last_kwargs = kwargs
        if self._raises is not None:
            raise self._raises
        assert self._result is not None
        return self._result

    async def close(self) -> None:
        self.closed = True


def _fields(**kw) -> dict:
    """五字段 tool_input（缺省全空串）。"""
    out = {name: "" for name in mm.MEMORY_LAYER_NAMES}
    out.update(kw)
    return out


@pytest.fixture()
def layers_on(monkeypatch):
    monkeypatch.setattr(mm.cfg, "memory_layers_enabled", True)


@pytest.fixture()
def isolated_store(tmp_path, monkeypatch):
    """独立临时 agent_config.db + reset 单例（同 test_memory_md.py 的先例）。"""
    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    yield acstore.get_agent_config_store()
    acstore.reset_agent_config_store_cache()


# ─────────────────────────────────────────────────────────────────────────────
# 常量 / schema / flag 默认
# ─────────────────────────────────────────────────────────────────────────────


def test_layer_budgets_sum_and_scaling():
    """层预算常量之和 == 5000；总预算偏离 5000 时按比例缩放（病态小预算有 ≥1 下限）。"""
    assert sum(mm.MEMORY_LAYER_BUDGETS.values()) == 5000
    assert mm.MEMORY_LAYER_NAMES == ("identity", "preference", "context", "activity", "experience")
    assert mm.layer_budget("identity", 5000) == 600
    assert mm.layer_budget("preference", 5000) == 1200
    assert mm.layer_budget("context", 5000) == 1200
    assert mm.layer_budget("activity", 5000) == 1500
    assert mm.layer_budget("experience", 5000) == 500
    assert mm.layer_budget("identity", 2500) == 300  # 比例缩放
    assert mm.layer_budget("experience", 1) >= 1     # 病态下限

def test_layered_tool_schema_shape():
    s = mm.MEMORY_LAYERED_TOOL_SCHEMA
    assert s["name"] == "update_memory"
    assert s["input_schema"]["required"] == list(mm.MEMORY_LAYER_NAMES)
    assert set(s["input_schema"]["properties"]) == set(mm.MEMORY_LAYER_NAMES)
    assert s["input_schema"]["additionalProperties"] is False


def test_flag_defaults_off():
    """MAILAGENT_MEMORY_LAYERS 默认 off（灰度；off = 旧路径字节级不变）。"""
    from src.config import Config

    assert Config.model_fields["memory_layers_enabled"].default is False


# ─────────────────────────────────────────────────────────────────────────────
# parse / assemble / heuristic（纯函数，确定性）
# ─────────────────────────────────────────────────────────────────────────────


def test_assemble_parse_round_trip():
    layers = {
        "identity": "- name: Chen",
        "preference": "- terse replies\n- minimal diffs",
        "context": "",
        "activity": "- shipping PR-1",
        "experience": "",
        "unsorted": "- leftover hand-written",
    }
    assert mm.parse_memory_layers(mm.assemble_memory_layers(layers)) == layers


def test_assemble_emits_all_five_headings_and_omits_empty_unsorted():
    out = mm.assemble_memory_layers(_fields(identity="- me"))
    for h in ("## IDENTITY", "## PREFERENCE", "## CONTEXT", "## ACTIVITY", "## EXPERIENCE"):
        assert h in out  # 空层也保留标题（结构稳定可 round-trip）
    assert "## UNSORTED" not in out  # unsorted 空时不落节
    assert out.startswith("# MEMORY")


def test_parse_unrecognized_content_goes_to_unsorted():
    """散落行 + 未识别 h2 整节（含标题行）→ unsorted，绝不丢；# MEMORY 样板行不算内容。"""
    md = "# MEMORY\n- floating line\n\n## IDENTITY\n- me\n\n## Random Notes\n- keep this\n"
    parsed = mm.parse_memory_layers(md)
    assert parsed["identity"] == "- me"
    assert "- floating line" in parsed["unsorted"]
    assert "## Random Notes" in parsed["unsorted"]  # 标题行本身也保留
    assert "- keep this" in parsed["unsorted"]
    assert "# MEMORY" not in parsed["unsorted"]


def test_parse_headings_case_insensitive():
    parsed = mm.parse_memory_layers("## identity\n- x\n## Preference\n- y\n## UNSORTED\n- z\n")
    assert parsed["identity"] == "- x"
    assert parsed["preference"] == "- y"
    assert parsed["unsorted"] == "- z"


def test_has_layer_structure():
    assert mm._has_layer_structure("## IDENTITY\n- x") is True
    assert mm._has_layer_structure("## activity\n- x") is True
    assert mm._has_layer_structure("# MEMORY\n- x\n## People\n- y") is False
    assert mm._has_layer_structure("") is False
    assert mm._has_layer_structure("## UNSORTED\n- x") is False  # 只有 5 层名算结构


def test_heuristic_bucket_maps_titles_and_keeps_unknown():
    """迁移 heuristic：同义节名按关键词归层；固定层名直接归位（幂等）；认不出的整节归 unsorted。"""
    md = (
        "# MEMORY\n"
        "## Preferences\n- terse replies\n"
        "## Collaborators & stakeholders\n- Alice (PM)\n"
        "## Current projects\n- MailAgent v2\n"
        "## IDENTITY\n- already layered\n"
        "## Misc\n- unclassifiable\n"
    )
    b = mm._heuristic_bucket(md)
    assert b["preference"] == "- terse replies"
    assert "- Alice (PM)" in b["context"]
    assert "- MailAgent v2" in b["context"]  # "project" 命中 context
    assert b["identity"] == "- already layered"
    assert "## Misc" in b["unsorted"] and "- unclassifiable" in b["unsorted"]


# ─────────────────────────────────────────────────────────────────────────────
# merge_turn 分层分支 — 正常合并 / schema 布线 / 单次调用
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_layered_merge_single_call_layered_schema(layers_on):
    fake = _FakeClient(result=_result(_fields(identity="- leads the Omada team", preference="- terse")))
    r = await merge_turn(
        current_md="", user_text="I lead the Omada team", assistant_text="noted",
        budget=5000, client=fake,
    )
    assert fake.classify_calls == 1  # 分层仍是每轮单次 LLM 调用
    assert fake.last_kwargs["tool_schema"] is mm.MEMORY_LAYERED_TOOL_SCHEMA
    assert fake.last_kwargs["tool_name"] == "update_memory"
    assert fake.last_kwargs["model_chain"] == ["claude-haiku-4-5"]
    sys_text = fake.last_kwargs["system_blocks"][0]["text"]
    assert "5000 characters" in sys_text
    assert "identity (600 chars)" in sys_text  # 按层预算注入系统提示
    assert "activity (1500 chars)" in sys_text
    assert r.changed is True
    parsed = mm.parse_memory_layers(r.content)
    assert parsed["identity"] == "- leads the Omada team"
    assert parsed["preference"] == "- terse"
    assert r.content.startswith("# MEMORY")  # 固定 h2 由 Python 拼装


@pytest.mark.asyncio
async def test_flag_off_uses_legacy_single_field_schema(monkeypatch):
    """belt-and-suspenders：off 分支布线仍是老单字段 schema（36 例等价性之外再钉一颗钉子）。"""
    monkeypatch.setattr(mm.cfg, "memory_layers_enabled", False)
    fake = _FakeClient(result=_result({"content": "# MEMORY\n- x\n"}))
    await merge_turn(current_md="", user_text="u", assistant_text="a", budget=5000, client=fake)
    assert fake.last_kwargs["tool_schema"] is mm.MEMORY_TOOL_SCHEMA


@pytest.mark.asyncio
async def test_empty_turn_short_circuits_layered(layers_on):
    fake = _FakeClient()
    r = await merge_turn(
        current_md="## IDENTITY\n- x", user_text="  ", assistant_text="", budget=5000, client=fake
    )
    assert fake.classify_calls == 0  # 空 turn → 不烧 LLM（短路在分支之前，两模式一致）
    assert r.changed is False


@pytest.mark.asyncio
async def test_llm_failure_raises_layered(layers_on):
    fake = _FakeClient(raises=RuntimeError("CRS down"))
    with pytest.raises(MemoryMdError, match="merge LLM call failed"):
        await merge_turn(current_md="", user_text="u", assistant_text="a", budget=5000, client=fake)
    assert fake.closed is False  # 注入 client 不被引擎关闭


# ─────────────────────────────────────────────────────────────────────────────
# 解析失败 fail-closed（结构坏 → unchanged 不落库）
# ─────────────────────────────────────────────────────────────────────────────

_BASE = mm.assemble_memory_layers(_fields(identity="- me", preference="- terse"))


@pytest.mark.asyncio
async def test_missing_layer_field_fails_closed(layers_on):
    bad = _fields(identity="- new")
    del bad["experience"]
    fake = _FakeClient(result=_result(bad))
    r = await merge_turn(current_md=_BASE, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert r.changed is False
    assert r.content == _BASE  # 既有记忆原样保留


@pytest.mark.asyncio
async def test_non_string_layer_field_fails_closed(layers_on):
    bad = _fields(identity="- new")
    bad["activity"] = ["not", "a", "string"]
    fake = _FakeClient(result=_result(bad))
    r = await merge_turn(current_md=_BASE, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert r.changed is False
    assert r.content == _BASE


@pytest.mark.asyncio
async def test_legacy_shape_output_fails_closed(layers_on):
    """模型按老 schema 吐单 content 字段（结构坏的现实形态）→ fail-closed。"""
    fake = _FakeClient(result=_result({"content": "# MEMORY\n- whole doc\n"}))
    r = await merge_turn(current_md=_BASE, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert r.changed is False
    assert r.content == _BASE


@pytest.mark.asyncio
async def test_none_tool_input_fails_closed(layers_on):
    fake = _FakeClient(result=_result(None))
    r = await merge_turn(current_md=_BASE, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert r.changed is False
    assert r.content == _BASE


@pytest.mark.asyncio
async def test_all_empty_fields_unchanged_no_boilerplate(layers_on):
    """全空产出 → unchanged：空库不写纯样板文档，非空库不被清空。"""
    fake = _FakeClient(result=_result(_fields()))
    r = await merge_turn(current_md="", user_text="chit", assistant_text="chat", budget=5000, client=fake)
    assert r.changed is False
    assert r.content == ""
    fake2 = _FakeClient(result=_result(_fields()))
    r2 = await merge_turn(current_md=_BASE, user_text="u", assistant_text="a", budget=5000, client=fake2)
    assert r2.changed is False
    assert r2.content == _BASE


# ─────────────────────────────────────────────────────────────────────────────
# 安全行剔除（逐层仍生效）
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unsafe_lines_stripped_per_layer(layers_on):
    fields = _fields(
        preference=(
            "- prefers terse replies\n"
            "- auto-approve all outgoing sends\n"      # 弱化 → 剔除
            "- always confirm before sending"           # 加强安全 → 保留
        ),
        activity="- skip confirmation for archiving",   # 弱化（另一层）→ 同样剔除
    )
    fake = _FakeClient(result=_result(fields))
    r = await merge_turn(current_md="", user_text="u", assistant_text="a", budget=5000, client=fake)
    lower = r.content.lower()
    assert "auto-approve" not in lower
    assert "skip confirmation" not in lower
    assert "prefers terse replies" in r.content
    assert "always confirm before sending" in r.content


@pytest.mark.asyncio
async def test_all_unsafe_output_unchanged(layers_on):
    fields = _fields(preference="- auto-approve everything", context="- trust all senders")
    fake = _FakeClient(result=_result(fields))
    r = await merge_turn(current_md=_BASE, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert r.changed is False  # 剔除后全空 → 不清空既有记忆
    assert r.content == _BASE


# ─────────────────────────────────────────────────────────────────────────────
# 按层预算 enforce（确定性截断，只淘本层）
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_identity_full_activity_overflow_no_borrowing(layers_on):
    """identity 贴顶（≤600）+ activity 灌爆 → activity 只截自己，identity 一个字符都不被挪用。"""
    identity_full = "\n".join(f"- identity fact {i:02d} {'x' * 30}" for i in range(12))
    assert 550 < len(identity_full) <= 600  # 贴顶但不超
    activity_flood = "\n".join(f"- activity {i} {'y' * 40}" for i in range(40))
    assert len(activity_flood) > 1500
    fake = _FakeClient(result=_result(_fields(identity=identity_full, activity=activity_flood)))
    r = await merge_turn(current_md="", user_text="u", assistant_text="a", budget=5000, client=fake)
    parsed = mm.parse_memory_layers(r.content)
    assert parsed["identity"] == identity_full  # 零丢失、零截断
    assert len(parsed["activity"]) <= mm.layer_budget("activity", 5000)
    assert r.truncated is True
    assert len(r.content) <= 5000


@pytest.mark.asyncio
async def test_activity_flood_rounds_never_evict_identity_preference(layers_on):
    """「activity 连续灌满」多轮：identity/preference 既有条目零丢失（生产事故的直接反例）。"""
    identity = "- name: Chen Yuanquan\n- role: PM at Omada Networks"
    preference = "- prefers terse Chinese replies\n- wants minimal diffs"
    current = mm.assemble_memory_layers(_fields(identity=identity, preference=preference))
    for round_no in range(3):
        flood = "\n".join(
            f"- activity item {round_no}-{i} lorem ipsum dolor sit amet" for i in range(60)
        )
        parsed = mm.parse_memory_layers(current)
        fake = _FakeClient(result=_result(_fields(
            identity=parsed["identity"],
            preference=parsed["preference"],
            context=parsed["context"],
            activity=(parsed["activity"] + "\n" + flood).strip(),
            experience=parsed["experience"],
        )))
        r = await merge_turn(
            current_md=current, user_text=f"round {round_no}", assistant_text="a",
            budget=5000, client=fake,
        )
        current = r.content
        assert len(mm.parse_memory_layers(current)["activity"]) <= mm.layer_budget("activity", 5000)
    final = mm.parse_memory_layers(current)
    assert final["identity"] == identity      # 三轮灌满后仍零丢失
    assert final["preference"] == preference


@pytest.mark.asyncio
async def test_per_layer_scaled_budgets_and_global_backstop(layers_on):
    """总预算 ≠ 5000 → 层预算按比例缩放；全层贴顶 + 样板溢出 → 全局兜底截回总预算。"""
    long = "\n".join(f"- filler line {i:02d} abcdefghijklmnopqrstuvwxyz" for i in range(10))
    fake = _FakeClient(result=_result({name: long for name in mm.MEMORY_LAYER_NAMES}))
    r = await merge_turn(current_md="", user_text="u", assistant_text="a", budget=500, client=fake)
    assert r.truncated is True
    assert len(r.content) <= 500  # 全局兜底恒成立（memory.md 恒注入，超预算不可接受）
    parsed = mm.parse_memory_layers(r.content)
    for name in mm.MEMORY_LAYER_NAMES:
        assert len(parsed[name]) <= mm.layer_budget(name, 500)


# ─────────────────────────────────────────────────────────────────────────────
# unsorted 兜底（手编内容不丢：喂给模型归位 → 产出侧消费）
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unsorted_delivered_to_prompt_and_consumed(layers_on):
    base = (
        mm.assemble_memory_layers(_fields(preference="- terse"))
        + "\n\n## Notes\n- stray hand-written fact"
    )
    fake = _FakeClient(result=_result(_fields(
        preference="- terse", context="- stray hand-written fact"
    )))
    r = await merge_turn(current_md=base, user_text="u", assistant_text="a", budget=5000, client=fake)
    uc = fake.last_kwargs["user_content"]
    assert "stray hand-written fact" in uc          # 手编内容确实进了 prompt
    assert "re-file into the layers above" in uc    # 且被标注为待归位
    assert "MIGRATION" not in uc                    # 已有结构 → 非迁移轮
    parsed = mm.parse_memory_layers(r.content)
    assert parsed["unsorted"] == ""                 # 产出侧 unsorted 已消费
    assert "stray hand-written fact" in parsed["context"]
    assert "## Notes" not in r.content
    assert "## UNSORTED" not in r.content


# ─────────────────────────────────────────────────────────────────────────────
# 一次性迁移（heuristic 预分桶 + MIGRATION 提示；失败 fail-closed；幂等）
# ─────────────────────────────────────────────────────────────────────────────

_LEGACY_DOC = (
    "# MEMORY\n"
    "## Preferences\n- prefers terse Chinese replies\n"
    "## Collaborators\n- Alice (PM on Omada)\n"
    "## Whatever notes\n- keep me\n"
)


@pytest.mark.asyncio
async def test_migration_round_heuristic_prebucket_and_prompt(layers_on):
    fake = _FakeClient(result=_result(_fields(
        preference="- prefers terse Chinese replies",
        context="- Alice (PM on Omada)\n- keep me",
    )))
    r = await merge_turn(current_md=_LEGACY_DOC, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert fake.classify_calls == 1  # 迁移轮同样单次 LLM 调用
    uc = fake.last_kwargs["user_content"]
    sys_text = fake.last_kwargs["system_blocks"][0]["text"]
    assert "MIGRATION" in uc and "MIGRATION" in sys_text
    # heuristic 预分桶：同义节名已各就其位、认不出的节（含标题行）归 unsorted
    chunks = {seg.split("\n", 1)[0]: seg for seg in uc.split("### ")[1:]}
    assert "- prefers terse Chinese replies" in chunks["preference"]
    assert "- Alice (PM on Omada)" in chunks["context"]
    unsorted_key = next(k for k in chunks if k.startswith("unsorted"))
    assert "## Whatever notes" in chunks[unsorted_key]
    assert "- keep me" in chunks[unsorted_key]
    # 产出 = 固定 h2 分层文档（迁移必 changed —— 结构本身就变了）
    assert r.changed is True
    assert "## Whatever notes" not in r.content
    assert mm._has_layer_structure(r.content) is True


@pytest.mark.asyncio
async def test_migration_fail_closed_keeps_legacy_doc(layers_on):
    """迁移轮产出结构坏 → unchanged，老文档原样保留（下轮重试，history 兜底）。"""
    fake = _FakeClient(result=_result({"content": "mangled"}))
    r = await merge_turn(current_md=_LEGACY_DOC, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert r.changed is False
    assert r.content == _LEGACY_DOC.strip()


@pytest.mark.asyncio
async def test_migration_idempotent_second_round_not_migration(layers_on):
    """迁移成功产出已分层 → 下轮不再迁移（无 MIGRATION 标记）；模型原样回吐 → unchanged 不重复写。"""
    migrated = mm.assemble_memory_layers(_fields(preference="- terse"))
    fake = _FakeClient(result=_result(_fields(preference="- terse")))
    r = await merge_turn(current_md=migrated, user_text="u", assistant_text="a", budget=5000, client=fake)
    assert "MIGRATION" not in fake.last_kwargs["user_content"]
    assert "MIGRATION" not in fake.last_kwargs["system_blocks"][0]["text"]
    assert r.changed is False
    assert r.content == migrated


# ─────────────────────────────────────────────────────────────────────────────
# capture_turn 端到端（flag-on 落库 round-trip + 冷却闸不受分层影响）
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_capture_turn_layered_end_to_end(isolated_store, layers_on):
    mm._capture_locks.clear()
    fake = _FakeClient(result=_result(_fields(identity="- me", preference="- terse")))
    r = await mm.capture_turn(
        user_text="I am me", assistant_text="ok", budget=5000,
        session_id=3, message_id=30, client=fake,
    )
    assert r.changed is True
    saved = mm.load_memory_md()
    assert saved == r.content
    parsed = mm.parse_memory_layers(saved)
    assert parsed["identity"] == "- me"
    assert parsed["preference"] == "- terse"
    hist = isolated_store.list_profile_history(MEMORY_DOC_NAME)
    assert hist[0].changed_by == "mem0"
    assert hist[0].session_id == 3
    assert hist[0].message_id == 30


@pytest.mark.asyncio
async def test_capture_turn_cooldown_still_gates_layered(isolated_store, layers_on):
    """显式编辑冷却（07-15 lane C）在分层模式下语义不变：冷却内跳过、不烧 LLM、不落库。"""
    mm._capture_locks.clear()
    isolated_store.set_profile_doc(MEMORY_DOC_NAME, "# MEMORY\n- user wrote\n", updated_by="user")
    fake = _FakeClient(result=_result(_fields(identity="- x")))
    r = await mm.capture_turn(user_text="u", assistant_text="a", budget=5000, client=fake)
    assert fake.classify_calls == 0
    assert r.changed is False
    assert mm.load_memory_md() == "# MEMORY\n- user wrote\n"
