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
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Sequence
from urllib.parse import urlparse

import numpy as np

from src.embedding.protocol import BUILTIN_EMBEDDING_GEMMA_PROFILE
from src.embedding.quantize import (
    dequantize_int8 as _emb_dequantize,
    l2_normalize,
    pack_bq,
    quantize_int8 as quantize,
)
from src.library.constants import (
    CHUNK_MAX_MODEL_TOKENS,
    CHUNK_MAX_PER_FILE,
    CHUNK_MIN_TOKENS,
    CHUNK_OVERLAP_TOKENS,
    CHUNK_TARGET_TOKENS,
    EMBED_CACHE_DIRNAME,
    EMBED_DIM,
    EMBED_DOC_PREFIX,
    EMBED_MODEL_EXTRA_FILES,
    EMBED_MODEL_FILE,
    EMBED_MODEL_ID,
    EMBED_MODEL_REPO,
    EMBED_QUERY_PREFIX,
    EMBED_QUERY_TASK,
)
from src.repository.email_repository import _is_cjk_char

#: 远端相对路径（含可选外部权重文件，如 ``onnx/model_q4.onnx_data``）。
_REMOTE_FILES: tuple[str, ...] = (
    EMBED_MODEL_FILE,
    *EMBED_MODEL_EXTRA_FILES,
    "tokenizer.json",
    "config.json",
)
#: 权重目录里需要凑齐的文件（本地一律拍平成 basename）。
MODEL_FILES: tuple[str, ...] = tuple(os.path.basename(p) for p in _REMOTE_FILES)
_DEFAULT_MIRRORS: tuple[str, ...] = ("https://huggingface.co", "https://hf-mirror.com")
_HF_URL = "{base}/{repo}/resolve/main/{path}"

_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(\S.*)$")


class DownloadCancelled(Exception):
    """下载被用户主动取消（保留 ``.part`` 文件供断点续传）。"""


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


def query_text(query: str, *, prefix: str = EMBED_QUERY_PREFIX) -> str:
    """query 侧提示前缀（EmbeddingGemma 默认 `task: search result | query: `）。"""
    return f"{prefix}{query}"


def doc_text(text: str, *, prefix: str = EMBED_DOC_PREFIX) -> str:
    """文档块侧提示前缀（与 query 侧区分）。"""
    return f"{prefix}{text}"


def dequantize(blobs: Iterable[bytes], *, dim: int = EMBED_DIM) -> np.ndarray:
    """一批 int8 blob → ``(n, dim)`` float32 矩阵（已除回 127；仍近似 L2 归一）。"""
    return _emb_dequantize(blobs, dim=dim)


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


def _parse_total_from_content_range(header: Optional[str]) -> Optional[int]:
    """解析 HTTP ``Content-Range: bytes start-end/total`` 或 ``bytes */total`` 中的总字节数。"""
    if not header or "/" not in header:
        return None
    tail = header.rsplit("/", 1)[-1].strip()
    if not tail or tail == "*":
        return None
    try:
        val = int(tail)
        return val if val >= 0 else None
    except ValueError:
        return None


def _build_mirror_list(endpoints: Optional[Sequence[str]]) -> list[str]:
    ordered: list[str] = []
    for ep in [*(endpoints or ()), *_DEFAULT_MIRRORS]:
        cleaned = str(ep or "").strip().rstrip("/")
        if cleaned and cleaned not in ordered:
            ordered.append(cleaned)
    return ordered


