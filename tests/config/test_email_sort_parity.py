"""列表排序 ORDER BY 白名单的跨语言对账闸（TS `emailSort.ts` ↔ Python `email_views.py`）。

登记在 ``docs/reference/architecture/architecture-internals.md``「跨语言手抄常量的一致性闸」
表里（**加闸必须登记，否则无人发现**）。

**为什么是建闸而不是消灭镜像**（CLAUDE.md 要求先问这个问题）：同一个「按发件人/主题/
重要性排序时 SQL 该怎么写」的事实有两份实现 ——

  * 桌面 IPC 走 better-sqlite3 主进程 DAO（``frontend/src/shared/lib/emailSort.ts`` 的
    ``ENRICHED_ORDER_BY``，由 ``electron/main/handlers/email.ts`` 拼进 listEnriched）
  * 远程 web 走 serve-api（``src/api/routers/email_views.py`` 的同名常量）

两条 wire 各自建 SQL、跨进程跨语言，没有可共享的运行时载体（把 SQL 片段塞进配置文件
反而多一层可漂移的手抄）。TS 那侧**已经**把词表 + SQL 收敛进一个零依赖叶子模块，能消灭
的镜像都消灭了；剩下的 Python 这份消灭不掉，故建闸。

**漂了会怎样**（本闸的 load-bearing 处）：同一封邮件在桌面和远程网页上排在不同位置，
两边各自看都自洽、都不报错。最毒的一种是 importance 的 null-guard 首列只在一侧存在 ——
那一侧的「由低到高」会把一整片没跑过 AI 的邮件顶到最前面，另一侧不会。

🔴 抽取失败必须红：两个抽取器都有 count canary + 抓不到结构时 ``AssertionError``，
不允许退化成「没东西可比 = 平凡绿」。
"""

from __future__ import annotations

import ast
import re
from typing import Dict

import pytest

from . import _parsers as p

EMAIL_SORT_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "lib" / "emailSort.ts"
EMAIL_VIEWS_PY = p.REPO_ROOT / "src" / "api" / "routers" / "email_views.py"

# 词表基数 canary —— 抽取器只抓到一部分（比抓不到更毒，见 internals「两个实战坑」）
# 时立刻红。改动排序键数量时**同步改这里**，那正是「请再看一眼两侧」的提示。
EXPECTED_SORT_KEYS = {"date", "sender", "subject", "importance"}
EXPECTED_SORT_DIRS = {"desc", "asc"}


def _norm(sql: str) -> str:
    """空白归一 —— 两侧的缩进/换行不同（TS 模板串 vs Python 三引号），比的是 SQL。"""
    return re.sub(r"\s+", " ", sql).strip()


# ---------------------------------------------------------------------------
# TS 侧抽取
# ---------------------------------------------------------------------------


def _ts_src(src: str | None = None) -> str:
    return EMAIL_SORT_TS.read_text(encoding="utf-8") if src is None else src


def ts_sort_keys(src: str | None = None) -> set[str]:
    body = _ts_src(src)
    m = re.search(r"export const EMAIL_SORT_KEYS = \[([^\]]*)\] as const", body)
    assert m, "emailSort.ts 里抓不到 `export const EMAIL_SORT_KEYS = [...] as const` —— 抽取器需更新"
    keys = set(re.findall(r"'([^']+)'", m.group(1)))
    assert keys, "EMAIL_SORT_KEYS 抽出空集 —— 抽取器需更新"
    return keys


def ts_sort_dirs(src: str | None = None) -> set[str]:
    body = _ts_src(src)
    m = re.search(r"export const EMAIL_SORT_DIRS = \[([^\]]*)\] as const", body)
    assert m, "emailSort.ts 里抓不到 `export const EMAIL_SORT_DIRS = [...] as const` —— 抽取器需更新"
    dirs = set(re.findall(r"'([^']+)'", m.group(1)))
    assert dirs, "EMAIL_SORT_DIRS 抽出空集 —— 抽取器需更新"
    return dirs


