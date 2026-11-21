"""ONNX local embedding provider with lazy imports, MRL truncation, and CoreML safety probe."""

from __future__ import annotations

import os
from typing import Any, Optional, Sequence

import numpy as np

from src.embedding.protocol import BUILTIN_EMBEDDING_GEMMA_PROFILE, OnnxModelProfile
from src.embedding.quantize import l2_normalize, mrl_truncate


class OnnxLocalProvider:
    """Unified ONNX Runtime local embedder (MEAN / CLS / LAST_TOKEN pooling + MRL truncation).

    All heavy imports (``onnxruntime``, ``tokenizers``) happen strictly inside ``__init__``
    so importing ``src.embedding`` stays zero-cost when local semantic models are absent.
    """

    provider_kind: str = "builtin_onnx"
    _DTYPES = {
        "tensor(float)": np.float32,
        "tensor(float16)": np.float16,
        "tensor(int64)": np.int64,
    }

    def __init__(
        self,
        model_dir: str,
        *,
        profile: OnnxModelProfile = BUILTIN_EMBEDDING_GEMMA_PROFILE,
        use_coreml: bool = False,
        onnx_filename: Optional[str] = None,
    ) -> None:
        import onnxruntime as ort  # noqa: PLC0415 — lazy load (~150 MB)
        from tokenizers import Tokenizer  # noqa: PLC0415

        self.model_dir = model_dir
        self.profile = profile
        self.model_id = profile.model_id
        self.max_tokens = int(profile.max_tokens)
        self.dim = int(profile.output_dim if profile.output_dim > 0 else profile.full_dim)
        self.coreml_fallback_reason: Optional[str] = None

        model_name = onnx_filename or os.path.basename(profile.onnx_file)
        model_path = os.path.join(model_dir, model_name)
        tok_path = os.path.join(model_dir, "tokenizer.json")
        if not os.path.isfile(model_path):
            raise FileNotFoundError(f"ONNX model file not found: {model_path}")
        if not os.path.isfile(tok_path):
            raise FileNotFoundError(f"tokenizer.json not found: {tok_path}")

        self._tok: Any = Tokenizer.from_file(tok_path)
        self._tok.no_padding()
        self._tok.enable_truncation(max_length=max(8, self.max_tokens - 1))
        self._eos_id: Optional[int] = self._tok.token_to_id("<|endoftext|>")
        pad_cand = self._tok.token_to_id("<pad>")
        self._pad_id: int = pad_cand if pad_cand is not None else (self._eos_id if self._eos_id is not None else 0)

        available = set(ort.get_available_providers())
        self.session: Any = None
        if use_coreml and "CoreMLExecutionProvider" in available:
            try:
                self.session = self._create_session(ort, model_path, ["CoreMLExecutionProvider", "CPUExecutionProvider"])
                self._init_io_meta()
                # Mandatory 2-sample dummy forward probe with varying sequence lengths:
                # catches graphs that compile cleanly on load but fail at runtime forward.
                self._run_batch(["hello", "hello world dynamic shape coreml probe"])
            except Exception as exc:  # noqa: BLE001 — fail safe onto CPU EP
                from loguru import logger

                self.coreml_fallback_reason = str(exc)
                logger.warning(f"[embedding] CoreML EP probe failed ({exc}); falling back to CPUExecutionProvider")
                self.session = None

        if self.session is None:
            self.session = self._create_session(ort, model_path, ["CPUExecutionProvider"])
            self._init_io_meta()

        self.providers: list[str] = list(self.session.get_providers())
        self.active_ep: str = self.providers[0] if self.providers else "CPUExecutionProvider"

    @staticmethod
    def _create_session(ort: Any, model_path: str, providers: list[str]) -> Any:
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        return ort.InferenceSession(model_path, sess_options=opts, providers=providers)

    def _init_io_meta(self) -> None:
        self._inputs = {i.name: i for i in self.session.get_inputs()}
        self._output_names = [o.name for o in self.session.get_outputs()]

    def _tokenize(self, texts: Sequence[str]) -> tuple[np.ndarray, np.ndarray]:
        encoded = self._tok.encode_batch(list(texts))
        seqs: list[list[int]] = []
        for enc in encoded:
            ids = list(enc.ids)
            if self.profile.append_eos and self._eos_id is not None and (not ids or ids[-1] != self._eos_id):
                ids.append(self._eos_id)
            seqs.append(ids or [self._pad_id])
        width = max(len(s) for s in seqs)
        batch = len(seqs)
        input_ids = np.full((batch, width), self._pad_id, dtype=np.int64)
        mask = np.zeros((batch, width), dtype=np.int64)
        for i, seq in enumerate(seqs):
            input_ids[i, : len(seq)] = seq
            mask[i, : len(seq)] = 1
        return input_ids, mask

    def _feeds(self, input_ids: np.ndarray, mask: np.ndarray) -> dict[str, np.ndarray]:
        batch, width = input_ids.shape
        feeds: dict[str, np.ndarray] = {}
        for name, spec in self._inputs.items():
            if name == "input_ids":
                feeds[name] = input_ids
            elif name == "attention_mask":
                feeds[name] = mask
            elif name == "token_type_ids":
                feeds[name] = np.zeros((batch, width), dtype=np.int64)
            elif name == "position_ids":
                feeds[name] = np.tile(np.arange(width, dtype=np.int64), (batch, 1))
            else:
                dtype = self._DTYPES.get(spec.type, np.float32)
                shape = [
                    batch if isinstance(d, str) and "batch" in d else (0 if isinstance(d, str) else int(d))
                    for d in spec.shape
                ]
                feeds[name] = np.zeros(shape, dtype=dtype)
        return feeds

    def _pool(self, outputs: Sequence[np.ndarray], mask: np.ndarray) -> np.ndarray:
        picked = None
        for i, oname in enumerate(self._output_names):
            if oname in ("sentence_embedding", "last_hidden_state") or outputs[i].ndim in (2, 3):
                cand = np.asarray(outputs[i], dtype=np.float32)
                if cand.ndim in (2, 3):
                    picked = cand
                    break
        if picked is None:
            picked = np.asarray(outputs[0], dtype=np.float32)

        if picked.ndim == 2:
            pooled = l2_normalize(picked)
        elif self.profile.pooling == "cls":
            pooled = l2_normalize(picked[:, 0, :])
        elif self.profile.pooling == "last_token":
            last = np.maximum(mask.sum(axis=1) - 1, 0)
            pooled = l2_normalize(picked[np.arange(picked.shape[0]), last])
        else:
            mask_f = mask.astype(np.float32)[..., None]
            pooled = l2_normalize((picked * mask_f).sum(axis=1) / np.maximum(mask_f.sum(axis=1), 1e-9))

        return mrl_truncate(pooled, self.dim)

    def _run_batch(self, raw_texts: Sequence[str]) -> np.ndarray:
        if self.session is None or self._tok is None:
            raise RuntimeError("OnnxLocalProvider session is closed")
        input_ids, mask = self._tokenize(raw_texts)
        outputs = self.session.run(None, self._feeds(input_ids, mask))
        return self._pool(outputs, mask)

    def encode(self, texts: Sequence[str], *, batch_size: int = 8) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        pref = self.profile.doc_prefix
        prepared = [f"{pref}{t}" if pref else str(t) for t in texts]
        out: list[np.ndarray] = []
        for start in range(0, len(prepared), batch_size):
            out.append(self._run_batch(prepared[start : start + batch_size]))
        return np.concatenate(out, axis=0)

    def encode_query(self, query: str) -> np.ndarray:
        text = f"{self.profile.query_prefix}{query}"
        return self._run_batch([text])[0]

    def close(self) -> None:
        self.session = None
        self._tok = None
