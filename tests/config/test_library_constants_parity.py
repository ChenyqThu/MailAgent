"""闸 — 资料库（library）词表 / 上限的两处载体对账。

同一组「资料库的值域事实」跨语言存在两份：

  1. ``frontend/src/shared/libraryConstants.ts`` —— TS 零依赖叶子（renderer / main / ai-gateway 三处共用）
  2. ``src/library/constants.py`` —— Python 零依赖叶子（serve-api 校验 / 存储层 / 路径 jail 单源）

失败形态：改了一侧的 slug / kind / 上限，另一侧不动 —— 编译过、测试过，直到 renderer 把
``library.db`` 里没有的 kind 当成合法值渲染，或 serve-api 按 1 MB 拒了 gateway 按 2 MB 放行的写入。

🔴 抽取失败必须红：每个抽取器抓不到目标结构就抛（不返回空集），外加逐项 canary 下限断言。
🔴 顺序也是契约：词表按**列表**逐位比较（前端 select 选项序、树的顶层序都按这个顺序渲染）。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import List

import pytest

from . import _parsers as p

LIBRARY_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "libraryConstants.ts"
LIBRARY_PY = p.REPO_ROOT / "src" / "library" / "constants.py"

#: 字符串词表（两侧同名；顺序敏感）。
VOCABULARIES = (
    "TOP_LEVEL_SLUGS",
    "KINDS",
    "TEXT_STATUS",
    "FILE_STATUS",
    "SOURCES",
    "MOUNT_MODES",
    "MOUNT_STATUS",
    "WRITE_EXT_ALLOWLIST",
    "MOUNT_DENY_SUFFIXES",
    "MOUNT_DENY_DIRS",
    "GATEWAY_LIBRARY_READ_TOOL_NAMES",
    "GATEWAY_LIBRARY_WRITE_TOOL_NAMES",
)

#: 每组词表的成员数下限（canary：解析器退化成「抓到个空数组」时必须红，而不是平凡绿）。
VOCAB_FLOOR = {
    "TOP_LEVEL_SLUGS": 5,
    "KINDS": 8,
    "TEXT_STATUS": 4,
    "FILE_STATUS": 3,
    "SOURCES": 5,
    "MOUNT_MODES": 2,
    "MOUNT_STATUS": 3,
    "WRITE_EXT_ALLOWLIST": 6,
    "MOUNT_DENY_SUFFIXES": 4,
    "MOUNT_DENY_DIRS": 1,
    "GATEWAY_LIBRARY_READ_TOOL_NAMES": 3,
    "GATEWAY_LIBRARY_WRITE_TOOL_NAMES": 4,
}

#: 数值上限（两侧同名；TS 侧允许 ``1024 * 1024`` 乘法表达式，Python 侧同样）。
INT_CONSTANTS = (
    "TEXT_WRITE_MAX_BYTES",
    "UPLOAD_MAX_BYTES",
    "EXTRACT_MAX_BYTES",
    "READ_TOOL_MAX_CHARS",
    "READ_TOOL_MAX_BYTES",
    "HISTORY_MAX_PER_FILE",
    "HISTORY_MAX_TOTAL_BYTES",
    "TRASH_TTL_DAYS",
    "FOLDER_PAGE_SIZE",
    "MOUNT_MAX_FILES",
    "TREE_VIRTUALIZE_THRESHOLD",
)

#: 字符串常量（两侧同名）。
STR_CONSTANTS = ("PROJECTION_SLUG", "TRASH_SLUG", "AGENT_DOCS_SLUG", "RESOURCE_KEY_PREFIX")


# =============================================================================
# 抽取器（抓不到就抛 —— 不静默返回空集）
# =============================================================================


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


_TS_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
_TS_LINE_COMMENT_RE = re.compile(r"(?m)//.*$")


def _ts_source_without_comments() -> str:
    """先剥注释再抽：数组体内若日后加注释，注释里的引号不能被当成成员（部分抽取比抽不到更毒）。"""
    src = _read(LIBRARY_TS)
    return _TS_LINE_COMMENT_RE.sub("", _TS_BLOCK_COMMENT_RE.sub("", src))


def parse_ts_const_string_array(const_name: str, src: str) -> List[str]:
    """``export const NAME = [ 'a', '.b-c' ] as const`` → 字符串列表（顺序保留；成员可含 ``.`` / ``-``）。"""
    m = re.search(rf"export const {const_name}\s*=\s*\[", src)
    if not m:
        raise AssertionError(
            f"{LIBRARY_TS.name}: 没找到 `export const {const_name} = [` —— 解析器需更新"
        )
    end = src.find("] as const", m.end())
    if end == -1:
        raise AssertionError(
            f"{LIBRARY_TS.name}: {const_name} 数组没有 `] as const` 结尾 —— 解析器需更新"
        )
    members = re.findall(r"'([^'\n]+)'", src[m.end():end])
    if not members:
        raise AssertionError(f"{LIBRARY_TS.name}: {const_name} 数组解析为空 —— 解析器需更新")
    return members


def parse_ts_const_int_expr(const_name: str, src: str) -> int:
    """``export const NAME = 15 * 1024 * 1024`` / ``= 12000`` → int（只认整数与乘号，别的一律抛）。"""
    m = re.search(rf"export const {const_name}\s*=\s*([0-9_\s*]+?)\s*(?:\n|;)", src)
    if not m:
        raise AssertionError(
            f"{LIBRARY_TS.name}: 没找到 `export const {const_name} = <int expr>` —— 解析器需更新"
        )
    factors = [f.strip() for f in m.group(1).split("*")]
    if not factors or any(not re.fullmatch(r"[0-9][0-9_]*", f) for f in factors):
        raise AssertionError(f"{LIBRARY_TS.name}: {const_name} 不是整数乘法表达式 —— 解析器需更新")
    value = 1
    for f in factors:
        value *= int(f.replace("_", ""))
    return value


def parse_ts_const_string(const_name: str, src: str) -> str:
    """``export const NAME = '…'``（单引号字符串字面量）→ 字符串；抓不到必抛。"""
    m = re.search(rf"export const {const_name}\s*(?::\s*[^=]+)?=\s*'([^'\n]*)'", src)
    if not m:
        raise AssertionError(
            f"{LIBRARY_TS.name}: 没找到 `export const {const_name} = '<str>'` —— 解析器需更新"
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


def parse_py_str_tuple(const_name: str, path: Path) -> List[str]:
    """Python 模块级 ``NAME: Tuple[str, ...] = ("a", "b")`` → 列表（顺序保留）。"""
    value = _py_module_const(const_name, path)
    if not isinstance(value, (ast.Tuple, ast.List)):
        raise AssertionError(f"{path.name}: {const_name} 不是 tuple/list 字面量 —— 解析器需更新")
    out: List[str] = []
    for elt in value.elts:
        if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
            raise AssertionError(f"{path.name}: {const_name} 含非字符串常量元素 —— 解析器需更新")
        out.append(elt.value)
    if not out:
        raise AssertionError(f"{path.name}: {const_name} 解析为空 —— 解析器需更新")
    return out


def _py_int_expr(node: ast.AST, label: str) -> int:
    if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        return _py_int_expr(node.left, label) * _py_int_expr(node.right, label)
    raise AssertionError(f"{label} 不是整数常量 / 整数乘法表达式 —— 解析器需更新")


def parse_py_int_expr(const_name: str, path: Path) -> int:
    """Python 模块级 ``NAME: int = 15 * 1024 * 1024`` / ``NAME = 12000``（AST，只认整数与乘号）。"""
    return _py_int_expr(_py_module_const(const_name, path), f"{path.name}: {const_name}")


def parse_py_str_const(const_name: str, path: Path) -> str:
    """Python 模块级 ``NAME: str = "…"`` / ``NAME = "…"``（AST）。"""
    value = _py_module_const(const_name, path)
    if not (isinstance(value, ast.Constant) and isinstance(value.value, str)):
        raise AssertionError(f"{path.name}: {const_name} 不是字符串常量 —— 解析器需更新")
    return value.value


# =============================================================================
# 对账
# =============================================================================


@pytest.mark.parametrize("name", VOCABULARIES)
def test_vocabulary_ts_python_parity(name: str) -> None:
    """TS 叶子与 Python 叶子的同名词表逐位相等（成员 + 顺序）。"""
    ts = parse_ts_const_string_array(name, _ts_source_without_comments())
    py = parse_py_str_tuple(name, LIBRARY_PY)
    floor = VOCAB_FLOOR[name]
    assert len(ts) >= floor, f"libraryConstants.ts 的 {name} 只解析到 {len(ts)} 项（预期 >={floor}）—— 解析器坏了"
    assert len(py) >= floor, f"constants.py 的 {name} 只解析到 {len(py)} 项（预期 >={floor}）—— 解析器坏了"
    assert ts == py, (
        f"{name} 的 TS / Python 两份词表漂了（成员或顺序）：\n"
        f"  libraryConstants.ts：{ts}\n"
        f"  constants.py：      {py}\n"
        "→ 改词表必须两侧同批：libraryConstants.ts / src/library/constants.py。"
    )


@pytest.mark.parametrize("name", INT_CONSTANTS)
def test_int_constant_parity(name: str) -> None:
    """数值上限：TS 叶子 = Python 叶子（renderer 的前置校验与 serve-api 的必须同数）。"""
    ts = parse_ts_const_int_expr(name, _ts_source_without_comments())
    py = parse_py_int_expr(name, LIBRARY_PY)
    assert ts > 0 and py > 0, f"{name} 解析成 0 —— 解析器坏了"
    assert ts == py, (
        f"{name} 漂了：libraryConstants.ts={ts}，constants.py={py}。"
        "两侧不同数 = renderer 放行的写入被 serve-api 拒（或反过来服务端放行了 gateway 截断过的内容）。"
    )


@pytest.mark.parametrize("name", STR_CONSTANTS)
def test_str_constant_parity(name: str) -> None:
    """字符串常量：slug / 引用键前缀两侧逐字相等（前缀不同字 = 事项里的 `library:` 引用解析不到）。"""
    ts = parse_ts_const_string(name, _ts_source_without_comments())
    py = parse_py_str_const(name, LIBRARY_PY)
    assert ts and py, f"{name} 解析成空串 —— 解析器坏了"
    assert ts == py, f"{name} 漂了：libraryConstants.ts={ts!r}，constants.py={py!r}"


def test_named_slugs_are_members_of_top_level_slugs() -> None:
    """三个具名 slug 必须是 TOP_LEVEL_SLUGS 的成员（改名漏一处 = 树里少一根 / 免卡通道指向不存在的目录）。"""
    slugs = parse_py_str_tuple("TOP_LEVEL_SLUGS", LIBRARY_PY)
    for name in ("PROJECTION_SLUG", "TRASH_SLUG", "AGENT_DOCS_SLUG"):
        value = parse_py_str_const(name, LIBRARY_PY)
        assert value in slugs, f"{name}={value!r} 不在 TOP_LEVEL_SLUGS {slugs} 里"


def test_extractors_fail_loudly_on_missing_structures() -> None:
    """反向用例：抽取器抓不到目标结构时必须抛（否则整道闸会退化成平凡绿）。"""
    ts_src = _ts_source_without_comments()
    with pytest.raises(AssertionError):
        parse_ts_const_string_array("LIBRARY_NO_SUCH_VOCAB", ts_src)
    with pytest.raises(AssertionError):
        parse_ts_const_int_expr("NO_SUCH_INT_CONST", ts_src)
    with pytest.raises(AssertionError):
        parse_ts_const_string("NO_SUCH_STR_CONST", ts_src)
    with pytest.raises(AssertionError):
        parse_py_str_tuple("NO_SUCH_VOCAB", LIBRARY_PY)
    with pytest.raises(AssertionError):
        parse_py_int_expr("NO_SUCH_INT_CONST", LIBRARY_PY)
    with pytest.raises(AssertionError):
        parse_py_str_const("NO_SUCH_STR_CONST", LIBRARY_PY)
    # 数组体存在但为空 → 也必须红（不是「无对象可比 = 平凡绿」）。
    with pytest.raises(AssertionError):
        parse_ts_const_string_array("EMPTY", "export const EMPTY = [] as const\n")
    # 非乘法表达式（加法 / 浮点）→ 抛，而不是猜一个数。
    with pytest.raises(AssertionError):
        parse_ts_const_int_expr("BAD", "export const BAD = 1 + 2\n")