def ts_order_by(src: str | None = None) -> Dict[str, str]:
    """`ENRICHED_ORDER_BY` 的 key → SQL 模板（模板串里的 `${...}` 先按 TS 常量求值）。"""
    body = _ts_src(src)
    idx = body.find("export const ENRICHED_ORDER_BY")
    assert idx >= 0, "emailSort.ts 里抓不到 `export const ENRICHED_ORDER_BY` —— 抽取器需更新"
    brace = body.find("{", idx)
    assert brace >= 0, "ENRICHED_ORDER_BY 找不到对象字面量起始 `{` —— 抽取器需更新"
    block = p._balanced_block(body, brace, "emailSort.ENRICHED_ORDER_BY")

    # 名次常量（`PRIORITY_RANK.critical` 之类）+ PRIORITY_RANK_SQL 供模板串求值。
    ranks = _ts_priority_ranks(body)
    rank_sql = _ts_priority_rank_sql(body, ranks)

    out: Dict[str, str] = {}
    # 每一项形如 `key: '...'` / `key: "..."` / `key: \`...\``，值可能跨行。
    for m in re.finditer(r"(?m)^\s{2}(\w+):\s*(['\"`])(.*?)\2,?\s*$", block, re.S):
        out[m.group(1)] = _ts_eval_template(m.group(3), rank_sql, ranks)
    assert out, "ENRICHED_ORDER_BY 抽出空集 —— 抽取器需更新"
    return out


def _ts_priority_ranks(body: str) -> Dict[str, int]:
    idx = body.find("export const PRIORITY_RANK = {")
    assert idx >= 0, "emailSort.ts 里抓不到 `export const PRIORITY_RANK = {` —— 抽取器需更新"
    block = p._balanced_block(body, body.find("{", idx), "emailSort.PRIORITY_RANK")
    ranks = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", block)}
    assert len(ranks) == 5, f"PRIORITY_RANK 期望 5 档，抽到 {len(ranks)} —— 抽取器需更新"
    m = re.search(r"export const PRIORITY_RANK_UNKNOWN = (\d+)", body)
    assert m, "emailSort.ts 里抓不到 PRIORITY_RANK_UNKNOWN —— 抽取器需更新"
    ranks["__unknown__"] = int(m.group(1))
    return ranks


def _ts_priority_rank_sql(body: str, ranks: Dict[str, int]) -> str:
    m = re.search(r"const PRIORITY_RANK_SQL = `(.*?)`", body, re.S)
    assert m, "emailSort.ts 里抓不到 PRIORITY_RANK_SQL 模板串 —— 抽取器需更新"
    return _ts_eval_template(m.group(1), None, ranks)


def _ts_eval_template(tpl: str, rank_sql: str | None, ranks: Dict[str, int]) -> str:
    """把模板串里的 `${PRIORITY_RANK.x}` / `${PRIORITY_RANK_UNKNOWN}` / `${PRIORITY_RANK_SQL}`
    换成字面值。出现任何**没登记**的插值 → 抛错（抽取器失效必红，不许静默留原样）。"""

    def sub(m: "re.Match[str]") -> str:
        expr = m.group(1).strip()
        if expr == "PRIORITY_RANK_UNKNOWN":
            return str(ranks["__unknown__"])
        if expr == "PRIORITY_RANK_SQL":
            assert rank_sql is not None, "PRIORITY_RANK_SQL 自身不应再插值它自己"
            return rank_sql
        km = re.fullmatch(r"PRIORITY_RANK\.(\w+)", expr)
        if km:
            return str(ranks[km.group(1)])
        raise AssertionError(f"emailSort.ts 模板串里出现未登记的插值 `${{{expr}}}` —— 抽取器需更新")

    return re.sub(r"\$\{([^}]*)\}", sub, tpl)


# ---------------------------------------------------------------------------
# Python 侧抽取（AST，不 import —— email_views.py 会拉起 FastAPI + repo）
# ---------------------------------------------------------------------------


def _py_module(src: str | None = None) -> ast.Module:
    return ast.parse(EMAIL_VIEWS_PY.read_text(encoding="utf-8") if src is None else src)


