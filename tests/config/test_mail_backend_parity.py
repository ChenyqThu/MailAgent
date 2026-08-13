"""邮件 backend 值域跨语言一致性闸（task 08-12 outlook_com 三值化）.

backend 值域（applescript | davmail | outlook_com）存在多份手抄, 无法消灭镜像
（Python pydantic Field / factory 分支 / types Literal 与 TS 单源分属两个语言),
按仓规建闸锁死:

  1. Python `src/config.py`               — mailagent_backend Field description 值域
  2. Python `src/mail/backend/factory.py` — create_backend 的 backend_name 分支判据
  3. Python `src/mail/backend/types.py`   — BackendOrigin Literal
  4. TS `frontend/src/shared/lib/mailBackend.ts`
       — MailBackendKind type union + MAIL_BACKEND_KINDS 数组（前端单源）
       — availableBackendsForPlatform 平台矩阵（win=[outlook_com,davmail] /
         mac=[applescript,davmail]），与 factory 的 win32 闸语义一致
  5. TS `frontend/src/electron/main/handlers/onboarding.ts`
       — task 08-12 起不再手抄值域（import 单源 coerceMailBackendForPlatform），
         闸锁「不得回退到二值字面量钳制」

仓规两条实战坑（写抽取器必须遵守）:
  - 部分抽取比抽不到更毒: 每个抽取器抽到 0 个值 / 找不到目标声明必须 raise，
    绝不允许静默返回空集让相等断言 vacuous pass。
  - 同名结构不止一个: AST 抽取锚定具体赋值目标/函数名并断言恰好一个命中；
    文本抽取先断言锚点唯一再切块。
"""
from __future__ import annotations

import ast
import re
from typing import List, Set

import pytest

from . import _parsers as p

EXPECTED_BACKENDS = {"applescript", "davmail", "outlook_com"}

_CONFIG_PY = p.REPO_ROOT / "src" / "config.py"
_FACTORY_PY = p.REPO_ROOT / "src" / "mail" / "backend" / "factory.py"
_TYPES_PY = p.REPO_ROOT / "src" / "mail" / "backend" / "types.py"
_MAILBACKEND_TS = (
    p.REPO_ROOT / "frontend" / "src" / "shared" / "lib" / "mailBackend.ts"
)
_ONBOARDING_TS = (
    p.REPO_ROOT
    / "frontend"
    / "src"
    / "electron"
    / "main"
    / "handlers"
    / "onboarding.ts"
)


def _skip_if_frontend_absent() -> None:
    if not _MAILBACKEND_TS.exists():
        pytest.skip("frontend mailBackend.ts 缺失（无 frontend checkout）")


# ---------------------------------------------------------------------------
# Python 侧抽取器
# ---------------------------------------------------------------------------

def _config_backend_values() -> Set[str]:
    """config.py mailagent_backend Field 的 description 里抽 'xxx' ( 形态的值域."""
    tree = ast.parse(_CONFIG_PY.read_text(encoding="utf-8"))
    hits: List[ast.AnnAssign] = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id == "mailagent_backend"
    ]
    assert len(hits) == 1, (
        f"config.py 应恰好一处 mailagent_backend 声明, 实得 {len(hits)}"
    )
    call = hits[0].value
    assert isinstance(call, ast.Call), "mailagent_backend 应赋值为 Field(...) 调用"
    desc = None
    for kw in call.keywords:
        if kw.arg == "description" and isinstance(kw.value, ast.Constant):
            desc = kw.value.value
    assert isinstance(desc, str) and desc, (
        "mailagent_backend Field 缺 description 字符串, 抽取器锚点失效"
    )
    # description 的值域写法固定为 `'value' (说明)` —— 抽引号值后跟 `(` 的形态。
    values = set(re.findall(r"'([a-z][a-z0-9_]*)'\s*\(", desc))
    assert values, "description 里抽不到任何 backend 值, 抽取器失效（不许静默 pass）"
    return values


def _factory_fn() -> ast.FunctionDef:
    tree = ast.parse(_FACTORY_PY.read_text(encoding="utf-8"))
    fns = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "create_backend"
    ]
    assert len(fns) == 1, f"factory.py 应恰好一个 create_backend, 实得 {len(fns)}"
    return fns[0]


