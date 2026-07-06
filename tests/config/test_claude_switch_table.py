"""T4 — CLAUDE.md「关键开关现状」表对账（宽松版，E3 WP1）。

表是人肉维护的「flag → 代码默认」精选表，历史上漂移过（e3 方案举的
agent_harness_enabled=True vs 表中 false）。本测试把表里**能干净解析**的行的默认值列与
代码实际默认对账；表格式复杂（默认列常带长说明、多 flag 混排、非 bool 默认），解析走
宽松策略：解析不了的行跳过并计数，用 skip 上限 + 可对账下限 + canary 键防「解析器静默失效
退化成全 skip = 平凡绿」。

WP0 实测现状 0 漂移 → 应立即绿。cutover 后这几行默认字面量若不同步改 → 本测试红
（表本身成为下一轮漂移源前先被拦下）。
"""


from . import _parsers as p

# 表里可对账行的下限 / skip 行的上限 —— 解析器失效会让 comparable 掉到 0、skip 冲高，
# 这两个哨兵把「退化成全 skip」拦成红。当前实测：comparable≈20 行、skip≈3 行。
_MIN_COMPARABLE = 15
_MAX_SKIPPED = 8
# canary：这些关键 flag 必须落在「可对账」集合里（解析器认得它们）。
_CANARY_KEYS = {
    "MAILAGENT_BACKEND",
    "LLM_AGENT_ENABLED",
    "MAILAGENT_CUSTOM_AGENTS_ENABLED",
    "FEISHU_NOTIFY_ENABLED",
}


def _resolve_code_default(env_key, config_by_key, env_bool, hot_bool):
    """按载体优先级解析 flag 的代码默认值（bool 或 enum str）；解析不到返回 (None, reason)。"""
    if env_key in config_by_key:  # pydantic
        default = config_by_key[env_key]
        if isinstance(default, (bool, str)):
            return default, None
        return None, f"config 字段默认非 bool/str 常量（={default!r}）"
    if env_key in env_bool:  # Node envBool
        return env_bool[env_key], None
    if env_key in hot_bool:  # Python env-only 热读
        d = hot_bool[env_key]
        if isinstance(d, bool):
            return d, None
        return None, f"_hot_bool fallback 非字面量（={d!r}，跟随 pydantic）"
    return None, "在 config / envBool / _hot_bool 三载体里都找不到"


def _default_matches(code_default, table_literal) -> bool:
    if isinstance(code_default, bool):
        return table_literal == ("true" if code_default else "false")
    return code_default == table_literal  # enum str


def test_switch_table_defaults_match_code():
    fields = p.parse_config_fields()
    config_by_key = {f.effective_env_key: f.default for f in fields if f.default is not p._NO_LITERAL}
    env_bool = p.parse_env_bool_defaults() if p.GATEWAY_LIFECYCLE.exists() else {}
    hot_bool = p.parse_hot_bool_defaults()

    rows = p.parse_switch_table()
    assert rows, "CLAUDE.md 开关表解析为空 —— parse_switch_table 坏了"

    comparable_keys = set()
    skipped_rows = 0
    mismatches = []
    unresolved = []

    for row in rows:
        if not row.comparable:
            skipped_rows += 1
            continue
        for env_key in row.full_keys:
            code_default, reason = _resolve_code_default(env_key, config_by_key, env_bool, hot_bool)
            if code_default is None:
                # 载体缺失（如无 frontend 时 Node-only flag）不算硬失败，记为 unresolved。
                unresolved.append(f"{env_key}: {reason}")
                continue
            comparable_keys.add(env_key)
            if not _default_matches(code_default, row.default_literal):
                mismatches.append(
                    f"{env_key}: CLAUDE.md 表默认={row.default_literal!r} 但代码默认="
                    f"{code_default!r}"
                )

    assert not mismatches, (
        "CLAUDE.md 开关表的默认值与代码实测不符（表漂移了）：\n"
        + "\n".join(f"  {m}" for m in mismatches)
        + "\n→ 改 CLAUDE.md「关键开关现状」表的默认列，或修代码默认。"
    )

    # 防「解析器静默失效退化成全 skip」：可对账下限 + skip 上限 + canary。
    assert len(comparable_keys) >= _MIN_COMPARABLE, (
        f"只对账了 {len(comparable_keys)} 个 flag（下限 {_MIN_COMPARABLE}）—— 表解析器可能失效。"
        f"\n  可对账：{sorted(comparable_keys)}\n  unresolved：{unresolved}"
    )
    assert skipped_rows <= _MAX_SKIPPED, (
        f"skip 了 {skipped_rows} 行（上限 {_MAX_SKIPPED}）—— 表格式变了或解析器退化，请检查 "
        "parse_switch_table 是否还认得默认列。"
    )
    # 无 frontend 时 Node-only flag（如 SKILL_SELF_MOUNT）无法解析属正常，故 canary 仅在
    # frontend 在场时严格校验；纯 pydantic canary（如 LLM_AGENT_ENABLED）恒可解析。
    if p.GATEWAY_LIFECYCLE.exists():
        canary_absent = _CANARY_KEYS - comparable_keys
        assert not canary_absent, (
            f"canary flag 未落进可对账集合（表解析器认不出它们）：{sorted(canary_absent)}"
        )
