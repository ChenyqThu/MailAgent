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
ENV_KEYS_TS = REPO_ROOT / "frontend" / "src" / "electron" / "main" / "lib" / "env-keys.ts"
SETTINGS_PY = REPO_ROOT / "src" / "api" / "routers" / "settings.py"
ELECTRON_VITE = REPO_ROOT / "frontend" / "electron.vite.config.ts"
WEB_VITE = REPO_ROOT / "frontend" / "vite.web.config.ts"
GATEWAY_LIFECYCLE = REPO_ROOT / "frontend" / "src" / "electron" / "main" / "ai_gateway_lifecycle.ts"
EMAIL_HANDLER_TS = REPO_ROOT / "frontend" / "src" / "electron" / "main" / "handlers" / "email.ts"
SETTINGS_HANDLER_TS = REPO_ROOT / "frontend" / "src" / "electron" / "main" / "handlers" / "settings.ts"
SETTINGS_TYPES_TS = REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "settings.ts"
EMAIL_ROUTER_PY = REPO_ROOT / "src" / "api" / "routers" / "email.py"


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
    validation_alias: Optional[str]     # Field(validation_alias="...")，AliasChoices 时取首选键
    default: object                     # 常量默认值，或 _NO_LITERAL
    has_factory: bool                   # 有 default_factory
    required: bool                      # Field(...) 首位 Ellipsis
    alias_extras: tuple = ()            # AliasChoices 的非首选键（legacy 兼容名，如 issue #52）

    @property
    def effective_env_key(self) -> str:
        """pydantic 实际读取的 env 键 = validation_alias（若有）否则 字段名.upper()。
        （Field(env=) 被 pydantic v2 忽略 —— 见 config.py 顶 model_config 注释。）
        AliasChoices 场景 = 首选（canonical）键；legacy 键在 alias_extras。"""
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
        alias_extras: tuple = ()
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
                elif (
                    kw.arg == "validation_alias"
                    and isinstance(kw.value, ast.Call)
                    and getattr(kw.value.func, "id", None) == "AliasChoices"
                ):
                    # AliasChoices("CANONICAL", "LEGACY", ...) —— 首选 = canonical env 键，
                    # 其余为 legacy 兼容名（issue #52）。非常量参数直接炸（解析器不静默）。
                    choices = []
                    for a in kw.value.args:
                        if not isinstance(a, ast.Constant) or not isinstance(a.value, str):
                            raise AssertionError(
                                f"config.py 字段 {field_name} 的 AliasChoices 含非字符串常量参数"
                                " —— 解析器需更新"
                            )
                        choices.append(a.value)
                    if not choices:
                        raise AssertionError(
                            f"config.py 字段 {field_name} 的 AliasChoices 无参数 —— 解析器需更新"
                        )
                    alias = choices[0]
                    alias_extras = tuple(choices[1:])
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
                alias_extras=alias_extras,
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


# 行首**没有** `#` 的 `KEY=`。「文档化」与「用户会看见并填」不是一回事：注释掉的示例行
# 对已有安装等于不存在（.env 是历史累积的真文件，不会因示例更新而同步）。
_ENV_EXAMPLE_ACTIVE_KEY_RE = re.compile(r"(?m)^\s*([A-Z][A-Z0-9_]+)\s*=")


def parse_env_example_active_keys(src: Optional[str] = None) -> Set[str]:
    """.env.example 里**未注释**的键（issue #64 方向 4 的可见性判据之一）。"""
    src = src if src is not None else _read(ENV_EXAMPLE)
    return set(_ENV_EXAMPLE_ACTIVE_KEY_RE.findall(src))


# =============================================================================
# frontend MANAGED_ENV_KEYS（Settings UI 能读写的键白名单）
# =============================================================================

# 数组元素形如 `  'KEY',`（注释行不匹配 —— 它们以 `//` 开头）。
_TS_KEY_RE = re.compile(r"(?m)^\s*'([A-Z][A-Z0-9_]*)'\s*,?\s*$")
_MANAGED_ARRAY_END = "\n] as const"


