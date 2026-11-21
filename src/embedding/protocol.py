"""Protocol, datatypes, and built-in model profile for unified local embeddings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Protocol, Sequence, runtime_checkable

import numpy as np

PoolingMode = Literal["mean", "cls", "last_token"]
ProviderKind = Literal["builtin_onnx", "openai_compat"]


@dataclass(frozen=True)
class OnnxModelProfile:
    """Descriptor for an ONNX sentence/document embedding model."""

    model_id: str
    repo: str
    onnx_file: str
    extra_files: tuple[str, ...]
    full_dim: int
    output_dim: int
    pooling: PoolingMode
    query_prefix: str
    doc_prefix: str
    append_eos: bool
    max_tokens: int
    min_score: float
    approx_bytes: int


BUILTIN_EMBEDDING_GEMMA_PROFILE = OnnxModelProfile(
    model_id="embeddinggemma-300m-q4-mrl256",
    repo="onnx-community/embeddinggemma-300m-ONNX",
    onnx_file="onnx/model_q4.onnx",
    extra_files=("onnx/model_q4.onnx_data",),
    full_dim=768,
    output_dim=256,
    pooling="mean",
    query_prefix="task: search result | query: ",
    doc_prefix="title: none | text: ",
    append_eos=False,
    max_tokens=512,
    min_score=0.48,
    approx_bytes=208 * 1024 * 1024,
)


@dataclass(frozen=True)
class EmbeddingProviderConfig:
    """Persisted provider selection (``<data>/embedding_provider.json``)."""

    kind: ProviderKind = "builtin_onnx"
    base_url: Optional[str] = None
    model: Optional[str] = None
    dim: Optional[int] = None
    min_score: float = 0.48
    use_coreml: bool = False


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Minimal synchronous contract shared by Library, Email Semantic Index, and mem0."""

    model_id: str
    dim: int
    provider_kind: str

    def encode(self, texts: Sequence[str], *, batch_size: int = 8) -> np.ndarray:
        """Encode document/passage strings (no query-only prefix) -> ``(n, dim)`` float32 L2-normalized."""
        ...

    def encode_query(self, query: str) -> np.ndarray:
        """Encode a search query string (with query prefix if configured) -> ``(dim,)`` float32 L2-normalized."""
        ...

    def close(self) -> None:
        """Release runtime handles / memory when unloading on idle or provider switch."""
        ...
