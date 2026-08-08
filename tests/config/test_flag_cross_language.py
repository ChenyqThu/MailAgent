"""T3 — 跨语言同名 flag 映射 + cutover 双侧默认一致（E3 WP1 本套件最高价值项）。

两类事故：
  * 改名/删除漏一侧：同一 flag 被多载体读取（Node envBool + Python _hot_bool / pydantic），
    改一处漏另一处 → 单侧生效割裂。CROSS_LANGUAGE_FLAGS 显式登记每个多载体 flag 的载体源，
    断言 env 键字面量在每个登记源文件里出现。
  * cutover 翻默认漏一侧：6 个 openness flag 的默认值分散在 Node（envBool 默认参数）和
    Python（_hot_bool fallback 字面量 / pydantic Field default）两侧；WP4 翻默认为 true 时
    若只改一侧 → gateway 注册了工具但前端 /chat/config 投影仍 false（或反之）。今天两侧都是
    false → 绿；翻默认漏一侧 → 红。

映射表以盘点文件 `.trellis/tasks/07-06-.../research/flag-inventory.md`「Node main env」节为准。
用正则匹配模式抽取默认值，不硬编码行号。
"""

import pytest

from . import _parsers as p

# 多载体 flag → 各载体源文件（断言 env 键字面量在每个源里出现）。
# lifecycle = Node gateway 读；chat = Python serve-api /chat/config 热读；config = pydantic。
_LIFECYCLE = p.GATEWAY_LIFECYCLE
_CHAT = p.CHAT_PY
_CONFIG = p.CONFIG_PY

CROSS_LANGUAGE_FLAGS = {
    # cutover 6：5 个 openness = Node envBool + Python _hot_bool；CUSTOM_AGENTS = Node + pydantic
    "MAILAGENT_OPENNESS_SESSION_TOOLS": [_LIFECYCLE, _CHAT],
    "MAILAGENT_OPENNESS_CONFIG_TOOLS": [_LIFECYCLE, _CHAT],
    "MAILAGENT_OPENNESS_WEB_TOOLS": [_LIFECYCLE, _CHAT],
    "MAILAGENT_OPENNESS_EXEC_TOOLS": [_LIFECYCLE, _CHAT],
    "MAILAGENT_OPENNESS_SKILL_INSTALL": [_LIFECYCLE, _CHAT],
    "MAILAGENT_CUSTOM_AGENTS_ENABLED": [_LIFECYCLE, _CHAT, _CONFIG],
    # island：pydantic alias 字段 + Node envBool
    "MAILAGENT_ISLAND_AGENT_ENABLED": [_LIFECYCLE, _CONFIG],
    # mem0 对：CAPTURE 只 Node 读、RETRIEVAL 只 Python 读（跨语言拆分，改名易漏另一侧）
    "MAILAGENT_MEM0_CAPTURE": [_LIFECYCLE],
    "MAILAGENT_MEM0_RETRIEVAL": [_CHAT],
    # 记忆分层（阶段 0.5-③ PR-1）：Python pydantic only（capture 引擎 memory_md.py 经 cfg 读）；
    # 登记防改名漏侧，PR-2 真变双载体（读侧/Node）时在此加 _CHAT/_LIFECYCLE
    "MAILAGENT_MEMORY_LAYERS": [_CONFIG],
    # skill 自挂载 kill-switch：Node only
    "MAILAGENT_SKILL_SELF_MOUNT": [_LIFECYCLE],
    # 阶段 0.5 技能名单进 prompt：Node only（Python 恒发 skillCatalog 数据、不读这个 flag ——
    # 登记是防改名漏一侧，不是声明双载体；真变成双载体时在此加 _CHAT/_CONFIG）
    "MAILAGENT_SKILL_CATALOG_PROMPT": [_LIFECYCLE],
    # kos 时间衰减：Node envBool + pydantic alias 双读
    "MAILAGENT_KOS_TIME_DECAY_ENABLED": [_LIFECYCLE, _CONFIG],
    # 写 / 外发 kill-switch：Node only
    "MAILAGENT_AI_SDK_WRITE_TOOLS": [_LIFECYCLE],
    "MAILAGENT_AI_SDK_SEND_TOOL": [_LIFECYCLE],
    "MAILAGENT_CUSTOM_AGENT_CALL": [_LIFECYCLE],
    # standing context：Python env-only 热读
    "MAILAGENT_STANDING_CONTEXT_ENABLED": [_CHAT],
    # MCP connector 总闸（08-01 阶段 1）：Node envBool（gateway 动态工具注入 + manifest 拉取）
    # ＋ pydantic（serve-api /api/connector/* 的 409 门）—— 与 island 同形态的双载体。
    # 🔴 双侧默认必须同为 false（灰度未 cutover）；翻默认时两边一起翻，不然会出现
    # 「gateway 注册了连接器工具但每次调用都 409」或反过来「端点开着却没工具」。
    "MAILAGENT_MCP_CONNECTORS": [_LIFECYCLE, _CONFIG],
    # 飞书 IM 总闸（08-01 阶段 2 PR-1/PR-2）：Node envBool（gateway /api/ai/im-chat 端点注册 +
    # createImSession 接线，PR-1）＋ pydantic（serve-api 侧飞书连接底座 im_feishu_enabled，
    # PR-2 并行 lane）—— 与 MCP_CONNECTORS 同形态的双载体。
    # 🔴 双侧默认必须同为 true（cutover 2026-08-04）；翻默认时两边一起翻，不然会出现
    # 「飞书桥在跑但 gateway 端点 404」或反过来「端点开着却没有桥来调」。
    "MAILAGENT_IM_FEISHU": [_LIFECYCLE, _CONFIG],
    # IM 上网独立开关（grill Q19=A，🔴 不做成 grant）：Node only（gateway ToolSet 的 im_chat
    # venue switch；Python 不读）。登记防改名漏一侧，真变双载体时在此加 _CHAT/_CONFIG。
    "MAILAGENT_IM_WEB_ENABLED": [_LIFECYCLE],
}

