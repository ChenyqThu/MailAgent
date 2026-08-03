"""闸 13/14/15 — custom agent 的三处跨语言手抄契约。

本文件的三道闸都来自 07-28 custom-agent 体验 epic 的 review（见
`.trellis/tasks/08-02-custom-agent-epic-review-lint/prd.md` F2/F3/F5）：epic 自己建了两道好闸
（report block 词表、chat origin filter），却漏了它同批改动的这三处。

**为什么是「建闸」而不是「消灭镜像」**（CLAUDE.md 要求先问这个问题）：

* **能力档工具集 ↔ headless 可选工具集**：两者不是同一份数据的两份拷贝 —— Python 侧
  ``HEADLESS_TOOL_OPTIONS`` 是「headless run 能挂哪些工具」的清单（后端权威，端点直接投影给
  前端），TS 侧 ``CUSTOM_AGENT_CAPABILITY_TOOL_SETS`` 是「这些工具怎么分成六张能力卡的档位」的
  产品语义。**但分档必须恰好覆盖清单全集**：清单里有而没被任何档收录的工具，用户一动能力卡就
  会被 ``replaceToolCapability`` 判为「非 managed」而永久滞留；档里有而清单里没有的名字，写进
  ``allowed_tools`` 后会被 gateway 的交集（``agentRun.ts`` ``wrapCfgForAgentRun``）默默丢掉 ——
  UI 显示该档已开，实际那个工具根本不存在。故闸的形式 = **两个集合精确相等**。
  单源化要走构建期代码生成（Python → TS 常量），成本高于本闸且给打包链引入新步骤。
* **``AGENT_RUN_STATES`` ↔ ``AgentRunState``**：TS 侧是 union **类型**（编译期构件，
  ``assertNever`` 靠它穷举），Python 侧是运行时 ``frozenset``（``/api/agent-runs`` 的 state 过滤
  值域校验要用）。一个编译期一个运行时，无法互相 import。原代码注释称「assertNever 会强制 UI
  侧同步」—— 那只在 TS **内部**成立：Python 加第 10 个 state 时 TS 毫无感知，多出来的 state 会
  让 ``STATE_VISUAL`` 查表落空。
* **``max_run_seconds`` 的默认/上限**：TS 侧是 gateway 边界的防御性 re-clamp（防 stale/畸形
  spec 复活已退役的 5 分钟超时）。它有意是第二道防线，不能直接信 spec —— 但两侧数字必须同源，
  否则 Python 抬了上限而 TS 不动 = gateway 按旧顶提前 abort，run 在没到预算时就被杀。

🔴 三道闸的解析器全部「抽取失败必红」：抓不到目标结构就抛，且各带 count/成员 canary ——
空集 == 空集恒真是这类闸最常见的失效形态（见 architecture-internals.md）。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Dict, Set, Tuple

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_RUNS_PY = REPO_ROOT / "src/api/routers/agent_runs.py"
RUN_STATE_PY = REPO_ROOT / "src/agents/run_state.py"
TRIGGER_PY = REPO_ROOT / "src/agents/trigger.py"
CAPABILITIES_TS = REPO_ROOT / "frontend/src/shared/lib/customAgentCapabilities.ts"
REPORT_TYPES_TS = REPO_ROOT / "frontend/src/shared/api/types/report.ts"
AGENT_RUN_TS = REPO_ROOT / "frontend/src/ai-gateway/agentRun.ts"


# =============================================================================
# 解析器（抽取失败一律抛，绝不返回空）
# =============================================================================


def _py_module(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def parse_py_pair_tuple(name: str, path: Path) -> Dict[str, str]:
    """模块级 ``NAME: T = (("a", "b"), ...)`` → dict。非二元组元素即抛。"""
    for stmt in _py_module(path).body:
        target = None
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            target = stmt.target.id
        elif (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
        ):
            target = stmt.targets[0].id
        if target != name or stmt.value is None:
            continue
        if not isinstance(stmt.value, (ast.Tuple, ast.List)):
            raise AssertionError(f"{path.name}:{name} 右值不是 tuple/list 字面量 —— 解析器需更新")
        out: Dict[str, str] = {}
        for elt in stmt.value.elts:
            if not isinstance(elt, (ast.Tuple, ast.List)) or len(elt.elts) != 2:
                raise AssertionError(f"{path.name}:{name} 含非二元组元素 —— 解析器需更新")
            key, value = elt.elts
            if not (
                isinstance(key, ast.Constant)
                and isinstance(key.value, str)
                and isinstance(value, ast.Constant)
                and isinstance(value.value, str)
            ):
                raise AssertionError(f"{path.name}:{name} 含非字符串常量 —— 解析器需更新")
            out[key.value] = value.value
        return out
    raise AssertionError(f"{path.name}: 没找到模块级 `{name} = (...)` —— 解析器需更新")


def parse_py_frozenset(name: str, path: Path) -> Set[str]:
    """模块级 ``NAME = frozenset({...})`` → set。"""
    for stmt in _py_module(path).body:
        if not (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and stmt.targets[0].id == name
        ):
            continue
        call = stmt.value
        if not (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "frozenset"
            and len(call.args) == 1
        ):
            raise AssertionError(f"{path.name}:{name} 不再是 `frozenset({{...}})` —— 解析器需更新")
        literal = call.args[0]
        if not isinstance(literal, (ast.Set, ast.List, ast.Tuple)):
            raise AssertionError(f"{path.name}:{name} 的 frozenset 参数不是字面量 —— 解析器需更新")
        out: Set[str] = set()
        for elt in literal.elts:
            if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
                raise AssertionError(f"{path.name}:{name} 含非字符串元素 —— 解析器需更新")
            out.add(elt.value)
        return out
    raise AssertionError(f"{path.name}: 没找到 `{name} = frozenset(...)` —— 解析器需更新")


def parse_py_int_const(name: str, path: Path) -> int:
    """模块级 ``NAME = <int>``。"""
    for stmt in _py_module(path).body:
        if not (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and stmt.targets[0].id == name
        ):
            continue
        if not (isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, int)):
            raise AssertionError(f"{path.name}:{name} 不是整数字面量 —— 解析器需更新")
        return stmt.value.value
    raise AssertionError(f"{path.name}: 没找到 `{name} = <int>` —— 解析器需更新")


_TS_CONST_ARRAY_RE = re.compile(
    r"const\s+([A-Z][A-Z0-9_]*)\s*=\s*\[(.*?)\]\s*as\s+const", re.S
)
_TS_QUOTED_RE = re.compile(r"'([^']+)'")


def parse_ts_tool_constants(src: str) -> Dict[str, Set[str]]:
    """``customAgentCapabilities.ts`` 里所有 ``const XXX = [...] as const`` → {常量名: 工具名集合}。

    数组里的 ``...OTHER_TOOLS`` 展开由调用方按引用关系闭包（见 capability_card_tools）。
    """
    out: Dict[str, Set[str]] = {}
    for name, body in _TS_CONST_ARRAY_RE.findall(src):
        out[name] = set(_TS_QUOTED_RE.findall(body))
    if not out:
        raise AssertionError(f"{CAPABILITIES_TS}: 一个 `const … as const` 数组都没解析到 —— 解析器需更新")
    return out


def capability_card_tools() -> Set[str]:
    """六能力卡映射表实际引用到的全部原子工具名（含 spread 展开）。

    🔴 不是「文件里所有字符串」：只收 ``CUSTOM_AGENT_CAPABILITY_TOOL_SETS`` 块真正引用到的常量，
    并断言其引用的每个标识符都已解析到 —— 少解析一个常量（部分抽取）比抽不到更毒，那会让闸
    在「TS 侧多了一族工具」时照样绿。
    """
    src = CAPABILITIES_TS.read_text(encoding="utf-8")
    constants = parse_ts_tool_constants(src)

    block_match = re.search(
        r"export const CUSTOM_AGENT_CAPABILITY_TOOL_SETS\s*=\s*\{(.*?)\n\}\s*as\s+const", src, re.S
    )
    assert block_match, "没找到 CUSTOM_AGENT_CAPABILITY_TOOL_SETS 块 —— 解析器需更新"
    block = block_match.group(1)
    referenced = set(re.findall(r"\b([A-Z][A-Z0-9_]*)\b", block))
    assert referenced, "CUSTOM_AGENT_CAPABILITY_TOOL_SETS 块里没有常量引用 —— 解析器需更新"

    unknown = sorted(referenced - constants.keys())
    assert not unknown, (
        f"能力档映射引用了未解析到的常量 {unknown} —— 解析器漏抽（部分抽取会让本闸假绿）"
    )

    # spread 闭包：常量之间互相 `...` 引用（EMAIL_ORGANIZE = [...EMAIL_READ, …]）。
    def expand(name: str, seen: Set[str]) -> Set[str]:
        assert name not in seen, f"常量 {name} 自引用成环 —— 解析器需更新"
        seen = seen | {name}
        body_match = re.search(rf"const\s+{name}\s*=\s*\[(.*?)\]\s*as\s+const", src, re.S)
        assert body_match, f"常量 {name} 抽取失败"
        body = body_match.group(1)
        tools = set(_TS_QUOTED_RE.findall(body))
        for ref in re.findall(r"\.\.\.([A-Z][A-Z0-9_]*)", body):
            tools |= expand(ref, seen)
        return tools

    out: Set[str] = set()
    for name in referenced:
        out |= expand(name, set())
    return out


def parse_ts_multiline_union(name: str, path: Path) -> Tuple[str, ...]:
    """``export type NAME =\\n  | 'a'\\n  | 'b'`` → 值元组（保序）。"""
    src = path.read_text(encoding="utf-8")
    match = re.search(rf"export type {re.escape(name)}\s*=\s*((?:\s*\|\s*'[^']+')+)", src)
    if not match:
        raise AssertionError(f"{path.name}: 没找到 `export type {name} = | '…'` —— 解析器需更新")
    values = tuple(_TS_QUOTED_RE.findall(match.group(1)))
    if not values:
        raise AssertionError(f"{path.name}:{name} 联合类型解析到 0 个值 —— 解析器需更新")
    return values


def parse_ts_int_const(name: str, path: Path) -> int:
    src = path.read_text(encoding="utf-8")
    match = re.search(rf"export const {re.escape(name)}\s*=\s*([\d_]+)", src)
    if not match:
        raise AssertionError(f"{path.name}: 没找到 `export const {name} = <int>` —— 解析器需更新")
    return int(match.group(1).replace("_", ""))


# =============================================================================
# 闸 13 — 六能力卡的工具词表 ↔ headless 可选工具集
# =============================================================================


def test_capability_cards_cover_exactly_the_headless_tool_options():
    """两侧必须**精确相等**（不是包含关系）。

    左缺（headless 有、能力卡没收）→ 该工具不归任何档管，用户动一次能力卡它就成了永久滞留的
    孤儿；右缺（能力卡有、headless 没有）→ 写进 allowed_tools 后被 gateway 交集丢掉，UI 显示
    该档已开而工具根本不存在。本项目真发生过工具改名（email_search → email_list_filter），
    改名只改一侧正是本闸要挡的形态。
    """
    headless = parse_py_pair_tuple("HEADLESS_TOOL_OPTIONS", AGENT_RUNS_PY)
    cards = capability_card_tools()

    # canary：任一侧缩水到疑似解析器失效的量级即拦下（空集 == 空集恒真）。
    assert len(headless) >= 30, f"HEADLESS_TOOL_OPTIONS 只解析到 {len(headless)} 项 —— 解析器坏了"
    assert len(cards) >= 30, f"能力卡工具集只解析到 {len(cards)} 项 —— 解析器坏了"
    assert "email_get" in headless and "report_write" in headless, "headless 抽取 canary 失败"
    assert "email_get" in cards and "report_write" in cards, "能力卡抽取 canary 失败"

    headless_only = sorted(set(headless) - cards)
    cards_only = sorted(cards - set(headless))
    assert not (headless_only or cards_only), (
        "六能力卡的工具词表与 headless 可选工具集漂移了：\n"
        f"  只在 Python HEADLESS_TOOL_OPTIONS（没有任何能力档收录它 → 用户动能力卡时它成孤儿）："
        f"{headless_only}\n"
        f"  只在 TS 能力档映射（gateway 交集会丢掉它 → UI 说开了其实不存在）：{cards_only}\n"
        "→ 加/改/重命名 headless 工具时两处必须同批改：\n"
        "  src/api/routers/agent_runs.py（HEADLESS_TOOL_OPTIONS）\n"
        "  frontend/src/shared/lib/customAgentCapabilities.ts（六档映射表）"
    )


def test_report_write_is_the_only_artifact_class_tool():
    """artifact class 不享受 gateway 的交集豁免（只有 exec/web 享受），故它必须落在某个能力档里，
    否则 owner 无法把它配给 agent。这条把「class 语义」与「档位覆盖」绑在一起。"""
    headless = parse_py_pair_tuple("HEADLESS_TOOL_OPTIONS", AGENT_RUNS_PY)
    artifacts = sorted(name for name, cls in headless.items() if cls == "artifact")
    assert artifacts == ["report_write"], f"artifact class 工具集变了：{artifacts}"
    assert "report_write" in capability_card_tools()


# =============================================================================
# 闸 14 — AGENT_RUN_STATES ↔ TS AgentRunState
# =============================================================================


def test_agent_run_states_match_typescript_union():
    """9 值读态两侧同步。Python 多一个值 → TS 的 STATE_VISUAL 查表落空（渲染空白）；
    TS 多一个值 → 前端渲染了后端永不产出的状态。"""
    python_states = parse_py_frozenset("AGENT_RUN_STATES", RUN_STATE_PY)
    ts_states = parse_ts_multiline_union("AgentRunState", REPORT_TYPES_TS)

    assert len(python_states) >= 8, f"AGENT_RUN_STATES 只解析到 {len(python_states)} 个 —— 解析器坏了"
    assert "skipped" in python_states, "skipped 抽取 canary 失败（07-28 epic W1 加的第 9 值）"
    assert "paused_handoff" not in python_states, (
        "paused_handoff 是 outcome 不是读态 —— 解析器抓错了结构"
    )

    only_py = sorted(python_states - set(ts_states))
    only_ts = sorted(set(ts_states) - python_states)
    assert not (only_py or only_ts), (
        "custom agent run 读态值域漂移了：\n"
        f"  只在 Python run_state.py：{only_py}\n"
        f"  只在 TS types/report.ts：{only_ts}\n"
        "→ assertNever 只在 TS 内部生效，拦不住 Python 单方面加值；两处必须同批改。"
    )


# =============================================================================
# 闸 15 — max_run_seconds 的默认与上限
# =============================================================================


def test_agent_run_seconds_default_and_ceiling_match_gateway():
    """gateway 的防御性 re-clamp 必须与后端 Budget clamp 同源。

    漂移后果不对称且都难发现：Python 抬上限而 TS 不动 → run 在 gateway 侧被提前 abort（用户看到
    的是「跑到一半没了」）；Python 降默认而 TS 不动 → 畸形 spec 反而拿到更长的运行时间。
    """
    py_default = parse_py_int_const("DEFAULT_MAX_RUN_SECONDS", TRIGGER_PY)
    py_ceiling = parse_py_int_const("MAX_RUN_SECONDS_CEILING", TRIGGER_PY)
    ts_default = parse_ts_int_const("DEFAULT_AGENT_RUN_SECONDS", AGENT_RUN_TS)
    ts_ceiling = parse_ts_int_const("MAX_AGENT_RUN_SECONDS", AGENT_RUN_TS)

    assert py_default >= 60 and py_ceiling >= 60, "秒数 canary 失败 —— 解析器可能抓到了别的数字"

    assert (py_default, py_ceiling) == (ts_default, ts_ceiling), (
        "agent run 时间预算跨语言漂移了：\n"
        f"  Python src/agents/trigger.py: default={py_default} ceiling={py_ceiling}\n"
        f"  TS frontend/src/ai-gateway/agentRun.ts: default={ts_default} ceiling={ts_ceiling}\n"
        "→ 两处必须同批改（TS 侧是 gateway 边界的防御性 re-clamp，不是可以落后的副本）。"
    )


# =============================================================================
# 反向用例 —— 证明三道闸真会红，而不是恒绿的摆设
# =============================================================================


def test_reverse_gate_catches_injected_tool_drift():
    """注入用**加**而非删：删在「该项此刻本就缺席」时等于没注入，会跟着真实的红一起红。"""
    headless = set(parse_py_pair_tuple("HEADLESS_TOOL_OPTIONS", AGENT_RUNS_PY))
    cards = capability_card_tools()
    probe = "__injected_tool_probe"
    assert probe not in headless and probe not in cards, "合成探针撞车了，换一个"

    assert sorted((headless | {probe}) - cards) == [probe]  # headless 多一个 → 必被报出
    assert sorted((cards | {probe}) - headless) == [probe]  # 能力卡多一个 → 必被报出


def test_reverse_gate_catches_injected_state_drift():
    python_states = parse_py_frozenset("AGENT_RUN_STATES", RUN_STATE_PY)
    ts_states = set(parse_ts_multiline_union("AgentRunState", REPORT_TYPES_TS))
    probe = "__injected_state_probe"
    assert sorted((python_states | {probe}) - ts_states) == [probe]
    assert sorted((ts_states | {probe}) - python_states) == [probe]


@pytest.mark.parametrize(
    "src, expect",
    [
        ("HEADLESS_TOOL_OPTIONS = 'not a tuple'", "右值不是 tuple/list"),
        ('HEADLESS_TOOL_OPTIONS = (("a", "read"), "bare")', "含非二元组元素"),
        ("OTHER = ((1, 2),)", "没找到模块级"),
    ],
)
def test_reverse_pair_tuple_parser_failure_is_loud(tmp_path, src, expect):
    """🔴「抽取失败必须红」：结构变了就抛，绝不返回空 dict（空 == 空恒真）。"""
    probe = tmp_path / "probe.py"
    probe.write_text(src, encoding="utf-8")
    with pytest.raises(AssertionError, match=expect):
        parse_py_pair_tuple("HEADLESS_TOOL_OPTIONS", probe)


@pytest.mark.parametrize(
    "src, expect",
    [
        ("AGENT_RUN_STATES = {'a'}", "不再是 `frozenset"),
        ("AGENT_RUN_STATES = frozenset(SOME_VAR)", "参数不是字面量"),
        ("OTHER = frozenset({'a'})", "没找到"),
    ],
)
def test_reverse_frozenset_parser_failure_is_loud(tmp_path, src, expect):
    probe = tmp_path / "probe.py"
    probe.write_text(src, encoding="utf-8")
    with pytest.raises(AssertionError, match=expect):
        parse_py_frozenset("AGENT_RUN_STATES", probe)


def test_reverse_ts_union_parser_failure_is_loud(tmp_path):
    probe = tmp_path / "probe.ts"
    probe.write_text("export type AgentRunState = string\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="没找到"):
        parse_ts_multiline_union("AgentRunState", probe)


def test_reverse_capability_parser_rejects_unresolved_constant():
    """能力档块引用了一个没解析到的常量时必须抛 —— 部分抽取比抽不到更毒。"""
    src = (
        "const EMAIL_READ_TOOLS = ['email_get'] as const\n"
        "export const CUSTOM_AGENT_CAPABILITY_TOOL_SETS = {\n"
        "  email: { read: EMAIL_READ_TOOLS, draft: MYSTERY_TOOLS }\n"
        "} as const\n"
    )
    constants = parse_ts_tool_constants(src)
    referenced = set(re.findall(r"\b([A-Z][A-Z0-9_]*)\b", src.split("TOOL_SETS")[1]))
    assert sorted(referenced - constants.keys()) == ["MYSTERY_TOOLS"]
