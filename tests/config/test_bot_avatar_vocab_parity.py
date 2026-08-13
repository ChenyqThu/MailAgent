"""bot 头像词表 + 上传字节上限的跨语言一致性闸（08-12 living-bot-avatar WP4）。

三对手抄常量，Python 侧（``src/reports/wire.py``）是 canonical：

- ``BOT_AVATAR_SHAPES``（8 形）↔ ``frontend/src/shared/bot-avatar/shapes.ts`` 同名导出
- ``BOT_AVATAR_COLORS``（11 色）↔ ``frontend/src/shared/bot-avatar/colors.ts`` 同名导出
- ``AVATAR_IMAGE_MAX_BYTES``（150KB，上传头像服务端复核）↔
  ``frontend/src/shared/components/agents/avatarImage.ts`` 同名导出
  —— 这对是 0804 WP7 留下的旧债：两侧注释一直写着「数值必须一致」却无机器对账，顺手入闸。

**为什么不能消灭镜像**：Python serve-api（保存闸）↔ TS renderer（编辑器网格 / 客户端压缩）
跨语言，无共享运行时载体。

**漂了会怎样**：

- 词表漂（前端多一档）：编辑器能选、PATCH 却被 400 拒 ——「保存失败」但没人指向词表；
  （后端多一档）：CLI / 导入能落库，前端渲染判别不认 → 头像静默回落派生外观，
  「保存成功但显示的不是选的那个」。
- 150KB 漂：前端按大值压完自信提交 → 服务端按小值拒；反向则前端白白多压几档质量。

🔴 抽取失败必须**红**：任一侧抽不到常量就 ``AssertionError``，绝不 skip —— 恒绿的闸比
没有闸更糟（它让人以为有保护）。末尾 canary 用合成源码证明每个抽取器真会红。

TS 侧词表契约（WP2 落 shapes/colors 时须满足，抽取器只认这个形状）::

    shapes.ts:  export const BOT_AVATAR_SHAPES = ['blob', …] as const
    colors.ts:  export const BOT_AVATAR_COLORS = ['white', …] as const

（字符串字面量数组，可多行；类型注解写在 ``=`` 左侧不影响抽取。）WP2 未落地期间本闸的
词表两例保持红是**设计内的**（失败信息会指明文件缺失），不许为过渡期 skip。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import List, Optional, Tuple

import pytest

from . import _parsers as p

_WIRE_PY = p.REPO_ROOT / "src" / "reports" / "wire.py"
_SHAPES_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "bot-avatar" / "shapes.ts"
_COLORS_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "bot-avatar" / "colors.ts"
_AVATAR_IMAGE_TS = (
    p.REPO_ROOT / "frontend" / "src" / "shared" / "components" / "agents" / "avatarImage.ts"
)


# ── 抽取器（Python: AST；TS: 锚点 + 括起数组正则）───────────────────────────────


def _py_top_assign(path: Path, name: str, src: Optional[str] = None) -> ast.AST:
    """模块顶层 ``name = <expr>`` 的右值节点。抓不到 → AssertionError（不许平凡绿）。"""
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
    )


def py_str_tuple(path: Path, name: str, src: Optional[str] = None) -> Tuple[str, ...]:
    node = _py_top_assign(path, name, src)
    assert isinstance(node, (ast.Tuple, ast.List)), f"{path.name}: `{name}` 不是 tuple/list 字面量"
    out: List[str] = []
    for el in node.elts:
        assert isinstance(el, ast.Constant) and isinstance(el.value, str), (
            f"{path.name}: `{name}` 含非字符串字面量项 —— 部分抽取比抽不到更毒，抽取器需更新"
        )
        out.append(el.value)
    assert out, f"{path.name}: `{name}` 抽到空集 —— 抽取器需更新"
    return tuple(out)


def _eval_int_expr(node: ast.AST, ctx: str) -> int:
    """int 字面量 / 纯字面量乘法（``150 * 1024`` 这种自文档写法）。其余形态必须红。"""
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        return _eval_int_expr(node.left, ctx) * _eval_int_expr(node.right, ctx)
    raise AssertionError(f"{ctx} 只支持 int 字面量与字面量乘法 —— 写法变了，抽取器需更新")


def py_int_value(path: Path, name: str, src: Optional[str] = None) -> int:
    return _eval_int_expr(_py_top_assign(path, name, src), f"{path.name}: `{name}`")


def ts_str_array(path: Path, decl: str, src: Optional[str] = None) -> Tuple[str, ...]:
    """``export const <decl> … = [ 'a', 'b', … ]`` 的字符串字面量序列（可多行）。

    先锚 ``=`` 再找 ``[``：跳过 ``: readonly Foo[]`` 这类写在 ``=`` 左侧的类型注解方括号。
    词表数组是扁平字符串，取 ``[`` 后第一个 ``]`` 即可。
    """
    if src is None:
        assert path.exists(), (
            f"{path} 不存在 —— TS 侧词表尚未落地（WP2）或文件搬家了。本闸在词表就位前"
            f"保持红是设计内的，落地时须满足本文件 docstring 的导出契约"
        )
        text = path.read_text(encoding="utf-8")
    else:
        text = src
    anchor = f"export const {decl}"
    assert text.count(anchor) == 1, (
        f"{path.name} 里 `{anchor}` 出现 {text.count(anchor)} 次（期望恰 1）—— 同名声明"
        f"多份正是 parity 闸静默读错源的方式；改名/搬家则抽取器需同步更新"
    )
    eq_idx = text.find("=", text.find(anchor))
    open_idx = text.find("[", eq_idx)
    close_idx = text.find("]", open_idx)
    assert eq_idx >= 0 and open_idx >= 0 and close_idx > open_idx, (
        f"{path.name}: `{decl}` 不是 `= [ … ]` 数组字面量 —— 写法重构了，抽取器需更新"
    )
    lits = re.findall(r"['\"]([^'\"]+)['\"]", text[open_idx + 1 : close_idx])
    assert lits, f"{path.name}: `{decl}` 的数组里抽不到字符串字面量 —— 抽取器需更新"
    return tuple(lits)


def ts_int_value(path: Path, name: str, src: Optional[str] = None) -> int:
    text = path.read_text(encoding="utf-8") if src is None else src
    matches = re.findall(
        rf"^export const {name}\s*=\s*(\d+(?:\s*\*\s*\d+)*)\s*$", text, flags=re.MULTILINE
    )
    assert len(matches) == 1, (
        f"{path.name}: 期望恰 1 个 `export const {name} = <int 字面量/乘法>`，"
        f"抽到 {len(matches)} 个 —— 抽取器需更新"
    )
    value = 1
    for part in matches[0].split("*"):
        value *= int(part.strip())
    return value


# ── ① 8 形词表 ───────────────────────────────────────────────────────────────


def test_bot_shape_vocabulary_matches_across_languages():
    canonical = py_str_tuple(_WIRE_PY, "BOT_AVATAR_SHAPES")
    assert canonical == (
        "sphere", "capsule", "cylinder", "cone", "cube", "diamond", "mickey", "cursor",
    ), (
        f"bot shape 词表变成 {canonical!r} —— 这是词表本体的改动，必须同步 TS shapes.ts、"
        f"编辑器网格与本断言（三处一起动才是有意的演进而非漂移）"
    )
    ts = ts_str_array(_SHAPES_TS, "BOT_AVATAR_SHAPES")
    assert len(set(ts)) == len(ts), f"shapes.ts 词表含重复项：{ts!r}（集合比较会掩掉它，先拒）"
    # 集合比较（顺序有意不闸：网格展示顺序归前端）。
    assert set(ts) == set(canonical), (
        f"TS shape 词表 {sorted(set(ts))!r} 与 Python canonical {sorted(set(canonical))!r} "
        f"不一致 —— 见本文件 docstring「保存成功但显示的不是选的那个」后果"
    )


# ── ② 11 色词表 ──────────────────────────────────────────────────────────────


def test_bot_color_vocabulary_matches_across_languages():
    canonical = py_str_tuple(_WIRE_PY, "BOT_AVATAR_COLORS")
    assert canonical == (
        "white", "brown", "red", "orange", "yellow", "green",
        "teal", "blue", "purple", "pink", "gray",
    ), (
        f"bot color 词表变成 {canonical!r} —— 这是词表本体的改动，必须同步 TS colors.ts、"
        f"色盘 swatch 与本断言"
    )
    ts = ts_str_array(_COLORS_TS, "BOT_AVATAR_COLORS")
    assert len(set(ts)) == len(ts), f"colors.ts 词表含重复项：{ts!r}（集合比较会掩掉它，先拒）"
    assert set(ts) == set(canonical), (
        f"TS color 词表 {sorted(set(ts))!r} 与 Python canonical {sorted(set(canonical))!r} "
        f"不一致 —— 前端多的档 PATCH 被 400 拒；后端多的档前端渲染回落派生外观"
    )


# ── ③ 上传头像 150KB 上限（0804 WP7 旧债入闸）───────────────────────────────────


def test_avatar_image_byte_cap_matches_across_languages():
    py = py_int_value(_WIRE_PY, "AVATAR_IMAGE_MAX_BYTES")
    ts = ts_int_value(_AVATAR_IMAGE_TS, "AVATAR_IMAGE_MAX_BYTES")
    assert py == ts, (
        f"上传头像字节上限漂了：Python {py} vs TS {ts}。前端按自己的值压完提交、"
        f"服务端按另一个值复核 —— 大于服务端时用户看到的是无法解释的保存失败"
    )


# ── ④ canary：抽取器失效必须红，不许变成平凡绿 ─────────────────────────────────


def test_extraction_failure_is_red_not_silently_green():
    """用合成源码证明每个抽取器在锚点消失 / 写法重构时会抛，而不是返回空集/错值。"""
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(_WIRE_PY, "BOT_AVATAR_SHAPES", src="X = 1\n")
    with pytest.raises(AssertionError, match="含非字符串字面量"):
        # 词表改成从别处拼出来（非字面量）→ 必须红，不许抽到半张表。
        py_str_tuple(_WIRE_PY, "BOT_AVATAR_SHAPES", src="BOT_AVATAR_SHAPES = ('blob', X)\n")
    with pytest.raises(AssertionError, match="只支持 int 字面量"):
        py_int_value(_WIRE_PY, "AVATAR_IMAGE_MAX_BYTES", src="AVATAR_IMAGE_MAX_BYTES = 150 * K\n")
    # 乘法写法本身要能算对（wire.py 现状就是 150 * 1024）。
    assert py_int_value(_WIRE_PY, "AVATAR_IMAGE_MAX_BYTES", src="AVATAR_IMAGE_MAX_BYTES = 150 * 1024\n") == 153600
    with pytest.raises(AssertionError, match="出现 0 次"):
        ts_str_array(_SHAPES_TS, "BOT_AVATAR_SHAPES", src="const x = 1\n")
    with pytest.raises(AssertionError, match="出现 2 次"):
        ts_str_array(
            _SHAPES_TS,
            "BOT_AVATAR_SHAPES",
            src="export const BOT_AVATAR_SHAPES = ['a']\nexport const BOT_AVATAR_SHAPES = ['b']\n",
        )
    with pytest.raises(AssertionError, match="抽不到字符串字面量"):
        # 声明还在、数组被清空 → 必须红（而不是「空集当没漂」）。
        ts_str_array(_SHAPES_TS, "BOT_AVATAR_SHAPES", src="export const BOT_AVATAR_SHAPES = []\n")
    # 多行数组 + `=` 左侧类型注解是合法契约形状，抽取器必须吃得下（防未来格式化误伤）。
    assert ts_str_array(
        _SHAPES_TS,
        "BOT_AVATAR_SHAPES",
        src="export const BOT_AVATAR_SHAPES: readonly string[] = [\n  'a',\n  'b',\n] as const\n",
    ) == ("a", "b")
    with pytest.raises(AssertionError, match="期望恰 1 个"):
        ts_int_value(_AVATAR_IMAGE_TS, "AVATAR_IMAGE_MAX_BYTES", src="const x = 1\n")
    assert ts_int_value(
        _AVATAR_IMAGE_TS, "AVATAR_IMAGE_MAX_BYTES", src="export const AVATAR_IMAGE_MAX_BYTES = 150 * 1024\n"
    ) == 153600