# cutover 5 openness flag：Node envBool 默认 vs Python _hot_bool 字面量，须逐字相等。
OPENNESS_CUTOVER_FLAGS = [
    "MAILAGENT_OPENNESS_SESSION_TOOLS",
    "MAILAGENT_OPENNESS_CONFIG_TOOLS",
    "MAILAGENT_OPENNESS_WEB_TOOLS",
    "MAILAGENT_OPENNESS_EXEC_TOOLS",
    "MAILAGENT_OPENNESS_SKILL_INSTALL",
]


def _skip_if_lifecycle_absent():
    if not p.GATEWAY_LIFECYCLE.exists():
        pytest.skip("frontend ai_gateway_lifecycle.ts 缺失（无 frontend checkout）")


def test_cross_language_flag_keys_present():
    """映射表里每个 env 键字面量在其登记的每个载体源文件中出现（防改名/删除漏一侧）。"""
    _skip_if_lifecycle_absent()
    missing = []
    for env_key, sources in CROSS_LANGUAGE_FLAGS.items():
        for src_path in sources:
            if not src_path.exists():
                continue  # 该载体源缺失（如无 frontend）→ 跳过该源，不误报
            text = src_path.read_text(encoding="utf-8")
            if env_key not in text:
                missing.append(f"{env_key} 未在 {src_path.name} 中出现")
    assert not missing, (
        "跨语言 flag 映射表登记的 env 键在其载体源里消失了（改名/删除漏一侧？）：\n"
        + "\n".join(f"  {m}" for m in missing)
        + "\n→ 若确已迁移，同步更新 CROSS_LANGUAGE_FLAGS 映射表。"
    )


