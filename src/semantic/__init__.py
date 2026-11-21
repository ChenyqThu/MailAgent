"""Independent email lightweight semantic index (``semantic_index.db``)."""

from __future__ import annotations

from src.semantic.db import SEMANTIC_DB_FILENAME, SEMANTIC_SCHEMA_VERSION, SemanticDb, resolve_semantic_db_path
from src.semantic.repository import SemanticRepository
from src.semantic.service import (
    SemanticIndexService,
    build_email_semantic_text,
    get_semantic_service,
    reset_semantic_service_for_tests,
)

__all__ = [
    "SEMANTIC_DB_FILENAME",
    "SEMANTIC_SCHEMA_VERSION",
    "SemanticDb",
    "SemanticIndexService",
    "SemanticRepository",
    "build_email_semantic_text",
    "get_semantic_service",
    "reset_semantic_service_for_tests",
    "resolve_semantic_db_path",
]
