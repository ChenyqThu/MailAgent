"""闸 1 — `email.get` 的 wire 投影跨语言对账（TS 手写投影 ↔ Python wire 投影）。

同一个「一封邮件在 wire 上长什么样」的事实有两份手写投影：

  * 桌面 IPC —— ``frontend/src/electron/main/handlers/email.ts`` 的
    ``shapeFullRecord`` / ``shapeNestedAttachment``
  * 远程 web / CLI —— ``src/services/wire.py`` 的 ``meta_to_dict`` /
    ``attachment_to_dict``（+ ``api/routers/email.py::get_email`` 追加 body/attachments）

``tests/cli/test_wire_parity.py`` 已经把 **Python 那一侧** 钉得很死（golden 字面量 +
字节序），但它只看得见 Python。TS 侧无人对账 —— 于是漂移在两个方向上都真实发生过
（2026-07-27 审计，本批修）：

  * ``shapeFullRecord`` 漏投影 ``is_important``（列在 SELECT 里、就是没 return 出来）
    → 桌面 EmailDetail 的 ❗ 徽标永不渲染 + ComposePanel draft-edit 静默丢高重要性。
    web 一直是对的，所以「换个端就好了」的报告永远指不到根因。
  * 内嵌附件 TS 多带 ``internal_id``（12 字段），Python 是有意的 11 字段
    （wire.py gotcha #1 + test_wire_parity 钉死「不含 internal_id」）—— TS 那份是
    复用 attachment:list 的 shaper 复制来的 accident，还被一条断言错契约的测试
    （「内嵌附件满足 **attachment-list** schema」）固化成了「契约」。

这道闸对账的是**字段集**，不是字段序：
  * IPC 走 structured clone，键序无意义；
  * Python 侧的键序另有 golden（``is_important`` 有意追加在末尾），强行统一序会把
    那份 golden 掀了，换不来任何好处。

🔴 抽取失败必须红：两侧解析器都有 count canary + 抽不到结构时抛错，空集 == 空集恒真。
"""

from typing import Set, Tuple

import pytest

from src.repository.email_repository import AttachmentRecord, EmailMetadataRecord
from src.services import wire

from . import _parsers as p


def _make_meta() -> EmailMetadataRecord:
    """真实调一次 wire 投影用的最小 record —— 键集来自**真投影**而非手抄清单。"""
    return EmailMetadataRecord(
        internal_id=1,
        message_id="<m@example.com>",
        thread_id="<t@example.com>",
        subject="s",
        sender="a@example.com",
        sender_name="A",
        to_addr="b@example.com",
        cc_addr="",
        date_received="2026-07-27 10:00:00",
        mailbox="收件箱",
        is_read=True,
        is_flagged=False,
        sync_status="synced",
        notion_page_id=None,
        notion_thread_id=None,
        sync_error=None,
        retry_count=0,
        next_retry_at=None,
        created_at=1.0,
        updated_at=2.0,
        is_important=True,
    )


def _make_attachment() -> AttachmentRecord:
    return AttachmentRecord(
        id=1,
        internal_id=1,
        filename="a.pdf",
        content_type="application/pdf",
        size_bytes=1,
        is_inline=False,
        content_id=None,
        local_path="data/attachments/1/a.pdf",
        sha256="x",
        derived_from=None,
        derived_format=None,
        notion_file_id=None,
        notion_block_id=None,
        created_at=1.0,
    )


def _python_record_keys() -> Set[str]:
    """Python 侧 `GET /email/{id}` 的完整 data 键集 = wire 投影 + 路由追加的键。

    路由追加的那两个键（body / attachments）不手抄 —— 从 ``get_email`` 函数体里
    静态抽 ``data["k"] = ...``，谁改了路由这里跟着变。
    """
    base = set(wire.meta_to_dict(_make_meta(), include_important=True))
    extra = p.parse_py_subscript_assign_keys(
        "data", p.EMAIL_ROUTER_PY, func_name="get_email"
    )
    assert extra, "email.py::get_email 里没抽到任何 `data[...] = ` 赋值 —— 解析器需更新"
    return base | extra


def _both_record_sides() -> Tuple[Set[str], Set[str]]:
    ts = p.parse_ts_return_object_keys("shapeFullRecord")
    py = _python_record_keys()
    # canary：任一侧抽取器失效 → 空/残缺集 → 下面的集合相等断言平凡通过。
    assert len(ts) > 15, f"shapeFullRecord 只解析到 {len(ts)} 个字段（预期 >15）—— TS 解析器坏了"
    assert len(py) > 15, f"Python wire 侧只解析到 {len(py)} 个字段（预期 >15）—— Python 侧坏了"
    return ts, py