def _py_assign(tree: ast.Module, name: str) -> ast.AST:
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
        if target == name and stmt.value is not None:
            return stmt.value
    raise AssertionError(f"email_views.py 里没找到模块级 `{name} = ...` —— 抽取器需更新")


def py_sort_keys(src: str | None = None) -> set[str]:
    node = _py_assign(_py_module(src), "EMAIL_SORT_KEYS")
    return p._string_literals_of(node, "email_views.EMAIL_SORT_KEYS")


def py_sort_dirs(src: str | None = None) -> set[str]:
    node = _py_assign(_py_module(src), "EMAIL_SORT_DIRS")
    return p._string_literals_of(node, "email_views.EMAIL_SORT_DIRS")


def py_order_by(src: str | None = None) -> Dict[str, str]:
    """`ENRICHED_ORDER_BY` dict 字面量 → key → SQL（f-string 里的常量插值已求值）。"""
    tree = _py_module(src)
    node = _py_assign(tree, "ENRICHED_ORDER_BY")
    assert isinstance(node, ast.Dict), "email_views.ENRICHED_ORDER_BY 不是 dict 字面量 —— 抽取器需更新"
    consts = _py_consts(tree)
    out: Dict[str, str] = {}
    for k, v in zip(node.keys, node.values):
        assert isinstance(k, ast.Constant) and isinstance(k.value, str), (
            "ENRICHED_ORDER_BY 的键必须是字符串字面量 —— 抽取器需更新"
        )
        out[k.value] = _py_eval_str(v, consts, f"ENRICHED_ORDER_BY[{k.value!r}]")
    assert out, "ENRICHED_ORDER_BY 抽出空集 —— 抽取器需更新"
    return out


def _py_consts(tree: ast.Module) -> Dict[str, object]:
    """模块级的字符串/整数常量（供 f-string 插值求值）。"""
    out: Dict[str, object] = {}
    for stmt in tree.body:
        if (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and isinstance(stmt.value, ast.Constant)
            and isinstance(stmt.value.value, (str, int))
        ):
            out[stmt.targets[0].id] = stmt.value.value
    return out


