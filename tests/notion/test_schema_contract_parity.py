"""闸 — Notion 两库 schema 契约 JSON ↔ 写入侧 property 名对账（task 08-20）。

单源 = ``frontend/src/shared/lib/notionDbSchema.contract.json``（Notion OAuth 库发现 /
选择器校验的唯一机器可读权威；TS 侧 ``notionDbSchema.ts`` 运行时直接 import 它）。
🔴 契约内容以**写入侧代码**为准，不以 CLAUDE.md 的表为准（2026-08-20 实勘：表里的
``AI Priority`` / ``AI Review Status`` / ``AI Action`` 是旧名，代码真名是 ``Priority`` /
``Processing Status`` / ``Action Type``）。

对账语义（两档）：

  * **required 档**（缺失即校验不过）= 默认同步路径会写的字段：
    ``src/notion/pages.py::_build_properties``（dict 字面量键 + ``properties["X"] =``
    条件赋值）∪ ``src/notion/threads.py`` 线程关联写入（Parent Item / Sub-item）。
    → 与契约 email required 名集合**双向相等**。
  * **recommended 档**（缺失只 warn 不拦）= 仅可选功能写的字段
    （``src/llm_agent/notion_writer.py::_build_props``）→ 契约每个名字须在写入器里
    以字面量出现（改名即红）。
  * **calendar required** = ``src/calendar_notion/sync.py::_build_properties`` 写入集
    → 契约每个名字须在该函数体里以字面量出现。

漂移的后果：写入侧改名/加字段而契约不动 → OAuth 模板 / 选择器按旧契约校验通过，
但 sync 首封写入被 Notion 400（"X is not a property that exists"）；反向同理。

🔴 抽取失败必须红：函数体找不到 / 抽取数量低于下限（部分抽取比抽不到更毒）都直接
AssertionError，绝不静默返回空集（空集 ⊆ 任何集合恒真 = 假绿）。
"""

import json
import re
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CONTRACT_PATH = (
    _REPO_ROOT / "frontend" / "src" / "shared" / "lib" / "notionDbSchema.contract.json"
)
_PAGES_PY_PATH = _REPO_ROOT / "src" / "notion" / "pages.py"
_THREADS_PY_PATH = _REPO_ROOT / "src" / "notion" / "threads.py"
_CAL_SYNC_PATH = _REPO_ROOT / "src" / "calendar_notion" / "sync.py"
_LLM_WRITER_PATH = _REPO_ROOT / "src" / "llm_agent" / "notion_writer.py"

# 抽取 canary 下限（现值：pages 12+3=15、threads 2、calendar 18、recommended 13；
# 低于下限 = 抽取器疑似失效 —— 部分抽取比抽不到更毒）。
_MIN_DICT_KEYS = 10
_MIN_ASSIGN_KEYS = 3
_MIN_PAGES_TOTAL = 12
_MIN_REQUIRED_TOTAL = 15
_MIN_RECOMMENDED_TOTAL = 8
_MIN_CALENDAR_TOTAL = 15

_DICT_KEY_RE = re.compile(r'"([A-Z][A-Za-z0-9 ]*)"\s*:\s*\{')
_ASSIGN_KEY_RE = re.compile(r'properties\["([A-Za-z0-9 ]+)"\]\s*=')
_THREADS_PROP_RE = re.compile(r'properties=\{"([A-Za-z0-9 -]+)"\s*:')


def _load_contract() -> Dict:
    contract = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    assert "databases" in contract and "email" in contract["databases"], (
        f"{_CONTRACT_PATH} 结构不对：缺 databases.email —— 契约被改形，先修 TS 侧再来"
    )
    return contract


def _contract_props(role: str, tier: str = "requiredProperties") -> List[Dict]:
    props = _load_contract()["databases"][role][tier]
    assert isinstance(props, list), f"契约 {role}.{tier} 非列表"
    return props


def _contract_email_required() -> Set[str]:
    names = {p["name"] for p in _contract_props("email")}
    assert len(names) >= _MIN_REQUIRED_TOTAL, (
        f"契约 email required 只有 {len(names)} 个字段（预期 ≥{_MIN_REQUIRED_TOTAL}）"
        "—— 契约被大改，先确认写入侧再来"
    )
    return names