def _both_attachment_sides() -> Tuple[Set[str], Set[str]]:
    ts = p.parse_ts_return_object_keys("shapeNestedAttachment")
    py = set(wire.attachment_to_dict(_make_attachment()))
    assert len(ts) > 8, f"shapeNestedAttachment 只解析到 {len(ts)} 个字段（预期 >8）—— TS 解析器坏了"
    assert len(py) > 8, f"attachment_to_dict 只有 {len(py)} 个字段（预期 >8）—— Python 侧坏了"
    return ts, py


def _drift(ts: Set[str], py: Set[str]) -> Tuple[list, list]:
    """两侧独有的字段。真实断言与反向用例共用同一个判定, 不各写一份。"""
    return sorted(ts - py), sorted(py - ts)


def test_email_get_record_projection_parity():
    """桌面 shapeFullRecord 的字段集 == Python `GET /email/{id}` 的 data 字段集。"""
    ts, py = _both_record_sides()
    ts_only, py_only = _drift(ts, py)
    assert not (ts_only or py_only), (
        "email.get 的两份 wire 投影漂移了（手写镜像漏改一侧）：\n"
        f"  只在 TS shapeFullRecord（桌面有、web 无）：{ts_only}\n"
        f"  只在 Python wire（web 有、桌面无 → 该字段的 UI 在桌面静默失效）：{py_only}\n"
        "→ 两处必须同时改：\n"
        "  frontend/src/electron/main/handlers/email.ts 的 shapeFullRecord\n"
        "  src/services/wire.py 的 meta_to_dict（+ api/routers/email.py::get_email）\n"
        "  新增字段还要进 docs/cli-schema/email-get.schema.json"
        "（email_record 是 additionalProperties:false，漏了会让前端 ajv 测试红）"
    )


def test_nested_attachment_projection_parity():
    """内嵌附件两侧字段集相等 —— 尤其 internal_id 两侧都**不**该有。"""
    ts, py = _both_attachment_sides()
    ts_only, py_only = _drift(ts, py)
    assert not (ts_only or py_only), (
        "email.get 内嵌附件的两份投影漂移了：\n"
        f"  只在 TS shapeNestedAttachment：{ts_only}\n"
        f"  只在 Python attachment_to_dict：{py_only}\n"
        "→ 内嵌形是 11 字段（wire.py gotcha #1：不含 local_path / internal_id）。"
        "带 internal_id 的 12 字段形是**另一个** payload（attachment:list），"
        "它有自己的 shaper（handlers/attachment.ts）与自己的 schema，勿混用。"
    )


def test_nested_attachment_never_leaks_host_path_or_parent_id():
    """🔴 回归钉子：内嵌附件绝不回显 local_path / internal_id。

    没有这条, 上面的 parity 在「谁把 internal_id 一起加回两侧」时会平凡绿 ——
    而那正是本批修掉的 accident 的形状。镜像 test_wire_parity.py 的同名断言。
    """
    ts, py = _both_attachment_sides()
    for side, keys in (("TS shapeNestedAttachment", ts), ("Python attachment_to_dict", py)):
        assert "local_path" not in keys, f"{side} 回显了 host 路径 local_path"
        assert "internal_id" not in keys, (
            f"{side} 带上了 internal_id —— 内嵌位置它恒 == 记录自身的 internal_id，是纯冗余；"
            "需要它的是 attachment:list 面"
        )


def test_is_important_present_on_both_sides():
    """🔴 回归钉子：本批修掉的 is_important 必须两侧都在。

    上面的 parity 在「谁把它从两侧一起删了」时平凡绿 —— 而 EmailDetail 的 ❗ 徽标
    仍读着 `email.is_important`，又会静默不渲染。
    """
    ts, py = _both_record_sides()
    assert "is_important" in ts, (
        "is_important 掉出 shapeFullRecord —— 桌面 ❗ 徽标又永不渲染了"
        "（该列一直在 LIST_COLS 的 SELECT 里，漏的是 return 那一步，所以没有任何报错）"
    )
    assert "is_important" in py, "is_important 掉出 Python wire（meta_to_dict include_important）"


# =============================================================================
# 反向用例 —— 证明这道闸真会红, 而不是恒绿的摆设
# =============================================================================