def _factory_branch_values() -> Set[str]:
    """factory.py create_backend 里所有 `backend_name == "<const>"` 判据."""
    values: Set[str] = set()
    for node in ast.walk(_factory_fn()):
        if not isinstance(node, ast.Compare):
            continue
        if not (isinstance(node.left, ast.Name) and node.left.id == "backend_name"):
            continue
        if len(node.ops) != 1 or not isinstance(node.ops[0], ast.Eq):
            continue
        comp = node.comparators[0]
        if isinstance(comp, ast.Constant) and isinstance(comp.value, str):
            values.add(comp.value)
    assert values, "create_backend 里抽不到任何 backend_name == 分支, 抽取器失效"
    return values


def _types_backend_origin_values() -> Set[str]:
    """types.py `BackendOrigin = Literal[...]` 的成员."""
    tree = ast.parse(_TYPES_PY.read_text(encoding="utf-8"))
    hits = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "BackendOrigin"
    ]
    assert len(hits) == 1, f"types.py 应恰好一处 BackendOrigin 赋值, 实得 {len(hits)}"
    sub = hits[0].value
    assert isinstance(sub, ast.Subscript), "BackendOrigin 应是 Literal[...] 下标形态"
    elts = sub.slice.elts if isinstance(sub.slice, ast.Tuple) else [sub.slice]
    values = {
        e.value for e in elts if isinstance(e, ast.Constant) and isinstance(e.value, str)
    }
    assert values, "BackendOrigin Literal 抽不到任何成员, 抽取器失效"
    return values


# ---------------------------------------------------------------------------
# TS 侧抽取器（文本；先断言锚点唯一再切块）
# ---------------------------------------------------------------------------

def _mailbackend_ts_src() -> str:
    return _MAILBACKEND_TS.read_text(encoding="utf-8")


def _ts_type_union_values() -> Set[str]:
    src = _mailbackend_ts_src()
    lines = re.findall(r"export type MailBackendKind = ([^\n]+)", src)
    assert len(lines) == 1, (
        f"mailBackend.ts 应恰好一处 MailBackendKind type 声明, 实得 {len(lines)}"
    )
    values = set(re.findall(r"'([a-z][a-z0-9_]*)'", lines[0]))
    assert values, "MailBackendKind union 抽不到任何成员, 抽取器失效"
    return values


def _ts_kinds_array_values() -> Set[str]:
    src = _mailbackend_ts_src()
    anchors = [m.start() for m in re.finditer(r"export const MAIL_BACKEND_KINDS", src)]
    assert len(anchors) == 1, (
        f"mailBackend.ts 应恰好一处 MAIL_BACKEND_KINDS 声明, 实得 {len(anchors)}"
    )
    end = src.find("] as const", anchors[0])
    assert end != -1, "MAIL_BACKEND_KINDS 缺 `] as const` 结尾, 切块失败"
    values = set(re.findall(r"'([a-z][a-z0-9_]*)'", src[anchors[0] : end]))
    assert values, "MAIL_BACKEND_KINDS 数组抽不到任何成员, 抽取器失效"
    return values


def _ts_platform_matrix() -> "tuple[List[str], List[str]]":
    """availableBackendsForPlatform 的 (win 列表, darwin/other 列表)（保序）."""
    src = _mailbackend_ts_src()
    anchors = [
        m.start()
        for m in re.finditer(r"export function availableBackendsForPlatform", src)
    ]
    assert len(anchors) == 1, (
        f"应恰好一处 availableBackendsForPlatform 声明, 实得 {len(anchors)}"
    )
    end = src.find("\n}", anchors[0])
    assert end != -1, "availableBackendsForPlatform 函数体切块失败"
    body = src[anchors[0] : end]

    win_match = re.findall(r"platform === 'win32'\) return \[([^\]]*)\]", body)
    assert len(win_match) == 1, "win32 分支 return 抽取失败（必须恰好 1 处）"
    returns = re.findall(r"return \[([^\]]*)\]", body)
    assert len(returns) == 2, f"函数体应恰好 2 个 return 数组, 实得 {len(returns)}"
    default_arms = [r for r in returns if r != win_match[0]]
    assert len(default_arms) == 1, "default 分支 return 抽取失败"

    win = re.findall(r"'([a-z][a-z0-9_]*)'", win_match[0])
    default = re.findall(r"'([a-z][a-z0-9_]*)'", default_arms[0])
    assert win and default, "平台矩阵某分支抽到 0 个值, 抽取器失效"
    return win, default


