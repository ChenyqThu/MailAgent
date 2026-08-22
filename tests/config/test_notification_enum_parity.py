"""通知中心枚举的**跨语言一致性闸**（task 08-20-notification-center 步骤 7）。

canonical = ``src/notify/center_models.py``（零依赖叶子模块；``notification`` 表的 CHECK
值域经 ``sql_check_clause`` 引用它，Python 侧零手抄）＋ ``src/notify/center.py`` 的
``_LIST_STATE_VALUES``（列表查询参数的值域，含聚合档 ``all`` —— 它不是行状态，故不在
center_models 里，两者没有共同上游可下沉）。
TS 手抄 = ``frontend/src/shared/api/types/notifications.ts``（renderer 无法 import Python，
运行时值集只能自带一份 —— 消灭不了镜像，故建闸）。

漂了会怎样：TS 侧多一档 → 前端能选、请求却 400 ``E_INVALID_ARG``；TS 侧少一档 → 服务端
真给那个值时前端类型收窄不到它（图标/色调/文案投影落空，条目渲染成裸态）。

🔴 抽取失败必须**红**：抓不到锚点 / 声明改形 → AssertionError，不许退化成「没东西可比 =
平凡绿」；末尾 canary 用合成源码证明闸真会红。抽取器直接复用
``test_contact_enum_parity.py`` 的两个（同一对 Python/TS 形状，不再抄第二份）。
"""

from __future__ import annotations

import pytest

from . import _parsers as p
from .test_contact_enum_parity import py_str_tuple, ts_array_literals

CENTER_MODELS_PY = p.REPO_ROOT / "src" / "notify" / "center_models.py"
CENTER_PY = p.REPO_ROOT / "src" / "notify" / "center.py"
NOTIFICATIONS_TS = (
    p.REPO_ROOT / "frontend" / "src" / "shared" / "api" / "types" / "notifications.ts"
)

#: canonical 常量名（两侧同名，方便 grep）。
PAIRS = (
    "NOTIFICATION_CATEGORY_VALUES",
    "NOTIFICATION_STATE_VALUES",
    "NOTIFICATION_SEVERITY_VALUES",
)


@pytest.mark.parametrize("name", PAIRS)
def test_notification_vocabulary_identical_across_languages(name):
    canonical = py_str_tuple(CENTER_MODELS_PY, name)
    ts = ts_array_literals(NOTIFICATIONS_TS, name)
    assert ts == canonical, (
        f"{name}: TS 手抄 {ts!r} 与 center_models.py canonical {canonical!r} 不一致 —— "
        f"改值域必须两侧同步（TS 多一档 = 前端能发、服务端 CHECK/校验 400；少一档 = "
        f"服务端真存的值在前端投影里没有落点）"
    )


def test_list_state_vocabulary_identical_across_languages():
    """``GET /notifications?state=`` 的值域轴。canonical 在 center.py（是查询参数的
    值域，不是行状态）—— TS 侧多一档 = 过滤能选却恒 400；少一档 = 服务端支持的档位
    前端调不到。"""
    canonical = py_str_tuple(CENTER_PY, "_LIST_STATE_VALUES")
    ts = ts_array_literals(NOTIFICATIONS_TS, "NOTIFICATION_LIST_STATE_VALUES")
    assert ts == canonical, (
        f"list state 轴: TS 手抄 {ts!r} 与 center.py canonical {canonical!r} 不一致"
    )


# ── canary：抽取器失效必须红 ───────────────────────────────────────────────────


def test_extraction_failure_is_red_not_silently_green():
    with pytest.raises(AssertionError, match="找不到顶层常量"):
        py_str_tuple(CENTER_MODELS_PY, "NOTIFICATION_CATEGORY_VALUES", src="X = 1\n")
    with pytest.raises(AssertionError, match="非字符串字面量"):
        py_str_tuple(
            CENTER_MODELS_PY,
            "NOTIFICATION_CATEGORY_VALUES",
            src="NOTIFICATION_CATEGORY_VALUES = ('system', X)\n",
        )
    with pytest.raises(AssertionError, match="找不到"):
        ts_array_literals(
            NOTIFICATIONS_TS, "NOTIFICATION_CATEGORY_VALUES", src="const x = 1\n"
        )
    with pytest.raises(AssertionError, match="抽不到任何字符串字面量"):
        ts_array_literals(
            NOTIFICATIONS_TS,
            "NOTIFICATION_CATEGORY_VALUES",
            src="export const NOTIFICATION_CATEGORY_VALUES = [] as const\n",
        )
    with pytest.raises(AssertionError, match="数组字面量"):
        ts_array_literals(
            NOTIFICATIONS_TS,
            "NOTIFICATION_CATEGORY_VALUES",
            src="export const NOTIFICATION_CATEGORY_VALUES = makeValues()\n",
        )
