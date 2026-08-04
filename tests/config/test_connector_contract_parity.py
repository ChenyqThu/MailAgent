"""MCP connector 授权契约的**跨语言一致性闸**（Python 权威 ↔ TS gateway / zod / wire 类型）。

08-01 阶段 1 PR3 一次引入了**两组**跨语言手抄：

1. **crud 天花板词表 + 序**（``read < write < update``，🔴 **不含 delete**）——七处副本：
   - `src/agents/trigger.py::_CONNECTOR_GRANT_VALUES`（保存闸：值域外入库即拒，权威）
   - `src/connectors/service.py::CONNECTOR_CRUD_RANK`（服务端天花板闸的序）
   - `frontend/src/ai-gateway/tools/policy.ts::ConnectorGrant`（TS 类型联合）
   - `frontend/src/ai-gateway/tools/policy.ts::CONNECTOR_CRUD_RANK`（注册期过滤的序）
   - `frontend/src/ai-gateway/tools/schemas.ts::customAgentConnectorGrantSchema`（模型输入 zod）
   - `frontend/src/shared/api/types/chat.ts::AgentRunSpec.toolPolicy.grantConnectors`（spec wire）
   - `frontend/src/shared/api/types/report.ts::CustomAgentToolPolicy.grant_connectors`（REST wire）
2. **caller ``context_mode`` 值域** —— `src/connectors/service.py::CALLER_CONTEXT_MODES`
   ↔ `frontend/src/ai-gateway/tools/policy.ts::AGENT_CONTEXT_MODES`。

**为什么不能消灭镜像**：跨语言 + 跨构件种类（Python 校验 / TS 类型 / zod runtime schema /
wire 接口声明），没有可共享的运行时载体；TS 侧三份里有两份是**编译期类型**，压根没有值可以
import。Python 内部的两份（值域 tuple vs rank dict）语义也不同（"能不能存" vs "谁 ≤ 谁"），
且 `connectors` 包刻意不在 import 期拉 `agents` 链。⇒ 保留副本 + 建闸，纪律见 CLAUDE.md。

**漂了会怎样**（本闸的 load-bearing 处）：

- 任一侧多出 ``'delete'`` = grill Q3=B 的安全地板破口。TS 侧多它 → 模型能提出 delete 天花板、
  审批卡照渲染成一个正常授权（Python 那侧最终会 400，但 owner 已经批过一次"删除权限"了）；
  Python 侧多它 → 删除类工具真的可被 headless 调用（service 的 `ceiling_allows` 直接放行）。
- 序漂（比如 TS 把 update 排到 write 前面）= **两道闸各判各的**：gateway 注册了一个工具、
  服务端 403 把它拒掉（功能坏但安全），或者反过来 —— gateway 过滤掉服务端本会放行的工具。
  两种都不会有任何报错指向真因。
- ``context_mode`` 拼写漂移 = TS 发的合法调用被 Python 400（headless connector 全线不可用），
  或者某个新场地悄悄落进 headless 分支拿到 grant 语义。

🔴 抽取失败必须**红**：每个抽取器抓不到锚点就 ``AssertionError``，不允许退化成
「没东西可比 = 平凡绿」；末尾 canary 用**合成源码**证明闸真会红。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pytest

from . import _parsers as p

POLICY_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "tools" / "policy.ts"
SCHEMAS_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "tools" / "schemas.ts"
CHAT_TYPES_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "chat.ts"
REPORT_TYPES_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "report.ts"
TRIGGER_PY = p.REPO_ROOT / "src" / "agents" / "trigger.py"
SERVICE_PY = p.REPO_ROOT / "src" / "connectors" / "service.py"


# ── Python 侧抽取（AST，绕开 config.py 的模块级 pydantic 实例化）─────────────────


def _py_assign(path: Path, name: str, src: Optional[str] = None) -> ast.AST:
    """模块顶层 ``name = <expr>`` 的右值节点。抓不到 → AssertionError。"""
    text = src if src is not None else path.read_text(encoding="utf-8")
    tree = ast.parse(text)
    for node in tree.body:
        targets = (
            node.targets
            if isinstance(node, ast.Assign)
            else [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        for t in targets:
            if isinstance(t, ast.Name) and t.id == name:
                assert node.value is not None, f"{path.name}: `{name}` 有声明无赋值 —— 抽取器需更新"
                return node.value
    raise AssertionError(
        f"{path.name} 里找不到顶层常量 `{name}` —— 它改名/搬家了，本闸的抽取器需同步更新"
        f"（不许让它静默变成平凡绿）"
    )


def py_str_tuple(path: Path, name: str, src: Optional[str] = None) -> Tuple[str, ...]:
    node = _py_assign(path, name, src)
    assert isinstance(node, (ast.Tuple, ast.List)), f"{path.name}: `{name}` 不是 tuple/list 字面量"
    out: List[str] = []
    for el in node.elts:
        assert isinstance(el, ast.Constant) and isinstance(el.value, str), (
            f"{path.name}: `{name}` 含非字符串字面量项 —— 抽取器需更新"
        )
        out.append(el.value)
    assert out, f"{path.name}: `{name}` 抽到空集 —— 抽取器需更新"
    return tuple(out)


def py_str_int_dict(path: Path, name: str, src: Optional[str] = None) -> Dict[str, int]:
    node = _py_assign(path, name, src)
    assert isinstance(node, ast.Dict), f"{path.name}: `{name}` 不是 dict 字面量"
    out: Dict[str, int] = {}
    for k, v in zip(node.keys, node.values):
        assert (
            isinstance(k, ast.Constant)
            and isinstance(k.value, str)
            and isinstance(v, ast.Constant)
            and isinstance(v.value, int)
        ), f"{path.name}: `{name}` 含非 str→int 字面量项 —— 抽取器需更新"
        out[k.value] = v.value
    assert out, f"{path.name}: `{name}` 抽到空 dict —— 抽取器需更新"
    return out


# ── TS 侧抽取（正则，锚在**行首**结束符上，避免行尾注释截断——见 issue #68 教训）───


def _read(path: Path, src: Optional[str]) -> str:
    return path.read_text(encoding="utf-8") if src is None else src


def ts_string_union(path: Path, decl: str, src: Optional[str] = None) -> Tuple[str, ...]:
    """``<decl> = 'a' | 'b' | 'c'`` / ``Record<string, 'a' | 'b'>`` 里的单引号字面量序列。"""
    text = _read(path, src)
    idx = text.find(decl)
    assert idx >= 0, f"{path.name} 里找不到 `{decl}` —— 声明改名/搬家了，抽取器需同步更新"
    line = text[idx : text.find("\n", idx)]
    lits = re.findall(r"'([^']+)'", line)
    assert lits, f"{path.name}: `{decl}` 那行抽不到任何字符串字面量 —— 抽取器需更新"
    return tuple(lits)


def ts_const_string_array(path: Path, decl: str, src: Optional[str] = None) -> Tuple[str, ...]:
    """``export const X = [ 'a', 'b' ] as const`` —— 结束符锚在行首的 ``]``。"""
    text = _read(path, src)
    idx = text.find(decl)
    assert idx >= 0, f"{path.name} 里找不到 `{decl}` —— 抽取器需同步更新"
    end = re.search(r"^\]", text[idx:], re.MULTILINE)
    assert end, f"{path.name}: `{decl}` 找不到行首的 `]` 结束符 —— 抽取器需更新"
    lits = re.findall(r"'([^']+)'", text[idx : idx + end.start()])
    assert lits, f"{path.name}: `{decl}` 抽到空数组 —— 抽取器需更新"
    return tuple(lits)


def ts_rank_record(path: Path, decl: str, src: Optional[str] = None) -> Dict[str, int]:
    """``export const CONNECTOR_CRUD_RANK: Record<…> = { read: 1, … }`` —— 行首 ``}`` 结束。"""
    text = _read(path, src)
    idx = text.find(decl)
    assert idx >= 0, f"{path.name} 里找不到 `{decl}` —— 抽取器需同步更新"
    end = re.search(r"^\}", text[idx:], re.MULTILINE)
    assert end, f"{path.name}: `{decl}` 找不到行首的 `}}` 结束符 —— 抽取器需更新"
    pairs = re.findall(r"(\w+)\s*:\s*(\d+)", text[idx : idx + end.start()])
    assert pairs, f"{path.name}: `{decl}` 抽到空 record —— 抽取器需更新"
    return {k: int(v) for k, v in pairs}


def ts_zod_enum(path: Path, decl: str, src: Optional[str] = None) -> Tuple[str, ...]:
    text = _read(path, src)
    idx = text.find(decl)
    assert idx >= 0, f"{path.name} 里找不到 `{decl}` —— 抽取器需同步更新"
    m = re.search(r"z\.enum\(\[([^\]]*)\]\)", text[idx : idx + 400])
    assert m, f"{path.name}: `{decl}` 抽不到 z.enum([...]) —— 写法变了，抽取器需更新"
    lits = tuple(re.findall(r"'([^']+)'", m.group(1)))
    assert lits, f"{path.name}: `{decl}` 的 z.enum 是空的 —— 抽取器需更新"
    return lits


# ── ① crud 天花板词表 + 序 ─────────────────────────────────────────────────────

_CEILING_SITES = {
    "py:trigger._CONNECTOR_GRANT_VALUES": lambda: py_str_tuple(
        TRIGGER_PY, "_CONNECTOR_GRANT_VALUES"
    ),
    "py:service.CONNECTOR_CRUD_RANK(keys by rank)": lambda: tuple(
        k for k, _ in sorted(py_str_int_dict(SERVICE_PY, "CONNECTOR_CRUD_RANK").items(),
                             key=lambda kv: kv[1])
    ),
    "ts:policy.ConnectorGrant": lambda: ts_string_union(
        POLICY_TS, "export type ConnectorGrant ="
    ),
    "ts:policy.CONNECTOR_CRUD_RANK(keys by rank)": lambda: tuple(
        k for k, _ in sorted(ts_rank_record(POLICY_TS, "export const CONNECTOR_CRUD_RANK").items(),
                             key=lambda kv: kv[1])
    ),
    "ts:schemas.customAgentConnectorGrantSchema": lambda: ts_zod_enum(
        SCHEMAS_TS, "export const customAgentConnectorGrantSchema"
    ),
    "ts:chat.AgentRunSpec.grantConnectors": lambda: ts_string_union(
        CHAT_TYPES_TS, "grantConnectors?: Record<string,"
    ),
    "ts:report.CustomAgentToolPolicy.grant_connectors": lambda: ts_string_union(
        REPORT_TYPES_TS, "grant_connectors?: Record<string,"
    ),
}


def test_ceiling_vocabulary_is_identical_and_ordered_across_all_seven_sites():
    """七处副本的天花板词表**逐项且有序**一致（序 = read < write < update 的语义本体）。"""
    extracted = {name: fn() for name, fn in _CEILING_SITES.items()}
    canonical = extracted["py:trigger._CONNECTOR_GRANT_VALUES"]
    assert canonical == ("read", "write", "update"), (
        f"保存闸的值域变成 {canonical!r} —— 这是天花板语义本体的改动，"
        f"改它必须同时改另外六处 + PRD 决策 5 / grill Q3=B"
    )
    for name, values in extracted.items():
        assert values == canonical, (
            f"{name} = {values!r} 与保存闸权威 {canonical!r} 不一致 —— "
            f"两道闸（gateway 注册期过滤 / 服务端天花板闸）会各判各的，且没有任何报错指向真因"
        )


def test_delete_is_absent_from_every_ceiling_site():
    """🔴 安全地板（grill Q3=B）：``delete`` 不在**任何一侧**的天花板值域里。

    单独一条负例断言而不是靠上面的相等闸兜 —— 七处同时被加上 delete 时相等闸依然绿。
    """
    for name, fn in _CEILING_SITES.items():
        assert "delete" not in fn(), (
            f"{name} 出现了 'delete' 天花板 —— MVP 不开删除（grill Q3=B/Q16=A）："
            f"删除类工具照常同步入清单、界面恒灰、AI 任何场合都不注册。放开它是一次产品决策，"
            f"要同时改七处值域 + 解灰界面开关，不能从这里单点渗进来"
        )


def test_rank_is_dense_and_monotonic_on_both_legs():
    """两条腿的 rank 都是 1..N 稠密递增 —— ``ceiling_allows`` 的 ``<=`` 才有意义。"""
    py_rank = py_str_int_dict(SERVICE_PY, "CONNECTOR_CRUD_RANK")
    ts_rank = ts_rank_record(POLICY_TS, "export const CONNECTOR_CRUD_RANK")
    assert py_rank == ts_rank, f"rank 两侧不一致：py={py_rank!r} ts={ts_rank!r}"
    assert sorted(py_rank.values()) == list(range(1, len(py_rank) + 1)), (
        f"rank 不是 1..N 稠密递增：{py_rank!r}"
    )


# ── ② caller context_mode 值域 ─────────────────────────────────────────────────


def test_caller_context_modes_match_gateway_agent_context_modes():
    """Python 的 caller 白名单 ↔ TS ``AGENT_CONTEXT_MODES``（**有序**逐项相等）。

    TS 侧是 gateway 实际会发出的 ``caller.context_mode`` 全集；Python 侧是它的接收白名单。
    右边多一个 → 那种 mode 的调用被 Python 400（功能整条不可用，报错还指向"调用方 bug"）；
    左边多一个 → Python 认一个 gateway 永远不会发的 mode（死值域，但也说明谁改了没同步）。
    """
    py_modes = py_str_tuple(SERVICE_PY, "CALLER_CONTEXT_MODES")
    ts_modes = ts_const_string_array(POLICY_TS, "export const AGENT_CONTEXT_MODES = [")
    assert py_modes == ts_modes, (
        f"caller context_mode 值域漂移：py={py_modes!r} ts={ts_modes!r}"
    )


def test_headless_modes_are_a_proper_subset_that_excludes_manual_and_im():
    """headless 白名单 ⊂ 全集，且**不含** manual_chat / im_chat（两者各有专属分支）。"""
    all_modes = set(py_str_tuple(SERVICE_PY, "CALLER_CONTEXT_MODES"))
    headless = set(py_str_tuple(SERVICE_PY, "HEADLESS_CONTEXT_MODES"))
    assert headless < all_modes, f"HEADLESS_CONTEXT_MODES 不是真子集：{headless!r} ⊄ {all_modes!r}"
    assert "manual_chat" not in headless, "manual_chat 混进 headless 白名单 = owner 面被强加天花板"
    assert "im_chat" not in headless, (
        "im_chat 混进 headless 白名单 = 阶段 0b 场地凭 grant 就能调 connector"
        "（它的开放应该是一个独立开关，不是 grant —— grill Q10=A）"
    )


# ── ③ canary：抽取器失效必须红，不许变成平凡绿 ─────────────────────────────────


def test_extraction_failure_is_red_not_silently_green():
    """用**合成源码**证明每个抽取器在锚点消失 / 写法重构时会抛，而不是返回空集。"""
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(TRIGGER_PY, "_CONNECTOR_GRANT_VALUES", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_int_dict(SERVICE_PY, "CONNECTOR_CRUD_RANK", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到"):
        ts_string_union(POLICY_TS, "export type ConnectorGrant =", src="const x = 1\n")
    with pytest.raises(AssertionError, match="找不到"):
        ts_rank_record(POLICY_TS, "export const CONNECTOR_CRUD_RANK", src="const x = 1\n")
    with pytest.raises(AssertionError, match="抽不到 z.enum"):
        # 声明还在、但换成了 z.union(...) 写法 → 必须红（而不是"抽到空集当没漂"）
        ts_zod_enum(
            SCHEMAS_TS,
            "export const customAgentConnectorGrantSchema",
            src="export const customAgentConnectorGrantSchema = z.union([z.literal('read')])\n",
        )
    with pytest.raises(AssertionError, match="找不到行首"):
        ts_const_string_array(
            POLICY_TS,
            "export const AGENT_CONTEXT_MODES = [",
            src="export const AGENT_CONTEXT_MODES = [ 'manual_chat' ] as const\n",
        )


def test_gate_would_go_red_on_a_synthetic_drift():
    """反向用例：合成一份"多了 delete"的源码，相等闸与负例闸都必须红。

    用合成源码而不是改真源 —— 真漂移在场时说不清是闸红了还是源坏了。
    """
    drifted = "_CONNECTOR_GRANT_VALUES = (\"read\", \"write\", \"update\", \"delete\")\n"
    values = py_str_tuple(TRIGGER_PY, "_CONNECTOR_GRANT_VALUES", src=drifted)
    assert "delete" in values  # 抽取器确实看见了漂移…
    assert values != ts_string_union(POLICY_TS, "export type ConnectorGrant ="), (
        "合成漂移没能让相等闸红 —— 说明闸本身失效"
    )
