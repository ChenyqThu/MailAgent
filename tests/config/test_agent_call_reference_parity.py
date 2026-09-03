"""闸 —— `AgentCallReference` 判别 union 的两处消费方对账（P2-L12）。

`custom_agent_call` 的跨 agent 引用类型 `AgentCallReference` 曾在两处各手抄一份，且没有任何
一致性闸：

  1. ``frontend/src/ai-gateway/tools/agent_call.ts``（工具执行侧）—— `type` 是严格字面量 union
     `'session' | 'report' | 'notion' | 'email' | 'calendar'`。
  2. ``frontend/src/shared/assistant/tools/generic/CustomAgentCallCard.tsx``（卡片渲染侧）——
     `type` 偷懒写成 `string`，比 1 更松。

失败形态：给 1 加一个新 `type` 分支，2 认不出来 —— 编译过、测试过，直到那类引用在卡片上静默不
渲染（2 的类型本来就比 1 宽，类型检查挡不住这种漂移）。

修法（CLAUDE.md：先问能不能消灭镜像，消灭不了才建闸）：两处都改成从零依赖叶子
``frontend/src/shared/agentCallReference.ts`` import 同一个类型；本闸钉住「它们不许再自己写一份」
——范式抄 ``tests/config/test_group_constants_parity.py`` 第 4 条（消费方 import 单源，闸钉住
「不许自己再写一份字面量」）。P2-L12 在消灭镜像之上加了 `'library'` 一档 +
`customAgentCallSchema.library_file_ids`，本闸同时钉住这一档的落地形状。

🔴 抽取失败必须红：每个抽取器抓不到目标结构就抛（不返回空集），外加逐项 canary 断言非空。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List

import pytest

from . import _parsers as p

LEAF_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "agentCallReference.ts"
AGENT_CALL_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "tools" / "agent_call.ts"
CARD_TSX = (
    p.REPO_ROOT
    / "frontend"
    / "src"
    / "shared"
    / "assistant"
    / "tools"
    / "generic"
    / "CustomAgentCallCard.tsx"
)
SCHEMAS_TS = p.REPO_ROOT / "frontend" / "src" / "ai-gateway" / "tools" / "schemas.ts"

#: 值域下限（canary）—— 消灭镜像前的五个 + P2-L12 新增的 'library'。
REFERENCE_TYPE_FLOOR = 6
#: 精确值域 —— 这是叶子自己的内容期望（不是第二份生产镜像），漂移即改坏了值域本身。
EXPECTED_REFERENCE_TYPES = {"session", "report", "notion", "email", "calendar", "library"}


# =============================================================================
# 抽取器（抓不到就抛 —— 不静默返回空集）
# =============================================================================


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_ts_const_string_array(const_name: str, src: str, *, label: str) -> List[str]:
    """``export const NAME = [ 'a', 'b', ] as const`` → 字符串列表（顺序保留）。"""
    m = re.search(rf"export const {const_name}\s*=\s*\[", src)
    if not m:
        raise AssertionError(f"{label}: 没找到 `export const {const_name} = [` —— 解析器需更新")
    end = src.find("] as const", m.end())
    if end == -1:
        raise AssertionError(f"{label}: {const_name} 数组没有 `] as const` 结尾 —— 解析器需更新")
    members = re.findall(r"'([^'\n]+)'", src[m.end() : end])
    if not members:
        raise AssertionError(f"{label}: {const_name} 数组解析为空 —— 解析器需更新")
    return members


#: 叶子文件不许出现真正的 import 语句（行首只有空白紧跟 `import`）。TS/JS 里注释永远不会让某个
#: 物理行以裸 `import` 开头（`//`/`*` 前缀会挡在前面），故这个正则不会被注释里提到"import"一词误伤。
_IMPORT_LINE_RE = re.compile(r"(?m)^\s*import\b")


def leaf_has_zero_imports(src: str) -> bool:
    return _IMPORT_LINE_RE.search(src) is None


#: 消费方 import `AgentCallReference` 时必须来自叶子模块路径（`@shared/agentCallReference` 或等价
#: 相对路径），而不是从别处（比如把类型重新定义在另一个文件里再转手 re-export）。
_LEAF_IMPORT_RE = re.compile(
    r"import\s+(?:type\s+)?\{[^}]*\bAgentCallReference\b[^}]*\}\s+from\s+"
    r"['\"]([^'\"]*\bagentCallReference)['\"]"
)


def imports_agent_call_reference_from_leaf(src: str) -> bool:
    return _LEAF_IMPORT_RE.search(src) is not None


#: 本地手抄的判别式：`(export )?interface AgentCallReference`。消灭镜像后两处消费方都不该再有。
_OWN_INTERFACE_RE = re.compile(r"(?m)^\s*(?:export\s+)?interface\s+AgentCallReference\b")


def declares_own_interface(src: str) -> bool:
    return _OWN_INTERFACE_RE.search(src) is not None


def custom_agent_call_schema_block(src: str) -> str:
    """`customAgentCallSchema` 定义体（从声明到它自己的 `.strict()` 结尾）。

    只在这个切片里找 `library_file_ids`——避免文件里别的 schema 恰好也叫这个名字的字段时
    被误判命中（部分抽取比抽不到更毒）。
    """
    start = src.find("export const customAgentCallSchema")
    if start == -1:
        raise AssertionError(
            f"{SCHEMAS_TS.name}: 没找到 `export const customAgentCallSchema` —— 解析器需更新"
        )
    end = src.find(".strict()", start)
    if end == -1:
        raise AssertionError(
            f"{SCHEMAS_TS.name}: customAgentCallSchema 后面没找到 `.strict()` 结尾 —— 解析器需更新"
        )
    return src[start:end]


def _balanced_parens(src: str, open_idx: int, label: str) -> str:
    """从 ``src[open_idx]``（必须是 `(`）取到配对 `)` 的整块（含两端）。

    `z.array(z.number().int().positive())` 的数组元素类型本身含多个顺次的空括号调用
    （`.int()` / `.positive()`），朴素的 `[^)]*` 正则会在第一个 `)` 处提前截断（部分抽取比
    抽不到更毒）——这里用括号深度计数正确跨过它们，只在配对的外层 `)` 处停。
    """
    if src[open_idx] != "(":
        raise AssertionError(f"{label}: 期望 `(` 起始 —— 解析器需更新")
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
            if depth == 0:
                return src[open_idx : i + 1]
    raise AssertionError(f"{label}: 圆括号未闭合 —— 解析器需更新")


def library_file_ids_field(block: str) -> tuple:
    """`library_file_ids: z.array(<inner>).max(<N>).optional()` → (inner 类型文本, N)。"""
    label = f"{SCHEMAS_TS.name}:customAgentCallSchema.library_file_ids"
    m = re.search(r"library_file_ids\s*:\s*z\.array\(", block)
    if not m:
        raise AssertionError(f"{label}: 没找到 `library_file_ids: z.array(` —— 解析器需更新")
    open_idx = m.end() - 1
    array_call = _balanced_parens(block, open_idx, label)
    inner = array_call[1:-1]
    rest = block[open_idx + len(array_call) :]
    tail_m = re.match(r"\s*\.max\((\d+)\)\.optional\(\)", rest)
    if not tail_m:
        raise AssertionError(f"{label}: `z.array(...)` 后面没跟 `.max(<N>).optional()` —— 解析器需更新")
    return inner, int(tail_m.group(1))


# =============================================================================
# 对账
# =============================================================================


def test_leaf_has_zero_imports() -> None:
    """叶子文件不许 import 任何东西 —— 两处消费方一处在 gateway 的 Node 运行时直接加载。"""
    src = _read(LEAF_TS)
    assert leaf_has_zero_imports(src), (
        f"{LEAF_TS.name} 出现了 import 语句 —— 零依赖叶子被破了：gateway 侧会因为拉进多余的运行时"
        "依赖（electron / store 之类）而加载失败。"
    )


def test_leaf_reference_types_are_exactly_the_expected_set() -> None:
    """叶子的 `AGENT_CALL_REFERENCE_TYPES` 值域 —— 五个既有类型 + P2-L12 新增的 'library'。"""
    types = parse_ts_const_string_array(
        "AGENT_CALL_REFERENCE_TYPES", _read(LEAF_TS), label=LEAF_TS.name
    )
    assert len(types) >= REFERENCE_TYPE_FLOOR, (
        f"{LEAF_TS.name} 的 AGENT_CALL_REFERENCE_TYPES 只解析到 {len(types)} 项"
        f"（预期 >={REFERENCE_TYPE_FLOOR}）—— 解析器坏了"
    )
    assert set(types) == EXPECTED_REFERENCE_TYPES, (
        f"AGENT_CALL_REFERENCE_TYPES 漂了：\n"
        f"  解析到：{sorted(set(types))}\n"
        f"  期望：  {sorted(EXPECTED_REFERENCE_TYPES)}\n"
        "→ 'library' 缺失 = P2-L12 的加值没有落地；少了别的成员 = 消灭镜像那一步误删了既有值域。"
    )


@pytest.mark.parametrize(
    "path",
    [AGENT_CALL_TS, CARD_TSX],
    ids=["agent_call.ts", "CustomAgentCallCard.tsx"],
)
def test_consumer_imports_the_single_source(path: Path) -> None:
    """两处消费方都必须 import 叶子的类型，不许自己再写一份字面量（消灭镜像 > 建闸的执行面）。"""
    src = _read(path)
    assert imports_agent_call_reference_from_leaf(src), (
        f"{path.name} 没有从 agentCallReference.ts import `AgentCallReference` —— 要么被删了，"
        "要么改回了自己写一份（可能更宽松的）字面量类型，这正是本闸要拦住的漂移形态。"
    )
    assert not declares_own_interface(src), (
        f"{path.name} 里又出现了本地 `interface AgentCallReference` 声明 —— 这就是手抄回潮："
        "改用 frontend/src/shared/agentCallReference.ts 的单源类型。"
    )


def test_custom_agent_call_schema_has_library_file_ids_bounded_to_50() -> None:
    """`customAgentCallSchema.library_file_ids`：数字数组，上限 50（design §5.1「跨 agent」）。"""
    block = custom_agent_call_schema_block(_read(SCHEMAS_TS))
    inner, cap = library_file_ids_field(block)
    assert "z.number()" in inner, (
        f"library_file_ids 的数组元素类型不是 z.number()（实际：{inner!r}）—— "
        "library_file.id 是 SQLite INTEGER PRIMARY KEY，schema 侧也应是数字，不是字符串。"
    )
    assert cap == 50, (
        f"library_file_ids 的 .max() 上限是 {cap}，design §5.1 与本任务规格要求 50。"
    )


def test_extractors_fail_loudly_on_missing_structures() -> None:
    """反向用例：抽取器抓不到目标结构时必须抛（否则整道闸会退化成平凡绿）。"""
    with pytest.raises(AssertionError):
        parse_ts_const_string_array("NO_SUCH_VOCAB", _read(LEAF_TS), label=LEAF_TS.name)
    with pytest.raises(AssertionError):
        parse_ts_const_string_array(
            "EMPTY", "export const EMPTY = [] as const\n", label="synthetic"
        )
    with pytest.raises(AssertionError):
        custom_agent_call_schema_block("no such marker anywhere in this string")
    with pytest.raises(AssertionError):
        custom_agent_call_schema_block("export const customAgentCallSchema = z.object({})")
    with pytest.raises(AssertionError):
        library_file_ids_field("agent_id: z.string()")
    with pytest.raises(AssertionError):
        library_file_ids_field("library_file_ids: z.array(z.number()).optional()")  # 漏 .max()
