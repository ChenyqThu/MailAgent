"""Report artifact vocabulary parity across Python and TypeScript.

The extraction canaries are deliberate: a source-format change must fail this gate instead of
silently comparing an empty set and reporting a false green.
"""

from __future__ import annotations

import re
from pathlib import Path

from src.reports.models import REPORT_BLOCK_TYPES, REPORT_CADENCES


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
