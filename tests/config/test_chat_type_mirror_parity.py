"""闸 3 — chat 行形状的两份 TS 手抄镜像对账（本批事故的正主）。

同一组「ai_chat.db 的行长什么样」的类型存在两份手抄副本，**都在前端、都是 TS**：

  * ``frontend/src/shared/chat_model.ts`` —— DB 行形状（1:1 对齐
    ai_chat_sessions / ai_chat_messages / chat_tool_call 三表），chat_db.ts re-export
  * ``frontend/src/shared/api/types/chat.ts`` —— API/IPC 边界投影，renderer 按它取字段

两条读路径都是 ``SELECT *``（桌面 ``chat_db/tool_calls.ts``、远程 ``src/chat/db.py``），
所以**列一直在 wire 上传**；漂的只有类型。于是失败形态特别阴：编译过、运行时也没报错，
只是类型在对 wire 形状撒谎，直到有人据此认定「这列读不到」而删掉读侧兜底。实测两例：

  * ``ChatMessage.ui_message_json``（v9 加列只改了 chat_model）—— 本批之前刚修，
    该字段的注释里留了完整事故记录。
  * ``ChatToolCall.whitelist_rule_id``（v18 加列只改了 chat_model）—— **本闸建起来当场
    抓到的第 12 处漂移**（人工审计那 11 项里没有它），本批一并补上。

**为什么是「建闸」而不是「消灭镜像」**（CLAUDE.md 要求先问这个问题）：
``api/types/chat.ts`` 至今**一个 import 都没有**，其文件注释明写这条边界是有意的
（"kept inline so api/types stays the boundary surface without importing chat internals"）。
消灭镜像（``export type { ChatMessage } from '../../chat_model'``）要打破这个仍在被维护的
不变式；且两者概念上是两个面 —— DB 行 vs 「可以过 IPC/HTTP 的那部分」（那些
"NEVER store secrets here — the field crosses the IPC boundary" 注释就是作者在逐列过这道判断），
将来真出现一列不该出网时，re-export 会把「让它别出网」变成不可能。故保留两份 + 建闸。

🔴 抽取失败必须红：两侧解析器共用 ``parse_ts_interface_keys``（抓不到 interface / 抓不到
key 就抛），外加 count canary。
"""

import re
from typing import Set, Tuple

import pytest

from . import _parsers as p

CHAT_MODEL_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "chat_model.ts"
CHAT_TYPES_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "chat.ts"
# 来源筛选词表的 Python 侧两处手抄（远程 web 走的就是它们，见 origin filter 用例的红字）。
CHAT_ROUTER_PY = p.REPO_ROOT / "src" / "api" / "routers" / "chat.py"
CHAT_DB_PY = p.REPO_ROOT / "src" / "chat" / "db.py"

# 两份镜像里同名同义的行类型 → 该类型的字段数下限（canary，防解析器失效后平凡绿）。
MIRRORED_ROW_TYPES = {
    "ChatMessage": 10,
    "ChatSession": 10,
    "ChatToolCall": 15,
}


def _both_sides(name: str) -> Tuple[Set[str], Set[str]]:
    model = p.parse_ts_interface_keys(name, CHAT_MODEL_TS)
    api = p.parse_ts_interface_keys(name, CHAT_TYPES_TS)
    floor = MIRRORED_ROW_TYPES[name]
    assert len(model) >= floor, (
        f"chat_model.ts 的 {name} 只解析到 {len(model)} 个字段（预期 >={floor}）—— 解析器坏了"
    )
    assert len(api) >= floor, (
        f"api/types/chat.ts 的 {name} 只解析到 {len(api)} 个字段（预期 >={floor}）—— 解析器坏了"
    )
    return model, api


def _drift(model: Set[str], api: Set[str]) -> Tuple[list, list]:
    """两侧独有的字段。真实断言与反向用例共用同一个判定, 不各写一份。"""
    return sorted(model - api), sorted(api - model)