def parse_managed_env_keys(src: Optional[str] = None) -> Set[str]:
    """`MANAGED_ENV_KEYS = [...]` 数组里的键。

    🔴 只取这一个数组 —— 同文件后面的 `SECRET_ENV_KEYS` / `READONLY_DISPLAY_KEYS`
    是同样的字面量形状，整文件正则会把「只在脱敏集里」的键误判成「UI 可见」。
    """
    src = src if src is not None else _read(ENV_KEYS_TS)
    start = src.find("export const MANAGED_ENV_KEYS")
    if start == -1:
        raise AssertionError(f"{ENV_KEYS_TS.name}: 没找到 `export const MANAGED_ENV_KEYS` —— 解析器需更新")
    end = src.find(_MANAGED_ARRAY_END, start)
    if end == -1:
        raise AssertionError(f"{ENV_KEYS_TS.name}: MANAGED_ENV_KEYS 数组没有 `] as const` 结尾 —— 解析器需更新")
    return set(_TS_KEY_RE.findall(src[start:end]))


def parse_ts_key_set(const_name: str, src: Optional[str] = None) -> Set[str]:
    """env-keys.ts 里 `export const <NAME>: Set<string> = new Set<string>([...])` 的键集。

    用于 SECRET_ENV_KEYS / READONLY_DISPLAY_KEYS —— 与 MANAGED_ENV_KEYS 的 `] as const`
    数组形状不同（`])` 结尾），故单独一个解析器而不是复用上面那个。
    """
    src = src if src is not None else _read(ENV_KEYS_TS)
    start = src.find(f"export const {const_name}")
    if start == -1:
        raise AssertionError(f"{ENV_KEYS_TS.name}: 没找到 `export const {const_name}` —— 解析器需更新")
    end = src.find("\n])", start)
    if end == -1:
        raise AssertionError(f"{ENV_KEYS_TS.name}: {const_name} 的 Set 没有 `])` 结尾 —— 解析器需更新")
    return set(_TS_KEY_RE.findall(src[start:end]))


# =============================================================================
# 后端受管键白名单（src/api/routers/settings.py，env-keys.ts 的手抄镜像）
# =============================================================================


def _string_literals_of(node: ast.AST, label: str) -> Set[str]:
    """List/Set/Tuple 字面量 → 其中的字符串常量集合。含非字符串常量元素时抛错（不静默）。"""
    if not isinstance(node, (ast.List, ast.Set, ast.Tuple)):
        raise AssertionError(f"{label}: 右值不是 list/set/tuple 字面量 —— 解析器需更新")
    out: Set[str] = set()
    for elt in node.elts:
        if not (isinstance(elt, ast.Constant) and isinstance(elt.value, str)):
            raise AssertionError(f"{label}: 含非字符串常量元素 —— 解析器需更新")
        out.add(elt.value)
    return out


def parse_py_key_collection(
    name: str, path: Path = SETTINGS_PY, src: Optional[str] = None
) -> Set[str]:
    """静态解析某个 .py 里模块级 `NAME = [...]` / `NAME: T = [...]` 的字符串字面量集合。

    AST 而非正则：注释风格 / 换行 / 尾逗号变化都不影响，且找不到该赋值时抛错（不返回空集）。
    **不 import** 目标模块 —— settings.py 的 import 链会拉起 FastAPI + config 单例。
    """
    tree = ast.parse(src if src is not None else _read(path))
    for stmt in tree.body:
        target: Optional[str] = None
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            target = stmt.target.id
        elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            target = stmt.targets[0].id
        if target != name or stmt.value is None:
            continue
        return _string_literals_of(stmt.value, f"{path.name}:{name}")
    raise AssertionError(f"{path.name}: 没找到模块级 `{name} = [...]` 赋值 —— 解析器需更新")


# =============================================================================
# TS 投影 / 类型的字段集（wire 形状对账用）
# =============================================================================

# 行注释先剥掉，避免注释里的 `foo: bar` 被当成字段。字符串里的 `//` 不在这些
# 目标块里出现（都是 `key: expr` 形式），故按行剥是安全的。
_TS_LINE_COMMENT_RE = re.compile(r"(?m)//.*$")
# 块内某一层的 `key:` / `'key':` / `"key":`（行首缩进后）。
_TS_OBJ_KEY_RE = re.compile(r"""(?m)^\s*(?:'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*[?]?\s*:""")


