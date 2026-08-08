"""trigger.kind → context_mode 派生表的**跨表一致性闸**（三张镜像表锁一处）。

这张表存在三份镜像，改任何一份必须同步另外两份（07-24 schedule-builder 批差点漏改的
正是这类 bug —— 只改 gateway 求值侧，Python 盖章侧仍 fall-through：规则的双键
``(context_mode, agent_id)`` 对不上 → owner 配的免卡规则**永不命中**，恒 HITL）：

1. ``src/api/routers/agent.py::_derive_rule_context_mode`` —— 建规时盖章（写侧权威）
2. ``frontend/src/ai-gateway/agentRun.ts::deriveContextMode`` —— headless run 求值侧
3. ``frontend/src/shared/components/agents/custom-agent/shared.ts::deriveHeadlessMode``
   —— 抽屉展示侧（漏改 = 自动化策略区显示「未配置触发」+ 全部规则标 dormant）

做法镜像本仓先例（``frontend/tests/main/db_version_consistency.test.ts`` 跨语言读源码
锁手抄常量 / ``mailboxSemantics`` 跨语言锁集合，方向相反）：canonical 表就是本文件的
``CONTEXT_MODE_TABLE``；Python 侧穷举断言行为，TS 两份从源码正则抽取分支比对。

🔴 抽取器只认当前的单行习语 ``if (kind === '<kind>' [|| kind === '<kind>']) return '<mode>'``。
若把 TS 函数重构成 switch / 查表对象，本测试会**因抽取失败而红**（不是静默放过）——
这是刻意的：重构者必须回来同步更新抽取器，并顺手核对三张表仍一致。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Set

import pytest

from src.agents.trigger import TriggerValidationError

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_SITES = {
    "gateway deriveContextMode": (
        _REPO_ROOT / "frontend/src/ai-gateway/agentRun.ts",
        "deriveContextMode",
    ),
    "drawer deriveHeadlessMode": (
        _REPO_ROOT / "frontend/src/shared/components/agents/custom-agent/shared.ts",
        "deriveHeadlessMode",
    ),
}

# ── canonical 表（本测试即 SSoT；改语义先改这里再同步三处源码）─────────────────
CONTEXT_MODE_TABLE: Dict[str, str] = {
    "cron": "cron_headless",
    "schedule": "cron_headless",       # 07-24 schedule-builder：与 cron 同为定时 headless
    "email_filter": "untrusted_trigger",
    "calendar_event_change": "untrusted_trigger",
    "calendar_before_start": "untrusted_trigger",
    # 阶段 0b 预置（harness-expansion epic grill Q10=A）：阶段 2 飞书对话的第四场合。
    # parse_trigger 尚不认识 'im'（保存面在阶段 2 才放开），Python 侧靠 parse 前 peek 派生 ——
    # 当前没有任何行能带这个 kind，映射行 dormant。
    "im": "im_chat",
}

_TRIGGER_PAYLOADS = {
    "cron": {"v": 1, "kind": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"},
    "schedule": {
        "v": 1, "kind": "schedule",
        "rule": {"freq": "daily", "interval": 1, "weekdays": [], "monthMode": "date",
                 "monthDay": 1, "ordinal": 1, "weekday": 0, "hour": 9, "minute": 0,
                 "clamp": False},
        "anchor": "2026-07-24", "timezone": "Asia/Shanghai",
    },
    "email_filter": {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批"},
    "calendar_event_change": {"v": 1, "kind": "calendar_event_change"},
    "calendar_before_start": {
        "v": 1, "kind": "calendar_before_start", "lead_seconds": 86400,
    },
    "im": {"v": 1, "kind": "im"},
}


def _derive(kind: str) -> str:
    from src.api.routers.agent import _derive_rule_context_mode

    return _derive_rule_context_mode({"trigger_json": json.dumps(_TRIGGER_PAYLOADS[kind])})


# ── Python 侧：穷举断言 ────────────────────────────────────────────────────────

def test_python_table_exhaustive():
    assert set(_TRIGGER_PAYLOADS) == set(CONTEXT_MODE_TABLE)  # 表与样例 payload 同域
    for kind, mode in CONTEXT_MODE_TABLE.items():
        assert _derive(kind) == mode, f"kind={kind}"


def test_python_unknown_kind_fails_closed_at_parse():
    """未知 kind 在 parse_trigger 就拒（400），永远走不到盖章 —— 不存在隐式档位。
    （'im' 是唯一的显式例外：0b 预置的 parse 前 peek，见 CONTEXT_MODE_TABLE 注释。）"""
    from src.api.routers.agent import _derive_rule_context_mode

    with pytest.raises(TriggerValidationError):
        _derive_rule_context_mode({"trigger_json": '{"v":1,"kind":"webhook"}'})


# ── TS 侧：从源码抽取分支集合比对 ──────────────────────────────────────────────

def _extract_ts_table(path: Path, func_name: str) -> Dict[str, Set[str]]:
    """TS 源码 → {context_mode: {kind, ...}}。抽取失败（函数缺失 / 习语变了）→ 断言红。"""
    assert path.exists(), f"TS mirror moved? {path}"
    src = path.read_text(encoding="utf-8")
    m = re.search(rf"function {func_name}\b.*?\n}}", src, re.DOTALL)
    assert m, f"function {func_name} not found in {path.name} — 镜像函数被移动/改名，更新本闸"
    body = m.group(0)
    table: Dict[str, Set[str]] = {}
    for cond, mode in re.findall(r"if\s*\(([^)]*)\)\s*return\s*'([a-z_]+)'", body):
        kinds = re.findall(r"kind\s*===\s*'([a-z_]+)'", cond)
        assert kinds, f"{func_name}: 分支条件抽不出 kind 字面量（习语变了？）: {cond!r}"
        table.setdefault(mode, set()).update(kinds)
    assert table, f"{func_name}: 一条分支都没抽到 —— 习语重构了，更新本闸的抽取器"
    return table


@pytest.mark.parametrize("label", sorted(_TS_SITES))
def test_ts_mirrors_match_canonical_table(label):
    path, func = _TS_SITES[label]
    ts_table = _extract_ts_table(path, func)
    expected: Dict[str, Set[str]] = {}
    for kind, mode in CONTEXT_MODE_TABLE.items():
        expected.setdefault(mode, set()).add(kind)
    assert ts_table == expected, (
        f"{label} 与 canonical 表漂移：ts={ts_table} expected={expected} —— "
        "三处镜像（agent.py / agentRun.ts / shared.ts）必须同批改"
    )