def _slice_function(src: str, needle: str, path_label: str) -> str:
    """截出方法体（从 ``def <name>(`` 到下一个同缩进 ``def``）。找不到必红。"""
    start = src.find(needle)
    assert start != -1, (
        f"{path_label} 里没找到 `{needle}` —— 函数被改名/搬家了，"
        "本闸的抽取器需要跟着改（别让它静默返回空集）"
    )
    end = src.find("\n    def ", start)
    if end == -1:
        end = len(src)
    return src[start:end]


def _extract_pages_property_names(src: Optional[str] = None) -> Set[str]:
    """从 pages.py ``_build_properties`` 抽取写入的 property 名（抽取失败必须红）。"""
    if src is None:
        src = _PAGES_PY_PATH.read_text(encoding="utf-8")
    body = _slice_function(src, "def _build_properties(", "src/notion/pages.py")

    dict_keys = _DICT_KEY_RE.findall(body)
    assign_keys = _ASSIGN_KEY_RE.findall(body)
    assert len(dict_keys) >= _MIN_DICT_KEYS, (
        f"_build_properties 的 dict 字面量键只抽到 {len(dict_keys)} 个"
        f"（预期 ≥{_MIN_DICT_KEYS}）—— 正则或代码形态变了"
    )
    assert len(assign_keys) >= _MIN_ASSIGN_KEYS, (
        f"_build_properties 的 properties[...] 赋值键只抽到 {len(assign_keys)} 个"
        f"（预期 ≥{_MIN_ASSIGN_KEYS}）—— 正则或代码形态变了"
    )
    names = set(dict_keys) | set(assign_keys)
    assert len(names) >= _MIN_PAGES_TOTAL, (
        f"_build_properties 总共只抽到 {len(names)} 个 property 名（预期 ≥{_MIN_PAGES_TOTAL}）"
    )
    return names


def _extract_threads_property_names(src: Optional[str] = None) -> Set[str]:
    """从 threads.py 抽取线程关联写入的 property 名（Parent Item / Sub-item）。"""
    if src is None:
        src = _THREADS_PY_PATH.read_text(encoding="utf-8")
    names = set(_THREADS_PROP_RE.findall(src))
    assert len(names) >= 2, (
        f"threads.py 的 properties={{...}} 写入只抽到 {sorted(names)}"
        "（预期 ≥2：Parent Item + Sub-item）—— 正则或代码形态变了"
    )
    return names


def _write_side_email_names() -> Set[str]:
    return _extract_pages_property_names() | _extract_threads_property_names()


def _drift(contract_names: Set[str], extracted: Set[str]) -> Tuple[List[str], List[str]]:
    """两侧独有的名字。真实断言与反向用例共用同一判定。"""
    return sorted(contract_names - extracted), sorted(extracted - contract_names)


def test_email_required_matches_write_side():
    """契约 email required 名集 == pages.py ∪ threads.py 写入集（双向相等，无 baseline）。"""
    contract_names = _contract_email_required()
    extracted = _write_side_email_names()

    contract_only, code_only = _drift(contract_names, extracted)
    assert not (contract_only or code_only), (
        "契约 JSON 与写入侧（pages.py::_build_properties + threads.py）漂移了：\n"
        f"  只在契约（代码不再写 → 契约/模板里是死字段或改名漏改）：{contract_only}\n"
        f"  只在代码（写入了契约没有的字段 → 按契约建的模板库会被 Notion 400）：{code_only}\n"
        "→ 改写入侧字段名必须同步 frontend/src/shared/lib/notionDbSchema.contract.json"
        "（并让模板跟上）；反之亦然。"
    )


def test_email_recommended_names_exist_in_llm_writer():
    """契约 recommended 档每个名字须在 llm_agent/notion_writer.py::_build_props 以字面量出现。

    recommended = 仅 LLM 可选功能写的字段（Priority / Action Type / AI Summary ...）。
    改名漏改契约 → 模板里是旧名字段，LLM 标注写入静默 400。
    """
    recommended = [p["name"] for p in _contract_props("email", "recommendedProperties")]
    assert len(recommended) >= _MIN_RECOMMENDED_TOTAL, (
        f"契约 email recommended 只有 {len(recommended)} 个（预期 ≥{_MIN_RECOMMENDED_TOTAL}）"
    )
    body = _slice_function(
        _LLM_WRITER_PATH.read_text(encoding="utf-8"), "def _build_props(", "notion_writer.py"
    )
    missing = [name for name in recommended if f'"{name}"' not in body]
    assert not missing, (
        f"契约 recommended 档这些名字在 notion_writer.py::_build_props 里找不到：{missing}\n"
        "→ 要么写入器改名了（同步契约），要么契约录错了名字。"
    )


