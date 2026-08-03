"""Report artifact vocabulary parity across Python and TypeScript.

The extraction canaries are deliberate: a source-format change must fail this gate instead of
silently comparing an empty set and reporting a false green.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.reports.models import (
    MANUAL_CHAT_REPORT_AGENT_ID,
    MAX_IMAGE_SRC_CHARS,
    REPORT_BLOCK_TYPES,
    REPORT_CADENCES,
)


ROOT = Path(__file__).resolve().parents[2]
TS_CONTRACT = ROOT / "frontend/src/shared/api/reportBlocks.ts"
TS_TYPES = ROOT / "frontend/src/shared/api/types/report.ts"
QUOTED = re.compile(r"'([^']+)'")


def _extract_const_array(source: str, name: str) -> tuple[str, ...]:
    match = re.search(rf"export\s+const\s+{name}\s*=\s*\[(.*?)\]\s*as\s+const", source, re.S)
    assert match is not None, f"failed to extract {name}; update the consistency gate parser"
    values = tuple(QUOTED.findall(match.group(1)))
    assert values, f"{name} extraction returned no values"
    return values


def test_report_block_types_match_frontend_runtime_contract() -> None:
    source = TS_CONTRACT.read_text(encoding="utf-8")
    frontend = _extract_const_array(source, "REPORT_BLOCK_TYPES")
    assert "header" in frontend and "image" in frontend, "block extraction canary failed"
    assert frontend == REPORT_BLOCK_TYPES


def test_report_cadences_match_runtime_and_typescript_union() -> None:
    runtime_source = TS_CONTRACT.read_text(encoding="utf-8")
    frontend_runtime = _extract_const_array(runtime_source, "REPORT_CADENCES")
    assert "custom" in frontend_runtime, "cadence extraction canary failed"

    type_source = TS_TYPES.read_text(encoding="utf-8")
    type_match = re.search(r"export\s+type\s+ReportCadence\s*=([^\n]+)", type_source)
    assert type_match is not None, "failed to extract ReportCadence union"
    frontend_type = tuple(QUOTED.findall(type_match.group(1)))
    assert frontend_type, "ReportCadence union extraction returned no values"

    assert frontend_runtime == REPORT_CADENCES
    assert frontend_type == REPORT_CADENCES


def test_image_src_cap_matches_frontend_runtime_schema() -> None:
    """image src 上限跨语言同源（08-02 review F8）。

    这是 report_write 里唯一没有长度约束过的模型自由字段（markdown 的 text 早有 50k 上限），
    两侧任一边放宽而另一边不动，就会出现「gateway 收下、Python 拒绝」或反之的静默不一致。
    """
    source = TS_CONTRACT.read_text(encoding="utf-8")
    match = re.search(r"export\s+const\s+MAX_IMAGE_SRC_CHARS\s*=\s*([\d_]+)", source)
    assert match is not None, "没找到 MAX_IMAGE_SRC_CHARS —— 更新这道闸的解析器"
    frontend_cap = int(match.group(1).replace("_", ""))
    assert frontend_cap >= 1000, "上限 canary 失败 —— 解析器可能抓到了别的数字"
    assert frontend_cap == MAX_IMAGE_SRC_CHARS


def test_manual_chat_author_id_matches_frontend() -> None:
    """manual chat 报告的哨兵作者 id 跨语言同源（08-02 review F6）。

    两侧不一致的后果不对称：gateway 传的 id 若与 Python 认的哨兵不同，`/reports/custom` 会按
    「未知 agent」拒绝，manual chat 的 report_write 直接不可用（且报错指向 agentId 而非配置）。
    """
    source = TS_CONTRACT.read_text(encoding="utf-8")
    match = re.search(r"export\s+const\s+MANUAL_CHAT_REPORT_AGENT_ID\s*=\s*'([^']+)'", source)
    assert match is not None, "没找到 MANUAL_CHAT_REPORT_AGENT_ID —— 更新这道闸的解析器"
    assert match.group(1) == MANUAL_CHAT_REPORT_AGENT_ID
