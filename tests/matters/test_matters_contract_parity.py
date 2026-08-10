from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from src.api.routers import chat
from src.mail import sync_store
from src.matters import models


ENUMS = (
    models.MatterStatus,
    models.MatterHealth,
    models.MatterPriority,
    models.MatterItemKind,
    models.MatterItemStatus,
    models.MatterUpdateReviewStatus,
    models.MatterActorKind,
)

ROOT = Path(__file__).resolve().parents[2]
MATTER_TS = ROOT / "frontend/src/shared/api/types/matter.ts"

TS_ARRAYS = {
    "MATTER_STATUSES": models.MATTER_STATUSES,
    "MATTER_HEALTH_VALUES": models.MATTER_HEALTH_VALUES,
    "MATTER_PRIORITIES": models.MATTER_PRIORITIES,
    "MATTER_ITEM_KINDS": models.MATTER_ITEM_KINDS,
    "MATTER_ITEM_STATUSES": models.MATTER_ITEM_STATUSES,
    "MATTER_RESOURCE_KINDS": models.MATTER_RESOURCE_KINDS,
    "MATTER_RELATION_TYPES": models.MATTER_RELATION_TYPES,
    "MATTER_ATTENTION_KINDS": models.MATTER_ATTENTION_KINDS,
    "MATTER_ATTENTION_STATES": models.MATTER_ATTENTION_STATES,
    "MATTER_CHANGE_KINDS": models.MATTER_CHANGE_KINDS,
    "MATTER_RUN_STATUSES": models.MATTER_RUN_STATUSES,
    "MATTER_RUN_TRIGGERS": models.MATTER_RUN_TRIGGERS,
    "MATTER_ACCESS_POLICIES": models.MATTER_ACCESS_POLICIES,
    "MATTER_UPDATE_REVIEW_STATUSES": models.MATTER_UPDATE_REVIEW_STATUSES,
    "MATTER_ACTOR_KINDS": models.MATTER_ACTOR_KINDS,
    "MATTER_RESOURCE_SUBSCRIPTION_STATES": models.MATTER_RESOURCE_SUBSCRIPTION_STATES,
    "MATTER_SEARCH_FIELDS": models.MATTER_SEARCH_FIELDS,
    "BUILTIN_MATTER_TYPES": models.BUILTIN_MATTER_TYPES,
}


def ts_const_string_array(
    path: Path, name: str, *, src: str | None = None
) -> tuple[str, ...]:
    source = path.read_text(encoding="utf-8") if src is None else src
    match = re.search(
        rf"export\s+const\s+{re.escape(name)}\s*=\s*\[(?P<body>.*?)\]\s+as\s+const",
        source,
        re.DOTALL,
    )
    assert match is not None, f"{path}: 找不到 export const {name} = [...] as const"
    body = match.group("body")
    values = tuple(re.findall(r"(['\"])(.*?)\1", body))
    extracted = tuple(value for _, value in values)
    scrubbed = re.sub(r"(['\"])(.*?)\1", "", body)
    scrubbed = re.sub(r"[\s,]", "", scrubbed)
    assert not scrubbed, f"{path}: {name} 含非字符串字面量或部分抽取: {scrubbed!r}"
    assert extracted, f"{path}: {name} 抽取结果为空"
    return extracted


def test_migration_ddl_uses_canonical_sql_check_helper():
    source = inspect.getsource(sync_store)
    assert "sql_check_clause(MatterStatus)" in source
    assert "sql_check_clause(MatterItemKind)" in source
    assert "sql_check_clause(MatterUpdateReviewStatus)" in source


def test_python_values_equal_sql_check_value_sets():
    ddl = "\n".join(sync_store.MATTER_TABLE_DDLS)
    for enum_type in ENUMS:
        values = tuple(member.value for member in enum_type)
        clause = models.sql_check_clause(enum_type)
        assert clause in ddl, (
            f"DDL missing canonical CHECK for {enum_type.__name__}: {values}"
        )


def test_typescript_enum_mirrors_equal_python_canonical_values():
    for name, canonical in TS_ARRAYS.items():
        extracted = ts_const_string_array(MATTER_TS, name)
        assert len(extracted) == len(canonical), (
            f"{name} 成员数漂移: TS={len(extracted)} Python={len(canonical)}"
        )
        assert extracted == canonical, f"{name} 漂移: TS={extracted!r} Python={canonical!r}"


def test_typescript_extractor_failure_and_partial_extraction_are_red():
    with pytest.raises(AssertionError, match="找不到"):
        ts_const_string_array(MATTER_TS, "MATTER_STATUSES", src="export const X = [] as const")
    with pytest.raises(AssertionError, match="抽取结果为空"):
        ts_const_string_array(
            MATTER_TS, "MATTER_STATUSES", src="export const MATTER_STATUSES = [] as const"
        )


def test_chat_config_projects_the_same_pydantic_matters_flag_as_the_router_gate():
    source = inspect.getsource(chat.chat_config)
    assert '"mattersEnabled": bool(getattr(cfg, "matters_enabled", False))' in source
    with pytest.raises(AssertionError, match="部分抽取"):
        ts_const_string_array(
            MATTER_TS,
            "MATTER_STATUSES",
            src="export const MATTER_STATUSES = ['inbox', SOME_VALUE] as const",
        )
