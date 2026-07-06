"""E3 配置治理一致性网 — 四载体的静态解析器（WP1）。

跨语言 flag / 手抄常量的既有事故类别（`Field(env=)` 静默失效、vite define 单侧复活、
`EXPECTED_DB_VERSION` 漏改、env-only 不进 environ）都源于「同一配置事实存在多份手抄副本、
无机器对账」。本模块提供纯静态解析器，被同目录 test_*.py 用来把这些副本对账起来。

设计原则（对齐 frontend/tests/main/db_version_consistency.test.ts +
tests/agent_eval/runner/tests/test_gateway_catalog_completeness.py 的既有样板）：
  * 纯文本 / AST 解析，**不 import** 运行时模块 —— 尤其 src/config.py 的模块级
    `config = Config()` 会因必填 env 缺失而 ValidationError，静态 AST 解析绕开它。
  * 每个解析器都能被测试侧用 canary 断言守住（解析器静默失效 → 返回空集 → 测试须立刻红，
    不能悄悄变成「无对象可比 = 平凡绿」）。
  * 解析不到预期结构时抛清晰错误（哪个文件、哪个模式），不静默通过。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Set

# tests/config/_parsers.py → parents[2] = 仓库根。
REPO_ROOT = Path(__file__).resolve().parents[2]

CONFIG_PY = REPO_ROOT / "src" / "config.py"
CHAT_PY = REPO_ROOT / "src" / "api" / "routers" / "chat.py"
ENV_EXAMPLE = REPO_ROOT / ".env.example"
CLAUDE_MD = REPO_ROOT / "CLAUDE.md"
ELECTRON_VITE = REPO_ROOT / "frontend" / "electron.vite.config.ts"
WEB_VITE = REPO_ROOT / "frontend" / "vite.web.config.ts"
GATEWAY_LIFECYCLE = REPO_ROOT / "frontend" / "src" / "electron" / "main" / "ai_gateway_lifecycle.ts"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# =============================================================================
# 载体 1 — pydantic Field（src/config.py），AST 静态解析
# =============================================================================

# default 无常量值时的占位（default_factory / required Ellipsis / 复杂表达式）。
_NO_LITERAL = object()


class ConfigField(NamedTuple):
    field_name: str
    annotation: Optional[str]           # 'bool' / 'str' / 'int' / 'float' / None
    declared_env: Optional[str]         # Field(env="...") 的字面值（pydantic v2 忽略但仍是文档意图）
    validation_alias: Optional[str]     # Field(validation_alias="...")
    default: object                     # 常量默认值，或 _NO_LITERAL
    has_factory: bool                   # 有 default_factory
    required: bool                      # Field(...) 首位 Ellipsis

    @property
    def effective_env_key(self) -> str:
        """pydantic 实际读取的 env 键 = validation_alias（若有）否则 字段名.upper()。
        （Field(env=) 被 pydantic v2 忽略 —— 见 config.py 顶 model_config 注释。）"""
        return self.validation_alias or self.field_name.upper()


def _const_literal(node: ast.AST) -> object:
    """ast 节点 → Python 常量值；非常量返回 _NO_LITERAL。"""
    if isinstance(node, ast.Constant):
        return node.value
    return _NO_LITERAL


def parse_config_fields(src: Optional[str] = None) -> List[ConfigField]:
    """静态解析 Config(BaseSettings) 的所有 `name: type = Field(...)` 字段。"""
    src = src if src is not None else _read(CONFIG_PY)
    tree = ast.parse(src)
    cls: Optional[ast.ClassDef] = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Config":
            cls = node
            break
    if cls is None:
        raise AssertionError("src/config.py 里没找到 `class Config(BaseSettings)` —— 解析器需更新")

    fields: List[ConfigField] = []
    for stmt in cls.body:
        if not (isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)):
            continue
        field_name = stmt.target.id
        annotation = stmt.annotation.id if isinstance(stmt.annotation, ast.Name) else None

        declared_env: Optional[str] = None
        alias: Optional[str] = None
        default: object = _NO_LITERAL
        has_factory = False
        required = False

        value = stmt.value
        if isinstance(value, ast.Call) and getattr(value.func, "id", None) == "Field":
            for arg in value.args:  # 首位 `...`（Ellipsis）= 必填、无默认
                if isinstance(arg, ast.Constant) and arg.value is Ellipsis:
                    required = True
            for kw in value.keywords:
                if kw.arg == "env" and isinstance(kw.value, ast.Constant):
                    declared_env = kw.value.value
                elif kw.arg == "validation_alias" and isinstance(kw.value, ast.Constant):
                    alias = kw.value.value
                elif kw.arg == "default":
                    default = _const_literal(kw.value)
                elif kw.arg == "default_factory":
                    has_factory = True
        else:
            # 裸赋值 `x: int = 5` 也支持（当前 config.py 全走 Field，但别假设）。
            default = _const_literal(value)

        fields.append(
            ConfigField(
                field_name=field_name,
                annotation=annotation,
                declared_env=declared_env,
                validation_alias=alias,
                default=default,
                has_factory=has_factory,
                required=required,
            )
        )
    return fields


def config_bool_default(field_name: str, fields: Optional[List[ConfigField]] = None) -> Optional[bool]:
    """按字段名取 bool 默认值；找不到或非 bool 常量返回 None。"""
    fields = fields if fields is not None else parse_config_fields()
    for f in fields:
        if f.field_name == field_name and isinstance(f.default, bool):
            return f.default
    return None


# =============================================================================
# 载体 2 — env-only 热读（src/api/routers/chat.py 的 _hot_bool）
# =============================================================================

# `_hot_bool(env_vals, "KEY", <fallback>)`；fallback = True / False / cfg.xxx，可跨行。
_HOT_BOOL_RE = re.compile(
    r'_hot_bool\(\s*env_vals\s*,\s*"([A-Z][A-Z0-9_]+)"\s*,\s*([^)]+?)\)',
    re.S,
)


def parse_hot_bool_defaults(src: Optional[str] = None) -> Dict[str, object]:
    """chat.py `_hot_bool(...)` 调用 → {env_key: default}。

    default 为 `True`/`False` 时是 bool；fallback 是 `cfg.xxx`（如
    MAILAGENT_CUSTOM_AGENTS_ENABLED 跟随 pydantic）时值为字符串 'cfg.xxx'。"""
    src = src if src is not None else _read(CHAT_PY)
    out: Dict[str, object] = {}
    for key, raw in _HOT_BOOL_RE.findall(src):
        expr = raw.strip()
        if expr == "True":
            out[key] = True
        elif expr == "False":
            out[key] = False
        else:
            out[key] = expr  # 如 'cfg.custom_agents_enabled'
    return out


# =============================================================================
# 载体 3 — Node main env（frontend/.../ai_gateway_lifecycle.ts 的 envBool）
# =============================================================================

# `envBool('KEY', true|false)`（函数定义 `function envBool(key: string, ...)` 无引号键，不匹配）。
_ENV_BOOL_RE = re.compile(r"envBool\(\s*'([A-Z][A-Z0-9_]+)'\s*,\s*(true|false)\s*\)")


def parse_env_bool_defaults(src: Optional[str] = None) -> Dict[str, bool]:
    """ai_gateway_lifecycle.ts `envBool('KEY', <bool>)` → {env_key: default}。"""
    src = src if src is not None else _read(GATEWAY_LIFECYCLE)
    return {key: (val == "true") for key, val in _ENV_BOOL_RE.findall(src)}


# =============================================================================
# 载体 4 — vite define（两份 vite 配置）
# =============================================================================

# 构建标识 define，非 flag 镜像，两宿主本就各不同 → 从 flag 对账里排除。
_BUILD_IDENTIFIER_DEFINES = {"__GIT_HASH__", "__BUILD_TIME__"}
# 编译常量 `__FOO__` 形状（flag define 历史上均此形状，如 cutover 期 __MAILAGENT_*__）。
_COMPILE_CONST_RE = re.compile(r"^__[A-Z0-9_]+__$")
# define 块内的 key：行首（缩进后）的 `__foo__:` / `'quoted':` / `"quoted":`。
_DEFINE_KEY_RE = re.compile(r"""(?m)^\s*(?:'([^']+)'|"([^"]+)"|(__[A-Z0-9_]+__))\s*:""")