def _balanced_block(src: str, open_idx: int, label: str) -> str:
    """从 ``src[open_idx]``（必须是 `{`）取到配对 `}` 的整块（含两端）。"""
    if src[open_idx] != "{":
        raise AssertionError(f"{label}: 期望 `{{` 起始 —— 解析器需更新")
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_idx : i + 1]
    raise AssertionError(f"{label}: 大括号未闭合 —— 解析器需更新")


def _top_level_keys(block: str, label: str) -> Set[str]:
    """对象字面量块 → **顶层** key 集（嵌套子对象的 key 不算）。

    做法：先剥行注释，再逐字符扫描按大括号深度过滤 —— 只保留 depth==1 的 `key:`。
    """
    block = _TS_LINE_COMMENT_RE.sub("", block)
    # 逐行记录该行起始处的深度，只收深度为 1 的行上的 key。
    keys: Set[str] = set()
    depth = 0
    for line in block.splitlines():
        line_start_depth = depth
        for ch in line:
            if ch in "{[(":
                depth += 1
            elif ch in "}])":
                depth -= 1
        if line_start_depth != 1:
            continue
        m = _TS_OBJ_KEY_RE.match(line)
        if m:
            keys.add(m.group(1) or m.group(2) or m.group(3))
    if not keys:
        raise AssertionError(f"{label}: 对象字面量里一个 key 都没解析到 —— 解析器需更新")
    return keys


def parse_ts_return_object_keys(
    func_name: str, path: Path = EMAIL_HANDLER_TS, src: Optional[str] = None
) -> Set[str]:
    """TS 里 ``function <name>(...) : T { return { ... } }`` 的返回对象顶层 key 集。

    用于把「TS 手写投影」与「Python wire 投影」对账。找不到函数 / 找不到
    `return {` → 抛错（🔴 抽取失败必须红，绝不返回空集让对账平凡通过）。
    """
    src = src if src is not None else _read(path)
    label = f"{path.name}:{func_name}"
    m = re.search(rf"function\s+{re.escape(func_name)}\s*\(", src)
    if m is None:
        raise AssertionError(f"{label}: 没找到 `function {func_name}(` —— 解析器需更新")
    ret = src.find("return {", m.end())
    if ret == -1:
        raise AssertionError(f"{label}: 函数体里没找到 `return {{` —— 解析器需更新")
    return _top_level_keys(_balanced_block(src, src.index("{", ret), label), label)


def parse_ts_interface_keys(
    iface_name: str, path: Path, src: Optional[str] = None
) -> Set[str]:
    """TS ``export interface <Name> { ... }`` 的顶层字段名集（`?` 可选标记不影响）。"""
    src = src if src is not None else _read(path)
    label = f"{path.name}:{iface_name}"
    m = re.search(rf"(?:export\s+)?interface\s+{re.escape(iface_name)}\b[^{{]*", src)
    if m is None:
        raise AssertionError(f"{label}: 没找到 `interface {iface_name}` —— 解析器需更新")
    return _top_level_keys(_balanced_block(src, src.index("{", m.end() - 1), label), label)


def parse_ts_const_object_keys(
    const_name: str, path: Path, src: Optional[str] = None
) -> Set[str]:
    """TS ``const <NAME>[: T] = { ... }`` 的顶层 key 集（如 handlers/settings.ts 的 DEFAULTS）。"""
    src = src if src is not None else _read(path)
    label = f"{path.name}:{const_name}"
    m = re.search(rf"const\s+{re.escape(const_name)}\b[^=]*=\s*", src)
    if m is None:
        raise AssertionError(f"{label}: 没找到 `const {const_name} =` —— 解析器需更新")
    if m.end() >= len(src) or src[m.end()] != "{":
        raise AssertionError(f"{label}: `const {const_name} =` 右值不是对象字面量 —— 解析器需更新")
    return _top_level_keys(_balanced_block(src, m.end(), label), label)


# =============================================================================
# Python dict 字面量的 key 集（AST，用于 router 里手组的 payload）
# =============================================================================


