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
3. **per-tool 三档词表**（08-05 WP-10）—— `src/agent_config/store.py::CONNECTOR_TOOL_MODES`
   （canonical：写侧校验 + 折算函数）↔ TS 两处编译期类型联合
   （gateway `tools/connector.ts::ConnectorToolMode` / 设置面 wire
   `shared/api/types/connector.ts::ConnectorToolMode`）。TS 侧无运行时值可 import ⇒ 建闸。
4. **connector.source 值域**（08-05 WP-12，Composio 单轨）——
   `src/agent_config/store.py::CONNECTOR_SOURCES`（canonical：写侧校验 + 行读侧的
   fail-closed 归一）↔ 设置面 wire `shared/api/types/connector.ts::ConnectorSource`。
   漂了会怎样：TS 多一档 = 出站告知按一个 Python 永远不会发的值分支（「经 Composio」那行
   字**该出现时不出现**）；Python 多一档 = 一条新装配路线在设置页显示成「直连」。
5. **目录 track 值域**（08-06 双轨）—— `src/connectors/catalog.py::CONNECTOR_TRACKS`
   （canonical：目录视图的出厂轨道 + `TRACK_TO_SOURCE` 的键）↔ 设置面 wire
   `shared/api/types/connector.ts::ConnectorTrack`。另有一条 **Python 内**的映射闸：
   `TRACK_TO_SOURCE` 的值必须恰好铺满 `CONNECTOR_SOURCES`（track ↔ source 是双射；漏一边
   = `row_is_off_track` 把一整轨的行全判成「已被取代」，把 owner 诱导去断开重连）。
   漂了会怎样：TS 少一档 = 新轨道的目录卡走进 default 分支（direct 卡被当成 composio 卡渲染
   成 BYOK disabled，一家结构上连不上）；Python 少一档 = `catalog_views` 抛 KeyError。

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
STORE_PY = p.REPO_ROOT / "src" / "agent_config" / "store.py"
CATALOG_PY = p.REPO_ROOT / "src" / "connectors" / "catalog.py"
CONNECTOR_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "tools" / "connector.ts"
CONNECTOR_TYPES_TS = (
    p.REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "connector.ts"
)


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


def py_str_str_dict(path: Path, name: str, src: Optional[str] = None) -> Dict[str, str]:
    node = _py_assign(path, name, src)
    assert isinstance(node, ast.Dict), f"{path.name}: `{name}` 不是 dict 字面量"
    out: Dict[str, str] = {}
    for k, v in zip(node.keys, node.values):
        assert (
            isinstance(k, ast.Constant)
            and isinstance(k.value, str)
            and isinstance(v, ast.Constant)
            and isinstance(v.value, str)
        ), f"{path.name}: `{name}` 含非 str→str 字面量项 —— 抽取器需更新"
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


#: Matters MVP P4 —— TS 有第五个 mode ``matter_followup``，但它**结构上到不了 connector 面**，
#: 故不进 Python 的 caller 白名单：
#:   * connector 工具的唯一加载缝 ``connector.ts::shouldLoadConnectorTools`` 只认四个 mode
#:     （manual/im 要求无 agentRunContext；两个 headless 要求 grants 非空），其余一律 false ——
#:     跟进 run 连 manifest 都不会拉，更不会注册任何 ``mcp__*`` 工具；
#:   * 且 D5 的矩阵行只放行 read + artifact，connector_write 在这个 venue 恒 false；
#:   * 且跟进 run 的 spec 结构上不带任何 grants（D5：`toolPolicy` 只投 allowedTools + skills）。
#: ⇒ gateway 永远不会以这个 mode 调 ``/api/connector/*``；把它加进 CALLER_CONTEXT_MODES 反而要
#: 在 owner-present / headless 里二选一站队（下一个用例的划尽闸），等于**替一个不存在的调用面
#: 提前做了 connector 产品决策** —— 正是 service.py 那段注释明令禁止的「继承」。
#: 🔴 这不是「把闸放宽成子集」：下面仍是**逐项有序相等**，只是先按本表剔除；任何**新**增的 mode
#: 依旧会让闸红（不在本表里就必须同步 Python 白名单）。将来若真要让跟进 venue 用 connector：
#: 从本表删掉它 + 同批改 CALLER_CONTEXT_MODES + 显式划进两张白名单之一。
CONNECTOR_UNREACHABLE_CONTEXT_MODES: Tuple[str, ...] = ("matter_followup",)


