"""中文 AI priority 枚举的**三处一致性闸**（issue #68）。

同一组中文标签在三处独立出现，历史上零互引：
- ``src/llm_agent/schema.py::PRIORITY_ENUM`` —— **真源**（Anthropic tool schema 的 enum，
  即 LLM 被允许输出的值域，本身对齐 Notion email DB 的 `AI Priority` select 选项）；
- ``src/kos/producer.py::_CN_PRIORITY_MAP`` —— 中文标签 → 英文档位，KOS 入库 payload 用；
- ``frontend/src/shared/lib/ai_mapping.ts::mapPriority`` —— 中文标签 → 前端 `AIPriority`。

🔴 **漂了怎么静默失败**：给 `PRIORITY_ENUM` 加第 5 档（比如给 urgent 补一个中文标签）而
忘了另两处 —— `_normalize_priority` 认不出就 **静默降成 `normal`**，于是这封高优邮件被
`KOS_INGEST_PRIORITY_FLOOR` 当普通件滤掉/放行错档，KOS 侧看不出任何异常；前端 `mapPriority`
认不出则返回 `null`，列表上那枚优先级点直接不渲染。两种都不报错。

**为什么不能全单源**：两个下游持的是**映射**（标签 → 各自的英文/UI 档位），不是值域副本，
派生不出来。能单源的那部分已经没有了 → 建闸，纪律见 CLAUDE.md。

**两侧都抽真源，本文件不持任何一侧的期望值副本**：Python 两处直接 import（同语言，比文本
抽取强）；TS 侧从 ``ai_mapping.ts`` 源码抽 `mapPriority` 的**有序**分支表并按首个命中求值
（`if` 链先到先得，顺序是语义的一部分）。抽取失败一律断言红。

**有意的不对称**（不是漂移，别"顺手对齐"）：`mapPriority` 认的标签是 canonical 的**超集** ——
它额外接 `紧迫/严重 → urgent` 与各档的英文名，源码注释写明是为「未来出现更高档时也能正确
渲染」预留的。故本闸只钉**方向**：canonical 的每个标签在 TS 侧必须命中、且落到与
`_CN_PRIORITY_MAP` 一致的档位；TS 多认的分支不管。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Tuple

import pytest

from src.kos.producer import _CN_PRIORITY_MAP, _PRIORITY_ORDER
from src.llm_agent.schema import PRIORITY_ENUM

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_SOURCE = _REPO_ROOT / "frontend/src/shared/lib/ai_mapping.ts"

# 抽 `if (raw.includes('紧急') || raw.includes('Critical')) return 'critical'` 这一族。
_TS_BRANCH_RE = re.compile(
    r"^\s*if \((?P<conds>raw\.includes\('[^']+'\)(?:\s*\|\|\s*raw\.includes\('[^']+'\))*)\)"
    r"\s*return '(?P<bucket>[a-z]+)'",
    re.M,
)
_TS_NEEDLE_RE = re.compile(r"raw\.includes\('([^']+)'\)")


def _extract_ts_branches(src: str, *, origin: str) -> List[Tuple[List[str], str]]:
    """``mapPriority`` 体内的 if 链 → **有序** [(命中子串们, 返回档位)]。"""
    body = re.search(
        r"export function mapPriority\b.*?\n\}", src, re.DOTALL
    )
    assert body, (
        f"{origin}: mapPriority 函数体没抽到 —— 被改名 / 换成 map 查表 / 换成 switch 了？"
        "更新本闸的抽取器，并顺手核对三处映射仍一致"
    )
    branches = [
        (_TS_NEEDLE_RE.findall(m.group("conds")), m.group("bucket"))
        for m in _TS_BRANCH_RE.finditer(body.group(0))
    ]
    assert branches, (
        f"{origin}: mapPriority 里一条 `if (raw.includes('…')) return '…'` 都没抽到 —— "
        "习语变了，更新本闸的抽取器"
    )
    return branches


def _ts_map_priority(label: str, branches: List[Tuple[List[str], str]]) -> str | None:
    """按源码顺序复刻首个命中即返回的语义（顺序是语义的一部分）。"""
    for needles, bucket in branches:
        if any(n in label for n in needles):
            return bucket
    return None


def _read_ts() -> str:
    assert _TS_SOURCE.exists(), f"镜像文件搬家了？{_TS_SOURCE}"
    return _TS_SOURCE.read_text(encoding="utf-8")


# ── Python 两处：同语言，直接 import 对撞 ────────────────────────────────────

def test_kos_map_covers_exactly_the_canonical_enum():
    assert set(_CN_PRIORITY_MAP) == set(PRIORITY_ENUM), (
        f"KOS 的中文 priority 映射键={sorted(_CN_PRIORITY_MAP)} 与 tool schema 的"
        f"PRIORITY_ENUM={sorted(PRIORITY_ENUM)} 漂移 —— 少一个 = 该档被 "
        "_normalize_priority **静默降成 normal**（高优邮件按普通件走 KOS floor，零报错）；"
        "多一个 = 映射了一个 LLM 根本产不出的标签"
    )


def test_kos_map_targets_are_known_priority_tiers():
    unknown = set(_CN_PRIORITY_MAP.values()) - set(_PRIORITY_ORDER)
    assert not unknown, (
        f"映射目标 {sorted(unknown)} 不在 _PRIORITY_ORDER={_PRIORITY_ORDER} 里 —— "
        "priority_at_or_above / floor 比较会拿不到序号"
    )


# ── 跨语言：canonical 的每个标签在 TS 侧必须命中同一档位 ─────────────────────

def test_ts_mapper_covers_every_canonical_label():
    branches = _extract_ts_branches(_read_ts(), origin=str(_TS_SOURCE))
    misses = [label for label in PRIORITY_ENUM if _ts_map_priority(label, branches) is None]
    assert not misses, (
        f"前端 mapPriority 认不出 canonical 标签 {misses} —— 返回 null 时列表上那枚"
        "优先级点**直接不渲染**，且不报错。加档位必须同批改 ai_mapping.ts"
    )


def test_ts_mapper_agrees_with_kos_on_every_canonical_label():
    branches = _extract_ts_branches(_read_ts(), origin=str(_TS_SOURCE))
    disagree = {
        label: (_ts_map_priority(label, branches), _CN_PRIORITY_MAP[label])
        for label in PRIORITY_ENUM
        if _ts_map_priority(label, branches) != _CN_PRIORITY_MAP[label]
    }
    assert not disagree, (
        f"同一标签在前端与 KOS 落到不同档位 {disagree} —— 用户看到的优先级与 KOS 里"
        "存的对不上，排查时两边各自都'正确'"
    )


# ── 反向用例：合成源码证明闸真会红 ───────────────────────────────────────────

_SYNTHETIC_MISSING_LOW = """
export function mapPriority(raw: string | null | undefined): AIPriority | null {
  if (raw.includes('紧急') || raw.includes('Critical')) return 'critical'
  if (raw.includes('重要') || raw.includes('Important')) return 'important'
  if (raw.includes('一般') || raw.includes('Normal')) return 'normal'
  return null
}
"""

_SYNTHETIC_WRONG_BUCKET = """
export function mapPriority(raw: string | null | undefined): AIPriority | null {
  if (raw.includes('紧急') || raw.includes('Critical')) return 'urgent'
  if (raw.includes('重要') || raw.includes('Important')) return 'important'
  if (raw.includes('一般') || raw.includes('Normal')) return 'normal'
  if (raw.includes('低') || raw.includes('Low')) return 'low'
  return null
}
"""

_SYNTHETIC_REFACTORED = """
const PRIORITY_TABLE = { '紧急': 'critical' } as const
export function mapPriority(raw: string | null | undefined): AIPriority | null {
  return PRIORITY_TABLE[raw] ?? null
}
"""


def test_gate_missing_label_would_go_red():
    branches = _extract_ts_branches(_SYNTHETIC_MISSING_LOW, origin="<synthetic>")
    misses = [label for label in PRIORITY_ENUM if _ts_map_priority(label, branches) is None]
    assert misses, "少了 ⚪ 低 分支的合成源码竟全命中 —— 本闸对漏档无感"


def test_gate_wrong_bucket_would_go_red():
    branches = _extract_ts_branches(_SYNTHETIC_WRONG_BUCKET, origin="<synthetic>")
    disagree = [
        label
        for label in PRIORITY_ENUM
        if _ts_map_priority(label, branches) != _CN_PRIORITY_MAP[label]
    ]
    assert disagree, "把 🔴 紧急 映成 urgent 的合成源码竟与 KOS 一致 —— 本闸对错档无感"


def test_gate_extractor_failure_would_go_red():
    """mapPriority 换成查表/switch 时必须断言失败，不是静默返回空分支表恒真。"""
    with pytest.raises(AssertionError):
        _extract_ts_branches(_SYNTHETIC_REFACTORED, origin="<synthetic>")
    with pytest.raises(AssertionError):
        _extract_ts_branches("export function mapLanguage() {}\n", origin="<synthetic>")
