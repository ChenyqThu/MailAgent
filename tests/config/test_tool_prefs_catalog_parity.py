"""跨构件一致性闸（08-05 WP-11）：per-tool 审批档 canonical 注册表 ↔ tool_catalog.json。

canonical = ``src/agent_config/tool_prefs.py::BUILTIN_TOOL_POLICIES``（Python 运行时权威：
serve-api 折算端点 + gateway wire 都从它出）。镜像 = ``tests/agent_eval/tool_catalog.json``
的 ``default_approval`` 字段（agent_eval R5 评分需要一个语言中立的默认档事实——eval runner
不 import src/）。这两处一旦漂移：R5 会把出厂免卡的工具打成 red（或反过来放过一个该弹卡的
工具），且测试全绿运行时静默错——所以钉双向。

三向断言：
  1. 注册表工具集合 == catalog write:true 且 tier != 'silent' 且非 legacy 的工具集合
     （新写工具漏在任一侧必红——接替 07-16 approval_mode.test.ts 两集划分完备性闸）。
  2. 每个工具的 catalog ``default_approval``（缺席 = 'ask'）== 注册表 default_tier。
  3. 抽取失败必红：catalog 读不到 / 空 / 形状变了 → 显式 fail，绝不静默跳过。
"""

from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO / "tests" / "agent_eval" / "tool_catalog.json"


def _catalog_write_tools() -> dict[str, str]:
    """catalog 的 write 工具 → 默认审批档（'auto' | 'ask'）。抽取失败必红。"""
    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    tools = raw.get("tools")
    assert isinstance(tools, dict) and tools, "tool_catalog.json extraction failed (no tools)"
    out: dict[str, str] = {}
    for name, entry in tools.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("legacy_retired") is True:
            continue
        if entry.get("write") is not True or entry.get("tier") == "silent":
            # default_approval 只允许出现在进审批链的 write 工具上（防误标 read/silent）。
            assert "default_approval" not in entry, (
                f"{name}: default_approval on a non-approval-chain tool"
            )
            continue
        da = entry.get("default_approval", "ask")
        assert da in ("auto", "ask"), f"{name}: bad default_approval {da!r}"
        out[name] = da
    assert out, "tool_catalog.json extraction failed (no write tools)"
    return out


def test_registry_matches_catalog_write_universe():
    from src.agent_config.tool_prefs import BUILTIN_TOOL_POLICY_BY_NAME

    catalog = _catalog_write_tools()
    registry = set(BUILTIN_TOOL_POLICY_BY_NAME)
    missing_in_registry = sorted(set(catalog) - registry)
    missing_in_catalog = sorted(registry - set(catalog))
    assert not missing_in_registry, (
        "write tools in tool_catalog.json but not in tool_prefs.py registry "
        f"(a new write tool needs an explicit factory tier decision): {missing_in_registry}"
    )
    assert not missing_in_catalog, (
        "tools in tool_prefs.py registry but not write:true in tool_catalog.json "
        f"(rename/retire must update both sides): {missing_in_catalog}"
    )


def test_default_tiers_match_catalog_default_approval():
    from src.agent_config.tool_prefs import BUILTIN_TOOL_POLICIES

    catalog = _catalog_write_tools()
    for policy in BUILTIN_TOOL_POLICIES:
        assert catalog.get(policy.tool_name) == policy.default_tier, (
            f"{policy.tool_name}: registry default_tier={policy.default_tier!r} but catalog "
            f"default_approval={catalog.get(policy.tool_name)!r} — update tool_catalog.json "
            "(and re-check R5 semantics) together with tool_prefs.py"
        )


def test_non_configurable_tools_never_default_auto():
    """configurable=False 的固定形状行（send / run_command / 供应链 / CRUD）恒 ask ——
    出厂就 auto 会让「不可配置」变成「不可配置地免卡」，方向反了。"""
    from src.agent_config.tool_prefs import BUILTIN_TOOL_POLICIES

    for policy in BUILTIN_TOOL_POLICIES:
        if not policy.configurable:
            assert policy.default_tier == "ask", policy.tool_name