def test_caller_context_modes_match_gateway_agent_context_modes():
    """Python 的 caller 白名单 ↔ TS ``AGENT_CONTEXT_MODES``（**有序**逐项相等，剔除够不着
    connector 面的 mode，见 ``CONNECTOR_UNREACHABLE_CONTEXT_MODES``）。

    TS 侧是 gateway 实际会发出的 ``caller.context_mode`` 全集；Python 侧是它的接收白名单。
    右边多一个 → 那种 mode 的调用被 Python 400（功能整条不可用，报错还指向"调用方 bug"）；
    左边多一个 → Python 认一个 gateway 永远不会发的 mode（死值域，但也说明谁改了没同步）。
    """
    py_modes = py_str_tuple(SERVICE_PY, "CALLER_CONTEXT_MODES")
    ts_modes = ts_const_string_array(POLICY_TS, "export const AGENT_CONTEXT_MODES = [")
    # canary：剔除表里的名字必须真的是一个 TS mode（改名/删除 → 这里先红，而不是静默少剔一项）
    for mode in CONNECTOR_UNREACHABLE_CONTEXT_MODES:
        assert mode in ts_modes, (
            f"{mode} 不在 TS AGENT_CONTEXT_MODES 里了 —— 剔除表过期，更新本闸"
        )
    expected = tuple(m for m in ts_modes if m not in CONNECTOR_UNREACHABLE_CONTEXT_MODES)
    assert py_modes == expected, (
        f"caller context_mode 值域漂移：py={py_modes!r} ts(剔除后)={expected!r}"
    )


def test_connector_load_seam_really_excludes_the_unreachable_modes():
    """上面那张剔除表的**理由本身**要可证伪：加载缝里不许出现这些 mode 的字面量。

    没有这条，剔除表就是一句自说自话的注释 —— 某天有人在 ``shouldLoadConnectorTools`` 里给
    跟进 venue 开了口子，第一个用例仍然绿（它只比对值域），而 Python 会 400 掉那些调用。
    """
    text = CONNECTOR_TS.read_text(encoding="utf-8")
    seam = re.search(
        r"export function shouldLoadConnectorTools\b.*?\n\}", text, re.DOTALL
    )
    assert seam, "shouldLoadConnectorTools 抽取失败 —— 加载缝被移动/改名，更新本闸"
    literals = set(re.findall(r"'([a-z_]+)'", seam.group(0)))
    assert "manual_chat" in literals and "cron_headless" in literals, (
        f"加载缝里抽不到已知 mode 字面量（习语变了？）：{sorted(literals)!r}"
    )
    for mode in CONNECTOR_UNREACHABLE_CONTEXT_MODES:
        assert mode not in literals, (
            f"{mode} 出现在 connector 加载缝里 —— 这个 venue 现在够得着 connector 了，"
            "必须把它从 CONNECTOR_UNREACHABLE_CONTEXT_MODES 删掉 + 同批加进 "
            "CALLER_CONTEXT_MODES 并显式划进 owner-present / headless 之一"
        )


def test_owner_present_and_headless_partition_the_caller_modes():
    """两张白名单（owner-present / headless）**不交叠且并起来划尽**全值域。

    阶段 2 PR-1（08-04 拍板「connector 对 im_chat 全开放」）：im_chat 归 owner-present 分支
    （与 manual 同档 —— 无服务端天花板，写恒 HITL 在 gateway 侧），**不是** headless ——
    混进 headless = 飞书场地凭 grant 免卡调写类 connector（安全地板破口）；manual 混进
    headless = owner 面被强加天花板。将来第五种 mode 必须被显式划进两侧之一（划进哪侧是
    独立决策），漏划 → 本闸红（不划尽）。
    """
    all_modes = set(py_str_tuple(SERVICE_PY, "CALLER_CONTEXT_MODES"))
    owner_present = set(py_str_tuple(SERVICE_PY, "OWNER_PRESENT_CONTEXT_MODES"))
    headless = set(py_str_tuple(SERVICE_PY, "HEADLESS_CONTEXT_MODES"))
    assert owner_present == {"manual_chat", "im_chat"}, (
        f"owner-present 白名单漂移：{owner_present!r} —— manual/im 之外的场地进这里是一次"
        "独立产品决策，不能顺手加"
    )
    assert owner_present & headless == set(), (
        f"两张白名单交叠：{owner_present & headless!r} —— 同一 mode 不能既免天花板又走 grant"
    )
    assert owner_present | headless == all_modes, (
        f"两张白名单没划尽值域：缺 {all_modes - (owner_present | headless)!r} —— "
        "新 mode 必须被显式划进 owner-present 或 headless 之一"
    )
    assert "manual_chat" not in headless, "manual_chat 混进 headless 白名单 = owner 面被强加天花板"
    assert "im_chat" not in headless, (
        "im_chat 混进 headless 白名单 = 飞书场地凭 grant 就能免卡调 connector 写类"
        "（它与 manual 同档：无天花板 + 写恒 HITL 在 gateway 审批卡 —— 08-04 拍板）"
    )