@pytest.mark.parametrize("name", sorted(MIRRORED_ROW_TYPES))
def test_chat_row_type_mirror_parity(name: str):
    """两份 chat 行类型逐字段对账（无 baseline —— 任一侧独有都是真 bug）。"""
    model, api = _both_sides(name)
    model_only, api_only = _drift(model, api)
    assert not (model_only or api_only), (
        f"{name} 的两份 TS 镜像漂移了（加列时只改了一处）：\n"
        f"  只在 chat_model.ts（= DB 真有这列, 且两条读路径都 SELECT *, 所以它在 wire 上；"
        f"缺的是类型 → 边界类型在撒谎）：{model_only}\n"
        f"  只在 api/types/chat.ts（声明了一个 DB 里没有的字段 → 读回恒 undefined）：{api_only}\n"
        "→ 加/改 ai_chat.db 列时两处必须同批改：\n"
        "  frontend/src/shared/chat_model.ts（DB 行形状）\n"
        "  frontend/src/shared/api/types/chat.ts（API/IPC 边界投影）\n"
        "  以及 chat_db 的 migration + src/chat/db.py 的读写镜像。"
    )


def test_known_incident_fields_present_on_both_sides():
    """🔴 回归钉子：两次真事故的字段必须两侧都在。

    没有这条, 上面的 parity 在「谁把它从两侧一起删了」时会平凡绿 —— 而 DB 里的列还在,
    wire 上还在传, 只是又没人认得它了。
    """
    msg_model, msg_api = _both_sides("ChatMessage")
    for side, keys in (("chat_model.ts", msg_model), ("api/types/chat.ts", msg_api)):
        assert "ui_message_json" in keys, (
            f"ui_message_json 掉出 {side} —— 这是 v9 的图片/富消息历史来源, "
            "读侧一旦据此删兜底, 图片历史当场全灭"
        )
    tc_model, tc_api = _both_sides("ChatToolCall")
    for side, keys in (("chat_model.ts", tc_model), ("api/types/chat.ts", tc_api)):
        assert "whitelist_rule_id" in keys, (
            f"whitelist_rule_id 掉出 {side} —— v18 免卡审计（哪条 PolicyRule 放行了 exec 调用）"
            "的唯一线索"
        )


def test_mirrored_types_exist_in_both_files():
    """镜像清单本身也要有效：清单里的类型必须两个文件里都真有。

    若某类型被改名 / 只剩一侧, 上面的 parametrize 会因解析器抛错而红 —— 这条把
    「清单过期」与「真漂移」分开, 报错时一眼看出是哪种。
    """
    for name in MIRRORED_ROW_TYPES:
        for path in (CHAT_MODEL_TS, CHAT_TYPES_TS):
            p.parse_ts_interface_keys(name, path)  # 抓不到就抛（不静默）


# =============================================================================
# 反向用例 —— 证明这道闸真会红, 而不是恒绿的摆设
# =============================================================================


def test_reverse_gate_catches_injected_drift():
    """故意制造漂移 → 判定必须报出来（与真实断言共用 `_drift`）。

    注入用**加字段**而非删字段：删字段在「该字段此刻本就缺席」时等于没注入,
    本用例会跟着真实的红一起红, 说不清自己证明了什么。
    """
    model, api = _both_sides("ChatToolCall")
    victim = "__injected_drift_probe"
    assert victim not in model and victim not in api, "合成探针字段撞车了, 换一个"
    base_model_only, base_api_only = (set(s) for s in _drift(model, api))

    # 形态 1：chat_model 有、api/types 漏 = whitelist_rule_id / ui_message_json 的真实形状。
    model_only, api_only = _drift(model | {victim}, api)
    assert set(model_only) - base_model_only == {victim}
    assert set(api_only) == base_api_only

    # 形态 2：api/types 声明了 DB 里没有的字段（读回恒 undefined）。
    model_only, api_only = _drift(model, api | {victim})
    assert set(api_only) - base_api_only == {victim}
    assert set(model_only) == base_model_only