def parse_py_dict_literal_keys(
    var_name: str, path: Path, src: Optional[str] = None, *, func_name: Optional[str] = None
) -> Set[str]:
    """某 .py 里 ``<var> = { "k": v, ... }`` 的字符串 key 集（AST，可限定在某函数内）。

    ``func_name`` 给定时只在该函数体内找（模块级同名变量不干扰）。找不到赋值 /
    右值不是 dict 字面量 / 含非字符串常量 key → 抛错（不静默返回空集）。
    """
    tree = ast.parse(src if src is not None else _read(path))
    label = f"{path.name}:{var_name}" + (f" (in {func_name})" if func_name else "")

    scope: List[ast.AST] = []
    if func_name:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
                scope = list(node.body)
                break
        if not scope:
            raise AssertionError(f"{label}: 没找到函数 `{func_name}` —— 解析器需更新")
    else:
        scope = list(tree.body)

    for node in scope:
        for stmt in ast.walk(node):
            target: Optional[str] = None
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                target = stmt.target.id
            elif (
                isinstance(stmt, ast.Assign)
                and len(stmt.targets) == 1
                and isinstance(stmt.targets[0], ast.Name)
            ):
                target = stmt.targets[0].id
            if target != var_name or stmt.value is None:
                continue
            if not isinstance(stmt.value, ast.Dict):
                raise AssertionError(f"{label}: 右值不是 dict 字面量 —— 解析器需更新")
            keys: Set[str] = set()
            for k in stmt.value.keys:
                if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                    raise AssertionError(f"{label}: 含非字符串常量 key（如 `**spread`）—— 解析器需更新")
                keys.add(k.value)
            if not keys:
                raise AssertionError(f"{label}: dict 字面量为空 —— 解析器需更新")
            return keys
    raise AssertionError(f"{label}: 没找到 `{var_name} = {{...}}` 赋值 —— 解析器需更新")


def parse_py_subscript_assign_keys(
    var_name: str, path: Path, src: Optional[str] = None, *, func_name: Optional[str] = None
) -> Set[str]:
    """某 .py 里 ``<var>["k"] = ...`` 形式赋的字符串 key 集（router 在 dict 之外追加的字段）。

    用于把「路由额外组装了哪些键」变成可机检事实, 而不是测试里手抄一个常量。
    ``func_name`` 必须给定到具体端点函数 —— 同一个 router 文件里别的端点也用
    ``data[...]``（如 search 的 parse_warnings）, 全模块扫会把它们混进来。
    """
    tree = ast.parse(src if src is not None else _read(path))
    root: ast.AST = tree
    if func_name:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
                root = node
                break
        else:
            raise AssertionError(
                f"{path.name}: 没找到函数 `{func_name}` —— 解析器需更新"
            )
    keys: Set[str] = set()
    for node in ast.walk(root):
        if not isinstance(node, ast.Assign):
            continue
        for tgt in node.targets:
            if (
                isinstance(tgt, ast.Subscript)
                and isinstance(tgt.value, ast.Name)
                and tgt.value.id == var_name
                and isinstance(tgt.slice, ast.Constant)
                and isinstance(tgt.slice.value, str)
            ):
                keys.add(tgt.slice.value)
    return keys


# =============================================================================
# env-only 直读豁免清单的分类小节（tests/config/env_only_reads_allowlist.txt）
# =============================================================================

# 小节标题形如 `# --- D. credential / 凭据存在性检测（…）------`。
_ALLOWLIST_SECTION_RE = re.compile(r"^#\s*-{2,}\s*([A-Z])\.\s*(.*)$")


def parse_allowlist_sections(src: Optional[str] = None) -> Dict[str, List[str]]:
    """豁免清单 → ``{小节字母: [键, ...]}``（小节标题之前的键归 ``''``）。"""
    path = Path(__file__).resolve().parent / "env_only_reads_allowlist.txt"
    src = src if src is not None else path.read_text(encoding="utf-8")
    out: Dict[str, List[str]] = {}
    section = ""
    for line in src.splitlines():
        m = _ALLOWLIST_SECTION_RE.match(line.strip())
        if m:
            section = m.group(1)
            continue
        key = line.split("#", 1)[0].strip()
        if key:
            out.setdefault(section, []).append(key)
    return out


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