def test_cutover_flag_defaults_consistent():
    """cutover 6 flag 的 Node 侧与 Python 侧默认值字面量一致。"""
    _skip_if_lifecycle_absent()
    env_bool = p.parse_env_bool_defaults()
    hot_bool = p.parse_hot_bool_defaults()
    config_fields = p.parse_config_fields()

    # canary：任一解析器失效返回空 dict 会让下面比对平凡通过。
    assert env_bool, "ai_gateway_lifecycle.ts envBool 抽取为空 —— _ENV_BOOL_RE 坏了"
    assert hot_bool, "chat.py _hot_bool 抽取为空 —— _HOT_BOOL_RE 坏了"
    for key in OPENNESS_CUTOVER_FLAGS:
        assert key in env_bool, f"canary miss: {key} 未在 lifecycle envBool 里（映射漂移）"
        assert key in hot_bool, f"canary miss: {key} 未在 chat.py _hot_bool 里（映射漂移）"

    drift = []
    # 5 openness：envBool 默认 vs _hot_bool 字面量
    for key in OPENNESS_CUTOVER_FLAGS:
        node_default = env_bool[key]
        py_default = hot_bool[key]
        if not isinstance(py_default, bool):
            drift.append(
                f"{key}: chat.py _hot_bool fallback 不是字面量 bool（={py_default!r}）—— "
                "openness flag 的 Python 侧默认应是硬字面量 True/False"
            )
        elif node_default != py_default:
            drift.append(
                f"{key}: Node envBool 默认={node_default} 但 Python _hot_bool 字面量={py_default}"
            )

    # CUSTOM_AGENTS：Node envBool vs pydantic Field default（chat.py 投影跟随 pydantic，不单查）
    ca_key = "MAILAGENT_CUSTOM_AGENTS_ENABLED"
    node_ca = env_bool.get(ca_key)
    py_ca = p.config_bool_default("custom_agents_enabled", config_fields)
    assert node_ca is not None, f"canary miss: {ca_key} 未在 lifecycle envBool 里"
    assert py_ca is not None, "canary miss: config.py custom_agents_enabled 默认非 bool 常量"
    if node_ca != py_ca:
        drift.append(
            f"{ca_key}: Node envBool 默认={node_ca} 但 config.py custom_agents_enabled 默认={py_ca}"
        )

    assert not drift, (
        "cutover flag 双侧默认值漂移（翻默认时漏改一侧 → gateway 工具注册与前端投影割裂）：\n"
        + "\n".join(f"  {d}" for d in drift)
        + "\n→ 翻默认必须同改 Node envBool 默认 + Python 侧（openness=_hot_bool 字面量 / "
        "CUSTOM_AGENTS=config.py Field default）。"
    )


# Node envBool ↔ pydantic Field 双载体 flag：两侧默认必须逐字相等，且等于这里登记的期望值。
# 上面那个用例只覆盖 Python 侧载体是 _hot_bool 的 6 个，本用例覆盖「Node + pydantic」这一形态
# —— 少了它，config.ts / ai_gateway_lifecycle.ts 里那句 "both defaults MUST stay true together
# (tests/config/test_flag_cross_language.py)" 是句空话（映射表只断言 env 键**出现**，不看默认值）。
# 🔴 期望值显式登记而不是「两侧相等即可」：cutover 是要人拍板的动作，写死期望值能让「谁把默认
# 悄悄翻了」也变成红，而不只是拦住「只翻一侧」。
NODE_PYDANTIC_DUAL_CARRIER_FLAGS = {
    # env 键 → (pydantic 字段名, 两侧期望默认)
    # MCP connector 总闸：灰度未 cutover（ship-off → dogfood → cutover 另拍）。
    "MAILAGENT_MCP_CONNECTORS": ("mcp_connectors_enabled", False),
    # 飞书 IM 总闸（08-01 阶段 2）：**cutover 2026-08-04**（owner dogfood 通过）。翻默认漏一侧
    # = 「桥在跑但 gateway /api/ai/im-chat 404」或反过来「端点开着却没有桥来调」。
    "MAILAGENT_IM_FEISHU": ("im_feishu_enabled", True),
}


def test_dual_carrier_node_pydantic_defaults_match_expected():
    """双载体（Node envBool + pydantic）flag：两侧默认相等且等于登记的期望值。"""
    _skip_if_lifecycle_absent()
    env_bool = p.parse_env_bool_defaults()
    config_fields = p.parse_config_fields()
    assert env_bool, "ai_gateway_lifecycle.ts envBool 抽取为空 —— _ENV_BOOL_RE 坏了"

    drift = []
    for env_key, (field_name, expected) in NODE_PYDANTIC_DUAL_CARRIER_FLAGS.items():
        node_default = env_bool.get(env_key)
        py_default = p.config_bool_default(field_name, config_fields)
        # canary：任一侧抽不到就是漂移/解析器失效，绝不静默跳过
        assert node_default is not None, f"canary miss: {env_key} 未在 lifecycle envBool 里"
        assert py_default is not None, (
            f"canary miss: config.py {field_name} 默认不是 bool 常量（改名了？漏 "
            f"validation_alias={env_key}？）"
        )
        if node_default is not expected or py_default is not expected:
            drift.append(
                f"{env_key}: Node envBool 默认={node_default} / config.py {field_name} "
                f"默认={py_default} —— 两侧都应是 {expected}"
            )

    assert not drift, (
        "双载体 flag 的两侧默认值不一致（或与登记的期望值不符）：\n"
        + "\n".join(f"  {d}" for d in drift)
        + "\n→ cutover（翻 true）就两侧一起翻，并同步改 NODE_PYDANTIC_DUAL_CARRIER_FLAGS 的"
        "期望值；只翻一侧会让 gateway 与 serve-api 割裂。"
    )
