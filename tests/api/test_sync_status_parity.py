"""``sync_status`` 值域的**契约 ↔ 实现一致性闸**（issue #68）。

`sync_status` 在两种**不同性质**的构件里声明，消灭不掉其一：
- ``docs/cli-schema/_common.schema.json#/$defs/sync_status`` —— **wire 契约**，前端
  `cli.gen.ts` 由它 codegen、web 侧 ajv conformance 测试拿它当判据；
- ``src/api/schemas/email.SyncStatus`` —— 运行期 Python Literal，pydantic 响应模型
  与（issue #68 起）CLI/serve-api 的 ``--status`` / ``?status=`` 过滤白名单都由它派生。

JSON Schema 不是 Python 值，import 不了 → 建闸，纪律见 CLAUDE.md「跨语言手抄常量必建
一致性闸」。**过滤白名单那一层已经单源掉了**（`VALID_SYNC_STATUSES = get_args(SyncStatus)`），
本闸只管剩下这一对真镜像。

🔴 这条闸修的是一个**真实数据不可达**：契约与 Literal 都有 ``deleted``（生产库现有一行
该状态的邮件），但两个 ``VALID_STATUSES`` 白名单历史上各自硬编码了 6 值、双双漏掉它 ——
于是 ``mailagent email list --status deleted`` 与 ``GET /api/email/list?status=deleted``
都把它当**非法参数**拒掉，错误文案还理直气壮地列出「合法的 6 个」。两侧同时漏 = 两侧
测试同时恒绿。

两侧都抽真源，本文件不持任何一侧的期望值副本；抽取失败一律断言红。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.api.schemas.email import VALID_SYNC_STATUSES

_REPO_ROOT = Path(__file__).resolve().parents[2]
_COMMON_SCHEMA = _REPO_ROOT / "docs/cli-schema/_common.schema.json"


def _extract_schema_statuses(doc: dict, *, origin: str) -> set[str]:
    """``$defs.sync_status.enum`` 去掉 null = 契约声明的字符串值域。"""
    node = doc.get("$defs", {}).get("sync_status")
    assert isinstance(node, dict), (
        f"{origin}: $defs.sync_status 没抽到 —— 契约被改名 / 挪位置了？更新本闸的抽取器"
    )
    enum = node.get("enum")
    assert isinstance(enum, list) and enum, (
        f"{origin}: $defs.sync_status.enum 不是非空数组 —— 换成 oneOf / $ref 了？更新本闸"
    )
    values = {v for v in enum if isinstance(v, str)}
    assert values, f"{origin}: enum 里一个字符串值都没有 —— 写法变了，更新本闸的抽取器"
    return values


def _read_schema() -> dict:
    assert _COMMON_SCHEMA.exists(), f"契约文件搬家了？{_COMMON_SCHEMA}"
    return json.loads(_COMMON_SCHEMA.read_text(encoding="utf-8"))


def test_python_literal_matches_wire_contract():
    schema = _extract_schema_statuses(_read_schema(), origin=str(_COMMON_SCHEMA))
    assert schema == set(VALID_SYNC_STATUSES), (
        f"契约 {sorted(schema)} 与 Python Literal {sorted(VALID_SYNC_STATUSES)} 漂移 —— "
        "契约多一个 = 后端会发出前端 codegen 不认的值；Literal 多一个 = 该值能被写进/"
        "查出，却过不了 web 侧 ajv 校验。加状态必须同批改两处"
    )


def test_contract_allows_null_but_the_filter_domain_does_not():
    """契约的 enum 含 ``null``（列未填时的合法 wire 值），过滤白名单里不该有 None。

    这条差异是**有意的**：`?status=` 是筛选条件，筛"空"要用别的语义，不是把 None
    塞进白名单。钉住它，免得有人"顺手对齐"时把 None 加进 VALID_SYNC_STATUSES。
    """
    enum = _read_schema()["$defs"]["sync_status"]["enum"]
    assert None in enum, "契约不再允许 null sync_status？那 Literal 侧的可空字段要一起改"
    assert None not in VALID_SYNC_STATUSES


def test_deleted_is_filterable():
    """回归钉：``deleted`` 必须在过滤白名单里（本 issue 的病根，生产有真实数据）。"""
    assert "deleted" in VALID_SYNC_STATUSES


# ── 反向用例：合成契约证明闸真会红 ───────────────────────────────────────────

def test_gate_drift_would_go_red():
    six_values = {"pending", "fetch_failed", "synced", "failed", "skipped", "dead_letter"}
    synthetic = {"$defs": {"sync_status": {"enum": sorted(six_values) + [None]}}}
    extracted = _extract_schema_statuses(synthetic, origin="<synthetic>")
    assert extracted != set(VALID_SYNC_STATUSES), (
        "漏掉 deleted 的合成契约竟与 Literal 相等 —— 本闸对漂移无感"
    )


def test_gate_extractor_failure_would_go_red():
    """契约换写法（$ref / oneOf / 改名）必须断言失败，不是静默返回空集恒真。"""
    with pytest.raises(AssertionError):
        _extract_schema_statuses({"$defs": {}}, origin="<synthetic>")
    with pytest.raises(AssertionError):
        _extract_schema_statuses(
            {"$defs": {"sync_status": {"$ref": "#/$defs/other"}}}, origin="<synthetic>"
        )
    with pytest.raises(AssertionError):
        _extract_schema_statuses(
            {"$defs": {"sync_status": {"enum": [None]}}}, origin="<synthetic>"
        )