# ── ③ per-tool 三档词表（08-05 WP-10 拍板；auto/ask/off，**有序**）────────────────

_TOOL_MODE_SITES = {
    "py:store.CONNECTOR_TOOL_MODES": lambda: py_str_tuple(STORE_PY, "CONNECTOR_TOOL_MODES"),
    "ts:gateway connector.ConnectorToolMode": lambda: ts_string_union(
        CONNECTOR_TS, "export type ConnectorToolMode ="
    ),
    "ts:shared api ConnectorToolMode": lambda: ts_string_union(
        CONNECTOR_TYPES_TS, "export type ConnectorToolMode ="
    ),
}


def test_tool_mode_vocabulary_is_identical_across_all_three_sites():
    """三处 per-tool 档位词表**逐项且有序**一致（canonical = Python store 写侧校验）。

    漂了会怎样：TS 侧多一档 → 设置面能发一个服务端 400 的档（UI 全绿存不进）；Python 侧
    多一档 → 一个 TS admission 判不认的档位从折算函数漏出去，gateway fail-closed 把工具
    整个吞掉（功能坏但安全），且没有任何报错指向真因。
    """
    extracted = {name: fn() for name, fn in _TOOL_MODE_SITES.items()}
    canonical = extracted["py:store.CONNECTOR_TOOL_MODES"]
    assert canonical == ("auto", "ask", "off"), (
        f"per-tool 档位值域变成 {canonical!r} —— 这是 08-05 三档语义本体的改动，"
        f"改它必须同步 TS 两处 + admission 判据 + 设置面控件 + mcp-connectors.md §5.5"
    )
    for name, values in extracted.items():
        assert values == canonical, (
            f"{name} = {values!r} 与 canonical {canonical!r} 不一致 —— 折算/admission/设置面"
            f"会各判各的，且没有任何报错指向真因"
        )


def test_gateway_admission_recognizes_exactly_the_registering_modes():
    """gateway 的 admission 判据（``admissibleConnectorCrud``）认的字面量 = 词表里
    「会注册」的两档（auto/ask）——off 及任何未知串 fail-closed。判据是行内字面量比较
    （无运行时词表可断言），故这里抽源码钉住：谁把判据改成别的写法，本闸红出来提醒
    同步这份 parity 契约。"""
    text = CONNECTOR_TS.read_text(encoding="utf-8")
    assert "entry.mode !== 'auto' && entry.mode !== 'ask'" in text, (
        "admissibleConnectorCrud 的 mode 判据写法变了 —— 确认注册面仍 = {auto, ask} 且"
        " fail-closed 后，同步更新本抽取锚点"
    )


# ── ③b connector.source 值域（08-05 WP-12：Composio 单轨的装配路线）──────────────

_SOURCE_SITES = {
    "py:store.CONNECTOR_SOURCES": lambda: py_str_tuple(STORE_PY, "CONNECTOR_SOURCES"),
    "ts:shared api ConnectorSource": lambda: ts_string_union(
        CONNECTOR_TYPES_TS, "export type ConnectorSource ="
    ),
}


def test_connector_source_vocabulary_is_identical_across_both_sites():
    """两处装配路线词表逐项且有序一致（canonical = Python store 写侧校验）。

    这个值域是**出站告知**的判据（「经 Composio」/「直连」小字、审批卡那一行、老直连行的
    迁移提示）——漂了不会报错，只会让一条数据出机的路径在 UI 上说成本地直连。
    """
    extracted = {name: fn() for name, fn in _SOURCE_SITES.items()}
    canonical = extracted["py:store.CONNECTOR_SOURCES"]
    assert canonical == ("composio", "custom_mcp"), (
        f"connector.source 值域变成 {canonical!r} —— 改它必须同步 TS wire 类型 + 设置面告知"
        f" + McpApprovalCard 的判据 + mcp-connectors.md 的 Composio 章节"
    )
    for name, values in extracted.items():
        assert values == canonical, (
            f"{name} = {values!r} 与 canonical {canonical!r} 不一致 —— 出站告知会按一个"
            f"对方永远不发的值分支"
        )


# ── ③c 目录 track 值域（08-06 双轨：direct + composio）────────────────────────────

