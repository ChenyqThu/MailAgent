"""Unified lazy local embedding engine (zero top-level heavy imports)."""

from __future__ import annotations

from src.embedding.protocol import (
    BUILTIN_EMBEDDING_GEMMA_PROFILE,
    EmbeddingProvider,
    EmbeddingProviderConfig,
    OnnxModelProfile,
    PoolingMode,
    ProviderKind,
)
from src.embedding.quantize import (
    dequantize_int8,
    l2_normalize,
    mrl_truncate,
    pack_bq,
    quantize_int8,
    two_stage_rank,
    unpack_bq_matrix,
)
from src.embedding.registry import (
    DEFAULT_IDLE_TTL_SEC,
    PROVIDER_CONFIG_FILENAME,
    EmbeddingManager,
    get_embedding_manager,
    load_provider_config,
    reset_embedding_manager_for_tests,
    resolve_provider_config_path,
    save_provider_config,
)

__all__ = [
    "BUILTIN_EMBEDDING_GEMMA_PROFILE",
    "DEFAULT_IDLE_TTL_SEC",
    "PROVIDER_CONFIG_FILENAME",
    "EmbeddingManager",
    "EmbeddingProvider",
    "EmbeddingProviderConfig",
    "OnnxModelProfile",
    "PoolingMode",
    "ProviderKind",
    "dequantize_int8",
    "get_embedding_manager",
    "l2_normalize",
    "load_provider_config",
    "mrl_truncate",
    "pack_bq",
    "quantize_int8",
    "reset_embedding_manager_for_tests",
    "resolve_provider_config_path",
    "save_provider_config",
    "two_stage_rank",
    "unpack_bq_matrix",
]
