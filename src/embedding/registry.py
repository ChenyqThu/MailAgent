"""Process-wide singleton EmbeddingManager with persisted config and 5-minute idle auto-unload."""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable, Optional, Sequence

from src.embedding.protocol import (
    BUILTIN_EMBEDDING_GEMMA_PROFILE,
    EmbeddingProviderConfig,
)

PROVIDER_CONFIG_FILENAME = "embedding_provider.json"
DEFAULT_IDLE_TTL_SEC = 300.0


def resolve_provider_config_path(library_root: str) -> str:
    """Resolve ``<data>/embedding_provider.json`` adjacent to ``library/``."""
    parent = os.path.dirname(os.path.abspath(library_root))
    return os.path.join(parent, PROVIDER_CONFIG_FILENAME)


def load_provider_config(config_path: Optional[str]) -> EmbeddingProviderConfig:
    if not config_path or not os.path.isfile(config_path):
        return EmbeddingProviderConfig()
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        kind = raw.get("kind")
        if kind == "openai_compat" and raw.get("base_url") and raw.get("model"):
            dim_val = raw.get("dim")
            dim = int(dim_val) if isinstance(dim_val, int) and dim_val > 0 else None
            min_score = float(raw.get("min_score", 0.35))
            return EmbeddingProviderConfig(
                kind="openai_compat",
                base_url=str(raw["base_url"]).strip(),
                model=str(raw["model"]).strip(),
                dim=dim,
                min_score=min_score,
                use_coreml=False,
            )
    except Exception:  # noqa: BLE001 — malformed/missing config degrades safely to built-in
        pass
    return EmbeddingProviderConfig()