_TRACK_SITES = {
    "py:catalog.CONNECTOR_TRACKS": lambda: py_str_tuple(CATALOG_PY, "CONNECTOR_TRACKS"),
    "ts:shared api ConnectorTrack": lambda: ts_string_union(
        CONNECTOR_TYPES_TS, "export type ConnectorTrack ="
    ),
}


def test_track_vocabulary_is_identical_across_both_sites():
    """两处出厂轨道词表逐项且有序一致（canonical = Python `catalog.CONNECTOR_TRACKS`）。

    漂了会怎样：TS 少一档 → 新轨道的目录卡走进 default 分支（direct 卡被当 composio 卡渲染成
    「先填 Composio key」的 disabled 态 —— 而那一轨恰恰是**不需要 key** 的那条，一整家结构上
    连不上）；Python 多一档而 TS 没有 → 同上，且没有任何报错指向真因。
    """
    extracted = {name: fn() for name, fn in _TRACK_SITES.items()}
    canonical = extracted["py:catalog.CONNECTOR_TRACKS"]
    assert canonical == ("direct", "composio"), (
        f"目录 track 值域变成 {canonical!r} —— 加一条轨道要同时给出它的 source 归属"
        f"（TRACK_TO_SOURCE）、连接端点的分派分支、TS 联合类型与目录卡的渲染分支"
    )
    for name, values in extracted.items():
        assert values == canonical, (
            f"{name} = {values!r} 与 canonical {canonical!r} 不一致 —— 目录卡会按一个"
            f"服务端永远不发的轨道分支"
        )


def test_track_to_source_is_a_bijection_onto_the_source_vocabulary():
    """🔴 track ↔ source 双射：每条轨道恰好一个 source，且两个 source 都被某条轨道认领。

    这是 `row_is_off_track` 的全部内容（设置页那句「先断开再换轨」提示的唯一判据）。漏一边
    的后果不是报错而是**误导**：某个 source 没有轨道认领 → 那一轨的**正确**行被整批判成
    「已被目录取代」，把 owner 诱导去断开重连一遍（08-06 之前老判据犯的正是这个错）。
    """
    tracks = py_str_tuple(CATALOG_PY, "CONNECTOR_TRACKS")
    mapping = py_str_str_dict(CATALOG_PY, "TRACK_TO_SOURCE")
    sources = py_str_tuple(STORE_PY, "CONNECTOR_SOURCES")
    assert tuple(mapping) == tracks, (
        f"TRACK_TO_SOURCE 的键 {tuple(mapping)!r} 与 CONNECTOR_TRACKS {tracks!r} 不一致"
    )
    assert sorted(mapping.values()) == sorted(sources), (
        f"TRACK_TO_SOURCE 的值 {sorted(mapping.values())!r} 没有恰好铺满 CONNECTOR_SOURCES "
        f"{sorted(sources)!r} —— 见本用例 docstring 的「误导」后果"
    )
    assert len(set(mapping.values())) == len(mapping), (
        f"两条轨道映射到同一个 source：{mapping!r} —— row_is_off_track 会认不出换轨"
    )


# ── ④ canary：抽取器失效必须红，不许变成平凡绿 ─────────────────────────────────


def test_extraction_failure_is_red_not_silently_green():
    """用**合成源码**证明每个抽取器在锚点消失 / 写法重构时会抛，而不是返回空集。"""
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(TRIGGER_PY, "_CONNECTOR_GRANT_VALUES", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(STORE_PY, "CONNECTOR_TOOL_MODES", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到"):
        ts_string_union(CONNECTOR_TS, "export type ConnectorToolMode =", src="const x = 1\n")
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(STORE_PY, "CONNECTOR_SOURCES", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到"):
        ts_string_union(CONNECTOR_TYPES_TS, "export type ConnectorSource =", src="const x = 1\n")
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(CATALOG_PY, "CONNECTOR_TRACKS", src="X = 1\n")
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_str_dict(CATALOG_PY, "TRACK_TO_SOURCE", src="X = 1\n")
    with pytest.raises(AssertionError, match="含非 str→str"):
        # 值换成了非字面量（比如从 store 里 import 常量拼出来）→ 必须红，不许抽到半张表
        py_str_str_dict(
            CATALOG_PY, "TRACK_TO_SOURCE", src="TRACK_TO_SOURCE = {'direct': SOME_CONST}\n"
        )
    with pytest.raises(AssertionError, match="找不到"):
        ts_string_union(CONNECTOR_TYPES_TS, "export type ConnectorTrack =", src="const x = 1\n")
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
