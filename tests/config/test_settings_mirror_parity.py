"""闸 2 — persistent settings 的三份镜像对账。

同一个「持久化设置有哪些字段」的事实存在三份手写副本：

  1. 共享类型 —— ``frontend/src/shared/api/types/settings.ts`` 的 ``PersistentSettings``
     （renderer 组件按它取字段，两个传输端共用）
  2. 桌面实现 —— ``frontend/src/electron/main/handlers/settings.ts`` 的 ``DEFAULTS``
     （``readSettings()`` = ``{...DEFAULTS, ...sanitize(persisted), userEmail}``，
     故 DEFAULTS 的键集就是 ``settings:get`` 的返回键集）
  3. 远程实现 —— ``src/api/routers/settings.py::get_settings_payload`` 手组的 payload

TS 那两份编译器会帮忙看着（DEFAULTS 声明成 ``PersistentSettings``，少一个键就编译不过），
**Python 那份没有任何东西看着** —— 于是它漏了 ``signature``（2026-07-27 审计，本批修）：
远程 web 的 compose「签名」按钮永久禁用（``ComposePanel`` 读 ``settings.signature``），
不报错、不降级提示，只是那个按钮永远是灰的。

对账的是**键集**不是值：几个 host-local 字段（dbPath / attachmentDir / notionAgent* /
signature）在远程恒 ``None`` 是有意的（serve-api 没有 Electron 的 ``<userData>/
settings.json``，也没被注入它的路径）。键必须在 —— 缺键 ≠ 空值：前端是同一批组件读
同一个类型，缺键会让控件静默退化，而空值至少是「配置为空」这个诚实语义。

🔴 抽取失败必须红：三侧解析器都有 count canary + 抽不到结构时抛错。
"""

from typing import Set, Tuple

import pytest

from . import _parsers as p

# 远程恒 None 的 host-local 字段 —— 键必须在，值有意为空（见模块 docstring）。
# 这是**值**层面的已知差异清单，不是键层面的豁免：下面的 parity 断言不看它。
_REMOTE_NULL_BY_DESIGN = {
    "dbPath",
    "attachmentDir",
    "notionAgentPageId",
    "notionAgentName",
    "signature",
}


def _three_sides() -> Tuple[Set[str], Set[str], Set[str]]:
    iface = p.parse_ts_interface_keys("PersistentSettings", p.SETTINGS_TYPES_TS)
    defaults = p.parse_ts_const_object_keys("DEFAULTS", p.SETTINGS_HANDLER_TS)
    payload = p.parse_py_dict_literal_keys(
        "payload", p.SETTINGS_PY, func_name="get_settings_payload"
    )
    # canary：任一侧抽取器失效 → 残缺集 → 集合相等断言平凡通过。
    assert len(iface) > 6, f"PersistentSettings 只解析到 {len(iface)} 个字段（预期 >6）—— TS 解析器坏了"
    assert len(defaults) > 6, f"DEFAULTS 只解析到 {len(defaults)} 个字段（预期 >6）—— TS 解析器坏了"
    assert len(payload) > 6, f"settings.py payload 只解析到 {len(payload)} 个字段（预期 >6）—— AST 解析器坏了"
    return iface, defaults, payload


def _drift(a: Set[str], b: Set[str]) -> Tuple[list, list]:
    """两侧独有的键。真实断言与反向用例共用同一个判定, 不各写一份。"""
    return sorted(a - b), sorted(b - a)


def test_desktop_defaults_match_shared_type():
    """桌面 DEFAULTS 的键集 == 共享 PersistentSettings 的字段集。

    这条 TypeScript 其实也管得住（DEFAULTS 有类型标注）, 但显式钉一道:
    它是下面那条 Python 对账的参照基准, 基准自己先要是对的。
    """
    iface, defaults, _ = _three_sides()
    iface_only, defaults_only = _drift(iface, defaults)
    assert not (iface_only or defaults_only), (
        "桌面 DEFAULTS 与共享类型漂移了：\n"
        f"  只在 PersistentSettings 类型：{iface_only}\n"
        f"  只在 DEFAULTS：{defaults_only}"
    )


def test_remote_payload_matches_shared_type():
    """远程 serve-api payload 的键集 == 共享 PersistentSettings 的字段集。

    🔴 这是本批修的那条 —— Python 侧没有类型系统兜底, 唯一的看门人就是它。
    """
    iface, _, payload = _three_sides()
    iface_only, payload_only = _drift(iface, payload)
    assert not (iface_only or payload_only), (
        "远程 settings payload 与共享类型漂移了（手写镜像漏改一侧）：\n"
        f"  只在 PersistentSettings 类型（web 上该字段读回 undefined → 控件静默失效）：{iface_only}\n"
        f"  只在 settings.py payload（发了个前端不认的键）：{payload_only}\n"
        "→ 新增 persistent setting 必须**三处**同时加：\n"
        "  frontend/src/shared/api/types/settings.ts 的 PersistentSettings\n"
        "  frontend/src/electron/main/handlers/settings.ts 的 DEFAULTS（+ 需要落盘就加 sanitize）\n"
        "  src/api/routers/settings.py::get_settings_payload 的 payload\n"
        "  值可以按传输端不同（host-local 字段远程给 None），键不可以。"
    )


