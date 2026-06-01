"""AI / translation endpoint response models (ai.{getCached,deleteCached},
and translateBatch IF ported).

getCached/deleteCached are cheap table reads/writes on email_translation
(src/repository/translation.py) — modeled here. translateBatch is Electron-main-
only LLM batch logic with NO CLI; porting it (html block extraction + pLimit
batching + gateway calls) is deferred to a later V2 sprint, but its response
model is included so a future router can adopt it without a schema change.

Field names are camelCase here to match the frontend TranslationCache /
TranslateBatchResult / TranslationSegment EXACTLY (these are hand-written TS
interfaces, not snake_case CLI schemas — the renderer reads them verbatim).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

TargetLang = Literal["zh", "en"]


class TranslationSegment(BaseModel):
    """One translated segment (frontend TranslationSegment).

    `src` is the original block text (used by the renderer for
    `textContent.includes(src)` matching); `tgt` is the translation.
    """

    src: str
    tgt: str


class TranslationCache(BaseModel):
    """Cached translation envelope (frontend TranslationCache).

    Returned by `GET /api/ai/translation/{id}` (getCached). camelCase on the
    wire to match the frontend interface.
    """

    internalId: int
    targetLang: TargetLang
    segments: list[TranslationSegment]
    source: Optional[str] = None  # 'llm_agent' (Path A) | 'on_demand' (Path B) | null
    model: Optional[str] = None
    fetchedAt: Optional[int] = None  # unix seconds; null for un-persisted


class TranslateBatchResult(TranslationCache):
    """Result of `POST /api/ai/translate-batch/{id}` (frontend TranslateBatchResult).

    Deferred: translateBatch logic is not yet ported server-side. Model kept so
    the router contract is ready. `failedBatches > 0` with non-empty segments =
    partial-failure UX on the renderer.
    """

    latencyMs: int
    failedBatches: int
    totalBatches: int


class DeleteCachedResult(BaseModel):
    """`DELETE /api/ai/translation/{id}` data — whether a cache row was removed."""

    deleted: bool


__all__ = [
    "TargetLang", "TranslationSegment", "TranslationCache",
    "TranslateBatchResult", "DeleteCachedResult",
]
