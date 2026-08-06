"""Data models for the agent eval/trace framework (schema.md §1, §2, §5).

Pure data holders; strict validation lives in loader.py. 3.9-compatible
(``from __future__ import annotations`` + typing aliases, stdlib only).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

CATEGORIES = {
    "search_read",
    "no_hit",
    "multi_email",
    "email_action",
    "report_cross",
    "skill_enablement",
    "safety",
}
SURFACES = {"general", "email"}
EVIDENCE_TYPES = {"email", "thread", "report", "attachment", "notion", "kos"}

# Typed evidence grounding (schema.md §5 R8 / H1 fix): map a tool_result output
# KEY (case-insensitive) -> evidence type. Only values under these keys count as
# grounded evidence — free text / subject lines never ground an id. This replaces
# the old raw-substring matching that allowed "5" to match "51201".
EVIDENCE_KEY_TYPES = {
    "internal_id": "email",
    "email_id": "email",
    "thread_id": "thread",
    "report_id": "report",
    "attachment_id": "attachment",
    "slug": "kos",
    "fact_id": "kos",
    "fact_ids": "kos",
    "page_id": "notion",
    "notion_page_id": "notion",
    "notionpageid": "notion",
    "new_page_id": "notion",
    "old_page_id": "notion",
}
RUBRIC_DIMS = {
    "answer_correctness",
    "evidence_grounding",
    "uncertainty_honesty",
    "tool_efficiency",
    "ux_clarity",
}
EVENT_TYPES = {
    "chunk",
    "thinking",
    "tool_use",
    "tool_result",
    "pending_confirmation",
    "usage",
    "done",
    "error",
    "tool_call",
}
TIERS = {"silent", "preview", "edit"}
BUDGET_ERROR_CODES = {"E_MAX_ITER", "E_COST_BUDGET"}
DEFAULT_BUDGET = {"max_iter": 8, "max_cost_usd": 0.5}


# --------------------------------------------------------------------------- #
# Tool catalog
# --------------------------------------------------------------------------- #
@dataclass
class ToolCatalog:
    """Wraps tool_catalog.json (schema.md §5 source of truth for tiers)."""

    tools: Dict[str, Dict[str, Any]]

    def known(self, name: Optional[str]) -> bool:
        return name in self.tools

    def tier(self, name: Optional[str]) -> Optional[str]:
        entry = self.tools.get(name or "")
        return entry.get("tier") if entry else None

    def is_write(self, name: Optional[str]) -> Optional[bool]:
        """True/False for known tools, None for unknown."""
        entry = self.tools.get(name or "")
        if entry is None:
            return None
        if "write" in entry:
            return bool(entry["write"])
        return entry.get("tier", "silent") != "silent"

    def default_auto(self, name: Optional[str]) -> bool:
        """08-05 WP-11 — is this write tool's FACTORY per-tool approval tier 'auto'?

        Mirrors src/agent_config/tool_prefs.py (parity gate:
        tests/config/test_tool_prefs_catalog_parity.py). R5 exempts exactly these
        tools from the mandatory pending_confirmation — a live recording under
        Manual + all-default per-tool tiers legally executes them card-free
        (recorder-contract.md). Unknown/absent → False (the write still must card).
        """
        entry = self.tools.get(name or "")
        return bool(entry) and entry.get("default_approval") == "auto"


# --------------------------------------------------------------------------- #
# Task
# --------------------------------------------------------------------------- #
@dataclass
class Task:
    id: str
    category: str
    title: str
    surface: str
    user_prompt: str
    fixtures: Dict[str, Any]
    allowed_tools: List[str]
    must_use_tools: List[str]
    forbidden_tools: List[str]
    expected_evidence: List[Dict[str, Any]]
    no_hit_expected: bool
    safety_critical: bool
    rubric: Dict[str, float]
    rubric_ref: str
    notes: str
    email_context: Optional[Dict[str, Any]] = None
    allowed_support_tools: List[str] = field(default_factory=list)
    budget: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_BUDGET))
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def max_iter(self) -> int:
        return int(self.budget.get("max_iter", DEFAULT_BUDGET["max_iter"]))

    @property
    def max_cost_usd(self) -> float:
        return float(self.budget.get("max_cost_usd", DEFAULT_BUDGET["max_cost_usd"]))

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Task":
        budget = dict(DEFAULT_BUDGET)
        budget.update(d.get("budget") or {})
        return cls(
            id=d["id"],
            category=d["category"],
            title=d.get("title", ""),
            surface=d["surface"],
            user_prompt=d.get("user_prompt", ""),
            fixtures=d.get("fixtures") or {},
            allowed_tools=list(d.get("allowed_tools") or []),
            must_use_tools=list(d.get("must_use_tools") or []),
            forbidden_tools=list(d.get("forbidden_tools") or []),
            allowed_support_tools=list(d.get("allowed_support_tools") or []),
            expected_evidence=list(d.get("expected_evidence") or []),
            no_hit_expected=bool(d.get("no_hit_expected", False)),
            safety_critical=bool(d.get("safety_critical", False)),
            rubric=dict(d.get("rubric") or {}),
            rubric_ref=d.get("rubric_ref", ""),
            notes=d.get("notes", ""),
            email_context=d.get("email_context"),
            budget=budget,
            raw=d,
        )


# --------------------------------------------------------------------------- #
# Trace
# --------------------------------------------------------------------------- #
@dataclass
class TraceRecord:
    task_id: str
    surface: str
    source: str
    config: Dict[str, Any]
    events: List[Dict[str, Any]]
    metrics: Dict[str, Any]
    final: Dict[str, Any]
    trace_version: str = "1.0"
    run_id: str = ""
    raw: Dict[str, Any] = field(default_factory=dict)

    def events_of(self, etype: str) -> List[Dict[str, Any]]:
        return [e for e in self.events if e.get("type") == etype]

    def tool_uses(self) -> List[Dict[str, Any]]:
        return self.events_of("tool_use")

    def tool_results(self) -> List[Dict[str, Any]]:
        return self.events_of("tool_result")

    def pending_confirmations(self) -> List[Dict[str, Any]]:
        return self.events_of("pending_confirmation")

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TraceRecord":
        return cls(
            task_id=d["task_id"],
            surface=d.get("surface", ""),
            source=d.get("source", ""),
            config=d.get("config") or {},
            events=list(d.get("events") or []),
            metrics=d.get("metrics") or {},
            final=d.get("final") or {},
            trace_version=d.get("trace_version", "1.0"),
            run_id=d.get("run_id", ""),
            raw=d,
        )


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #
@dataclass
class RuleViolation:
    rule: str  # "R1".."R8"
    detail: str

    def as_dict(self) -> Dict[str, str]:
        return {"rule": self.rule, "detail": self.detail}


@dataclass
class TaskResult:
    task_id: str
    category: str
    safety_critical: bool
    hard_pass: bool
    violations: List[RuleViolation]
    trace_source: str
    metrics: Dict[str, Any]
    warnings: List[str] = field(default_factory=list)

    @property
    def hard_score(self) -> float:
        return 1.0 if self.hard_pass else 0.0

    def rule_codes(self) -> set:
        return {v.rule for v in self.violations}

    def as_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "category": self.category,
            "safety_critical": self.safety_critical,
            "hard_pass": self.hard_pass,
            "hard_score": self.hard_score,
            "violations": [v.as_dict() for v in self.violations],
            "trace_source": self.trace_source,
            "metrics": self.metrics,
            "warnings": self.warnings,
        }
