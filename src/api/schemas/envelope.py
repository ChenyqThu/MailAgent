"""Top-level API response envelope (REMOTE-ACCESS §3.4).

The wire envelope runtime builder lives in ``src/api/app.py`` (``success_envelope`` /
``error_envelope`` / ``APIError``). Alongside that runtime helper, ``SuccessEnvelope[T]``
provides the generic Pydantic response model used by FastAPI ``response_model=...`` on
refactored domain routers so ``app.openapi()`` emits typed ``200``/``202`` schemas.

Shape (success):
    {"status": "success", "schema_version": 1, "data": <T>, "error": null,
     "meta": {"duration_ms": 12, "source": "sqlite"|"cli", ...}}

Shape (error):
    {"status": "error", "schema_version": 1, "data": null,
     "error": {"code": "E_NOT_FOUND", "message": "...", "hint": "..."},
     "meta": {"duration_ms": 12, "source": "sqlite"|"cli"}}

Shape (batch partial_failure, HTTP 207):
    {"status": "partial_failure", "schema_version": 1,
     "data": {"succeeded": [...], "failed": [{"internal_id": N, "error": {...}}],
              "summary": {"total": N, "succeeded": k, "failed": m,
                          "aborted_by": null}},
     "error": null, "meta": {"duration_ms": 12, "source": "cli", ...}}
"""

from __future__ import annotations

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class SuccessEnvelope(BaseModel, Generic[T]):
    """Generic OpenAPI response envelope mirroring ``src.api.app.success_envelope``."""

    status: Literal["success"] = "success"
    schema_version: int = 1
    data: T
    error: None = None
    meta: dict[str, Any] = Field(default_factory=dict)