def download_model(
    library_root: str,
    *,
    progress: Optional[Callable[[int, int], None]] = None,
    on_metrics: Optional[Callable[[dict[str, Any]], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    endpoints: Optional[Sequence[str]] = None,
    chunk_bytes: int = 1 << 20,
) -> str:
    """把权重拉到 ``cache_dir()``（约 614 MB）。写 ``.part`` 再 rename —— 支持镜像回退、HTTP Range 断点续传与取消。

    只在用户在设置页显式点「下载语义模型」时调用；除这一次外整条语义链路零网络。
    """
    import requests  # 函数级：serve-api 常驻进程不为一个可选功能付顶层 import
    from loguru import logger

    target = cache_dir(library_root)
    os.makedirs(target, exist_ok=True)
    mirrors = _build_mirror_list(endpoints)

    done_bytes = 0
    total_bytes = 0
    ema_speed: Optional[float] = None

    def _emit_metrics(mirror_host: str) -> None:
        if on_metrics is None:
            return
        eta: Optional[int] = None
        if ema_speed is not None and ema_speed > 0 and total_bytes > done_bytes:
            eta = int((total_bytes - done_bytes) / ema_speed)
        on_metrics({"speed_bps": ema_speed, "eta_seconds": eta, "mirror": mirror_host})

    for remote, name in zip(_REMOTE_FILES, MODEL_FILES):
        if cancel_event is not None and cancel_event.is_set():
            raise DownloadCancelled("download cancelled")
        dest = os.path.join(target, name)
        if os.path.isfile(dest):
            done_bytes += os.path.getsize(dest)
            total_bytes = max(total_bytes, done_bytes)
            continue

        tmp = dest + ".part"
        base_completed = done_bytes
        last_exc: Optional[Exception] = None
        downloaded = False

        for mirror_idx, base in enumerate(mirrors):
            mirror_host = urlparse(base).netloc or base
            url = _HF_URL.format(base=base, repo=EMBED_MODEL_REPO, path=remote)
            resume_offset = os.path.getsize(tmp) if os.path.isfile(tmp) else 0
            try:
                use_range = resume_offset > 0
                for _attempt in range(2):
                    if cancel_event is not None and cancel_event.is_set():
                        raise DownloadCancelled("download cancelled")
                    headers = {"Range": f"bytes={resume_offset}-"} if use_range else {}
                    with requests.get(url, headers=headers, stream=True, timeout=(10, 60)) as resp:
                        if resp.status_code == 416 and use_range:
                            cr_total = _parse_total_from_content_range(resp.headers.get("Content-Range"))
                            if cr_total is not None and cr_total == resume_offset:
                                done_bytes = base_completed + resume_offset
                                total_bytes = max(total_bytes, done_bytes)
                                os.replace(tmp, dest)
                                downloaded = True
                                break
                            # `.part` 大小异常，退回从 0 重下
                            resume_offset = 0
                            use_range = False
                            if os.path.isfile(tmp):
                                os.unlink(tmp)
                            continue

                        resp.raise_for_status()
                        if resp.status_code == 206 and use_range:
                            open_mode = "ab"
                            file_total = _parse_total_from_content_range(resp.headers.get("Content-Range"))
                            if file_total is None:
                                cl = int(resp.headers.get("content-length") or 0)
                                file_total = (resume_offset + cl) if cl > 0 else 0
                            done_bytes = base_completed + resume_offset
                        else:
                            open_mode = "wb"
                            resume_offset = 0
                            file_total = int(resp.headers.get("content-length") or 0)
                            done_bytes = base_completed

                        if file_total > 0:
                            total_bytes = max(total_bytes, base_completed + file_total)
                        _emit_metrics(mirror_host)
                        if progress is not None:
                            progress(done_bytes, max(total_bytes, done_bytes))

                        win_start = time.monotonic()
                        win_bytes = 0
                        with open(tmp, open_mode) as fh:
                            for block in resp.iter_content(chunk_size=chunk_bytes):
                                if cancel_event is not None and cancel_event.is_set():
                                    raise DownloadCancelled("download cancelled")
                                if not block:
                                    continue
                                fh.write(block)
                                n = len(block)
                                done_bytes += n
                                win_bytes += n
                                now = time.monotonic()
                                dt = now - win_start
                                if dt >= 0.25 and win_bytes > 0:
                                    inst = win_bytes / dt
                                    ema_speed = inst if ema_speed is None else (0.35 * inst + 0.65 * ema_speed)
                                    win_start = now
                                    win_bytes = 0
                                    _emit_metrics(mirror_host)
                                if progress is not None:
                                    progress(done_bytes, max(total_bytes, done_bytes))
                        os.replace(tmp, dest)
                        downloaded = True
                        # 记住本轮可用镜像，后续文件优先走它
                        if mirror_idx > 0:
                            mirrors = [base] + [m for m in mirrors if m != base]
                        break
                if downloaded:
                    break
            except DownloadCancelled:
                raise
            except Exception as exc:  # noqa: BLE001 — 镜像失败尝试下一个（如 Network/HTTP error）
                last_exc = exc
                done_bytes = base_completed
                logger.warning(f"[library] download {name} from {mirror_host} failed: {exc}")
                continue

        if not downloaded:
            assert last_exc is not None
            raise last_exc

    if progress is not None:
        progress(done_bytes, max(total_bytes, done_bytes))
    return target


class OnnxEncoder:
    """向后兼容封装 —— 委托给统一 ``OnnxLocalProvider``（支持 MRL + CoreML 安全探针）。"""

    def __init__(self, model_dir: str, *, use_coreml: bool = False, max_tokens: int = CHUNK_MAX_MODEL_TOKENS) -> None:
        from dataclasses import replace  # noqa: PLC0415
        from src.embedding.onnx_provider import OnnxLocalProvider  # noqa: PLC0415

        prof = replace(BUILTIN_EMBEDDING_GEMMA_PROFILE, max_tokens=int(max_tokens))
        self._inner = OnnxLocalProvider(model_dir, profile=prof, use_coreml=use_coreml)
        self.model_dir = model_dir
        self.model_id = self._inner.model_id
        self.dim = self._inner.dim
        self.providers = list(self._inner.providers)
        self.active_ep = self._inner.active_ep
        self.provider_kind = self._inner.provider_kind
        self.session = self._inner.session

    def encode(self, texts: Sequence[str], *, batch_size: int = 8) -> np.ndarray:
        return self._inner.encode(texts, batch_size=batch_size)

    def encode_query(self, query: str) -> np.ndarray:
        return self._inner.encode_query(query)

    def close(self) -> None:
        self._inner.close()


def load_encoder(library_root: str, *, use_coreml: bool = False) -> Optional[Any]:
    """有权重就开会话，**没权重返回 None**（不是异常 —— 纯 FTS 是合法的常态）。

    Step 4A PoC 实测：Apple Silicon 上 CoreML EP 对单 query 推理比 CPU EP 慢 7–13 倍，
    故 ``use_coreml`` 缺省保持 ``False``；开启时自动执行 2-token dummy forward 探针并在失败时回落 CPU。
    """
    if not model_present(library_root):
        return None
    try:
        return OnnxEncoder(cache_dir(library_root), use_coreml=use_coreml)
    except Exception as exc:  # noqa: BLE001 — 语义 lane 坏了也只降级
        from loguru import logger

        logger.warning(f"[library] semantic encoder unavailable: {exc}")
        return None
