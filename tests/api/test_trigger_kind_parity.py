"""trigger ``kind`` 值域 + schedule ``rule`` 键集的**跨语言一致性闸**（Python 真源 ↔ gateway zod）。

07-24 排程批新增 ``kind:'schedule'`` 时改了 4 处（`trigger.py` / 宽类型 / triggerSummary /
审批卡摘要），独漏 gateway 的输入 allowlist ``frontend/src/ai-gateway/tools/schemas.ts`` 的
``customAgentTriggerSchema`` —— ``.strict()`` 判别式只认 cron|email_filter，于是对话式 CRUD
（custom_agent_create/update）建不出、也改不了排程型 agent（fail-closed，非破口，但能力缺）。
issue #65 补上第三分支后，这里建闸防第四次漏改。

**为什么不能单源化**：同一份「trigger 形状」在三处各司其职且语义不同 ——
``src/agents/trigger.py``（保存时校验权威，深校验）/ ``frontend/src/shared/api/types/report.ts``
（展示用宽类型）/ ``schemas.ts`` zod（模型输入 allowlist，`.strict()` 拒未知键）。
前端另有 ``schedule/types.ts`` 的**宽松 coerce**（纠偏式，语义与严格校验相反），亦不可复用。
消灭不掉镜像 → 建闸，纪律见 CLAUDE.md「跨语言手抄常量必建一致性闸」。

**两侧都抽真源，本文件不持任何一侧的期望值副本**（镜像审计批教训：单侧硬编码的闸只能证明
硬编码那半没变；把错误期望焊死的闸更糟 —— 恒绿还会拦住真正的修复）：
- canonical kind 集 = 从 ``trigger.py::parse_trigger`` 源码抽 ``if kind == "..."`` 分支；
- canonical rule 键集 = 直接 import ``schedule_rule._RULE_KEYS``（私有但确是 wire 键真源：
  公开的 ``ScheduleRule`` dataclass 字段是 snake_case，与 camelCase wire 键比不了）；
- 两侧再各自与 zod 源码抽出的集合比对。Python 侧另有行为断言（真调 ``parse_trigger``）兜住
  「样例 payload 自己过期」的情形。

🔴 抽取失败必须**红**而不是空集恒真：三个抽取器在函数缺失 / 习语重构 / 一条没抽到时全部
断言失败。重构 zod 写法（拆常量、换 ``z.union``）的人必须回来更新抽取器，顺手核对镜像仍一致。
反向用例（``test_gate_*_would_go_red``）用**合成源码**证明闸真会红 —— 不用「删真源里的键」那招，
因为真漂移在场时说不清是闸红了还是源坏了。

姊妹闸：``tests/api/test_context_mode_consistency.py`` 锁的是同一个 ``kind`` 域**派生出的**
``context_mode`` 表（三处镜像）。加第四个 kind 时两处都会红。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Set

import pytest

# 私有 import 是有意的：``_RULE_KEYS`` 就是契约 §1 的 10 个 wire 键的真源。
from src.agents.schedule_rule import _RULE_KEYS
from src.agents.trigger import TriggerValidationError, parse_trigger

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_SOURCE = _REPO_ROOT / "src/agents/trigger.py"
_TS_SOURCE = _REPO_ROOT / "frontend/src/ai-gateway/tools/schemas.ts"

# 三种 kind 各一份**契约合法**的 payload（schedule 那份天然覆盖全 10 键 —— parse_rule 少一键即拒，
# 故这份 payload 漏键会在行为断言处红）。
_LEGAL_PAYLOADS = {
    "cron": {"v": 1, "kind": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"},
    "schedule": {
        "v": 1,
        "kind": "schedule",
        "rule": {
            "freq": "weekly",
            "interval": 2,
            "weekdays": [1, 5],
            "monthMode": "date",
            "monthDay": 1,
            "ordinal": "last",
            "weekday": 0,
            "hour": 9,
            "minute": 30,
            "clamp": False,
        },
        "anchor": "2026-07-24",
        "timezone": "America/Los_Angeles",
    },
    "email_filter": {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批"},
}


# ── 抽取器（源码 → 集合；抽不到一律断言红）────────────────────────────────────

def _extract_python_kinds(src: str, *, origin: str) -> Set[str]:
    """``parse_trigger`` 体内的 ``if kind == "<kind>"`` 分支集合 = 服务端认的 kind 值域。"""
    body = re.search(r"\ndef parse_trigger\b.*?(?=\ndef )", src, re.DOTALL)
    assert body, f"{origin}: parse_trigger 没抽到 —— 校验权威被移动/改名，更新本闸的抽取器"
    kinds = set(re.findall(r'if kind == "([a-z_]+)"', body.group(0)))
    assert kinds, f"{origin}: parse_trigger 里一个 kind 字面量都没抽到 —— 习语重构了，更新本闸"
    return kinds


_TS_UNION_RE = re.compile(
    r"export const customAgentTriggerSchema = z\.discriminatedUnion\('kind',\s*\[\n(.*?)\n\]\)",
    re.DOTALL,
)
_TS_RULE_RE = re.compile(r"rule: z\n\s*\.object\(\{\n(.*?)\n\s*\}\)", re.DOTALL)


def _extract_ts_union_block(src: str, *, origin: str) -> str:
    m = _TS_UNION_RE.search(src)
    assert m, (
        f"{origin}: customAgentTriggerSchema 的 z.discriminatedUnion 块没抽到 —— "
        "判别式被改写（拆成常量 / 换 z.union / 换引号？），更新本闸的抽取器"
    )
    return m.group(1)


def _extract_ts_kinds(src: str, *, origin: str) -> Set[str]:
    block = _extract_ts_union_block(src, origin=origin)
    kinds = set(re.findall(r"kind: z\.literal\('([a-z_]+)'\)", block))
    assert kinds, f"{origin}: 判别式里一个 z.literal('<kind>') 都没抽到 —— 习语变了，更新本闸"
    return kinds


def _extract_ts_rule_keys(src: str, *, origin: str) -> Set[str]:
    block = _extract_ts_union_block(src, origin=origin)
    m = _TS_RULE_RE.search(block)
    assert m, (
        f"{origin}: schedule 分支的 rule 对象没抽到 —— 分支被删或 rule 写法变了，更新本闸"
    )
    keys = set(re.findall(r"^\s*(\w+):", m.group(1), re.M))
    assert keys, f"{origin}: rule 对象里一个键都没抽到 —— 习语变了，更新本闸的抽取器"
    return keys


def _read(path: Path) -> str:
    assert path.exists(), f"镜像文件搬家了？{path}"
    return path.read_text(encoding="utf-8")


# ── Python 侧：真源值域 + 行为断言 ────────────────────────────────────────────

def test_payloads_cover_the_python_kind_domain():
    """样例 payload 必须穷举 trigger.py 认的每一种 kind（后端加第四种 → 这里先红）。"""
    kinds = _extract_python_kinds(_read(_PY_SOURCE), origin=str(_PY_SOURCE))
    assert kinds == set(_LEGAL_PAYLOADS), (
        f"trigger.py 的 kind 值域={sorted(kinds)}，本闸的样例 payload="
        f"{sorted(_LEGAL_PAYLOADS)} —— 新增/删除 kind 必须同批更新本闸与 gateway zod"
    )


@pytest.mark.parametrize("kind", sorted(_LEGAL_PAYLOADS))
def test_legal_payload_parses(kind: str):
    """每份样例都真过 parse_trigger（抽取到的分支确实可达，且样例没过期）。"""
    assert parse_trigger(_LEGAL_PAYLOADS[kind]) is not None


def test_unknown_kind_is_rejected():
    """值域是闭集：没有第四种被静默接受的 kind。"""
    with pytest.raises(TriggerValidationError):
        parse_trigger({"v": 1, "kind": "webhook"})


# ── gateway zod 侧：与 Python 真源比对 ───────────────────────────────────────

def test_gateway_zod_kinds_match_python():
    py = _extract_python_kinds(_read(_PY_SOURCE), origin=str(_PY_SOURCE))
    ts = _extract_ts_kinds(_read(_TS_SOURCE), origin=str(_TS_SOURCE))
    assert ts == py, (
        f"gateway zod 判别式={sorted(ts)} 与 trigger.py={sorted(py)} 漂移 —— "
        "少一种 = 对话式 CRUD 建不出该类 agent（issue #65 病根）；"
        "多一种 = 模型能提一个服务端必拒的形状"
    )


def test_gateway_zod_rule_keys_match_python():
    ts = _extract_ts_rule_keys(_read(_TS_SOURCE), origin=str(_TS_SOURCE))
    assert ts == set(_RULE_KEYS), (
        f"gateway zod 的 schedule rule 键={sorted(ts)} 与 schedule_rule._RULE_KEYS="
        f"{sorted(_RULE_KEYS)} 漂移 —— 契约 §1 要求 10 键全量必填，多/少键两侧都拒，"
        "任何一侧单改都会让模型提的排程恒被另一侧拒"
    )


# ── 反向用例：合成源码证明闸真会红 ───────────────────────────────────────────

_SYNTHETIC_TWO_KINDS = """
export const customAgentTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      cron: z.string().min(1).max(256)
    })
    .strict(),
  z
    .object({
      kind: z.literal('email_filter'),
      subject_pattern: z.string().max(256).optional()
    })
    .strict()
])
"""

_SYNTHETIC_REFACTORED = """
const cronBranch = z.object({ kind: z.literal('cron') }).strict()
export const customAgentTriggerSchema = z.union([cronBranch, scheduleBranch])
"""

_SYNTHETIC_RULE_SHORT_ONE_KEY = """
export const customAgentTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('schedule'),
      rule: z
        .object({
          freq: z.enum(['daily', 'weekly', 'monthly']),
          interval: z.number().int().min(1),
          weekdays: z.array(z.number().int().min(0).max(6)).max(7),
          monthMode: z.enum(['date', 'nth']),
          monthDay: z.number().int().min(1).max(31),
          weekday: z.number().int().min(0).max(6),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          clamp: z.boolean()
        })
        .strict(),
      anchor: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
      timezone: z.string().min(1).max(64)
    })
    .strict()
])
"""


def test_gate_kind_drift_would_go_red():
    """漏掉 schedule 分支的 zod（= issue #65 修复前的形状）必须比对不上。"""
    ts = _extract_ts_kinds(_SYNTHETIC_TWO_KINDS, origin="<synthetic>")
    py = _extract_python_kinds(_read(_PY_SOURCE), origin=str(_PY_SOURCE))
    assert ts != py, "合成的两分支 zod 竟与 Python 值域相等 —— 本闸对漂移无感"


def test_gate_extractor_failure_would_go_red():
    """判别式被重构成 z.union / 抽不到块 —— 必须断言失败，不是静默返回空集。"""
    with pytest.raises(AssertionError):
        _extract_ts_kinds(_SYNTHETIC_REFACTORED, origin="<synthetic>")
    with pytest.raises(AssertionError):
        _extract_python_kinds("def parse_something_else():\n    pass\n\ndef x():\n", origin="<s>")


def test_gate_rule_key_drift_would_go_red():
    """zod rule 少一个键（ordinal）必须比对不上 _RULE_KEYS。"""
    keys = _extract_ts_rule_keys(_SYNTHETIC_RULE_SHORT_ONE_KEY, origin="<synthetic>")
    assert keys != set(_RULE_KEYS), "合成的 9 键 rule 竟与 _RULE_KEYS 相等 —— 本闸对漂移无感"