def _extract_define_block(src: str, path_label: str) -> str:
    """取 `define:` 后大括号平衡的块文本；找不到 `define:` 返回空串（该文件无 define）。"""
    idx = src.find("define:")
    if idx == -1:
        return ""
    brace_start = src.find("{", idx)
    if brace_start == -1:
        raise AssertionError(f"{path_label}: 找到 `define:` 但其后无 `{{` —— 解析器需更新")
    depth = 0
    for i in range(brace_start, len(src)):
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[brace_start : i + 1]
    raise AssertionError(f"{path_label}: `define:` 块的大括号未闭合 —— 解析器需更新")


def parse_vite_define_keys(path: Path) -> Set[str]:
    """一份 vite 配置的 define 块里全部 key（含构建标识键）。"""
    block = _extract_define_block(_read(path), path.name)
    keys: Set[str] = set()
    for q1, q2, bare in _DEFINE_KEY_RE.findall(block):
        keys.add(q1 or q2 or bare)
    return keys


def flag_define_keys(all_keys: Set[str]) -> Set[str]:
    """从全部 define key 里筛出「flag 镜像」子集：MAILAGENT flag，或 `__FOO__` 编译常量
    （排除构建标识 __GIT_HASH__/__BUILD_TIME__）。两宿主的此子集必须相等。"""
    out: Set[str] = set()
    for k in all_keys:
        if "MAILAGENT" in k.upper():
            out.add(k)
        elif _COMPILE_CONST_RE.match(k) and k not in _BUILD_IDENTIFIER_DEFINES:
            out.add(k)
    return out