def _py_eval_str(node: ast.AST, consts: Dict[str, object], label: str) -> str:
    """字符串字面量 / 隐式拼接 / f-string（只允许插值模块级常量）→ 字面值。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for v in node.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                parts.append(v.value)
            elif isinstance(v, ast.FormattedValue):
                assert isinstance(v.value, ast.Name), (
                    f"{label}: f-string 只允许插值模块级常量名 —— 抽取器需更新"
                )
                assert v.value.id in consts, (
                    f"{label}: f-string 插值了未登记的常量 `{v.value.id}` —— 抽取器需更新"
                )
                parts.append(str(consts[v.value.id]))
            else:  # pragma: no cover - 结构变了就该红
                raise AssertionError(f"{label}: f-string 里出现无法求值的片段 —— 抽取器需更新")
        return "".join(parts)
    raise AssertionError(f"{label}: 期望字符串 / f-string 字面量 —— 抽取器需更新")


# ---------------------------------------------------------------------------
# 对账
# ---------------------------------------------------------------------------


def test_sort_key_vocabulary_parity():
    ts, py = ts_sort_keys(), py_sort_keys()
    assert ts == EXPECTED_SORT_KEYS, f"排序键集变了（TS={ts}）—— 改了词表就同步改本闸的 canary"
    assert ts == py, f"排序键词表两侧不一致：TS={ts} Python={py}"


def test_sort_dir_vocabulary_parity():
    ts, py = ts_sort_dirs(), py_sort_dirs()
    assert ts == EXPECTED_SORT_DIRS, f"排序方向集变了（TS={ts}）—— 改了词表就同步改本闸的 canary"
    assert ts == py, f"排序方向词表两侧不一致：TS={ts} Python={py}"


def test_order_by_sql_parity():
    ts, py = ts_order_by(), py_order_by()
    assert set(ts) == EXPECTED_SORT_KEYS, f"TS ENRICHED_ORDER_BY 的键集 = {set(ts)}"
    assert set(ts) == set(py), f"ENRICHED_ORDER_BY 键集不一致：TS={set(ts)} Python={set(py)}"
    for key in sorted(ts):
        assert _norm(ts[key]) == _norm(py[key]), (
            f"ORDER BY 模板 `{key}` 两侧不一致：\n  TS    = {_norm(ts[key])}\n"
            f"  Python= {_norm(py[key])}"
        )


def test_every_template_carries_the_stable_second_key_and_placeholder():
    """两侧每条模板都必须带 `m.internal_id` 尾键 + `{dir}` 占位（漏一个就是不稳定序 /
    SQL 语法错，而且只在某一端出现）。"""
    for label, table in (("TS", ts_order_by()), ("Python", py_order_by())):
        for key, sql in table.items():
            assert "m.internal_id" in sql, f"{label} 的 `{key}` 模板缺稳定第二键 m.internal_id"
            assert "{dir}" in sql, f"{label} 的 `{key}` 模板缺 {{dir}} 占位符"


def test_importance_null_guard_is_direction_independent_on_both_sides():
    """🔴 importance 的首列必须是恒 ASC 的 null-guard —— 它跟着方向翻的话，
    「由低到高」会把一整片没跑过 AI 的邮件顶到最前面（而且只在漂掉的那一端）。"""
    for label, table in (("TS", ts_order_by()), ("Python", py_order_by())):
        sql = _norm(table["importance"])
        assert sql.startswith("(CASE WHEN ("), f"{label} 的 importance 模板首列不是 CASE 表达式"
        assert "THEN 1 ELSE 0 END) ASC," in sql, (
            f"{label} 的 importance null-guard 不是恒 ASC —— {sql}"
        )


# ---------------------------------------------------------------------------
# 反向闸 —— 抽取器失效必须红，不许静默变成「无对象可比 = 平凡绿」
# ---------------------------------------------------------------------------


def test_reverse_gate_catches_injected_ts_drift():
    broken = EMAIL_SORT_TS.read_text(encoding="utf-8").replace(
        "m.subject COLLATE NOCASE {dir}", "m.subject {dir}"
    )
    assert _norm(ts_order_by(broken)["subject"]) != _norm(py_order_by()["subject"])


def test_reverse_gate_catches_injected_py_drift():
    broken = EMAIL_VIEWS_PY.read_text(encoding="utf-8").replace(
        '"subject": "m.subject COLLATE NOCASE {dir}, m.internal_id {dir}",',
        '"subject": "m.subject {dir}, m.internal_id {dir}",',
    )
    assert _norm(py_order_by(broken)["subject"]) != _norm(ts_order_by()["subject"])


@pytest.mark.parametrize(
    "mangle",
    [
        lambda s: s.replace("export const ENRICHED_ORDER_BY", "const RENAMED_ORDER_BY"),
        lambda s: s.replace("export const EMAIL_SORT_KEYS", "const RENAMED_KEYS"),
        lambda s: s.replace("const PRIORITY_RANK_SQL = `", "const RENAMED_SQL = `"),
    ],
)
def test_ts_parser_failure_is_loud_not_empty(mangle):
    broken = mangle(EMAIL_SORT_TS.read_text(encoding="utf-8"))
    with pytest.raises(AssertionError):
        ts_sort_keys(broken)
        ts_order_by(broken)


def test_ts_parser_rejects_unregistered_interpolation():
    """模板串里冒出没登记的 `${...}` → 抛错。不这么做的话它会被原样留在 SQL 里，
    与 Python 侧比较时「看起来只是文案不同」，而实际上那是一段活的 TS 表达式。"""
    broken = EMAIL_SORT_TS.read_text(encoding="utf-8").replace(
        "m.subject COLLATE NOCASE {dir}", "m.subject COLLATE ${SOME_NEW_CONST} {dir}"
    )
    with pytest.raises(AssertionError, match="未登记的插值"):
        ts_order_by(broken)


def test_py_parser_failure_is_loud_not_empty():
    broken = EMAIL_VIEWS_PY.read_text(encoding="utf-8").replace(
        "ENRICHED_ORDER_BY: dict[str, str] = {", "RENAMED_ORDER_BY: dict[str, str] = {"
    )
    with pytest.raises(AssertionError):
        py_order_by(broken)
