"""T5 — env-only `os.environ` 直读 ratchet（E3 WP2 验收项机器化）。

E3 §4 验收项之一：`grep -rn "os.environ.get\\|os.getenv" src/ --include='*.py'`
（排除 config.py + 豁免清单）趋零。本测试把那条 grep 变成机器闸。

背景：E3 配置治理要把「env-only 直读」这第 2 种 flag 载体收敛进 pydantic
（validation_alias），消灭手抄一致性事故面（`Field(env=)` 静默失效 / 必须 `load_dotenv`
先行）。但相当一批直读**有正当理由留在 env-direct**：进程注入（DATA_ROOT/PORT/TOKEN）、
path/db override、dev/security gate、credential、island 子系统（刻意不 import 全局
config）、诊断/infra、legacy notion_agent。这些登记进 env_only_reads_allowlist.txt。

设计（对齐 _parsers.py + env_example_orphans_baseline.txt 的既有样板）：
  * AST 扫描（不 import 运行时模块、不被注释/字符串里的 `os.environ.get(...)` 误伤）。
  * 每个读点抽 env 键字面量；键为模块常量（`NAME = "KEY"`）时静态解析；键为函数参数等
    运行时变量（无法抽字面量）时按文件豁免（_DYNAMIC_READ_FILES）。
  * canary 守「扫描器/清单静默失效 → 平凡绿」；ratchet 守「清单只减不增」。
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

_HERE = Path(__file__).resolve().parent
REPO_ROOT = _HERE.parents[1]
SRC = REPO_ROOT / "src"
_ALLOWLIST = _HERE / "env_only_reads_allowlist.txt"

# 键为运行时变量、无法抽字面量的读点（按 src-相对 posix 路径豁免）：
#   api/routers/chat.py       —— `_hot_bool(env_vals, k)` 里的 `os.environ.get(k)`，有意热读
#                                （STANDING_CONTEXT / MEM0_RETRIEVAL / openness 投影，serve-api
#                                 启动后改 .env 即时生效，见 CLAUDE.md 开关表说明）。
#   chat/notion_agent_gate.py —— `_read_env_number(name)` 泛型 env 数值读，legacy notion_agent
#                                镜像 TS config.ts，键由调用方以字面量传入。
_DYNAMIC_READ_FILES = {
    "api/routers/chat.py",
    "chat/notion_agent_gate.py",
}


def _load_allowlist() -> Set[str]:
    keys: Set[str] = set()
    for line in _ALLOWLIST.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            keys.add(line)
    return keys


def _is_env_read(call: ast.Call) -> bool:
    """`os.environ.get(...)` / `_os.environ.get(...)` / `os.getenv(...)` / `_os.getenv(...)`。"""
    f = call.func
    if not isinstance(f, ast.Attribute):
        return False
    if f.attr == "get":
        v = f.value
        return (
            isinstance(v, ast.Attribute)
            and v.attr == "environ"
            and isinstance(v.value, ast.Name)
            and v.value.id in ("os", "_os")
        )
    if f.attr == "getenv":
        return isinstance(f.value, ast.Name) and f.value.id in ("os", "_os")
    return False


def _module_str_consts(tree: ast.Module) -> Dict[str, str]:
    """模块级 `NAME = "STRING"` 常量表（解析 `os.environ.get(NAME)` 里的 Name 键）。"""
    out: Dict[str, str] = {}
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    out[tgt.id] = node.value.value
    return out


def _extract_key(call: ast.Call, consts: Dict[str, str]) -> Optional[str]:
    """读点的 env 键：直接字面量，或经模块常量解析的 Name；否则 None（运行时变量键）。"""
    if not call.args:
        return None
    a0 = call.args[0]
    if isinstance(a0, ast.Constant) and isinstance(a0.value, str):
        return a0.value
    if isinstance(a0, ast.Name):
        return consts.get(a0.id)  # 解析到 → 键；未定义 → None（dynamic）
    return None


def _scan() -> Tuple[List[Tuple[str, str]], List[str]]:
    """扫 src/ → (literal_reads=[(relpath, key)], dynamic_files=[relpath])。"""
    literal_reads: List[Tuple[str, str]] = []
    dynamic_files: List[str] = []
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC).as_posix()
        if rel == "config.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        consts = _module_str_consts(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _is_env_read(node):
                key = _extract_key(node, consts)
                if key is None:
                    dynamic_files.append(rel)
                else:
                    literal_reads.append((rel, key))
    return literal_reads, dynamic_files


def test_env_only_reads_are_allowlisted():
    allowlist = _load_allowlist()
    # canary：清单解析坏了 → 豁免集空 → 所有读违规（不会平凡绿），但仍拦「空文件」退化。
    assert len(allowlist) > 20, f"allowlist 只解析到 {len(allowlist)} 键（预期 >20）—— 文件坏了"

    literal_reads, dynamic_files = _scan()
    # canary：扫描器坏了 → 读点空 → 对账平凡绿。
    assert len(literal_reads) > 20, (
        f"只扫到 {len(literal_reads)} 个字面量 env 读（预期 >20）—— AST 扫描器坏了"
    )

    unlisted_keys = sorted({(rel, k) for rel, k in literal_reads if k not in allowlist})
    unlisted_dynamic = sorted({rel for rel in dynamic_files if rel not in _DYNAMIC_READ_FILES})

    assert not unlisted_keys, (
        "以下 os.environ 直读的 env 键不在 env_only_reads_allowlist.txt 里：\n"
        + "\n".join(f"  {rel}: {k}" for rel, k in unlisted_keys)
        + "\n→ 收编进 src/config.py（pydantic validation_alias），或评审确认属 env-direct 后"
        "登记进 tests/config/env_only_reads_allowlist.txt（附类别理由）。"
    )
    assert not unlisted_dynamic, (
        "以下文件有运行时变量键的 os.environ 直读（抽不出字面量），未在 _DYNAMIC_READ_FILES 豁免：\n"
        + "\n".join(f"  {rel}" for rel in unlisted_dynamic)
        + "\n→ 若确属有意（热读 helper / 泛型 env 读），加进本测试的 _DYNAMIC_READ_FILES。"
    )

    # ratchet：清单不该留「其实已不再被直读」的陈旧键（防只涨不缩）。
    live_keys = {k for _, k in literal_reads}
    stale = allowlist - live_keys
    assert not stale, (
        "allowlist 里这些键已不再被任何 os.environ 直读（可能刚收编 pydantic），应删行（ratchet 收缩）：\n"
        + "\n".join(f"  {k}" for k in sorted(stale))
    )
