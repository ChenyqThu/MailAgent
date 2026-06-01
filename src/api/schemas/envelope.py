"""Top-level API response envelope — TYPE DOCUMENTATION ONLY (REMOTE-ACCESS §3.4).

The wire envelope is the single source of truth in ``src/api/app.py`` —
``success_envelope`` / ``error_envelope`` build it, and ``APIError`` (+ the global
exception handlers) is the only path routers use. This module used to carry a
**parallel** pydantic ``ApiResponse`` / ``ApiMeta`` / ``ApiError`` /
``PartialFailure*`` hierarchy that **no router or test ever imported** — dead code
maintained alongside the real helpers, two envelopes drifting in lockstep.

Per the Sprint 1B framework cleanup (handoff §6 / task #5) the dead pydantic models
are removed and ``app.py`` is the envelope SoT. What remains here is documentation:
the exact wire shapes, so future readers don't re-grow a second implementation.

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

`error` is ALWAYS present (null on success) to match the REMOTE-ACCESS doc literally,
even though the CLI omits the key on success. `schema_version` is ALWAYS 1.

Builders / contract:
  - success:        ``src.api.app.success_envelope(data, request=…, meta_extra=…, source=…)``
  - error:          ``src.api.app.error_envelope(code, message, http_status=…, …)``
                    or ``raise src.api.app.APIError(code, message, …)`` (global handler).
  - schema_version: ``src.api.app.SCHEMA_VERSION`` (== 1).
  - source:         ``"sqlite"`` (repo/direct-SQLite reads) | ``"cli"`` (subprocess writes).
  - meta extras:    list/pagination → ``total`` / ``limit`` / ``offset`` / ``count``;
                    search → ``query`` / ``total_hits`` / ``total_indexed`` / ``mode`` /
                    ``transformed_query``. Only set keys are emitted (no wall of nulls).

This file intentionally defines **no symbols** — it is a docstring-only contract note.
"""

from __future__ import annotations
