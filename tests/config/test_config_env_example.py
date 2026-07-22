"""T2 — config.py ↔ .env.example 双向对账 + validation_alias 不变量（E3 WP1）。

三道断言：
  * 方向 A（test_config_fields_documented）：每个 pydantic 字段的 env 键都应在 .env.example
    出现；历史未文档化的一批用 ratchet baseline 豁免（只许缩小）。新字段忘了写示例 → 红。
  * 方向 B（test_env_example_orphans_explained）：.env.example 里没有 config 字段承接的键，
    必须是已登记的 env-only / Node-read orphan（ratchet baseline）。冒出新 orphan → 红。
  * 不变量（test_env_alias_invariant）：字段名.upper() ≠ env 键时必须用 validation_alias，
    否则 pydantic v2 静默读不到（= 2026-06-30 修的 9-flag env 链断事故类别，config.py:67）。
"""

from pathlib import Path
from typing import Set

from . import _parsers as p

_HERE = Path(__file__).resolve().parent
_MISSING_BASELINE = _HERE / "env_example_missing_baseline.txt"
_ORPHANS_BASELINE = _HERE / "env_example_orphans_baseline.txt"


def _load_baseline(path: Path) -> Set[str]:
    keys: Set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            keys.add(line)
    return keys


def test_config_fields_documented():
    """方向 A：config 字段 env 键 ⊆ .env.example ∪ missing-baseline。"""
    fields = p.parse_config_fields()
    effective_keys = {f.effective_env_key for f in fields}
    # canary：解析器坏了会让 effective_keys 空 → 对账平凡绿。
    assert len(effective_keys) > 100, (
        f"config 字段只解析到 {len(effective_keys)} 个 env 键（预期 >100）—— AST 解析器坏了"
    )

    env_example = p.parse_env_example_keys()
    baseline = _load_baseline(_MISSING_BASELINE)

    undocumented = effective_keys - env_example - baseline
    assert not undocumented, (
        "以下 config.py 字段的 env 键未在 .env.example 文档化，也不在 missing-baseline 里：\n"
        f"  {sorted(undocumented)}\n"
        "→ 请在 .env.example 补示例（裸 `KEY=` 或注释 `# KEY=`）。若确属有意省略的细调项，"
        "再把键加进 tests/config/env_example_missing_baseline.txt（评审可见）。"
    )

    # ratchet：baseline 不该留「其实已文档化」的陈旧豁免（防 baseline 只涨不缩）。
    stale = baseline & env_example
    assert not stale, (
        "missing-baseline 里这些键其实已在 .env.example 出现，应从 baseline 删除（ratchet 收缩）：\n"
        f"  {sorted(stale)}"
    )


def test_env_example_orphans_explained():
    """方向 B：.env.example 键 - config 字段 ⊆ orphans-baseline。"""
    fields = p.parse_config_fields()
    # AliasChoices 的 legacy 兼容键（alias_extras）也算「有字段承接」——它们确实被
    # pydantic 读取（issue #52 DAVMAIL_CIPHER_KEY），文档化不构成 orphan。
    effective_keys = {f.effective_env_key for f in fields} | {
        extra for f in fields for extra in f.alias_extras
    }
    env_example = p.parse_env_example_keys()
    # canary：.env.example 解析器坏了会让 env_example 空 → 平凡绿。
    assert len(env_example) > 50, (
        f".env.example 只解析到 {len(env_example)} 个键（预期 >50）—— key 正则坏了"
    )

    baseline = _load_baseline(_ORPHANS_BASELINE)
    orphans = env_example - effective_keys - baseline
    assert not orphans, (
        "以下键在 .env.example 出现，但没有 config.py 字段承接，也不在 orphans-baseline 里：\n"
        f"  {sorted(orphans)}\n"
        "→ 若它是新的 env-only / Node-read flag，评审确认后登记进 "
        "tests/config/env_example_orphans_baseline.txt；若它本该被 pydantic 读，"
        "多半是字段名≠env 键漏了 validation_alias（见 test_env_alias_invariant）。"
    )

    stale = baseline & effective_keys
    assert not stale, (
        "orphans-baseline 里这些键其实已有 config 字段承接（可能刚被收编 pydantic），"
        "应从 baseline 删除（ratchet 收缩）：\n"
        f"  {sorted(stale)}"
    )


def test_env_alias_invariant():
    """不变量：字段名.upper() ≠ 声明的 env 键 时必须用 validation_alias。

    这是 2026-06-30「9-flag env 链断」事故（Field(env=) 被 pydantic v2 忽略、字段名≠env
    键时静默读不到）的直接机器闸。"""
    fields = p.parse_config_fields()
    assert fields, "config 字段解析为空 —— AST 解析器坏了"

    violations = []
    for f in fields:
        if f.validation_alias is not None:
            continue  # 显式 alias = 安全
        if f.declared_env is not None and f.declared_env != f.field_name.upper():
            violations.append(
                f"{f.field_name}: Field(env={f.declared_env!r}) 但字段名.upper()="
                f"{f.field_name.upper()!r} —— pydantic 会读后者、env {f.declared_env} 静默失效"
            )

    assert not violations, (
        "以下字段的 env 键与字段名.upper() 不符却没用 validation_alias（env 会静默读不到）：\n"
        + "\n".join(f"  {v}" for v in violations)
        + "\n→ 改用 validation_alias=\"<ENV_KEY>\"（见 config.py:67 model_config 注释）。"
    )
