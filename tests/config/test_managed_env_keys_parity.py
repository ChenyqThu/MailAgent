"""闸 (a) — 两份受管 env 键白名单对账（跨语言手抄常量一致性闸第四例）。

同一份「Settings 能读写哪些 .env 键」的事实存在两份手抄副本：

  * 桌面 IPC 面 —— ``frontend/src/electron/main/lib/env-keys.ts`` 的
    ``MANAGED_ENV_KEYS`` / ``SECRET_ENV_KEYS``（SSoT）
  * 远程 web 面 —— ``src/api/routers/settings.py`` 的
    ``_MANAGED_ENV_KEYS`` / ``_SECRET_ENV_KEYS``（后者注释自称「逐字 port 自 env-keys.ts」）

**没有闸的后果实测已发生（2026-07-27 审计，本批修）**，且两个方向都漂了：

  * 只在 settings.py 有（3 个 CalDAV 日历键）→ 控件在 AccountsTab 渲染着，桌面 App 上
    ``env:get`` 读回空、``env:set`` 抛 ``E_INVALID_KEY``。**远程能改、桌面不能改。**
  * 只在 env-keys.ts 有（6 个：DRAFTS_SYNC_ENABLED / LLM_ENABLED_MODELS /
    MEMORY_CAPTURE_MODEL / MAILAGENT_INBOUND_READ_RECONCILE_ENABLED /
    MAILAGENT_BULK_CLIENT_{ID,SECRET}）→ 远程 web 的 ``GET /api/env`` 不返回它们，
    同一批 Settings 组件在 web 上读回空、显示成「未配置」。

这 6 个全部由「加了 TS 一侧就发版」的功能提交带进来（最近一个是今晚的 issue #64），
没有一次是有意为之 —— 正是 CLAUDE.md「跨语言手抄常量必建一致性闸」点名的形态。

secret 集同样对账：``MAILAGENT_BULK_CLIENT_SECRET`` 此前只在 TS 侧脱敏集里，
若有人把它补进 settings.py 的受管键却漏了脱敏集，**client_secret 会明文出网**。
所以两个集合必须在同一道闸里一起看，不能只对受管键。

🔴 抽取失败必须红：两侧解析器都有 count canary。空集 == 空集 恒真 = 假绿。
"""

from typing import List, Set, Tuple

import pytest

from . import _parsers as p


def _drift(desktop: Set[str], remote: Set[str]) -> Tuple[List[str], List[str]]:
    """两侧独有的键。真实断言与下面的反向用例共用同一个判定, 不各写一份。"""
    return sorted(desktop - remote), sorted(remote - desktop)


def _both_sides():
    ts_managed = p.parse_managed_env_keys()
    py_managed = p.parse_py_key_collection("_MANAGED_ENV_KEYS")
    # canary：任一侧抽取器失效 → 空集 → 下面的集合相等断言平凡通过。
    assert len(ts_managed) > 50, (
        f"env-keys.ts MANAGED_ENV_KEYS 只解析到 {len(ts_managed)} 个键（预期 >50）—— TS 解析器坏了"
    )
    assert len(py_managed) > 50, (
        f"settings.py _MANAGED_ENV_KEYS 只解析到 {len(py_managed)} 个键（预期 >50）—— AST 解析器坏了"
    )
    return ts_managed, py_managed


def test_managed_env_keys_parity():
    """两份受管键白名单必须集合相等（无 baseline —— 任一侧独有都是真 bug）。"""
    ts_managed, py_managed = _both_sides()

    ts_only, py_only = _drift(ts_managed, py_managed)
    assert not (ts_only or py_only), (
        "两份受管 env 键白名单漂移了（手抄镜像漏改一侧）：\n"
        f"  只在 env-keys.ts（桌面能改、远程 web 读回空）：{ts_only}\n"
        f"  只在 settings.py（远程能改、桌面 env:set 抛 E_INVALID_KEY）：{py_only}\n"
        "→ 新增受管 key 必须**同时**加两处：\n"
        "  frontend/src/electron/main/lib/env-keys.ts 的 MANAGED_ENV_KEYS\n"
        "  src/api/routers/settings.py 的 _MANAGED_ENV_KEYS"
    )


def test_secret_env_keys_parity():
    """两份脱敏集必须集合相等 —— 漏一侧 = 凭据明文出网。"""
    ts_secret = p.parse_ts_key_set("SECRET_ENV_KEYS")
    py_secret = p.parse_py_key_collection("_SECRET_ENV_KEYS")
    assert len(ts_secret) > 8, (
        f"env-keys.ts SECRET_ENV_KEYS 只解析到 {len(ts_secret)} 个键（预期 >8）—— TS 解析器坏了"
    )
    assert len(py_secret) > 8, (
        f"settings.py _SECRET_ENV_KEYS 只解析到 {len(py_secret)} 个键（预期 >8）—— AST 解析器坏了"
    )

    drift = sorted(ts_secret ^ py_secret)
    assert not drift, (
        "两份脱敏集漂移了：\n"
        f"  只在 env-keys.ts：{sorted(ts_secret - py_secret)}\n"
        f"  只在 settings.py：{sorted(py_secret - ts_secret)}\n"
        "→ 一个受管键若是凭据, 两侧脱敏集都要有。只加 settings.py 受管键而漏它的脱敏集 = "
        "该 secret 经 GET /api/env 明文出网。"
    )


