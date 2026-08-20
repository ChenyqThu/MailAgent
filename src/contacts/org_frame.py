"""Owner-maintained organization framework parsing and validation."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class CompanyEntry:
    name: str
    domains: tuple[str, ...] = ()
    note: str = ""


@dataclass(frozen=True)
class OrgFrame:
    companies: tuple[CompanyEntry, ...] = ()
    department_paths: tuple[tuple[str, ...], ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.companies and not self.department_paths


_HEADING_RE = re.compile(r"^#{1,6}\s*(.*?)\s*#*\s*$")


def _section_for_heading(value: str) -> str | None:
    normalized = value.strip().casefold()
    if normalized.startswith(("公司", "组织", "compan")):
        return "companies"
    if normalized.startswith(("部门", "depart")):
        return "departments"
    return None


def _content_line(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith(("- ", "* ", "+ ")):
        return stripped[2:].strip()
    return stripped


def _department_parts(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split("/") if part.strip())


def normalize_department_path(value: object) -> str:
    """Normalize whitespace around slash separators without rewriting other punctuation."""
    return " / ".join(_department_parts(str(value or "")))


def parse_org_frame(text: str) -> OrgFrame:
    companies: list[CompanyEntry] = []
    department_paths: list[tuple[str, ...]] = []
    section: str | None = None
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        heading = _HEADING_RE.match(line)
        if heading is not None:
            section = _section_for_heading(heading.group(1))
            continue
        content = _content_line(line)
        if section == "companies":
            # 裸名行（无 | 分列）也收：owner 只写公司名是最自然的写法，
            # 丢弃它会让该公司的建议反被标「框架外」，违背预期。
            columns = [column.strip() for column in content.split("|")]
            if not columns[0]:
                continue
            domains = tuple(
                domain.strip()
                for domain in (columns[1].split(",") if len(columns) > 1 else [])
                if domain.strip()
            )
            note = " | ".join(columns[2:]).strip() if len(columns) > 2 else ""
            companies.append(CompanyEntry(columns[0], domains, note))
        elif section == "departments":
            # 单级路径有效：写一行「EBG」= 表达「EBG 下自由展开」（互为前缀语义）。
            parts = _department_parts(content)
            if 1 <= len(parts) <= 5:
                department_paths.append(parts)
    return OrgFrame(tuple(companies), tuple(department_paths))


def load_org_frame() -> OrgFrame:
    """Read the owner document fail-open; absent, empty, or unreadable means no constraints."""
    try:
        from src.agent_config.store import (
            CONTACT_ORG_FRAME_DOC_NAME,
            get_agent_config_store,
        )

        doc = get_agent_config_store().get_profile_doc(
            CONTACT_ORG_FRAME_DOC_NAME, seed_if_absent=False
        )
        return parse_org_frame(getattr(doc, "content", "") or "")
    except Exception:
        return OrgFrame()


def render_org_frame(frame: OrgFrame) -> str:
    """Render only parsed entries so malformed owner text cannot enter trusted prompts."""
    if frame.is_empty:
        return ""
    lines: list[str] = []
    if frame.companies:
        lines.append("# Companies")
        for company in frame.companies:
            domains = ", ".join(company.domains)
            line = f"{company.name} | {domains}"
            if company.note:
                line += f" | {company.note}"
            lines.append(line)
    if frame.department_paths:
        if lines:
            lines.append("")
        lines.append("# Departments")
        lines.extend(" / ".join(path) for path in frame.department_paths)
    return "\n".join(lines)


def organization_in_frame(frame: OrgFrame, value: object) -> bool:
    if frame.is_empty:
        return True
    normalized = str(value or "").strip().casefold()
    return bool(normalized) and any(
        normalized == company.name.strip().casefold() for company in frame.companies
    )


def department_in_frame(frame: OrgFrame, value: object) -> bool:
    if frame.is_empty:
        return True
    value_parts = tuple(part.casefold() for part in _department_parts(str(value or "")))
    if not value_parts:
        return False
    for path in frame.department_paths:
        frame_parts = tuple(part.strip().casefold() for part in path)
        shared_length = min(len(value_parts), len(frame_parts))
        if value_parts[:shared_length] == frame_parts[:shared_length]:
            return True
    return False
