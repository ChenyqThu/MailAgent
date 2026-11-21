"""Local OpenAI-compatible HTTP embedding provider & Ollama / LM Studio server probe."""

from __future__ import annotations

import re
from typing import Any, Optional, Sequence

import numpy as np

from src.embedding.quantize import l2_normalize, mrl_truncate

_EMBEDDING_HINT_RE = re.compile(
    r"(embed|bge|e5|nomic|mxbai|snowflake|gte|jina|embeddinggemma|qwen3-embedding)",
    re.IGNORECASE,
)


def _clean_base_url(url: str) -> str:
    cleaned = str(url or "").strip().rstrip("/")
    if cleaned.endswith("/v1"):
        cleaned = cleaned[:-3]
    return cleaned


def probe_local_openai_servers(
    *,
    timeout: float = 0.8,
    custom_url: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Probe Ollama (11434), LM Studio (1234), and an optional custom loopback URL."""
    import requests  # noqa: PLC0415 — lazy load

    candidates: list[tuple[str, str, str]] = [
        ("ollama", "Ollama", "http://127.0.0.1:11434"),
        ("lmstudio", "LM Studio", "http://127.0.0.1:1234"),
    ]
    if custom_url:
        c = _clean_base_url(custom_url)
        if c and all(c != existing[2] for existing in candidates):
            candidates.append(("custom", "Custom Local Server", c))

    results: list[dict[str, Any]] = []
    for kind, label, base_url in candidates:
        entry: dict[str, Any] = {
            "kind": kind,
            "label": label,
            "base_url": base_url,
            "running": False,
            "models": [],
        }
        try:
            if kind == "ollama":
                resp = requests.get(f"{base_url}/api/tags", timeout=timeout)
                if resp.ok:
                    raw_models = resp.json().get("models") or []
                    names = [str(m.get("name")) for m in raw_models if m.get("name")]
                    entry["running"] = True
                    entry["models"] = _sort_embedding_models(names)
            else:
                resp = requests.get(f"{base_url}/v1/models", timeout=timeout)
                if resp.ok:
                    raw_models = resp.json().get("data") or []
                    names = [str(m.get("id")) for m in raw_models if m.get("id")]
                    entry["running"] = True
                    entry["models"] = _sort_embedding_models(names)
        except Exception:  # noqa: BLE001 — closed port / refused connection is normal
            pass
        results.append(entry)
    return results


def _sort_embedding_models(names: Sequence[str]) -> list[dict[str, Any]]:
    items = [
        {"id": n, "likely_embedding": bool(_EMBEDDING_HINT_RE.search(n))}
        for n in names
        if n
    ]
    items.sort(key=lambda item: (0 if item["likely_embedding"] else 1, item["id"].lower()))
    return items


class OpenAICompatLocalProvider:
    """Adapter calling local ``POST /v1/embeddings`` on Ollama / LM Studio / MLX Server."""

    provider_kind: str = "openai_compat"

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        dim: Optional[int] = None,
        query_prefix: str = "",
        doc_prefix: str = "",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = _clean_base_url(base_url)
        self.model = str(model).strip()
        if not self.base_url or not self.model:
            raise ValueError("base_url and model are required for OpenAICompatLocalProvider")
        safe_model = re.sub(r"[^a-zA-Z0-9._-]+", "_", self.model).strip("_") or "custom"
        self.dim = int(dim) if dim and int(dim) > 0 else 0
        self.model_id = (
            f"openai-compat:{safe_model}-d{self.dim}" if self.dim > 0 else f"openai-compat:{safe_model}"
        )
        self.query_prefix = query_prefix
        self.doc_prefix = doc_prefix
        self.api_key = api_key
        self.timeout = float(timeout)

    def _call(self, inputs: Sequence[str]) -> np.ndarray:
        import requests  # noqa: PLC0415

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {"model": self.model, "input": list(inputs)}
        resp = requests.post(
            f"{self.base_url}/v1/embeddings",
            json=payload,
            headers=headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        body = resp.json()
        rows = sorted(body.get("data") or [], key=lambda item: int(item.get("index", 0)))
        if len(rows) != len(inputs):
            raise RuntimeError(f"/v1/embeddings returned {len(rows)} vectors for {len(inputs)} inputs")
        mat = np.asarray([row["embedding"] for row in rows], dtype=np.float32)
        if mat.ndim != 2 or mat.shape[0] == 0:
            raise RuntimeError("/v1/embeddings returned invalid embedding tensor")
        if self.dim > 0:
            mat = mrl_truncate(mat, self.dim)
        else:
            mat = l2_normalize(mat)
            self.dim = int(mat.shape[1])
        return mat

    def encode(self, texts: Sequence[str], *, batch_size: int = 16) -> np.ndarray:
        if not texts:
            return np.zeros((0, max(1, self.dim)), dtype=np.float32)
        prepared = [f"{self.doc_prefix}{t}" if self.doc_prefix else str(t) for t in texts]
        out: list[np.ndarray] = []
        for start in range(0, len(prepared), batch_size):
            out.append(self._call(prepared[start : start + batch_size]))
        return np.concatenate(out, axis=0)

    def encode_query(self, query: str) -> np.ndarray:
        prepared = f"{self.query_prefix}{query}" if self.query_prefix else str(query)
        return self._call([prepared])[0]

    def close(self) -> None:
        return None