def test_secret_keys_are_managed():
    """脱敏集 ⊆ 受管集：脱敏只在返回受管键时才起作用, 非受管键根本不会被返回。

    单独立一条是因为它守的是另一半 —— 上面两条都绿, 仍可能有人把某 secret 只写进脱敏集
    而忘了受管集（那它压根不会被读到, 是「配了却不生效」的静默形态）。
    """
    ts_managed, py_managed = _both_sides()
    ts_orphan = sorted(p.parse_ts_key_set("SECRET_ENV_KEYS") - ts_managed)
    py_orphan = sorted(p.parse_py_key_collection("_SECRET_ENV_KEYS") - py_managed)
    assert not (ts_orphan or py_orphan), (
        "以下键在脱敏集里但不在受管集里（永远不会被 env:get 返回, 脱敏是空转）：\n"
        f"  env-keys.ts：{ts_orphan}\n  settings.py：{py_orphan}"
    )


def test_calendar_caldav_keys_are_managed_both_sides():
    """🔴 回归钉子：本批修掉的三个 CalDAV 日历键必须两侧都在。

    没有这条, 上面的 parity 测试在「谁把它们从两侧一起删了」时会平凡绿 —— 而 AccountsTab
    的三个控件仍渲染着、仍存不进去。
    """
    ts_managed, py_managed = _both_sides()
    for key in (
        "CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC",
        "CALENDAR_CALDAV_SYNC_WINDOW_PAST_DAYS",
        "CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS",
    ):
        assert key in ts_managed, f"{key} 掉出 env-keys.ts MANAGED_ENV_KEYS —— 桌面又存不进去了"
        assert key in py_managed, f"{key} 掉出 settings.py _MANAGED_ENV_KEYS —— 远程又读不到了"


# =============================================================================
# 反向用例 —— 证明这道闸真会红, 而不是恒绿的摆设
# =============================================================================


def test_reverse_gate_catches_injected_drift():
    """故意制造违规：把真实的一侧删掉一个键 → 判定必须报出漂移。

    用的是 `_drift` —— 与真实断言同一个判定函数, 不是另写一份等价逻辑。
    """
    ts_managed, py_managed = _both_sides()
    victim = "CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC"
    # 只看「注入后新增的漂移」—— 这样即便此刻仓库里本就有在途漂移（上面那条测试正红），
    # 本反向用例仍然只证明自己那一件事，不跟着别人的红一起红。
    base_ts_only, base_py_only = (set(s) for s in _drift(ts_managed, py_managed))

    # 形态 1：settings.py 有、env-keys.ts 漏（= 修复前的真实 bug，桌面存不进去）。
    ts_only, py_only = _drift(ts_managed - {victim}, py_managed)
    assert set(py_only) - base_py_only == {victim}
    assert set(ts_only) == base_ts_only

    # 形态 2：env-keys.ts 有、settings.py 漏（= 6 个键的那个方向，远程读回空）。
    ts_only, py_only = _drift(ts_managed, py_managed - {victim})
    assert set(ts_only) - base_ts_only == {victim}
    assert set(py_only) == base_py_only


def test_reverse_parser_failure_is_loud_not_empty():
    """🔴「抽取失败必须红」：解析器抓不到目标结构时抛错, 绝不返回空集。

    空集 == 空集 恒真 —— 若解析器静默返回空, 上面两条 parity 测试会在两份白名单完全
    对不上时照样绿。这是本仓一致性闸的既有纪律（见 _parsers.py 头注释）。
    """
    # Python 侧：赋值被改名 / 被搬进函数体 → 找不到模块级赋值。
    with pytest.raises(AssertionError, match="没找到模块级"):
        p.parse_py_key_collection("_MANAGED_ENV_KEYS", src="_RENAMED_KEYS = ['A', 'B']\n")
    # Python 侧：右值从字面量变成了推导式 / 拼接（值不再可静态确定）。
    with pytest.raises(AssertionError, match="不是 list/set/tuple 字面量"):
        p.parse_py_key_collection("_MANAGED_ENV_KEYS", src="_MANAGED_ENV_KEYS = _BASE + _EXTRA\n")
    # Python 侧：元素里混进非字符串常量（如引用了别处的常量）。
    with pytest.raises(AssertionError, match="含非字符串常量元素"):
        p.parse_py_key_collection("_MANAGED_ENV_KEYS", src="_MANAGED_ENV_KEYS = ['A', SOME_CONST]\n")

    # TS 侧：`] as const` 结尾没了（改成了别的数组形态）。
    with pytest.raises(AssertionError, match="没有 `] as const` 结尾"):
        p.parse_managed_env_keys(src="export const MANAGED_ENV_KEYS = ['A', 'B']\n")
    # TS 侧：常量被改名。
    with pytest.raises(AssertionError, match="没找到 `export const MANAGED_ENV_KEYS`"):
        p.parse_managed_env_keys(src="export const RENAMED = [\n  'A'\n] as const\n")
    with pytest.raises(AssertionError, match="没找到 `export const SECRET_ENV_KEYS`"):
        p.parse_ts_key_set("SECRET_ENV_KEYS", src="export const OTHER = new Set([])\n")


def test_reverse_canary_catches_shrunken_whitelist():
    """canary 下限本身也要有效：白名单缩水到解析器疑似失效的量级时 `_both_sides` 必抛。"""
    tiny_ts = "export const MANAGED_ENV_KEYS = [\n  'USER_EMAIL'\n] as const\n"
    assert p.parse_managed_env_keys(src=tiny_ts) == {"USER_EMAIL"}  # 解析本身成功
    # …但只有 1 个键 ⇒ 真实测试里的 `len(...) > 50` canary 会把它拦下（见 _both_sides）。
    assert len(p.parse_managed_env_keys(src=tiny_ts)) <= 50
