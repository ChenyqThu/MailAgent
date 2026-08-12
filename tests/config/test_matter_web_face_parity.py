"""跟进 run 网页检索档的**跨语言一致性闸**（Python 持久化权威 ↔ TS gateway 判定）。

0812 dogfood 把这个档从一个 TS 编译期常量变成 owner 可配的持久化设置，于是同一份词表
（``keep`` / ``search_only`` / ``off``）+ 同一个缺省值（``keep``）被手抄成两份：

- ``src/api/routers/agent.py::MATTER_RUN_WEB_FACES`` / ``MATTER_RUN_WEB_FACE_DEFAULT``
  —— canonical：``PUT /api/agent/matter-web-face`` 的值域闸（越域即 400）+ 缺行/脏行的读侧回落。
- ``frontend/src/ai-gateway/tools/policy.ts::MATTER_RUN_WEB_FACES``
  / ``frontend/src/ai-gateway/agentRun.ts::MATTER_RUN_WEB_FACE_DEFAULT``
  —— gateway：``parseMatterRunWebFace`` 的唯一收窄漏斗 + 腰带 fail-safe 的落点。
- ``frontend/src/shared/components/matters/useMatterRunWebFace.ts::WEB_FACE_ORDER``
  / ``::WEB_FACE_DEFAULT`` —— **renderer**：设置面 radio 的渲染词表 + 本模块 ``parseFace``
  的收窄词表 + 读失败兜底。

**为什么不能消灭镜像**：① Python 端点 ↔ Node gateway 跨语言，无共享运行时载体；② renderer
只对 ``policy.ts`` 做 **type-only** import（运行时 import 会把 gateway 那一坨拉进 renderer
bundle），类型擦除后运行时词表只能自带一份。TS 侧内部原本还有两处手抄（agentRun 的 resolver
漏斗 + lifecycle 的 wire 读），已由 ``policy.ts`` 的运行时数组 + ``parseMatterRunWebFace``
收成一处 —— 剩下这三份是消灭不掉的，故建闸。

**漂了会怎样**（本闸的 load-bearing 处）：

- 词表漂（任一侧多/少一档）：多出来的那档在设置面能选、PUT 也能过，但 gateway
  ``parseMatterRunWebFace`` 不认 → 静默回落成 ``keep``。于是「UI 显示 X、实际生效 keep」，
  而这正是端点刻意 400 而非静默回落所要防的那种劈叉 —— 只是漂到了另一侧。
- 缺省值漂（比如 TS 改成 ``off``、Python 仍报 ``keep``）：从未配置过的用户，设置页显示
  「保留网页检索」，实际每一轮无人值守跟进 run 都没有 web 工具。没有任何报错指向真因。
- 🔴 renderer 漂（新增一档只加进 Python + policy.ts，忘了 ``WEB_FACE_ORDER``）：**typecheck
  不会红** —— ``readonly MatterRunWebFace[]`` 装一个子集完全合法。后果 = 新档在设置面根本
  没有 radio，且服务端真的存着它时 ``parseFace`` 把它当脏值收成 ``keep`` ⇒ 界面显示「全给」、
  实际生效另一档。消费侧的 ``Record<MatterRunWebFace, …>`` 只保证 i18n 不缺键，接不住这条。

🔴 抽取失败必须**红**：抽取器抓不到锚点就 ``AssertionError``，不允许退化成「没东西可比 =
平凡绿」；末尾 canary 用**合成源码**证明闸真会红。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import List, Optional, Tuple

import pytest

from . import _parsers as p

AGENT_ROUTER_PY = p.REPO_ROOT / "src" / "api" / "routers" / "agent.py"
POLICY_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "tools" / "policy.ts"
AGENT_RUN_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "agentRun.ts"
RENDERER_HOOK_TS = (
    p.REPO_ROOT
    / "frontend"
    / "src"
    / "shared"
    / "components"
    / "matters"
    / "useMatterRunWebFace.ts"
)


# ── 抽取器（Python: AST；TS: 单行字面量正则）────────────────────────────────────


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


def py_str_const(path: Path, name: str, src: Optional[str] = None) -> str:
    node = _py_assign(path, name, src)
    assert isinstance(node, ast.Constant) and isinstance(node.value, str), (
        f"{path.name}: `{name}` 不是字符串字面量 —— 抽取器需更新"
    )
    return node.value


def ts_single_line_literals(path: Path, decl: str, src: Optional[str] = None) -> Tuple[str, ...]:
    """``<decl> …'a', 'b', 'c'…`` 同一行上的单引号字面量序列（声明换行重排 → 抽到空 → 红）。"""
    text = path.read_text(encoding="utf-8") if src is None else src
    idx = text.find(decl)
    assert idx >= 0, f"{path.name} 里找不到 `{decl}` —— 声明改名/搬家了，抽取器需同步更新"
    line = text[idx : text.find("\n", idx)]
    lits = re.findall(r"'([^']+)'", line)
    assert lits, f"{path.name}: `{decl}` 那行抽不到任何字符串字面量 —— 抽取器需更新"
    return tuple(lits)


# ── ① 三档词表（有序逐项一致）───────────────────────────────────────────────────


def test_web_face_vocabulary_is_identical_across_both_languages():
    canonical = py_str_tuple(AGENT_ROUTER_PY, "MATTER_RUN_WEB_FACES")
    assert canonical == ("keep", "search_only", "off"), (
        f"档位值域变成 {canonical!r} —— 这是三档语义本体的改动，改它必须同步 TS 词表 + "
        f"腰带判定（agentRun.matterRunAdmitsWeb）+ 设置面控件"
    )
    ts = ts_single_line_literals(POLICY_TS, "export const MATTER_RUN_WEB_FACES =")
    assert ts == canonical, (
        f"TS 词表 {ts!r} 与 Python canonical {canonical!r} 不一致 —— 见本文件 docstring 的"
        f"「UI 显示 X、实际生效 keep」后果"
    )
    renderer = ts_single_line_literals(RENDERER_HOOK_TS, "export const WEB_FACE_ORDER")
    assert renderer == canonical, (
        f"renderer 词表 {renderer!r} 与 Python canonical {canonical!r} 不一致 —— 🔴 这一侧"
        f"typecheck **接不住**（readonly MatterRunWebFace[] 装子集合法）：漏掉的档在设置面"
        f"没有 radio，服务端真存着它时 parseFace 又把它收成 keep ⇒ 界面显示「全给」、实际"
        f"生效另一档"
    )


# ── ② 缺省值 ───────────────────────────────────────────────────────────────────


def test_default_tier_is_identical_across_both_languages():
    py_default = py_str_const(AGENT_ROUTER_PY, "MATTER_RUN_WEB_FACE_DEFAULT")
    ts_default = ts_single_line_literals(
        AGENT_RUN_TS, "export const MATTER_RUN_WEB_FACE_DEFAULT"
    )
    assert py_default in py_str_tuple(AGENT_ROUTER_PY, "MATTER_RUN_WEB_FACES"), (
        f"缺省档 {py_default!r} 不在自己的值域里 —— 从未配置过的用户会读到一个 PUT 不进去的值"
    )
    assert ts_default == (py_default,), (
        f"TS 缺省档 {ts_default!r} 与 Python {py_default!r} 不一致 —— 从未配置过的用户会"
        f"「设置页显示一档、无人值守 run 实际跑另一档」，且没有任何报错指向真因"
    )
    renderer_default = ts_single_line_literals(RENDERER_HOOK_TS, "export const WEB_FACE_DEFAULT")
    assert renderer_default == (py_default,), (
        f"renderer 缺省档 {renderer_default!r} 与 Python {py_default!r} 不一致 —— 它是**读失败**"
        f"时界面显示的那一档；与服务端缺省不符 = 一次瞬时故障就让设置页谎报当前生效档"
    )


# ── ③ canary：抽取器失效必须红，不许变成平凡绿 ────────────────────────────────


def test_extraction_failure_is_red_not_silently_green():
    """用**合成源码**证明每个抽取器在锚点消失 / 写法重构时会抛，而不是返回空集。"""
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(AGENT_ROUTER_PY, "MATTER_RUN_WEB_FACES", src="X = 1\n")
    with pytest.raises(AssertionError, match="含非字符串字面量"):
        # 词表改成从别处拼出来（非字面量）→ 必须红，不许抽到半张表
        py_str_tuple(
            AGENT_ROUTER_PY, "MATTER_RUN_WEB_FACES", src="MATTER_RUN_WEB_FACES = ('keep', X)\n"
        )
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_const(AGENT_ROUTER_PY, "MATTER_RUN_WEB_FACE_DEFAULT", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到"):
        ts_single_line_literals(
            POLICY_TS, "export const MATTER_RUN_WEB_FACES =", src="const x = 1\n"
        )
    with pytest.raises(AssertionError, match="抽不到任何字符串字面量"):
        # 声明还在、但被格式化成多行 → 必须红（而不是"抽到空集当没漂"）
        ts_single_line_literals(
            POLICY_TS,
            "export const MATTER_RUN_WEB_FACES =",
            src="export const MATTER_RUN_WEB_FACES =\n  ['keep'] as const\n",
        )
    with pytest.raises(AssertionError, match="找不到"):
        ts_single_line_literals(
            AGENT_RUN_TS, "export const MATTER_RUN_WEB_FACE_DEFAULT", src="const x = 1\n"
        )
    with pytest.raises(AssertionError, match="找不到"):
        ts_single_line_literals(RENDERER_HOOK_TS, "export const WEB_FACE_ORDER", src="const x = 1\n")
    with pytest.raises(AssertionError, match="找不到"):
        ts_single_line_literals(
            RENDERER_HOOK_TS, "export const WEB_FACE_DEFAULT", src="const x = 1\n"
        )
