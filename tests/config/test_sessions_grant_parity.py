"""``grant_sessions`` 两态值域（own / all）的**跨语言一致性闸**（task 09-02 会话读取分档）。

Python 权威 `src/agents/trigger.py::_SESSIONS_GRANT_VALUES`（保存闸：值域外入库即拒）之外，
TS 侧有五份手抄副本，且都是**编译期类型 / zod / 字面量数组**，没有可 import 的运行时值：

- `frontend/src/ai-gateway/tools/policy.ts::SessionsGrant`（gateway 类型联合 + parseSessionsGrant）
- `frontend/src/shared/lib/customAgentCapabilities.ts::CUSTOM_AGENT_CAPABILITY_TIERS.sessions`
  （能力卡档位 —— 设置面按它渲染按钮）
- `frontend/src/ai-gateway/tools/schemas.ts::customAgentSessionsCapabilitySchema`（模型入参 zod）
- `frontend/src/shared/api/types/report.ts::CustomAgentToolPolicy.grant_sessions`（REST wire）
- `frontend/src/shared/api/types/chat.ts::AgentRunSpec.toolPolicy.grantSessions`（spec wire，
  **仅非默认值投影** ⇒ 值域 = 权威去掉首位默认 own，镜像 grantWeb 只投 gated/open）

漂了会怎样：TS 多一档 = 设置面/模型能提出一个 Python 400 的档位（owner 批过一次不存在的授权）；
Python 多一档 = 服务端能存一个 gateway `parseSessionsGrant` 永远塌成 own 的值（授了等于没授，
且没有任何报错指向真因）。抽取器沿用 test_connector_contract_parity 的（锚点抓不到即红，
不返回空集）。
"""

from __future__ import annotations

import pytest

from tests.config import _parsers as p
from tests.config.test_connector_contract_parity import (
    CHAT_TYPES_TS,
    POLICY_TS,
    REPORT_TYPES_TS,
    SCHEMAS_TS,
    TRIGGER_PY,
    py_str_tuple,
    ts_string_union,
    ts_zod_enum,
)

CAPABILITIES_TS = p.REPO_ROOT / "frontend" / "src" / "shared" / "lib" / "customAgentCapabilities.ts"

_SITES = {
    "py:trigger._SESSIONS_GRANT_VALUES": lambda: py_str_tuple(
        TRIGGER_PY, "_SESSIONS_GRANT_VALUES"
    ),
    "ts:policy.SessionsGrant": lambda: ts_string_union(
        POLICY_TS, "export type SessionsGrant ="
    ),
    "ts:customAgentCapabilities.TIERS.sessions": lambda: ts_string_union(
        CAPABILITIES_TS, "  sessions: ["
    ),
    "ts:schemas.customAgentSessionsCapabilitySchema": lambda: ts_zod_enum(
        SCHEMAS_TS, "const customAgentSessionsCapabilitySchema"
    ),
    "ts:report.CustomAgentToolPolicy.grant_sessions": lambda: ts_string_union(
        REPORT_TYPES_TS, "grant_sessions?:"
    ),
}


def test_sessions_grant_vocabulary_is_identical_and_ordered_across_all_sites():
    """权威 = (own, all)，首位 own 是缺省（parse_tool_policy / parseSessionsGrant 的塌落值）；
    五处副本逐项且有序一致（序 = 能力卡按钮顺序 = 弱→强）。"""
    extracted = {name: fn() for name, fn in _SITES.items()}
    canonical = extracted["py:trigger._SESSIONS_GRANT_VALUES"]
    assert canonical == ("own", "all"), (
        f"保存闸的值域变成 {canonical!r} —— 这是会话读取半径语义本体的改动，改它必须同时改"
        f"另外五处 + §13.24.2"
    )
    for name, values in extracted.items():
        assert values == canonical, (
            f"{name} = {values!r} 与保存闸权威 {canonical!r} 不一致 —— 设置面/模型会提出一个"
            f"服务端 400 的档位，或服务端存下一个 gateway 永远塌成 own 的值"
        )


def test_spec_wire_projects_exactly_the_non_default_values():
    """spec wire（AgentRunSpec.toolPolicy.grantSessions）只投非默认值：= 权威去掉首位 own。"""
    canonical = py_str_tuple(TRIGGER_PY, "_SESSIONS_GRANT_VALUES")
    wire = ts_string_union(CHAT_TYPES_TS, "grantSessions?:")
    assert wire == canonical[1:], (
        f"spec wire 值域 {wire!r} ≠ 权威非默认部分 {canonical[1:]!r} —— agent_runs.py 只在"
        f"grant_sessions == 'all' 时投影，两边必须同批改"
    )


def test_reverse_gate_extractors_fail_loud_not_empty():
    """抽取器失效必须红：锚点缺失 / 空集合都不能退化成「无对象可比 = 平凡绿」。"""
    with pytest.raises(AssertionError):
        py_str_tuple(TRIGGER_PY, "_SESSIONS_GRANT_VALUES", src="X = 1\n")
    with pytest.raises(AssertionError):
        ts_string_union(POLICY_TS, "export type SessionsGrant =", src="const x = 1\n")
    with pytest.raises(AssertionError):
        ts_string_union(CAPABILITIES_TS, "  sessions: [", src="  sessions: [],\n")
    with pytest.raises(AssertionError):
        ts_zod_enum(
            SCHEMAS_TS,
            "const customAgentSessionsCapabilitySchema",
            src="const customAgentSessionsCapabilitySchema = z.union([z.literal('own')])\n",
        )