# ---------------------------------------------------------------------------
# 断言
# ---------------------------------------------------------------------------

def test_python_backend_value_domain_three_sources_agree():
    assert _config_backend_values() == EXPECTED_BACKENDS
    assert _factory_branch_values() == EXPECTED_BACKENDS
    assert _types_backend_origin_values() == EXPECTED_BACKENDS


def test_ts_backend_value_domain_matches_python():
    _skip_if_frontend_absent()
    assert _ts_type_union_values() == EXPECTED_BACKENDS
    assert _ts_kinds_array_values() == EXPECTED_BACKENDS


def test_ts_platform_matrix_locks_outlook_com_to_windows():
    """平台过滤矩阵与 Python factory 的 win32 闸语义一致:
    outlook_com 仅 win / applescript 仅 mac；两列表都是全值域的子集。"""
    _skip_if_frontend_absent()
    win, default = _ts_platform_matrix()
    assert win == ["outlook_com", "davmail"], f"win 列表漂移: {win}"
    assert default == ["applescript", "davmail"], f"darwin/other 列表漂移: {default}"
    assert "outlook_com" not in default, "outlook_com 泄漏进 mac 列表（win-only 契约破坏）"
    assert "applescript" not in win, "applescript 泄漏进 win 列表（Mail.app 不存在）"
    assert set(win) <= EXPECTED_BACKENDS and set(default) <= EXPECTED_BACKENDS


def test_factory_outlook_com_branch_has_win32_gate():
    """factory 的 outlook_com 分支体内必须有 sys.platform win32 闸 + raise，
    与 TS 平台矩阵「outlook_com 仅 win」互为镜像."""
    fn = _factory_fn()
    # 同名结构不止一个: `backend_name == "outlook_com"` 在 create_backend 里出现
    # 两次（建实例分支 + probe 失败的 fallback 文案分支）。目标是建实例分支——
    # 用「体内 import OutlookComBackend」作第二锚点区分。
    branch_bodies = [
        node.body
        for node in ast.walk(fn)
        if isinstance(node, ast.If)
        and isinstance(node.test, ast.Compare)
        and isinstance(node.test.left, ast.Name)
        and node.test.left.id == "backend_name"
        and len(node.test.comparators) == 1
        and isinstance(node.test.comparators[0], ast.Constant)
        and node.test.comparators[0].value == "outlook_com"
        and any(
            isinstance(inner, ast.ImportFrom)
            and any(a.name == "OutlookComBackend" for a in inner.names)
            for stmt in node.body
            for inner in ast.walk(stmt)
        )
    ]
    assert len(branch_bodies) == 1, (
        f"create_backend 应恰好一个「建 OutlookComBackend 实例」的 outlook_com 分支, "
        f"实得 {len(branch_bodies)}"
    )
    gate_found = False
    for stmt in branch_bodies[0]:
        for node in ast.walk(stmt):
            if not isinstance(node, ast.If):
                continue
            consts = {
                c.value
                for c in ast.walk(node.test)
                if isinstance(c, ast.Constant) and isinstance(c.value, str)
            }
            if "win32" in consts and any(
                isinstance(inner, ast.Raise)
                for s in node.body
                for inner in ast.walk(s)
            ):
                gate_found = True
    assert gate_found, (
        "outlook_com 分支缺 `sys.platform != 'win32' → raise` 平台闸"
    )


def test_onboarding_imports_single_source_no_literal_clamp():
    """onboarding.ts 不得回退到二值字面量钳制——必须经 mailBackend.ts 单源收敛。

    task 08-12 前的病根: `isDavmail ? 'davmail' : 'applescript'` 把 win 上选的
    outlook_com 静默改写成 applescript。此闸锁两点: ① coerceMailBackendForPlatform
    有真实调用点; ② 旧钳制三元式绝迹。"""
    _skip_if_frontend_absent()
    src = _ONBOARDING_TS.read_text(encoding="utf-8")
    call_sites = re.findall(r"coerceMailBackendForPlatform\(", src)
    assert call_sites, (
        "onboarding.ts 没有 coerceMailBackendForPlatform 调用点——backend 收敛"
        "不再走 mailBackend.ts 单源？"
    )
    assert "? 'davmail' : 'applescript'" not in src, (
        "onboarding.ts 出现二值字面量钳制回潮（task 08-12 修掉的病根）"
    )
