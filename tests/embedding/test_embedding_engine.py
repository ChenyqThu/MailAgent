"""Unit tests for the unified lazy local embedding engine (`src/embedding/`)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from types import SimpleNamespace
from typing import Any
from unittest import mock

import numpy as np
import pytest

from src.embedding import (
    BUILTIN_EMBEDDING_GEMMA_PROFILE,
    EmbeddingManager,
    EmbeddingProviderConfig,
    dequantize_int8,
    l2_normalize,
    mrl_truncate,
    pack_bq,
    quantize_int8,
    two_stage_rank,
    unpack_bq_matrix,
)
from src.embedding.openai_compat import OpenAICompatLocalProvider, probe_local_openai_servers
from src.embedding.onnx_provider import OnnxLocalProvider


def test_importing_src_embedding_does_not_load_heavy_deps() -> None:
    """Importing ``src.embedding`` must never eagerly pull onnxruntime/tokenizers/fastembed/faiss."""
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, src.embedding; "
            "heavy = [m for m in ('onnxruntime', 'tokenizers', 'fastembed', 'faiss', 'requests') if m in sys.modules]; "
            "assert not heavy, f'unexpected heavy imports: {heavy}'",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout


def test_mrl_bq_and_two_stage_ranking_accuracy_and_legacy_null_fallback() -> None:
    rng = np.random.default_rng(123)
    full = rng.standard_normal((250, 768)).astype(np.float32)
    mrl = mrl_truncate(full, 256)
    assert mrl.shape == (250, 256)
    np.testing.assert_allclose(np.linalg.norm(mrl, axis=1), 1.0, atol=1e-5)

    # Query aligns strongly with row 42
    target_vec = mrl[42].copy()
    blobs = [quantize_int8(v) for v in mrl]
    bq_blobs: list[bytes | None] = [pack_bq(v) if i % 2 == 0 else None for i, v in enumerate(mrl)]

    i8_mat = np.stack([np.frombuffer(b, dtype=np.int8) for b in blobs])
    bq_mat = unpack_bq_matrix(bq_blobs, i8_mat)
    assert bq_mat is not None and bq_mat.shape == (250, 32)

    # N=250 > bq_candidates=50 exercises BQ Hamming coarse filter + int8 exact rerank
    ranked = two_stage_rank(target_vec, i8_mat, bq_mat, top_k=5, bq_candidates=50, min_score=0.5)
    assert ranked and ranked[0][0] == 42
    assert ranked[0][1] > 0.98

    # Dequantize helper consistency
    deq = dequantize_int8(blobs[:3], dim=256)
    assert deq.shape == (3, 256)
    assert l2_normalize(target_vec).shape == (256,)


def test_coreml_probe_falls_back_to_cpu_on_dummy_forward_error(tmp_path, monkeypatch) -> None:
    """When CoreML fails the mandatory 2-query dummy forward probe, provider falls back safely to CPU."""
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "model_q4.onnx").write_bytes(b"fake")
    (model_dir / "tokenizer.json").write_text("{}", encoding="utf-8")

    created_sessions: list[list[str]] = []

    class _FakeTok:
        def no_padding(self):
            pass

        def enable_truncation(self, **_kw):
            pass

        def token_to_id(self, _tok):
            return 1

        def encode_batch(self, texts):
            return [SimpleNamespace(ids=[2, 3, 4]) for _ in texts]

    class _FakeTokenizerCls:
        @staticmethod
        def from_file(_path):
            return _FakeTok()

    class _FakeSession:
        def __init__(self, _path, sess_options=None, providers=None):
            self._providers = list(providers or ["CPUExecutionProvider"])
            created_sessions.append(self._providers)

        def get_providers(self):
            return self._providers

        def get_inputs(self):
            return [
                SimpleNamespace(name="input_ids", type="tensor(int64)", shape=["batch", "seq"]),
                SimpleNamespace(name="attention_mask", type="tensor(int64)", shape=["batch", "seq"]),
            ]

        def get_outputs(self):
            return [SimpleNamespace(name="last_hidden_state")]

        def run(self, _names, feeds):
            if "CoreMLExecutionProvider" in self._providers:
                raise RuntimeError("coreml zero-element dynamic shape failure")
            b, w = feeds["input_ids"].shape
            out = np.ones((b, w, 256), dtype=np.float32)
            return [out]

    class _SessionOpts:
        graph_optimization_level = None

    fake_ort = SimpleNamespace(
        get_available_providers=lambda: ["CoreMLExecutionProvider", "CPUExecutionProvider"],
        SessionOptions=_SessionOpts,
        GraphOptimizationLevel=SimpleNamespace(ORT_ENABLE_ALL=1),
        InferenceSession=_FakeSession,
    )
    fake_tok_mod = SimpleNamespace(Tokenizer=_FakeTokenizerCls)
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    monkeypatch.setitem(sys.modules, "tokenizers", fake_tok_mod)

    prov = OnnxLocalProvider(str(model_dir), profile=BUILTIN_EMBEDDING_GEMMA_PROFILE, use_coreml=True)
    assert created_sessions == [
        ["CoreMLExecutionProvider", "CPUExecutionProvider"],
        ["CPUExecutionProvider"],
    ]
    assert prov.active_ep == "CPUExecutionProvider"
    assert "coreml zero-element" in (prov.coreml_fallback_reason or "")
    vecs = prov.encode(["doc a"])
    assert vecs.shape == (1, 256)
    assert abs(float(np.linalg.norm(vecs[0])) - 1.0) < 1e-5


def test_openai_compat_provider_and_probe(monkeypatch) -> None:
    import requests

    def fake_get(url: str, timeout: float = 1.0):
        if url == "http://127.0.0.1:11434/api/tags":
            return SimpleNamespace(
                ok=True,
                json=lambda: {"models": [{"name": "llama3:8b"}, {"name": "nomic-embed-text:latest"}]},
            )
        raise requests.ConnectionError("refused")

    def fake_post(url: str, json: dict[str, Any], headers: dict[str, str], timeout: float = 10.0):
        assert url == "http://127.0.0.1:11434/v1/embeddings"
        n = len(json["input"])
        data = [{"index": i, "embedding": [float(i + 1)] * 512} for i in range(n)]
        return SimpleNamespace(ok=True, raise_for_status=lambda: None, json=lambda: {"data": data})

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(requests, "post", fake_post)

    servers = probe_local_openai_servers()
    ollama = next(s for s in servers if s["kind"] == "ollama")
    assert ollama["running"] is True
    assert ollama["models"][0]["id"] == "nomic-embed-text:latest"
    assert ollama["models"][0]["likely_embedding"] is True

    prov = OpenAICompatLocalProvider("http://127.0.0.1:11434", "nomic-embed-text:latest", dim=256)
    docs = prov.encode(["a", "b"])
    q = prov.encode_query("hello")
    assert docs.shape == (2, 256)
    assert q.shape == (256,)


def test_embedding_manager_idle_unload_and_persistence(tmp_path) -> None:
    lib_root = tmp_path / "library"
    lib_root.mkdir()
    closed_calls = 0
    created_count = 0

    class _FakeProv:
        model_id = "fake-local"
        dim = 256
        provider_kind = "builtin_onnx"
        active_ep = "CPUExecutionProvider"

        def encode(self, texts, **_kw):
            return np.ones((len(texts), 256), dtype=np.float32)

        def encode_query(self, query):
            return np.ones(256, dtype=np.float32)

        def close(self):
            nonlocal closed_calls
            closed_calls += 1

    def loader(_root: str) -> Any:
        nonlocal created_count
        created_count += 1
        return _FakeProv()

    mgr = EmbeddingManager(library_root=str(lib_root), idle_ttl_sec=0.05)
    p1 = mgr.get_provider(str(lib_root), builtin_loader=loader, builtin_present=lambda _r: True)
    assert p1 is not None and created_count == 1
    p1.encode_query("warm")
    time.sleep(0.15)
    assert closed_calls == 1, "idle timer must unload provider after TTL"

    # Re-loads cleanly after unload
    p2 = mgr.get_provider(str(lib_root), builtin_loader=loader, builtin_present=lambda _r: True)
    assert p2 is not None and created_count == 2

    # Provider config persistence
    mgr.set_config(
        EmbeddingProviderConfig(
            kind="openai_compat",
            base_url="http://127.0.0.1:11434",
            model="qwen3-embedding:0.6b",
            dim=256,
            min_score=0.35,
        )
    )
    assert os.path.isfile(tmp_path / "embedding_provider.json")
    mgr2 = EmbeddingManager(library_root=str(lib_root))
    assert mgr2.get_config().kind == "openai_compat"
    assert mgr2.get_config().model == "qwen3-embedding:0.6b"
    mgr.unload()
