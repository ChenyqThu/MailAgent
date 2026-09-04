"""闸 — 群聊（g1）词表 / 成员上限的四处载体对账。

同一组「群编排的值域事实」跨语言、跨构件种类地存在四份：

  1. ``frontend/src/ai-gateway/groupFloors.ts`` —— TS 零依赖叶子（调度器 + renderer 单源）
  2. ``src/chat/group_limits.py`` —— Python 零依赖叶子（serve-api 校验单源）
  3. ``frontend/src/electron/main/chat_db/connection.ts`` v31 迁移块的三条 SQL ``CHECK``
     —— 数据库层的值域（SQL 字符串里的手抄，跨构件种类的边界）
  4. ``src/api/routers/chat.py`` —— 校验点。这一处**有意不是手抄**：它 import 单源 2，闸在这里
     钉住「它不许自己再写一份字面量」（CLAUDE.md：先问能不能消灭镜像，消灭不了才建闸）。

失败形态：改了一处词表 / 上限，另外三处不动 —— 编译过、测试过，直到某个 outcome 被 SQLite 的
CHECK 拒绝（整条 turn 台账写不进去 = 指标与地板计数同时静默失真），或 serve-api 放行了一个
gateway 不认识的响应模式。

🔴 抽取失败必须红：每个抽取器抓不到目标结构就抛（不返回空集），外加逐项 canary 断言非空。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Dict, List, Set

import pytest

from . import _parsers as p

GROUP_FLOORS_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "groupFloors.ts"
GROUP_LIMITS_PY = p.REPO_ROOT / "src" / "chat" / "group_limits.py"
CONNECTION_TS = (
    p.REPO_ROOT / "frontend" / "src" / "electron" / "main" / "chat_db" / "connection.ts"
)
CHAT_ROUTER_PY = p.REPO_ROOT / "src" / "api" / "routers" / "chat.py"

#: 三组词表在 TS / Python 两侧的同名常量（名字也是契约的一部分）。
VOCABULARIES = ("RESPONSE_MODES", "GROUP_STOP_REASONS", "GROUP_TURN_OUTCOMES", "GROUP_TRIGGER_KINDS")

#: 每组词表的成员数下限（canary：解析器退化成「抓到个空数组」时必须红，而不是平凡绿）。
VOCAB_FLOOR = {
    "RESPONSE_MODES": 2,
    "GROUP_STOP_REASONS": 12,
    "GROUP_TURN_OUTCOMES": 6,
    "GROUP_TRIGGER_KINDS": 4,
}

#: v31 的三条 CHECK 各自对应哪个词表（SQL 列名 → 常量名）。
CHECK_COLUMNS = {
    "response_mode": "RESPONSE_MODES",
    "outcome": "GROUP_TURN_OUTCOMES",
    "trigger_kind": "GROUP_TRIGGER_KINDS",
}


# =============================================================================
# 抽取器（抓不到就抛 —— 不静默返回空集）
# =============================================================================


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_ts_const_string_array(const_name: str, src: str) -> List[str]:
    """``export const NAME = [ 'a', 'b' ] as const`` → 字符串列表（顺序保留）。"""
    start = src.find(f"export const {const_name}")
    if start == -1:
        raise AssertionError(
            f"{GROUP_FLOORS_TS.name}: 没找到 `export const {const_name}` —— 解析器需更新"
        )
    end = src.find("] as const", start)
    if end == -1:
        raise AssertionError(
            f"{GROUP_FLOORS_TS.name}: {const_name} 数组没有 `] as const` 结尾 —— 解析器需更新"
        )
    body = src[start:end]
    open_idx = body.find("[")
    if open_idx == -1:
        raise AssertionError(f"{GROUP_FLOORS_TS.name}: {const_name} 不是数组字面量 —— 解析器需更新")
    return re.findall(r"'([a-z_]+)'", body[open_idx:])


def parse_ts_const_int(const_name: str, src: str) -> int:
    """``export const NAME = 8`` → 8（允许 `8` / `8_000` 写法）。"""
    m = re.search(rf"export const {const_name}\s*(?::\s*[^=]+)?=\s*([0-9_]+)\b", src)
    if not m:
        raise AssertionError(
            f"{GROUP_FLOORS_TS.name}: 没找到 `export const {const_name} = <int>` —— 解析器需更新"
        )
    return int(m.group(1).replace("_", ""))


def parse_ts_const_string(const_name: str, src: str) -> str:
    """``export const NAME = '…'``（单引号字符串字面量）→ 字符串；抓不到必抛。"""
    m = re.search(rf"export const {const_name}\s*(?::\s*[^=]+)?=\s*'([^'\n]*)'", src)
    if not m:
        raise AssertionError(
            f"{GROUP_FLOORS_TS.name}: 没找到 `export const {const_name} = '<str>'` —— 解析器需更新"
        )
    return m.group(1)


def _py_module_const(const_name: str, path: Path) -> ast.AST:
    """模块级 ``NAME: T = <value>`` / ``NAME = <value>`` 的值节点（AST，不 import 目标模块）。"""
    tree = ast.parse(_read(path))
    for stmt in tree.body:
        target = None
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            target = stmt.target.id
        elif (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
        ):
            target = stmt.targets[0].id
        if target != const_name or stmt.value is None:
            continue
        return stmt.value
    raise AssertionError(f"{path.name}: 没找到模块级 `{const_name} = <value>` —— 解析器需更新")


def parse_py_int_const(const_name: str, path: Path) -> int:
    """Python 模块级 ``NAME: int = 8`` / ``NAME = 8``（AST，不 import 目标模块）。"""
    value = _py_module_const(const_name, path)
    if not (isinstance(value, ast.Constant) and isinstance(value.value, int)):
        raise AssertionError(f"{path.name}: {const_name} 不是整数常量 —— 解析器需更新")
    return int(value.value)


def parse_py_str_const(const_name: str, path: Path) -> str:
    """Python 模块级 ``NAME: str = "…"`` / ``NAME = "…"``（AST，同 parse_py_int_const 体例）。"""
    value = _py_module_const(const_name, path)
    if not (isinstance(value, ast.Constant) and isinstance(value.value, str)):
        raise AssertionError(f"{path.name}: {const_name} 不是字符串常量 —— 解析器需更新")
    return value.value


def parse_v31_check_vocabularies() -> Dict[str, Set[str]]:
    """connection.ts 的 v31 迁移块里三条 ``CHECK (<col> IN ('a','b'))`` 的值域。

    🔴 只在 v31 块里找（`if (current < 31)` 到函数末），避免把别的版本块 / 头注里的同名字符串
    当成 v31 的 CHECK（部分抽取比抽不到更毒）。
    """
    src = _read(CONNECTION_TS)
    start = src.find("if (current < 31) {")
    if start == -1:
        raise AssertionError(f"{CONNECTION_TS.name}: 没找到 v31 迁移块 —— 解析器需更新")
    block = src[start:]
    out: Dict[str, Set[str]] = {}
    for column in CHECK_COLUMNS:
        m = re.search(rf"CHECK\s*\(\s*{column}\s+IN\s*\(([^)]*)\)\s*\)", block)
        if not m:
            raise AssertionError(
                f"{CONNECTION_TS.name}: v31 块里没找到 `CHECK ({column} IN (...))` —— 解析器需更新"
            )
        out[column] = set(re.findall(r"'([a-z_]+)'", m.group(1)))
    return out


# =============================================================================
# 对账
# =============================================================================


@pytest.mark.parametrize("name", VOCABULARIES)
def test_vocabulary_ts_python_parity(name: str) -> None:
    """TS 叶子与 Python 叶子的同名词表逐字相等（顺序无关，成员集相等）。"""
    ts = parse_ts_const_string_array(name, _read(GROUP_FLOORS_TS))
    py = p.parse_py_key_collection(name, path=GROUP_LIMITS_PY)
    floor = VOCAB_FLOOR[name]
    assert len(ts) >= floor, f"groupFloors.ts 的 {name} 只解析到 {len(ts)} 项（预期 >={floor}）—— 解析器坏了"
    assert len(py) >= floor, f"group_limits.py 的 {name} 只解析到 {len(py)} 项（预期 >={floor}）—— 解析器坏了"
    assert set(ts) == py, (
        f"{name} 的 TS / Python 两份词表漂了：\n"
        f"  只在 groupFloors.ts：{sorted(set(ts) - py)}\n"
        f"  只在 group_limits.py：{sorted(py - set(ts))}\n"
        "→ 改词表必须四处同批：groupFloors.ts / group_limits.py / connection.ts v31 的 CHECK / "
        "chat.py（后者 import 单源，不另写字面量）。"
    )


def test_v31_check_vocabularies_match_the_leaves() -> None:
    """SQLite 的三条 CHECK = 两个叶子的同一份词表（DB 层拒收 = 整条台账写不进去）。"""
    checks = parse_v31_check_vocabularies()
    ts_src = _read(GROUP_FLOORS_TS)
    for column, const_name in CHECK_COLUMNS.items():
        values = checks[column]
        assert len(values) >= VOCAB_FLOOR[const_name], (
            f"connection.ts v31 的 {column} CHECK 只解析到 {len(values)} 项 —— 解析器坏了"
        )
        assert values == set(parse_ts_const_string_array(const_name, ts_src)), (
            f"{column} 的 SQL CHECK 与 groupFloors.ts 的 {const_name} 漂了：\n"
            f"  只在 CHECK：{sorted(values - set(parse_ts_const_string_array(const_name, ts_src)))}\n"
            f"  只在 TS 词表：{sorted(set(parse_ts_const_string_array(const_name, ts_src)) - values)}\n"
            "→ CHECK 是 DB 层的硬拒收：词表多一个值而 CHECK 没跟上 = 那个 outcome 的 turn 行"
            "整条写不进去，指标与地板计数同时静默失真。"
        )
        assert values == p.parse_py_key_collection(const_name, path=GROUP_LIMITS_PY)


def test_max_group_members_parity() -> None:
    """成员上限：TS 叶子 = Python 叶子（renderer 的建群校验与 serve-api 的必须同数）。"""
    ts = parse_ts_const_int("MAX_GROUP_MEMBERS", _read(GROUP_FLOORS_TS))
    py = parse_py_int_const("MAX_GROUP_MEMBERS", GROUP_LIMITS_PY)
    assert ts > 0 and py > 0, "成员上限解析成 0 —— 解析器坏了"
    assert ts == py, (
        f"MAX_GROUP_MEMBERS 漂了：groupFloors.ts={ts}，group_limits.py={py}。"
        "两侧不同数 = renderer 让你选 8 个人、serve-api 在 5 个人处 400（或反过来，"
        "服务端放行了 gateway 的调度器没准备好承受的扇出）。"
    )


def test_chain_cap_max_parity() -> None:
    """chainCap 的允许上限：serve-api 的校验区间上界 = TS 侧的 CHAIN_CAP_MAX。"""
    ts = parse_ts_const_int("CHAIN_CAP_MAX", _read(GROUP_FLOORS_TS))
    py = parse_py_int_const("CHAIN_CAP_MAX", GROUP_LIMITS_PY)
    assert ts == py, f"CHAIN_CAP_MAX 漂了：groupFloors.ts={ts}，group_limits.py={py}"


def test_main_agent_member_id_parity() -> None:
    """主 agent 的保留成员 id：serve-api 的短路放行（Python）与 gateway 合成成员（TS）必须同字。

    两侧不同字 = 一侧把它当保留字放行、另一侧当普通 agent id 去查 report_agent 行 —— 群里的
    主 agent 要么建不出来（400），要么建出来后在发言时「人间蒸发」（成员事实缺失 → 403）。
    """
    ts = parse_ts_const_string("MAIN_AGENT_MEMBER_ID", _read(GROUP_FLOORS_TS))
    py = parse_py_str_const("MAIN_AGENT_MEMBER_ID", GROUP_LIMITS_PY)
    assert ts and py, "MAIN_AGENT_MEMBER_ID 解析成空串 —— 解析器坏了"
    assert ts == py, (
        f"MAIN_AGENT_MEMBER_ID 漂了：groupFloors.ts={ts!r}，group_limits.py={py!r}。"
    )


def test_chat_router_consumes_the_single_source() -> None:
    """第四处载体（chat.py 的校验点）**必须 import 单源，不许自己写字面量**。

    这是「消灭镜像 > 建闸」的执行面：真出现第四份手抄时，本用例先红。
    """
    src = _read(CHAT_ROUTER_PY)
    assert "from src.chat.group_limits import" in src, (
        "chat.py 不再 import group_limits —— 群校验要么被删了，要么改成了自己写一份字面量"
    )
    for name in ("MAX_GROUP_MEMBERS", "RESPONSE_MODES", "CHAIN_CAP_MAX"):
        assert name in src, f"chat.py 不再引用 {name} —— 校验点与单源脱钩"
    # 值域字面量元组（`("realtime", "mention")` 之类）不许在 chat.py 里重新出现。
    assert not re.search(r'"realtime"\s*,\s*"mention"', src), (
        "chat.py 里出现了响应模式的字面量元组 —— 这就是第四份手抄，改用 group_limits.RESPONSE_MODES"
    )


def test_extractors_fail_loudly_on_missing_structures() -> None:
    """反向用例：抽取器抓不到目标结构时必须抛（否则整道闸会退化成平凡绿）。"""
    with pytest.raises(AssertionError):
        parse_ts_const_string_array("GROUP_NO_SUCH_VOCAB", _read(GROUP_FLOORS_TS))
    with pytest.raises(AssertionError):
        parse_ts_const_int("NO_SUCH_INT_CONST", _read(GROUP_FLOORS_TS))
    with pytest.raises(AssertionError):
        parse_py_int_const("NO_SUCH_INT_CONST", GROUP_LIMITS_PY)
    with pytest.raises(AssertionError):
        p.parse_py_key_collection("NO_SUCH_VOCAB", path=GROUP_LIMITS_PY)
    with pytest.raises(AssertionError):
        parse_ts_const_string("NO_SUCH_STR_CONST", _read(GROUP_FLOORS_TS))
    with pytest.raises(AssertionError):
        parse_py_str_const("NO_SUCH_STR_CONST", GROUP_LIMITS_PY)