def test_signature_present_in_all_three():
    """🔴 回归钉子：本批修掉的 signature 必须三侧都在。

    没有这条, 上面的 parity 在「谁把它从三侧一起删了」时会平凡绿 —— 而 ComposePanel
    仍读着 `settings.signature`, 签名按钮又会永久禁用。
    """
    iface, defaults, payload = _three_sides()
    assert "signature" in iface, "signature 掉出 PersistentSettings 类型"
    assert "signature" in defaults, "signature 掉出桌面 DEFAULTS —— 桌面签名按钮失效"
    assert "signature" in payload, (
        "signature 掉出 settings.py payload —— 远程 web 的 compose 签名按钮又永久禁用了"
    )


def test_remote_null_by_design_list_is_still_accurate():
    """「远程恒 None」清单必须都是真字段 —— 清单本身也会过期。

    若某字段被删/改名而清单没跟着改, 这条会红, 提醒人回来看这份值层面的说明,
    而不是让一段过期的注释一直挂在那儿。
    """
    iface, _, _ = _three_sides()
    stale = sorted(_REMOTE_NULL_BY_DESIGN - iface)
    assert not stale, (
        f"「远程恒 None」清单里这些字段已不在 PersistentSettings 里了：{stale}"
        " —— 清单过期, 回 test_settings_mirror_parity.py 更新"
    )


# =============================================================================
# 反向用例 —— 证明这道闸真会红, 而不是恒绿的摆设
# =============================================================================


def test_reverse_gate_catches_injected_drift():
    """故意制造违规 → 判定必须报出漂移（与真实断言共用 `_drift`）。

    注入一律用**加键**而非删键：删键在「该键此刻本就缺席」时等于没注入，本用例会跟着
    真实的红一起红，说不清自己证明了什么。加一个两侧都没有的合成键则与仓库当前状态
    无关，永远是一次干净的注入（差集只看新增部分，故在途漂移也不干扰）。
    """
    iface, _, payload = _three_sides()
    victim = "__injectedDriftProbe"
    assert victim not in iface and victim not in payload, "合成探针键撞车了, 换一个"
    base_iface_only, base_payload_only = (set(s) for s in _drift(iface, payload))

    # 形态 1：类型有、Python payload 漏 = 修复前 signature 的真实形状
    #（web 上该字段读回 undefined → 控件静默失效）。
    iface_only, payload_only = _drift(iface | {victim}, payload)
    assert set(iface_only) - base_iface_only == {victim}
    assert set(payload_only) == base_payload_only

    # 形态 2：Python 发了个前端不认的键（后端加字段忘了同步类型）。
    iface_only, payload_only = _drift(iface, payload | {victim})
    assert set(payload_only) - base_payload_only == {victim}
    assert set(iface_only) == base_iface_only


def test_reverse_parser_failure_is_loud_not_empty():
    """🔴「抽取失败必须红」：解析器抓不到目标结构时抛错, 绝不返回空集。"""
    # TS interface 改名 / 变成 type alias。
    with pytest.raises(AssertionError, match="没找到 `interface PersistentSettings`"):
        p.parse_ts_interface_keys(
            "PersistentSettings", p.SETTINGS_TYPES_TS, src="export type PersistentSettings = {}\n"
        )
    # DEFAULTS 改名。
    with pytest.raises(AssertionError, match="没找到 `const DEFAULTS =`"):
        p.parse_ts_const_object_keys(
            "DEFAULTS", p.SETTINGS_HANDLER_TS, src="const BASELINE = {\n  a: 1\n}\n"
        )
    # DEFAULTS 右值不再是对象字面量（改成了函数调用 / 展开别处的常量）。
    with pytest.raises(AssertionError, match="右值不是对象字面量"):
        p.parse_ts_const_object_keys(
            "DEFAULTS", p.SETTINGS_HANDLER_TS, src="const DEFAULTS = buildDefaults()\n"
        )
    # Python：函数改名。
    with pytest.raises(AssertionError, match="没找到函数 `get_settings_payload`"):
        p.parse_py_dict_literal_keys(
            "payload", p.SETTINGS_PY, src="def other():\n    payload = {'a': 1}\n",
            func_name="get_settings_payload",
        )
    # Python：payload 改成了 dict 之外的构造（值不再可静态确定）。
    with pytest.raises(AssertionError, match="右值不是 dict 字面量"):
        p.parse_py_dict_literal_keys(
            "payload", p.SETTINGS_PY,
            src="def get_settings_payload():\n    payload = dict(a=1)\n",
            func_name="get_settings_payload",
        )
    # Python：payload 里混进 `**spread`（键不再逐个可见）。
    with pytest.raises(AssertionError, match="含非字符串常量 key"):
        p.parse_py_dict_literal_keys(
            "payload", p.SETTINGS_PY,
            src="def get_settings_payload():\n    payload = {**base, 'a': 1}\n",
            func_name="get_settings_payload",
        )


def test_reverse_canary_catches_shrunken_mirror():
    """canary 下限本身也要有效：镜像缩水到解析器疑似失效的量级时必被拦下。"""
    tiny = "export interface PersistentSettings {\n  dbPath: string | null\n}\n"
    assert p.parse_ts_interface_keys("PersistentSettings", p.SETTINGS_TYPES_TS, src=tiny) == {"dbPath"}
    # …但只有 1 个字段 ⇒ 真实测试里的 `len(...) > 6` canary 会把它拦下（见 _three_sides）。
    assert len(p.parse_ts_interface_keys("PersistentSettings", p.SETTINGS_TYPES_TS, src=tiny)) <= 6
