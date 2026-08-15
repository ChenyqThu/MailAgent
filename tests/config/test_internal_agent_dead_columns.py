"""内建 agent 写面的**死列闸**（task 08-14 R5）。

起因：同一张 `report_agent` 表上，本任务的调研撞到三个「配置面写了、审批卡弹了、行为一个字节
不变」的死键——

  1. `preprocess.prompt`  —— v1.1.0 起 persona 层移除，运行时「一律忽略」。
  2. `preprocess.enabled` —— 运行时读配置的 SELECT 压根不含该列；真开关是 env
     `LLM_AGENT_ENABLED`（设置页那个开关绑的就是它）。
  3. `report` 顶层 `cadence` —— 新形状下 `cadence_of` 以 `rule.freq` 为权威，顶层是降级镜像。

三个都是靠人肉 grep 消费点才发现的。死键比有风险更糟：它不会报错，只会让 owner 以为自己改了
某个纹丝不动的东西。本模块把「白名单里的字段必须指向真实消费点」变成红测试。

分两档（PRD R5）：
  · **硬闸** —— preprocess 的有效字段直接从运行时那条 SELECT 语句抽，与 TS 白名单对账。
  · **软闸** —— 其余各支：字段 → 消费点声明表，断言该消费点确实读了那一列。

🔴 抽取失败必须红（不是跳过）：抽不到比抽错更容易被忽略，而「部分抽取」是本仓踩过的坑。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
INTERNAL_AGENTS_TS = ROOT / "frontend/src/ai-gateway/tools/internal_agents.ts"
PREPROCESS_CONFIG_PY = ROOT / "src/llm_agent/preprocess_config.py"


def _balanced_object(source: str, open_index: int) -> str:
    """从 `source[open_index] == '{'` 起按大括号配平取出整个对象字面量。"""
    assert source[open_index] == "{", "配平起点必须是 '{'"
    depth = 0
    for index in range(open_index, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_index : index + 1]
    raise AssertionError("大括号不配平——抽取器读到了文件尾")


def branch_fields(source: str, type_literal: str) -> set[str]:
    """抽 `internalAgentUpdateSchema` 里某一支的顶层字段名。

    判据 = `type: z.literal('<x>')` 所在的那个 `z.object({...})`。找不到即抛（红），
    绝不返回空集合——空集合会让下面每一条断言都「通过」。
    """
    marker = f"type: z.literal('{type_literal}')"
    position = source.find(marker)
    assert position != -1, f"抽取失败：找不到 {marker}（schema 形状变了？）"
    open_index = source.rindex("{", 0, position)
    body = _balanced_object(source, open_index)
    # 顶层键 = 配平深度为 1 处的 `name:`。用逐字符扫描而不是正则，避免嵌套对象里的键混进来。
    fields: set[str] = set()
    depth = 0
    token = ""
    for index, char in enumerate(body):
        if char == "{":
            depth += 1
            token = ""
            continue
        if char == "}":
            depth -= 1
            token = ""
            continue
        if depth == 1:
            if char == ":" and token.strip():
                name = token.strip().split()[-1]
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    fields.add(name)
                token = ""
            elif char in ",\n":
                token = ""
            else:
                token += char
    fields.discard("type")
    return fields


def preprocess_runtime_columns() -> set[str]:
    """运行时真正读的列 = `get_preprocess_config` 那条 SELECT 的列名。"""
    source = PREPROCESS_CONFIG_PY.read_text(encoding="utf-8")
    match = re.search(r'"SELECT (?P<cols>.+?)"\s*\n?\s*"?\s*FROM report_agent', source, re.S)
    assert match, "抽取失败：找不到 get_preprocess_config 的 SELECT（实现改写法了？）"
    raw = match.group("cols").replace('"', " ").replace("\n", " ")
    return {part.strip() for part in raw.split(",") if part.strip()}


# ── 抽取器自检（闸自己得先被证明抓得到东西）──────────────────────────────────────


def test_the_extractor_actually_sees_a_planted_dead_key():
    """🔴 若把 `prompt` 加回 preprocess 支，闸必须抓到 —— 否则它只是块绿色的装饰。"""
    synthetic = """
      z
        .object({
          type: z.literal('preprocess'),
          agent_id: agentIdField,
          prompt: promptField,
          context_docs: docsField
        })
        .strict(),
    """
    assert branch_fields(synthetic, "preprocess") == {"agent_id", "prompt", "context_docs"}


def test_the_extractor_fails_loudly_when_the_branch_is_gone():
    with pytest.raises(AssertionError, match="抽取失败"):
        branch_fields("const x = 1", "preprocess")


# ── 硬闸：preprocess ────────────────────────────────────────────────────────────


def test_preprocess_writable_fields_are_exactly_the_columns_the_runtime_reads():
    """preprocess 支的可写字段 ⊆ 运行时 SELECT 的列（外加纯展示的 title）。"""
    source = INTERNAL_AGENTS_TS.read_text(encoding="utf-8")
    fields = branch_fields(source, "preprocess") - {"agent_id"}
    columns = preprocess_runtime_columns()
    # wire 的 friendly 名 → DB 列名（wire.py 的 config_patch_to_db 负责这层改名）。
    aliases = {"context_docs": "context_docs_json", "fallback_models": "fallback_models_json"}
    unbacked = {
        field
        for field in fields
        if field != "title" and aliases.get(field, field) not in columns
    }
    assert not unbacked, (
        f"preprocess 支有无人消费的字段：{sorted(unbacked)}。"
        f"运行时只读这些列：{sorted(columns)}（src/llm_agent/preprocess_config.py）。"
        "写面里出现别的字段 = 改了不生效的死键。"
    )


@pytest.mark.parametrize("dead_key", ["prompt", "enabled"])
def test_preprocess_dead_keys_are_absent_from_both_sides(dead_key: str):
    """两个死键：运行时不读，写面也不许给。"""
    assert dead_key not in preprocess_runtime_columns(), (
        f"preprocess 运行时开始读 {dead_key} 了？那它不再是死列，请更新本闸与工具白名单。"
    )
    fields = branch_fields(INTERNAL_AGENTS_TS.read_text(encoding="utf-8"), "preprocess")
    assert dead_key not in fields, (
        f"preprocess 支不许出现 {dead_key}："
        + (
            "persona 层 v1.1.0 已移除，该列运行时被忽略"
            if dead_key == "prompt"
            else "真开关是 env LLM_AGENT_ENABLED，行里的 enabled 无人读"
        )
    )


# ── 软闸：其余三支 ──────────────────────────────────────────────────────────────

#: 字段 → (消费点文件, 该文件里必须出现的判据)。加字段而不登记消费点 = 红。
#:
#: 🔴 `report.kos_enrich` 有意**不在**表里：本闸第一次跑就是被它拦下的 —— 全仓只有存取链
#: （wire 读写 / store 列 / ConfigDrawer 开关），报告生成流程里没有任何一处读它改变行为。
#: 它是本任务发现的第四个死键（前三个靠人肉 grep，这个是机器抓的），故不进模型写面。
#: 若将来有人给它接上真实消费端，连同这行注释一起登记回来。
FIELD_CONSUMERS: dict[str, dict[str, tuple[str, str]]] = {
    "report": {
        "title": ("src/reports/wire.py", "title"),
        "enabled": ("src/reports/worker.py", "enabled"),
        "model": ("src/reports/worker.py", 'agent.get("model")'),
        "prompt": ("src/reports/worker.py", 'persona_prompt=agent.get("prompt")'),
        "schedule": ("src/reports/store.py", "schedule_json"),
        "window_hours": ("src/reports/worker.py", "window_hours"),
        "trigger_mode": ("src/reports/worker.py", "trigger_mode"),
        "body_full_priorities": ("src/reports/worker.py", "body_full_priorities"),
        "context_docs": ("src/reports/worker.py", "context_docs"),
    },
    "search": {
        "title": ("src/reports/wire.py", "title"),
        "enabled": (
            "frontend/src/shared/assistant/searchAgentClient.ts",
            "a.type === 'search' && a.enabled",
        ),
        "model": ("frontend/src/shared/assistant/searchAgentClient.ts", "model"),
        "prompt": ("frontend/src/shared/assistant/searchAgentClient.ts", "prompt"),
    },
    "project_progress": {
        "title": ("src/reports/wire.py", "title"),
        "enabled": ("src/mail/new_watcher.py", "project_progress"),
        "email_filter": ("src/agents/trigger.py", "email_filter"),
    },
}


@pytest.mark.parametrize("branch", sorted(FIELD_CONSUMERS))
def test_every_writable_field_points_at_a_real_consumer(branch: str):
    source = INTERNAL_AGENTS_TS.read_text(encoding="utf-8")
    fields = branch_fields(source, branch) - {"agent_id"}
    declared = FIELD_CONSUMERS[branch]
    undeclared = fields - set(declared)
    assert not undeclared, (
        f"{branch} 支新增了未登记消费点的字段：{sorted(undeclared)}。"
        "先确认它真有运行时消费者（别再造第四个死键），然后在 FIELD_CONSUMERS 里登记。"
    )
    for field in sorted(fields):
        path, needle = declared[field]
        text = (ROOT / path).read_text(encoding="utf-8")
        assert needle in text, (
            f"{branch}.{field} 声明的消费点 {path} 里找不到判据 {needle!r} —— "
            "要么消费点搬了（更新本表），要么这个字段已经变成死键。"
        )