def test_reverse_parser_failure_is_loud_not_empty():
    """🔴「抽取失败必须红」：解析器抓不到目标结构时抛错, 绝不返回空集。

    空集 == 空集恒真 —— 若解析器静默返回空, 上面的 parity 会在两侧完全对不上时照样绿。
    """
    # interface 改名 / 变成 type alias（chat_model 若哪天改写法, 闸必须当场喊）。
    with pytest.raises(AssertionError, match="没找到 `interface ChatMessage`"):
        p.parse_ts_interface_keys(
            "ChatMessage", CHAT_MODEL_TS, src="export type ChatMessage = { id: number }\n"
        )
    # interface 在但体内一个字段都没解析到（写法变了, 如全用 index signature）。
    with pytest.raises(AssertionError, match="一个 key 都没解析到"):
        p.parse_ts_interface_keys(
            "ChatMessage", CHAT_MODEL_TS, src="export interface ChatMessage {\n  [k: string]: unknown\n}\n"
        )
    # 大括号没闭合（截断 / 解析起点错位）。
    with pytest.raises(AssertionError, match="大括号未闭合"):
        p.parse_ts_interface_keys(
            "ChatMessage", CHAT_MODEL_TS, src="export interface ChatMessage {\n  id: number\n"
        )


def test_reverse_canary_catches_shrunken_mirror():
    """canary 下限本身也要有效：镜像缩水到解析器疑似失效的量级时必被拦下。"""
    tiny = "export interface ChatMessage {\n  id: number\n}\n"
    assert p.parse_ts_interface_keys("ChatMessage", CHAT_MODEL_TS, src=tiny) == {"id"}
    # …但只有 1 个字段 ⇒ 真实测试里的 `>= 10` canary 会把它拦下（见 _both_sides）。
    assert len(p.parse_ts_interface_keys("ChatMessage", CHAT_MODEL_TS, src=tiny)) < MIRRORED_ROW_TYPES["ChatMessage"]


def test_nested_and_commented_fields_are_not_miscounted():
    """解析器只收顶层字段：嵌套对象字面量类型与注释里的 `foo:` 不能混进来。

    没这条, 「某侧多一个嵌套字段」会被当成多了一堆顶层字段, 报出假漂移。
    """
    src = (
        "export interface ChatMessage {\n"
        "  // decoy: not_a_field\n"
        "  id: number\n"
        "  nested: { inner_a: string; inner_b: number }\n"
        "  opt?: string | null\n"
        "}\n"
    )
    assert p.parse_ts_interface_keys("ChatMessage", CHAT_MODEL_TS, src=src) == {
        "id",
        "nested",
        "opt",
    }


def test_boundary_invariant_api_types_chat_has_no_imports():
    """🔴 本闸存在的前提：api/types/chat.ts 保持「零 import」的边界。

    这条不变式若哪天被打破（有人给它加了 import），那「不能消灭镜像」的理由就没了 ——
    应该回来重新评估 `export type { … } from '../../chat_model'` 单源导出，而不是继续
    维护两份手抄 + 一道闸。故意让它在边界松动时红，逼一次重新决策。
    """
    src = CHAT_TYPES_TS.read_text(encoding="utf-8")
    imports = [
        ln.strip()
        for ln in src.splitlines()
        if ln.lstrip().startswith("import ") or ln.lstrip().startswith("import\t")
    ]
    assert not imports, (
        "api/types/chat.ts 不再是零 import 了：\n  " + "\n  ".join(imports) + "\n"
        "→ 「保持边界所以不能单源导出」这个理由已经不成立。回 test_chat_type_mirror_parity.py "
        "的模块 docstring 重新评估：要么把 ChatMessage/ChatSession/ChatToolCall 改成从 "
        "shared/chat_model.ts re-export（镜像消灭, 本闸可退役），要么说明新 import 为何不算破例。"
    )