def save_provider_config(config_path: str, cfg: EmbeddingProviderConfig) -> None:
    parent = os.path.dirname(os.path.abspath(config_path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    payload: dict[str, Any] = {
        "kind": cfg.kind,
        "base_url": cfg.base_url,
        "model": cfg.model,
        "dim": cfg.dim,
        "min_score": cfg.min_score,
        "use_coreml": cfg.use_coreml,
    }
    tmp = config_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, config_path)


class _TrackedProviderProxy:
    """Wraps a provider instance so every call refreshes the manager's idle unload timer."""

    def __init__(self, inner: Any, on_touch: Callable[[], None]) -> None:
        self._inner = inner
        self._on_touch = on_touch

    @property
    def model_id(self) -> str:
        return str(getattr(self._inner, "model_id", BUILTIN_EMBEDDING_GEMMA_PROFILE.model_id))

    @property
    def dim(self) -> int:
        return int(getattr(self._inner, "dim", BUILTIN_EMBEDDING_GEMMA_PROFILE.output_dim))

    @property
    def provider_kind(self) -> str:
        return str(getattr(self._inner, "provider_kind", "builtin_onnx"))

    @property
    def active_ep(self) -> Optional[str]:
        return getattr(self._inner, "active_ep", None)

    def encode(self, texts: Sequence[str], *, batch_size: int = 8) -> Any:
        self._on_touch()
        return self._inner.encode(texts, batch_size=batch_size)

    def encode_query(self, query: str) -> Any:
        self._on_touch()
        return self._inner.encode_query(query)

    def close(self) -> None:
        close_fn = getattr(self._inner, "close", None)
        if callable(close_fn):
            close_fn()


class EmbeddingManager:
    """Process-wide shared lazy provider cache with idle memory auto-unload."""

    def __init__(
        self,
        *,
        library_root: Optional[str] = None,
        config_path: Optional[str] = None,
        idle_ttl_sec: float = DEFAULT_IDLE_TTL_SEC,
    ) -> None:
        self._lock = threading.RLock()
        self._library_root = library_root
        self._config_path = config_path or (
            resolve_provider_config_path(library_root) if library_root else None
        )
        self._idle_ttl_sec = float(idle_ttl_sec)
        self._config = load_provider_config(self._config_path)
        self._provider: Optional[_TrackedProviderProxy] = None
        self._loaded = False
        self._timer: Optional[threading.Timer] = None

    def bind_paths(self, library_root: str) -> None:
        with self._lock:
            changed = self._library_root != library_root
            self._library_root = library_root
            new_cfg_path = resolve_provider_config_path(library_root)
            if self._config_path != new_cfg_path:
                self._config_path = new_cfg_path
                self._config = load_provider_config(new_cfg_path)
                changed = True
            if changed:
                self.unload()

    def get_config(self) -> EmbeddingProviderConfig:
        with self._lock:
            if self._config_path and os.path.isfile(self._config_path):
                self._config = load_provider_config(self._config_path)
            return self._config

    def set_config(self, cfg: EmbeddingProviderConfig) -> EmbeddingProviderConfig:
        with self._lock:
            if self._config_path:
                save_provider_config(self._config_path, cfg)
            self._config = cfg
            self.unload()
            return cfg

    def active_model_id(self) -> str:
        cfg = self.get_config()
        if cfg.kind == "openai_compat" and cfg.model:
            import re

            safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", cfg.model).strip("_") or "custom"
            return f"openai-compat:{safe}-d{cfg.dim}" if cfg.dim else f"openai-compat:{safe}"
        return BUILTIN_EMBEDDING_GEMMA_PROFILE.model_id

    def active_dim(self) -> int:
        cfg = self.get_config()
        if cfg.kind == "openai_compat":
            with self._lock:
                if self._provider is not None and self._provider.dim > 0:
                    return self._provider.dim
            if cfg.dim and cfg.dim > 0:
                return cfg.dim
        return BUILTIN_EMBEDDING_GEMMA_PROFILE.output_dim

    def active_min_score(self) -> float:
        cfg = self.get_config()
        if cfg.kind == "openai_compat":
            return float(cfg.min_score)
        return float(BUILTIN_EMBEDDING_GEMMA_PROFILE.min_score)

    def is_available(
        self,
        library_root: Optional[str] = None,
        *,
        builtin_present: Optional[Callable[[str], bool]] = None,
    ) -> bool:
        cfg = self.get_config()
        if cfg.kind == "openai_compat":
            return bool(cfg.base_url and cfg.model)
        root = library_root or self._library_root
        if not root:
            return False
        if builtin_present is not None:
            return bool(builtin_present(root))
        from src.library import embed as E  # noqa: PLC0415

        return bool(E.model_present(root))

    def _schedule_idle_unload(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if self._idle_ttl_sec <= 0 or self._provider is None:
                return
            timer = threading.Timer(self._idle_ttl_sec, self._on_idle_timeout)
            timer.daemon = True
            timer.start()
            self._timer = timer

    def _on_idle_timeout(self) -> None:
        self.unload()

    def unload(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            if self._provider is not None:
                try:
                    self._provider.close()
                finally:
                    self._provider = None
            self._loaded = False

    def invalidate(self) -> None:
        self.unload()

    def get_provider(
        self,
        library_root: Optional[str] = None,
        *,
        builtin_loader: Optional[Callable[[str], Any]] = None,
        builtin_present: Optional[Callable[[str], bool]] = None,
    ) -> Optional[_TrackedProviderProxy]:
        with self._lock:
            cfg = self.get_config()
            if self._loaded and self._provider is not None:
                self._schedule_idle_unload()
                return self._provider

            if cfg.kind == "openai_compat":
                if not cfg.base_url or not cfg.model:
                    self._loaded = True
                    return None
                from src.embedding.openai_compat import OpenAICompatLocalProvider  # noqa: PLC0415

                raw = OpenAICompatLocalProvider(cfg.base_url, cfg.model, dim=cfg.dim)
                self._provider = _TrackedProviderProxy(raw, self._schedule_idle_unload)
                self._loaded = True
                self._schedule_idle_unload()
                return self._provider

            root = library_root or self._library_root
            if not root:
                self._loaded = True
                return None

            if builtin_present is not None and not builtin_present(root):
                self._loaded = True
                return None

            if builtin_loader is not None:
                raw = builtin_loader(root)
            else:
                from src.library import embed as E  # noqa: PLC0415

                raw = E.load_encoder(root, use_coreml=cfg.use_coreml)

            if raw is None:
                self._loaded = True
                self._provider = None
                return None

            self._provider = _TrackedProviderProxy(raw, self._schedule_idle_unload)
            self._loaded = True
            self._schedule_idle_unload()
            return self._provider


_manager: Optional[EmbeddingManager] = None
_manager_lock = threading.Lock()


def get_embedding_manager(library_root: Optional[str] = None) -> EmbeddingManager:
    """Process-wide singleton shared by library, semantic email index, and mem0."""
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = EmbeddingManager(library_root=library_root)
        elif library_root:
            _manager.bind_paths(library_root)
        return _manager


def reset_embedding_manager_for_tests() -> None:
    global _manager
    with _manager_lock:
        if _manager is not None:
            _manager.unload()
        _manager = None
