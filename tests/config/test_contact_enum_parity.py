"""通讯录枚举/可锁字段词表的**跨语言一致性闸**（task 08-13 WP2）。

canonical = ``src/contacts/taxonomy.py``（contact 表 CHECK 值域经 sql_check_clause
引用它，Python 侧零手抄）；TS 手抄 = ``frontend/src/shared/api/types/contact.ts``
（renderer 无法 import Python，运行时词表只能自带一份 —— 消灭不了镜像，故建闸）。

漂了会怎样：TS 侧多一档 → 设置面能选、PATCH 却 400；TS 侧少一档 → 服务端真存着
它时前端类型收窄崩投影（chips 行少一个选项、锁 pill 对不上字段）。

🔴 抽取失败必须**红**：抓不到锚点 / 声明改形 → AssertionError，不许退化成
「没东西可比 = 平凡绿」；末尾 canary 用合成源码证明闸真会红。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import List, Optional, Tuple

import pytest

from . import _parsers as p

TAXONOMY_PY = p.REPO_ROOT / "src" / "contacts" / "taxonomy.py"
CONTACT_TS = (
    p.REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "contact.ts"
)

#: canonical 常量名 → TS 声明锚点（两侧同名，方便 grep）。
PAIRS = (
    "CONTACT_KIND_VALUES",
    "CONTACT_FUNCTION_VALUES",
    "CONTACT_SENIORITY_VALUES",
    "CONTACT_LOCKABLE_FIELDS",
)


# ── 抽取器（Python: AST；TS: decl → 首个 `]` 的跨行 span）──────────────────────


def py_str_tuple(path: Path, name: str, src: Optional[str] = None) -> Tuple[str, ...]:
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
                value = node.value
                assert isinstance(value, (ast.Tuple, ast.List)), (
                    f"{path.name}: `{name}` 不是 tuple/list 字面量 —— 抽取器需更新"
                )
                out: List[str] = []
                for el in value.elts:
                    assert isinstance(el, ast.Constant) and isinstance(el.value, str), (
                        f"{path.name}: `{name}` 含非字符串字面量项 —— 抽取器需更新"
                    )
                    out.append(el.value)
                assert out, f"{path.name}: `{name}` 抽到空集 —— 抽取器需更新"
                return tuple(out)
    raise AssertionError(
        f"{path.name} 里找不到顶层常量 `{name}` —— 改名/搬家了，本闸抽取器需同步更新"
    )


def ts_array_literals(path: Path, name: str, src: Optional[str] = None) -> Tuple[str, ...]:
    """``export const <name> = [ … ] as const`` 里的字符串字面量（跨行, prettier
    重排安全; 到首个 ``]`` 为止）。"""
    text = path.read_text(encoding="utf-8") if src is None else src
    decl = f"export const {name}"
    idx = text.find(decl)
    assert idx >= 0, f"{path.name} 里找不到 `{decl}` —— 声明改名/搬家了，抽取器需同步更新"
    open_idx = text.find("[", idx)
    close_idx = text.find("]", idx)
    assert 0 <= open_idx < close_idx, (
        f"{path.name}: `{decl}` 后找不到 `[ … ]` 数组字面量 —— 声明改形了，抽取器需更新"
    )
    span = text[open_idx : close_idx + 1]
    lits = re.findall(r"""['"]([^'"]+)['"]""", span)
    assert lits, f"{path.name}: `{decl}` 的数组里抽不到任何字符串字面量 —— 抽取器需更新"
    return tuple(lits)


# ── 逐词表有序一致 ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", PAIRS)
def test_contact_vocabulary_identical_across_languages(name):
    canonical = py_str_tuple(TAXONOMY_PY, name)
    ts = ts_array_literals(CONTACT_TS, name)
    assert ts == canonical, (
        f"{name}: TS 手抄 {ts!r} 与 taxonomy.py canonical {canonical!r} 不一致 —— "
        f"改词表必须两侧同步（TS 侧多档 = 能选却 PATCH 400；少档 = 服务端真值在"
        f"前端投影里没有落点）"
    )


# ── canary：抽取器失效必须红 ───────────────────────────────────────────────────


def test_extraction_failure_is_red_not_silently_green():
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(TAXONOMY_PY, "CONTACT_KIND_VALUES", src="X = 1\n")
    with pytest.raises(AssertionError, match="非字符串字面量"):
        py_str_tuple(
            TAXONOMY_PY, "CONTACT_KIND_VALUES",
            src="CONTACT_KIND_VALUES = ('person', X)\n",
        )
    with pytest.raises(AssertionError, match="找不到"):
        ts_array_literals(CONTACT_TS, "CONTACT_KIND_VALUES", src="const x = 1\n")
    with pytest.raises(AssertionError, match="抽不到任何字符串字面量"):
        ts_array_literals(
            CONTACT_TS, "CONTACT_KIND_VALUES",
            src="export const CONTACT_KIND_VALUES = [] as const\n",
        )
    with pytest.raises(AssertionError, match="数组字面量"):
        ts_array_literals(
            CONTACT_TS, "CONTACT_KIND_VALUES",
            src="export const CONTACT_KIND_VALUES = makeValues()\n",
        )
