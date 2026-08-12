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


# ── Matters MVP P4 D5：第五 context mode `matter_followup` 的**独立**断言节 ──────────────────
#
# 🔴 它刻意**不进**上面那张 trigger-kind 表：`matter_followup` 不是 trigger 的一种，而是服务端
# spec 上的 `runKind` 盖章字段（`src/matters/run_spec.py`）。Matter 手动跟进的 trigger.kind 恒为
# 'manual'，若走 kind 阶梯会 fail-close 到 untrusted_trigger —— 安全方向没错，但**那一档仍放行
# domain_write**，正是本 mode 要禁掉的东西。`deriveHeadlessMode`（shared.ts，custom-agent 抽屉的
# 展示镜像）同理**不加**这一支：Matter run 不是 custom-agent 规则场景。
#
# 🔴 与上面那张表的物理隔离：runKind 分支在 agentRun.ts 里写成**花括号块**
# （`if (...) {\n return '...'\n}`），因为 `_extract_ts_table` 的习语是 `if (…) return '…'` 单行
# 且**要求**条件里抽得出 `kind === '…'`；单行写法会被它抓到却抽不出 kind → 那张表的闸会误红。
# 块写法对它不可见，本节的抽取器则专抓块写法。两边各自抽取失败都必须红，不许静默跳过。

_AGENT_RUN_TS = _REPO_ROOT / "frontend/src/ai-gateway/agentRun.ts"
_POLICY_TS = _REPO_ROOT / "frontend/src/ai-gateway/tools/policy.ts"
MATTER_FOLLOWUP_MODE = "matter_followup"


def _read(path: Path) -> str:
    assert path.exists(), f"TS 源文件移动了？{path}"
    return path.read_text(encoding="utf-8")


def test_run_kind_branch_precedes_the_whole_trigger_kind_ladder():
    """agentRun.ts：runKind 分支存在，且位于 kind 阶梯**之前**（顺序即语义）。"""
    src = _read(_AGENT_RUN_TS)
    match = re.search(r"function deriveContextMode\b.*?\n}", src, re.DOTALL)
    assert match, "deriveContextMode 不见了 —— 镜像函数被移动/改名，更新本闸"
    body = match.group(0)

    branch = re.search(
        r"if\s*\(\s*spec\.runKind\s*===\s*'(?P<kind>[a-z_]+)'\s*\)\s*\{\s*"
        r"return\s*'(?P<mode>[a-z_]+)'",
        body,
    )
    assert branch, (
        "抽不到 runKind 分支（习语变了？）—— 期望块写法 "
        "`if (spec.runKind === 'matter_followup') { return 'matter_followup' }`；"
        "🔴 别改成单行，那会让上面的 trigger-kind 表抽取器误红"
    )
    assert branch.group("kind") == MATTER_FOLLOWUP_MODE
    assert branch.group("mode") == MATTER_FOLLOWUP_MODE

    ladder = re.search(r"const kind\s*=\s*spec\.trigger", body)
    assert ladder, "kind 阶梯的起点（`const kind = spec.trigger…`）不见了 —— 更新本闸"
    assert branch.start() < ladder.start(), (
        "runKind 分支跑到 kind 阶梯后面去了：Matter run 的 trigger.kind='manual' 会先被阶梯"
        "fail-close 成 untrusted_trigger（那一档放行 domain_write）—— 顺序就是语义"
    )


def test_policy_registers_the_fifth_mode():
    src = _read(_POLICY_TS)
    modes = re.search(r"AGENT_CONTEXT_MODES\s*=\s*\[(.*?)\]", src, re.DOTALL)
    assert modes, "AGENT_CONTEXT_MODES 抽取失败 —— 习语变了，更新本闸"
    names = re.findall(r"'([a-z_]+)'", modes.group(1))
    assert names, "AGENT_CONTEXT_MODES 里一个 mode 都没抽到 —— 抽取器坏了"
    assert MATTER_FOLLOWUP_MODE in names, (
        f"{MATTER_FOLLOWUP_MODE} 不在 AGENT_CONTEXT_MODES 里 —— "
        "normalizeContextMode 会把它 fail-close 成 untrusted_trigger，整个跟进 venue 形同虚设"
    )


def test_matter_followup_matrix_branch_precedes_the_generic_pass():
    """policy.ts：matter_followup 分支必须在「read/domain_write/artifact 全放行」那行**之前**。

    那一行对所有非 manual mode 无条件放行 domain_write；插在它后面 = 分支永不生效、写工具照发。

    0812 owner 拍板后分支体是**块**（read/artifact 恒放行 + web 仅 grant 下放行 + 其余
    `return false`）—— 本闸钉：① 顺序（分支在通用放行行之前）② 分支体提到的 class 恰为
    read/artifact/web ③ web 那行必须 grant 条件（`grants?.web`，不许写成无条件放行）
    ④ 分支体以 `return false` 收尾（domain_write/connector_write/exec/capability_change/
    outbound 在这个 venue 结构性拿不到 —— 「一个写工具都不给」的矩阵侧形态）。
    """
    src = _read(_POLICY_TS)
    match = re.search(r"export function isToolClassAllowedInMode\b.*?\n}", src, re.DOTALL)
    assert match, "isToolClassAllowedInMode 不见了 —— 更新本闸"
    body = match.group(0)

    branch = re.search(
        rf"if\s*\(\s*mode\s*===\s*'{MATTER_FOLLOWUP_MODE}'\s*\)\s*\{{(?P<block>.*?)\n  \}}",
        body,
        re.DOTALL,
    )
    assert branch, f"抽不到 {MATTER_FOLLOWUP_MODE} 的矩阵分支块（习语变了？）—— 更新本闸"
    # 🔴 通用放行行的锚要求 'read' 后紧跟 'domain_write'（分支体内的
    # `toolClass === 'read' || toolClass === 'artifact'` 不许被它误认）。
    generic = re.search(
        r"if\s*\(\s*toolClass\s*===\s*'read'\s*\|\|\s*toolClass\s*===\s*'domain_write'"
        r".*?\)\s*return true",
        body,
        re.DOTALL,
    )
    assert generic, "抽不到 read/domain_write/artifact 通用放行行 —— 更新本闸"
    assert branch.start() < generic.start(), (
        "matter_followup 分支排在通用放行行之后：domain_write 会在它之前被无条件放行，"
        "跟进 run 将拿到全部 Matter 写工具"
    )

    block = branch.group("block")
    allowed = set(re.findall(r"toolClass\s*===\s*'([a-z_]+)'", block))
    assert allowed == {"read", "artifact", "web"}, (
        f"matter_followup 分支提到的 class 集合变了：{sorted(allowed)}"
        "（期望 read + artifact + web —— 多出成员 = 有 venue 放宽没过裁决，少了 = 读面塌了）"
    )
    web_line = re.search(r"toolClass\s*===\s*'web'.*", block)
    assert web_line and "grants?.web" in web_line.group(0), (
        "web 在 matter_followup 分支里必须是 grant 条件放行（`grants?.web === 'gated'/'open'`）"
        "—— 无条件放行 = spec 没授权也注册出网工具"
    )
    assert re.search(r"return false\s*$", block.strip()), (
        "matter_followup 分支体必须以 `return false` 收尾 —— 少了它，未列出的 class 会落进"
        "下面的 grant 阶梯（grantExec 将能在这个 venue 抬起 exec）"
    )