def test_calendar_required_names_exist_in_calendar_sync():
    """契约 calendar required 每个名字须在 calendar_notion/sync.py::_build_properties 出现。

    calendar 的默认同步路径写入器是它（含中文 select 字段 会议状态 / 日程类型 ——
    这也是「以写入侧代码为准」的直接证据：CLAUDE.md 旧表里的 `Status` 无人写入）。
    """
    required = [p["name"] for p in _contract_props("calendar")]
    assert len(required) >= _MIN_CALENDAR_TOTAL, (
        f"契约 calendar required 只有 {len(required)} 个（预期 ≥{_MIN_CALENDAR_TOTAL}）"
    )
    body = _slice_function(
        _CAL_SYNC_PATH.read_text(encoding="utf-8"), "def _build_properties(", "calendar_notion/sync.py"
    )
    missing = [name for name in required if f'"{name}"' not in body]
    assert not missing, (
        f"契约 calendar required 这些名字在 calendar_notion/sync.py::_build_properties "
        f"里找不到：{missing}\n→ 写入器改名须同步契约；契约多录了字段则删掉。"
    )


def test_signature_fields_pinned():
    """签名判据钉死（design.md：邮件库 = Subject(title)+Message ID；日历库 = Event ID+Time(date)）。

    单独钉一条是防「谁把签名标记挪到别的字段上」—— 上面的 parity 测试对此恒绿。
    """
    email_sig = {p["name"]: p["type"] for p in _contract_props("email") if p.get("signature")}
    assert email_sig == {"Subject": "title", "Message ID": "rich_text"}, (
        f"邮件库签名字段漂移：{email_sig}（应为 Subject(title) + Message ID(rich_text)）"
    )
    cal_sig = {p["name"]: p["type"] for p in _contract_props("calendar") if p.get("signature")}
    assert cal_sig == {"Event ID": "rich_text", "Time": "date"}, (
        f"日历库签名字段漂移：{cal_sig}（应为 Event ID(rich_text) + Time(date)）"
    )


# =============================================================================
# 反向用例 —— 证明这道闸真会红, 而不是恒绿的摆设
# =============================================================================


def test_reverse_gate_catches_injected_drift():
    """故意制造违规：把真实源码里的 `Message ID` 改名 → 判定必须报出漂移。

    用的是 `_drift` —— 与真实断言同一个判定函数，不是另写一份等价逻辑。
    """
    contract_names = _contract_email_required()
    real_src = _PAGES_PY_PATH.read_text(encoding="utf-8")
    mutated = real_src.replace('"Message ID": {', '"MessageId Renamed": {')
    assert mutated != real_src, "注入失败：pages.py 里找不到 `\"Message ID\": {` 了"

    extracted = _extract_pages_property_names(src=mutated) | _extract_threads_property_names()
    contract_only, code_only = _drift(contract_names, extracted)
    assert "Message ID" in contract_only, "改名后闸没报出契约侧失配 —— 判定失效"
    assert "MessageId Renamed" in code_only, "改名后闸没报出代码侧新名 —— 判定失效"


def test_reverse_extraction_failure_is_loud_not_empty():
    """🔴「抽取失败必须红」：函数缺失 / 形态大改时抛错，绝不静默返回空集。"""
    # 函数被改名/删除。
    with pytest.raises(AssertionError, match="没找到"):
        _extract_pages_property_names(
            src="class NotionPages:\n    def other(self):\n        pass\n"
        )
    # 函数还在但抽不出足量键（写法整体换形态 → 部分抽取 canary 拦下）。
    hollow = (
        "class NotionPages:\n"
        "    def _build_properties(self, email):\n"
        '        return {"Subject": {"title": []}}\n'
        "\n"
        "    def other(self):\n"
        "        pass\n"
    )
    with pytest.raises(AssertionError, match="只抽到"):
        _extract_pages_property_names(src=hollow)
    # threads.py 侧同理。
    with pytest.raises(AssertionError, match="只抽到"):
        _extract_threads_property_names(src="async def update_thread(): pass\n")
