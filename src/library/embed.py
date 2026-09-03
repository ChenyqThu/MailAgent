"""本地语义嵌入 —— onnxruntime 直调 + 标题感知切块 + int8 量化（design §9.1 / P3-L1）。

**绕过 fastembed**：fastembed 0.8 的 ``PoolingType`` 只有 CLS / MEAN / DISABLED，没有
Qwen3-Embedding 要的 last-token 池化。本模块因此自己走四步：tokenizer → ``session.run`` →
取最后一个非 pad token → L2 归一化。query 侧带指令前缀 ``Instruct: {task}\\nQuery: {q}``，
**文档侧不带**（这是 Qwen3-Embedding 的用法，两侧一致反而掉召回）。

零新增依赖：``onnxruntime`` / ``tokenizers`` / ``numpy`` 都已在 ``requirements.lock.txt`` 里
（mem0 那条腿带进来的）。``onnxruntime`` 与 ``requests`` 一律**函数级 import** —— 顶层拉进来等于
每个 serve-api 进程无条件付 150 MB 加载费。

🔴 **模型缺席是正常状态，不是异常**：``load_encoder()`` 没权重就返回 ``None``（不抛），检索退化成
纯 FTS。权重不进 .app，设置页点「下载语义模型」才落 ``DATA_ROOT/library/embed_cache/``。

本模块上半段（切块 / 量化 / token 估算 / 指令前缀）是**纯函数，零权重依赖**，测试全跑；
下半段（下载 / 会话）只在真有权重时才走到。
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Sequence

import numpy as np

from src.library.constants import (
    CHUNK_MAX_MODEL_TOKENS,
    CHUNK_MAX_PER_FILE,
    CHUNK_MIN_TOKENS,
    CHUNK_OVERLAP_TOKENS,
    CHUNK_TARGET_TOKENS,
    EMBED_CACHE_DIRNAME,
    EMBED_DIM,
    EMBED_MODEL_FILE,
    EMBED_MODEL_ID,
    EMBED_MODEL_REPO,
    EMBED_QUERY_TASK,
)
from src.repository.email_repository import _is_cjk_char

#: 权重目录里需要凑齐的文件（本地一律拍平成 basename）。
MODEL_FILES: tuple[str, ...] = (os.path.basename(EMBED_MODEL_FILE), "tokenizer.json", "config.json")
#: 远端相对路径（与 MODEL_FILES 一一对应）。
_REMOTE_FILES: tuple[str, ...] = (EMBED_MODEL_FILE, "tokenizer.json", "config.json")
_HF_URL = "https://huggingface.co/{repo}/resolve/main/{path}"

_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(\S.*)$")


# =============================================================================
# 纯函数：token 估算 / 切块 / 量化 / 指令前缀（零权重依赖）
# =============================================================================


def estimate_tokens(text: str) -> int:
    """Qwen BPE 的**保守**估算：CJK 按 1 token/字，其余按 4 字符/token。

    实测 Qwen 对中文约 0.6–0.8 token/字，这里取 1.0 —— 高估只会让块偏小（安全方向），
    低估会让块超出 ``CHUNK_MAX_MODEL_TOKENS`` 被 tokenizer 从中间截掉（丢内容）。
    """
    if not text:
        return 0
    cjk = sum(1 for c in text if _is_cjk_char(c))
    return cjk + (len(text) - cjk + 3) // 4


@dataclass(frozen=True)
class Chunk:
    """一块。``char_start`` / ``char_end`` 是**原文**切片边界（不含上下文前缀）。"""

    idx: int
    char_start: int
    char_end: int
    text: str
    #: 真正送进模型的串 = 上下文前缀（文件名 + 标题路径）+ 原文切片。
    payload: str
    #: ``sha256(payload)`` —— 前缀变了也算变（重嵌判据，见 service 的增量重嵌）。
    text_hash: str


def _segments(text: str) -> list[tuple[int, int, bool]]:
    """按行切成 ``(start, end, is_heading)``；超长单行再按字符预算劈开（防无换行的大文本）。"""
    out: list[tuple[int, int, bool]] = []
    # 每块最多 CHUNK_TARGET_TOKENS，故单段字符上限按最坏情况（全 CJK，1 token/字）取同值。
    seg_cap = CHUNK_TARGET_TOKENS
    pos = 0
    n = len(text)
    while pos < n:
        nl = text.find("\n", pos)
        end = n if nl == -1 else nl + 1
        line = text[pos:end]
        is_heading = bool(_HEADING_RE.match(line.rstrip("\n")))
        if end - pos <= seg_cap:
            out.append((pos, end, is_heading))
        else:
            cut = pos
            while cut < end:
                out.append((cut, min(cut + seg_cap, end), is_heading and cut == pos))
                cut += seg_cap
        pos = end
    return out


def _heading_trail(trail: list[tuple[int, str]]) -> str:
    """块首之前最近的标题路径（最多两级），拼成 ``一级 > 二级``。"""
    return " > ".join(title for _level, title in trail[-2:])


def _overlap_start(text: str, start: int, end: int, overlap_tokens: int) -> int:
    """块尾往前退到估算 token 达到 ``overlap_tokens`` 的位置；退不动（会与块首重合）就返回 ``end``。"""
    if overlap_tokens <= 0:
        return end
    pos = end
    while pos > start and estimate_tokens(text[pos:end]) < overlap_tokens:
        pos = max(start, pos - 16)
    return pos if start < pos < end else end


def _prefix(filename: str, trail: str) -> str:
    head = filename if not trail else f"{filename} — {trail}"
    return f"{head}\n\n"


def chunk_text(
    text: str,
    *,
    filename: str,
    target_tokens: int = CHUNK_TARGET_TOKENS,
    overlap_tokens: int = CHUNK_OVERLAP_TOKENS,
    max_chunks: int = CHUNK_MAX_PER_FILE,
) -> list[Chunk]:
    """标题感知切块：约 ``target_tokens`` 一块、``overlap_tokens`` 重叠、块内附文件名 + 标题路径。

    markdown 标题另起一块（当前块已达 ``CHUNK_MIN_TOKENS`` 时）；标题处**不做重叠**——新块的第一行
    就是标题，重叠只会把它抄两遍。空白块直接丢弃。
    """
    if not text or not text.strip():
        return []
    segs = _segments(text)
    chunks: list[Chunk] = []
    trail: list[tuple[int, str]] = []  # (level, title)，块首时的快照
    acc: list[tuple[int, int, bool]] = []
    acc_tokens = 0
    acc_trail = ""
    carried = False  # acc 里眼下只有上一块带过来的重叠尾巴（还没有新内容）

    def flush(*, overlap: bool) -> None:
        nonlocal acc, acc_tokens, acc_trail, carried
        if not acc:
            return
        start, end = acc[0][0], acc[-1][1]
        raw = text[start:end]
        # 标题处强制断块时，待发的可能只剩上一块的重叠尾巴（整段被上一块包住）—— 没有新内容，不发。
        duplicate = bool(chunks) and start >= chunks[-1].char_start and not text[chunks[-1].char_end:end].strip()
        if raw.strip() and not duplicate:
            payload = _prefix(filename, acc_trail) + raw
            chunks.append(
                Chunk(
                    idx=len(chunks),
                    char_start=start,
                    char_end=end,
                    text=raw,
                    payload=payload,
                    text_hash=hashlib.sha256(payload.encode("utf-8")).hexdigest(),
                )
            )
        acc, acc_tokens, carried = [], 0, False
        if not overlap:
            return
        # 重叠按**字符尾巴**退，不按整段退：无换行的大文本一段就有几百 token，
        # 整段退会让重叠变成 50%（而不是 15%）。落在段中间不影响 char_start/char_end 的准确性。
        tail = _overlap_start(text, start, end, overlap_tokens)
        if start < tail < end:
            acc = [(tail, end, False)]
            acc_tokens = estimate_tokens(text[tail:end])
            carried = True

    for seg in segs:
        start, end, is_heading = seg
        if is_heading:
            m = _HEADING_RE.match(text[start:end].rstrip("\n"))
            if acc_tokens >= CHUNK_MIN_TOKENS:
                flush(overlap=False)
            if m:
                level = len(m.group(1))
                trail = [t for t in trail if t[0] < level]
                trail.append((level, m.group(2).strip()))
        seg_tokens = estimate_tokens(text[start:end])
        # 先判后加：加完再判会让「一段就有 400 token」的无换行文本直接超一倍。
        # 🔴 但 acc 里只有重叠尾巴时不能提前断 —— 断了就是把尾巴单独发一遍（或丢掉），下一块从段边界重新起，
        # 相邻块**零重叠**，跨块的句子谁都召不回。
        if acc and not carried and acc_tokens + seg_tokens > target_tokens:
            flush(overlap=True)
        if not acc:
            acc_trail = _heading_trail(trail)
        acc.append(seg)
        acc_tokens += seg_tokens
        carried = False
        if acc_tokens >= target_tokens:
            flush(overlap=True)
        if len(chunks) >= max_chunks:
            return chunks[:max_chunks]
    flush(overlap=False)
    return chunks[:max_chunks]


def query_text(query: str, *, task: str = EMBED_QUERY_TASK) -> str:
    """query 侧指令前缀（文档侧不带 —— 两侧都带会把 query 向量拉向指令本身）。"""
    return f"Instruct: {task}\nQuery: {query}"


def quantize(vec: Sequence[float]) -> bytes:
    """L2 归一化后的向量 → int8（scale 127，无 per-vector scale：分量恒在 [-1, 1]）。1024 维 = 1 KB。"""
    arr = np.asarray(vec, dtype=np.float32)
    return np.clip(np.rint(arr * 127.0), -127, 127).astype(np.int8).tobytes()


def dequantize(blobs: Iterable[bytes], *, dim: int = EMBED_DIM) -> np.ndarray:
    """一批 int8 blob → ``(n, dim)`` float32 矩阵（已除回 127；仍近似 L2 归一）。"""
    rows = [np.frombuffer(b, dtype=np.int8) for b in blobs]
    if not rows:
        return np.zeros((0, dim), dtype=np.float32)
    return np.stack(rows).astype(np.float32) / 127.0


def l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=-1, keepdims=True)
    return mat / np.maximum(norms, 1e-12)


# =============================================================================
# 权重：目录 / 下载 / 会话（缺席是正常状态）
# =============================================================================


def cache_dir(library_root: str) -> str:
    """``<library_root>/embed_cache/<model_id>/``。

    🔴 挂在库根下不会被索引：库根的树与全量扫描都只从 ``ROOT_WRITABLE_TOP`` 四个 slug 出发
    （``service._walk_dirs`` / ``service.tree``），``embed_cache`` 不在其中。
    """
    return os.path.join(library_root, EMBED_CACHE_DIRNAME, EMBED_MODEL_ID)


def model_present(library_root: str) -> bool:
    d = cache_dir(library_root)
    return all(os.path.isfile(os.path.join(d, name)) for name in MODEL_FILES)


def model_bytes_on_disk(library_root: str) -> int:
    d = cache_dir(library_root)
    total = 0
    for name in MODEL_FILES:
        try:
            total += os.path.getsize(os.path.join(d, name))
        except OSError:
            pass
    return total


def download_model(
    library_root: str,
    *,
    progress: Optional[Callable[[int, int], None]] = None,
    chunk_bytes: int = 1 << 20,
) -> str:
    """把权重拉到 ``cache_dir()``（约 614 MB）。写 ``.part`` 再 rename —— 中断不会留下半个可用模型。

    只在用户在设置页显式点「下载语义模型」时调用；除这一次外整条语义链路零网络。
    """
    import requests  # 函数级：serve-api 常驻进程不为一个可选功能付顶层 import

    target = cache_dir(library_root)
    os.makedirs(target, exist_ok=True)
    done_bytes = 0
    total_bytes = 0
    for remote, name in zip(_REMOTE_FILES, MODEL_FILES):
        dest = os.path.join(target, name)
        if os.path.isfile(dest):
            done_bytes += os.path.getsize(dest)
            total_bytes = max(total_bytes, done_bytes)
            continue
        url = _HF_URL.format(repo=EMBED_MODEL_REPO, path=remote)
        tmp = dest + ".part"
        with requests.get(url, stream=True, timeout=60) as resp:
            resp.raise_for_status()
            total_bytes = max(total_bytes, done_bytes + int(resp.headers.get("content-length") or 0))
            with open(tmp, "wb") as fh:
                for block in resp.iter_content(chunk_size=chunk_bytes):
                    if not block:
                        continue
                    fh.write(block)
                    done_bytes += len(block)
                    if progress is not None:
                        progress(done_bytes, max(total_bytes, done_bytes))
        os.replace(tmp, dest)
    if progress is not None:
        progress(done_bytes, max(total_bytes, done_bytes))
    return target


class OnnxEncoder:
    """Qwen3-Embedding 的 ONNX 会话：tokenize → run → last-token 池化 → L2 归一。

    ``providers`` 缺省先试 CoreML 再回落 CPU；int8 图在 CoreML 上常整体回落 CPU，是否真有加速由 PoC 定。
    """

    def __init__(self, model_dir: str, *, use_coreml: bool = False, max_tokens: int = CHUNK_MAX_MODEL_TOKENS) -> None:
        import onnxruntime as ort  # 函数级：~150 MB，只有真跑语义时才付
        from tokenizers import Tokenizer

        self.model_dir = model_dir
        self.max_tokens = int(max_tokens)
        self.model_id = EMBED_MODEL_ID
        self.dim = EMBED_DIM
        self._tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self._tok.no_padding()
        self._tok.enable_truncation(max_length=max(8, self.max_tokens - 1))
        available = set(ort.get_available_providers())
        wanted = [p for p in (("CoreMLExecutionProvider",) if use_coreml else ()) if p in available]
        wanted.append("CPUExecutionProvider")
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            os.path.join(model_dir, os.path.basename(EMBED_MODEL_FILE)), sess_options=opts, providers=wanted
        )
        self.providers = list(self.session.get_providers())
        self._inputs = {i.name: i for i in self.session.get_inputs()}
        self._eos_id = self._tok.token_to_id("<|endoftext|>")
        self._pad_id = self._eos_id if self._eos_id is not None else 0

    # ── 内部 ──────────────────────────────────────────────────────────────

    def _tokenize(self, texts: Sequence[str]) -> tuple[np.ndarray, np.ndarray]:
        """右 padding + 末尾补 EOS（Qwen3-Embedding 的 last-token 池化取的就是这个位置）。"""
        encoded = self._tok.encode_batch(list(texts))
        seqs: list[list[int]] = []
        for enc in encoded:
            ids = list(enc.ids)
            if self._eos_id is not None and (not ids or ids[-1] != self._eos_id):
                ids.append(self._eos_id)
            seqs.append(ids or [self._pad_id])
        width = max(len(s) for s in seqs)
        input_ids = np.full((len(seqs), width), self._pad_id, dtype=np.int64)
        mask = np.zeros((len(seqs), width), dtype=np.int64)
        for i, seq in enumerate(seqs):
            input_ids[i, : len(seq)] = seq
            mask[i, : len(seq)] = 1
        return input_ids, mask

    _DTYPES = {"tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(int64)": np.int64}

    def _feeds(self, input_ids: np.ndarray, mask: np.ndarray) -> dict[str, np.ndarray]:
        """按图**声明的**输入喂参：transformers.js 风格的导出还要 position_ids + 空 past_key_values。"""
        batch, width = input_ids.shape
        feeds: dict[str, np.ndarray] = {}
        for name, spec in self._inputs.items():
            if name == "input_ids":
                feeds[name] = input_ids
            elif name == "attention_mask":
                feeds[name] = mask
            elif name == "position_ids":
                feeds[name] = np.tile(np.arange(width, dtype=np.int64), (batch, 1))
            else:
                dtype = self._DTYPES.get(spec.type, np.float32)
                shape = [batch if isinstance(d, str) and "batch" in d else (0 if isinstance(d, str) else int(d)) for d in spec.shape]
                feeds[name] = np.zeros(shape, dtype=dtype)
        return feeds

    def _pool(self, outputs: Sequence[np.ndarray], mask: np.ndarray) -> np.ndarray:
        names = [o.name for o in self.session.get_outputs()]
        picked = None
        for i, name in enumerate(names):
            if name in ("sentence_embedding", "last_hidden_state") or outputs[i].ndim in (2, 3):
                picked = np.asarray(outputs[i], dtype=np.float32)
                if picked.ndim in (2, 3):
                    break
        if picked is None:
            picked = np.asarray(outputs[0], dtype=np.float32)
        if picked.ndim == 2:  # 已经池化过的导出，直接归一
            return l2_normalize(picked)
        last = np.maximum(mask.sum(axis=1) - 1, 0)
        return l2_normalize(picked[np.arange(picked.shape[0]), last])

    # ── 对外 ──────────────────────────────────────────────────────────────

    def encode(self, texts: Sequence[str], *, batch_size: int = 8) -> np.ndarray:
        """文档侧（**不带**指令前缀）→ ``(n, dim)`` float32，已 L2 归一。"""
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        out: list[np.ndarray] = []
        for start in range(0, len(texts), batch_size):
            batch = list(texts[start : start + batch_size])
            input_ids, mask = self._tokenize(batch)
            outputs = self.session.run(None, self._feeds(input_ids, mask))
            out.append(self._pool(outputs, mask))
        return np.concatenate(out, axis=0)

    def encode_query(self, query: str) -> np.ndarray:
        """query 侧（带 ``Instruct:`` 前缀）→ ``(dim,)`` float32。"""
        return self.encode([query_text(query)])[0]


def load_encoder(library_root: str, *, use_coreml: bool = False) -> Optional[Any]:
    """有权重就开会话，**没权重返回 None**（不是异常 —— 纯 FTS 是合法的常态）。

    开会话本身失败（图不匹配 / EP 挂了）也返回 None：语义 lane 是增强，不该把检索整条打死。

    🔴 ``use_coreml`` 默认 **False**（2026-09-03 实测改的）。CoreML EP 会接下这张图的 141 个分区，
    但一 ``run`` 就炸：

        coreml_execution_provider.cc:222 Input (past_key_values.0.key) has a dynamic shape
        ({-1,8,-1,128}) but the runtime shape ({3,8,0,128}) has zero elements.

    Qwen3 的导出图带 KV-cache 输入，首次前向时它们是**零元素**张量，而 CoreML EP 不收零元素的
    动态形状。这不是机器差异，是这张图的结构决定的 —— 任何 Mac 都会撞。更麻烦的是 ORT 不会为此
    回落到 CPU：分区在 CoreML 上失败就整条 ``run`` 抛异常，而 ``load_encoder`` 只捕获**建会话**
    阶段的异常，所以留着这个默认值等于交出一个「建得起来、一用就炸」的 encoder。
    参数保留：将来 ORT / CoreML 支持零元素动态形状后，重测一次就能翻回来。
    """
    if not model_present(library_root):
        return None
    try:
        return OnnxEncoder(cache_dir(library_root), use_coreml=use_coreml)
    except Exception as exc:  # noqa: BLE001 — 见 docstring：语义 lane 坏了也只降级
        from loguru import logger

        logger.warning(f"[library] semantic encoder unavailable: {exc}")
        return None
