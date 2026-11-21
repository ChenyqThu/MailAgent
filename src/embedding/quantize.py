"""MRL truncation, int8 scalar quantization, Binary Quantization (BQ), and two-stage search ranking."""

from __future__ import annotations

from typing import Iterable, Optional, Sequence

import numpy as np

# 256-entry LUT avoids per-row Python loops during XOR + Hamming coarse scoring.
_POPCOUNT_LUT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def l2_normalize(mat: np.ndarray) -> np.ndarray:
    """Row-wise L2 normalization (handles 1D or 2D float arrays safely)."""
    arr = np.asarray(mat, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=-1, keepdims=True)
    return arr / np.maximum(norms, 1e-12)


def mrl_truncate(mat: np.ndarray, dim: int) -> np.ndarray:
    """Truncate trailing Matryoshka dimensions and re-normalize rows L2."""
    arr = np.asarray(mat, dtype=np.float32)
    if dim > 0 and arr.shape[-1] > dim:
        arr = arr[..., :dim]
    return l2_normalize(arr)


def quantize_int8(vec: Sequence[float] | np.ndarray) -> bytes:
    """Quantize L2-normalized unit vector -> int8 bytes (1 byte/dim, scale 127)."""
    arr = np.asarray(vec, dtype=np.float32)
    return np.clip(np.rint(arr * 127.0), -127, 127).astype(np.int8).tobytes()


def dequantize_int8(blobs: Iterable[bytes], *, dim: int) -> np.ndarray:
    """Restore ``int8`` blobs into ``(n, dim)`` float32 vectors divided by 127.0."""
    rows = [np.frombuffer(b, dtype=np.int8) for b in blobs]
    if not rows:
        return np.zeros((0, dim), dtype=np.float32)
    return np.stack(rows).astype(np.float32) / 127.0


def pack_bq(vec: Sequence[float] | np.ndarray) -> bytes:
    """Sign-bit Binary Quantization: float/int8 vector -> packed bits (dim // 8 bytes)."""
    arr = np.asarray(vec)
    bits = (arr > 0).astype(np.uint8)
    return np.packbits(bits, axis=-1).tobytes()


def unpack_bq_matrix(blobs: Sequence[bytes | None], fallback_i8_mat: np.ndarray) -> Optional[np.ndarray]:
    """Load packed BQ rows aligned with ``fallback_i8_mat``; derives missing BQ bits if needed."""
    n = len(blobs)
    if n == 0 or fallback_i8_mat.ndim != 2 or fallback_i8_mat.shape[0] != n:
        return None
    dim = fallback_i8_mat.shape[1]
    expected_bytes = (dim + 7) // 8
    out = np.empty((n, expected_bytes), dtype=np.uint8)
    for i, raw in enumerate(blobs):
        if raw is not None and len(raw) == expected_bytes:
            out[i] = np.frombuffer(raw, dtype=np.uint8)
        else:
            out[i] = np.packbits((fallback_i8_mat[i] > 0).astype(np.uint8))
    return out


def two_stage_rank(
    qvec: Sequence[float] | np.ndarray,
    vec_mat: np.ndarray,
    bq_mat: Optional[np.ndarray] = None,
    *,
    top_k: int = 50,
    bq_candidates: int = 100,
    min_score: float = 0.48,
) -> list[tuple[int, float]]:
    """Two-stage BQ Hamming coarse filter (top-100) + int8 cosine rerank over ``min_score``.

    Accepts ``vec_mat`` as either ``np.int8`` (scaled on candidates only to minimize memory/CPU)
    or ``np.float32`` already normalized. Returns ``[(row_idx, score), ...]`` descending.
    """
    n = int(vec_mat.shape[0]) if vec_mat.ndim == 2 else 0
    if n == 0 or top_k <= 0:
        return []
    q = l2_normalize(np.asarray(qvec, dtype=np.float32).reshape(-1))
    dim = int(vec_mat.shape[1])
    if q.shape[0] != dim:
        if q.shape[0] > dim:
            q = mrl_truncate(q, dim)
        else:
            return []

    if bq_mat is not None and len(bq_mat) == n and n > bq_candidates > 0:
        q_bq = np.packbits((q > 0.0).astype(np.uint8))
        xor = np.bitwise_xor(bq_mat, q_bq)
        hamming = _POPCOUNT_LUT[xor].sum(axis=1)
        k_th = min(bq_candidates, n) - 1
        cand_idx = np.argpartition(hamming, k_th)[:bq_candidates]
        sub = vec_mat[cand_idx]
        if sub.dtype == np.int8:
            sub_f = sub.astype(np.float32) / 127.0
        else:
            sub_f = np.asarray(sub, dtype=np.float32)
        sub_scores = sub_f @ q
        mask = np.flatnonzero(sub_scores >= min_score)
        pairs = [(int(cand_idx[i]), float(sub_scores[i])) for i in mask]
    else:
        if vec_mat.dtype == np.int8:
            mat_f = vec_mat.astype(np.float32) / 127.0
        else:
            mat_f = np.asarray(vec_mat, dtype=np.float32)
        scores = mat_f @ q
        mask = np.flatnonzero(scores >= min_score)
        pairs = [(int(i), float(scores[i])) for i in mask]

    pairs.sort(key=lambda item: (-item[1], item[0]))
    return pairs[:top_k]