def _parse_string_union(name: str, path) -> Set[str]:
    """Parse a single-line exported TS string union and fail loudly on shape drift."""
    src = path.read_text(encoding="utf-8")
    match = re.search(rf"^export type {re.escape(name)}\s*=\s*(.+)$", src, re.MULTILINE)
    assert match, f"{path}: 没找到 `export type {name} = ...`"
    rhs = match.group(1).strip()
    values = re.findall(r"'([^']+)'", rhs)
    normalized = " | ".join(f"'{value}'" for value in values)
    assert values and normalized == rhs, (
        f"{path}: {name} 不再是纯字符串联合类型（当前: {rhs!r}）—— 解析器或边界契约需更新"
    )
    return set(values)


def _parse_quoted_group(path, pattern: str, what: str) -> Set[str]:
    """按 ``pattern`` 抓一组带引号的字面量 → 值集合。

    🔴 抽取失败必须红：匹配不到、或匹配到但抓不出任何字面量，一律 assert 失败而非返回空集
    （空集会让下面的相等断言变成「两边都空 → 平凡通过」，正是 CLAUDE.md 记的闸失效形态）。
    """
    text = path.read_text(encoding="utf-8")
    m = re.search(pattern, text)
    assert m is not None, f"{what} 抽取失败（正则没命中，{path.name} 改了形状？）—— 解析器需更新"
    values = set(re.findall(r"""['"]([a-z_]+)['"]""", m.group(1)))
    assert values, f"{what} 抽到了但一个字面量都没解析出来: {m.group(1)!r}"
    return values


def test_chat_session_origin_filter_mirror_parity():
    """会话来源筛选跨 DB/API 边界手抄时，值集合必须保持一致。

    🔴 **四处**手抄，不是两处（08-01 阶段 2 PR-1 复核补齐后两处）：TS 的两份联合类型
    ``ChatSessionOriginFilter`` 之外，Python 侧还有 serve-api 查询参数的 ``Literal[...]``
    与 ``ChatDb.list_all_sessions`` 的校验元组。**同一个筛选值在 Electron 与远程 web 走的是
    两条完全不同的实现**（前者 TS ``listAllSessions`` 的 originClause，后者 HTTP →
    Python），所以只锁 TS↔TS 会让「在 TS 里合法、到 Python 就 422 / 或在 TS 里静默落进
    interactive 子句」这种**类型检查全绿的运行时错**溜过去 —— 阶段 2 PR-1 一度给联合类型加
    了个没有任何实现的 ``'im'``，正是这个形状。

    ⚠️ 与 ``origin`` **列**的值域（自由文本 ``'agent' | 'im' | NULL``，CHAT_DB v22 登记
    ``'im'``）是两回事：'im' 行有意走默认 interactive 子句（Q18=A 桌面可见），**不需要**
    也没有对应的筛选值。将来真要做「只看飞书会话」必须四处一起加。
    """
    expected = {"interactive", "agent", "all"}
    model = _parse_string_union("ChatSessionOriginFilter", CHAT_MODEL_TS)
    api = _parse_string_union("ChatSessionOriginFilter", CHAT_TYPES_TS)
    assert model == expected, f"chat_model.ts 的来源筛选契约漂移: {sorted(model)}"
    assert api == expected, f"api/types/chat.ts 的来源筛选契约漂移: {sorted(api)}"
    assert model == api

    # Python 侧两处（抽取失败必须红 —— 抽不到就是解析器坏了，不能平凡通过）
    api_literal = _parse_quoted_group(
        CHAT_ROUTER_PY, r'origin:\s*Literal\[([^\]]+)\]', "chat.py 的 origin Literal"
    )
    db_tuple = _parse_quoted_group(
        CHAT_DB_PY, r'origin\s+not\s+in\s+\(([^)]+)\)', "chat/db.py 的 origin 校验元组"
    )
    assert api_literal == expected, f"src/api/routers/chat.py 的 origin Literal 漂移: {sorted(api_literal)}"
    assert db_tuple == expected, f"src/chat/db.py 的 origin 校验元组漂移: {sorted(db_tuple)}"