def test_reverse_gate_catches_injected_drift():
    """故意制造漂移 → 判定必须报出来（用的是与真实断言同一个 `_drift`）。

    注入一律用**加字段**而非删字段：删字段在「该字段此刻本就缺席」时等于没注入，
    本用例会跟着真实的红一起红, 说不清自己证明了什么。加一个两侧都没有的合成字段
    则与仓库当前状态无关, 永远是一次干净的注入。
    """
    ts, py = _both_record_sides()
    victim = "__injected_drift_probe"
    assert victim not in ts and victim not in py, "合成探针字段撞车了, 换一个"
    base_ts_only, base_py_only = (set(s) for s in _drift(ts, py))

    # 形态 1：Python 有、TS 漏 = 修复前 is_important 的真实形状（桌面 ❗ 徽标不渲染）。
    ts_only, py_only = _drift(ts, py | {victim})
    assert set(py_only) - base_py_only == {victim}
    assert set(ts_only) == base_ts_only

    # 形态 2：TS 有、Python 漏（如顺手把 shapeListItem 的 snippet 复制进来）。
    ts_only, py_only = _drift(ts | {victim}, py)
    assert set(ts_only) - base_ts_only == {victim}
    assert set(py_only) == base_py_only


def test_reverse_gate_catches_injected_attachment_drift():
    """附件侧同样证明会红 —— 就用本批修掉的那个字段。"""
    ts, py = _both_attachment_sides()
    ts_only, py_only = _drift(ts | {"internal_id"}, py)
    assert ts_only == ["internal_id"], "把 internal_id 加回 TS 侧后, 闸必须报出漂移"
    assert py_only == []


def test_reverse_parser_failure_is_loud_not_empty():
    """🔴「抽取失败必须红」：解析器抓不到目标结构时抛错, 绝不返回空集。

    空集 == 空集恒真 —— 若解析器静默返回空, 上面的 parity 会在两侧完全对不上时照样绿。
    """
    # 函数被改名 / 被改成箭头函数赋值 → 找不到 `function <name>(`。
    with pytest.raises(AssertionError, match="没找到 `function shapeFullRecord"):
        p.parse_ts_return_object_keys("shapeFullRecord", src="const shapeFullRecord = () => ({})\n")
    # 函数在但不是 `return {` 直接返回对象（改成了先建变量再 return）。
    with pytest.raises(AssertionError, match="没找到 `return \\{`"):
        p.parse_ts_return_object_keys(
            "shapeFullRecord", src="function shapeFullRecord() {\n  return out\n}\n"
        )
    # 对象字面量在但一个 key 都没有（解析规则跟不上新写法）。
    with pytest.raises(AssertionError, match="一个 key 都没解析到"):
        p.parse_ts_return_object_keys(
            "shapeFullRecord", src="function shapeFullRecord() {\n  return {\n    ...spread\n  }\n}\n"
        )
    # 大括号没闭合（截断 / 解析起点错位）。
    with pytest.raises(AssertionError, match="大括号未闭合"):
        p.parse_ts_return_object_keys(
            "shapeFullRecord", src="function shapeFullRecord() {\n  return {\n    a: 1\n"
        )
    # Python 侧：路由函数改名 → 抽不到 data[...] 追加键。
    with pytest.raises(AssertionError, match="没找到函数 `get_email`"):
        p.parse_py_subscript_assign_keys(
            "data", p.EMAIL_ROUTER_PY, src="async def other():\n    data['body'] = None\n",
            func_name="get_email",
        )


def test_reverse_canary_catches_shrunken_projection():
    """canary 下限本身也要有效：投影缩水到解析器疑似失效的量级时必被拦下。"""
    tiny = "function shapeFullRecord() {\n  return {\n    internal_id: x\n  }\n}\n"
    assert p.parse_ts_return_object_keys("shapeFullRecord", src=tiny) == {"internal_id"}
    # …但只有 1 个字段 ⇒ 真实测试里的 `len(...) > 15` canary 会把它拦下（见 _both_record_sides）。
    assert len(p.parse_ts_return_object_keys("shapeFullRecord", src=tiny)) <= 15


def test_top_level_keys_ignores_nested_and_comments():
    """解析器只收顶层 key：嵌套对象的 key 与注释里的 `foo:` 不能混进来。

    没这条, 「TS 侧多一个嵌套字段」会被当成多了一堆顶层字段, 报出假漂移。
    """
    src = (
        "function f() {\n"
        "  return {\n"
        "    // decoy: not_a_field\n"
        "    top_a: 1,\n"
        "    nested: { inner_b: 2, inner_c: 3 },\n"
        "    top_d: call({ arg_e: 4 })\n"
        "  }\n"
        "}\n"
    )
    assert p.parse_ts_return_object_keys("f", src=src) == {"top_a", "nested", "top_d"}