# =============================================================================
# .env.example 键集
# =============================================================================

# 行首（可含 `# ` 注释前缀）的 `KEY=`；键为大写下划线。注释里对键的散文提及（无 `=`）不匹配。
_ENV_EXAMPLE_KEY_RE = re.compile(r"(?m)^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=")


def parse_env_example_keys(src: Optional[str] = None) -> Set[str]:
    src = src if src is not None else _read(ENV_EXAMPLE)
    return set(_ENV_EXAMPLE_KEY_RE.findall(src))


# =============================================================================
# CLAUDE.md「关键开关现状」表
# =============================================================================

class SwitchRow(NamedTuple):
    full_keys: List[str]      # 列 1 里 fully-qualified 的 backtick 键（丢弃 `_SHORTHAND`）
    default_literal: Optional[str]   # 列 2 前导字面量：'true'/'false'/枚举词，或 None（不可解析）
    comparable: bool
    skip_reason: Optional[str]


# 列 1 里 backtick 包裹、大写开头（排除 `_RETRIEVAL` 缩写）的 fully-qualified 键。
_BACKTICK_FULLKEY_RE = re.compile(r"`([A-Z][A-Z0-9_]+)`")
# 列 1 里 `` `KEY`(value) `` 形态 = 该行混了非 bool 默认（如 (5000)/(haiku)）→ 不可对账。
_INLINE_ANNOT_RE = re.compile(r"`[A-Z][A-Z0-9_]+`\s*\(")
# 列 2 前导字面量：首个 backtick 词或首个裸词。
_LEADING_LITERAL_RE = re.compile(r"^\s*`?([A-Za-z\[\]][A-Za-z0-9_\-\[\]]*)`?")


def _parse_default_literal(col2: str) -> Optional[str]:
    """列 2 → 前导字面量 'true'/'false'/枚举词；无法干净解析返回 None。"""
    if "前" in col2:  # 如「`true`（前 3，…）」= 默认仅适用前 N 个 flag，整行不可对账
        return None
    m = _LEADING_LITERAL_RE.match(col2.strip())
    if not m:
        return None
    tok = m.group(1)
    if tok in ("true", "false"):
        return tok
    if re.fullmatch(r"[a-z][a-z0-9_\-]*", tok):  # 枚举词（applescript / hybrid / important…）
        return tok
    return None  # `[]` / `—` / 数字等 → 不可对账


def parse_switch_table(src: Optional[str] = None) -> List[SwitchRow]:
    """解析 CLAUDE.md「关键开关现状」表。逐行判定是否可对账（宽松：不可解析即 skip）。"""
    src = src if src is not None else _read(CLAUDE_MD)
    heading = "## 关键开关现状"
    start = src.find(heading)
    if start == -1:
        raise AssertionError("CLAUDE.md 里没找到「## 关键开关现状」标题 —— 解析器需更新")
    # 表到下一个二级标题止。
    nxt = src.find("\n## ", start + len(heading))
    table = src[start : nxt if nxt != -1 else len(src)]

    rows: List[SwitchRow] = []
    for line in table.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        col1, col2 = cells[0], cells[1]
        if col1 in ("开关",) or set(col1) <= set("-: "):  # 表头 / 分隔行
            continue

        full_keys = _BACKTICK_FULLKEY_RE.findall(col1)
        if not full_keys:
            rows.append(SwitchRow([], None, False, "列 1 无 fully-qualified backtick 键"))
            continue
        if _INLINE_ANNOT_RE.search(col1):
            rows.append(SwitchRow(full_keys, None, False, "列 1 有 `KEY`(value) 内联值注释（混类型行）"))
            continue
        literal = _parse_default_literal(col2)
        if literal is None:
            rows.append(SwitchRow(full_keys, None, False, "列 2 默认值不可干净解析"))
            continue
        rows.append(SwitchRow(full_keys, literal, True, None))
    return rows
