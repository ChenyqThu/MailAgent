"""语义嵌入：切块 / 量化 / 增量重嵌 / 权重缺席（design §9.1，P3-L1）。

🔴 **本文件不许依赖 614 MB 权重**：纯函数部分零权重，服务部分一律注入假 encoder。CI 上不下载模型。
"""

from __future__ import annotations

import hashlib
from typing import Any, Sequence

import numpy as np
import pytest

from src.library import embed as E
from src.library import service as service_module
from src.library.constants import (
    CHUNK_OVERLAP_TOKENS,
    CHUNK_TARGET_TOKENS,
    EMBED_CACHE_DIRNAME,
    EMBED_DIM,
    EMBED_MODEL_APPROX_BYTES,
    EMBED_MODEL_ID,
    EMBED_MODEL_REPO,
)
from src.library.service import LibraryError, LibraryService

# =============================================================================
# 纯函数（零权重）
# =============================================================================


def test_estimate_tokens_counts_cjk_per_char_and_latin_per_four() -> None:
    assert E.estimate_tokens("") == 0
    assert E.estimate_tokens("研发排期") == 4  # CJK：1 token/字
    assert E.estimate_tokens("abcd") == 1  # 拉丁：4 字符/token
    # 混排取和，且**不会低估**（低估会让块超模型上下文被从中间截掉）。
    mixed = "研发deadline"
    assert E.estimate_tokens(mixed) >= len("deadline") // 4 + 2


def test_chunk_offsets_are_exact_and_cover_all_non_space_content() -> None:
    text = "# 周报\n\n" + ("本周完成排期与需求评审，下周继续推进。" * 60) + "\n\n## 风险\n\n" + ("vendor risk needs escalation. " * 60)
    chunks = E.chunk_text(text, filename="周报.md")
    assert len(chunks) > 3
    for c in chunks:
        assert text[c.char_start:c.char_end] == c.text, "char_start/char_end 与原文对不上"
        assert c.payload.endswith(c.text), "payload 必须是「上下文前缀 + 原文切片」"
        assert c.text_hash == hashlib.sha256(c.payload.encode("utf-8")).hexdigest()
    assert [c.idx for c in chunks] == list(range(len(chunks)))
    covered: set[int] = set()
    for c in chunks:
        covered |= set(range(c.char_start, c.char_end))
    missing = [i for i in range(len(text)) if i not in covered and not text[i].isspace()]
    assert missing == [], f"{len(missing)} 个非空白字符没进任何块 —— 这些内容永远搜不到"


def test_chunk_respects_token_budget_and_overlaps_previous_chunk() -> None:
    # 无换行的大文本：一段就有几百 token，最容易把块撑到目标的一倍。
    flat = "汇报" * 3000
    chunks = E.chunk_text(flat, filename="flat.txt")
    assert len(chunks) > 5
    assert max(E.estimate_tokens(c.text) for c in chunks) <= CHUNK_TARGET_TOKENS * 5 // 4
    for prev, cur in zip(chunks, chunks[1:]):
        overlap = prev.char_end - cur.char_start
        assert overlap > 0, "相邻块必须重叠（跨块的句子否则谁都召不回）"
        assert E.estimate_tokens(flat[cur.char_start:prev.char_end]) <= CHUNK_OVERLAP_TOKENS * 3


def test_chunk_is_heading_aware_and_carries_filename_plus_heading_as_context() -> None:
    md = "# 架构\n\n" + "alpha " * 30 + "\n\n## 风险\n\n" + "beta " * 30 + "\n\n### 缓解\n\n" + "gamma " * 30
    chunks = E.chunk_text(md, filename="notes.md")
    heads = [c.payload.splitlines()[0] for c in chunks]
    assert heads[0] == "notes.md — 架构"
    assert "风险" in heads[1] and "架构" in heads[1]
    assert "缓解" in heads[-1]
    # 每个标题各自起一块（标题处不重叠 —— 重叠只会把标题抄两遍）。
    assert [c.text.lstrip().startswith("#") for c in chunks] == [True] * len(chunks)


def test_chunk_edge_cases_empty_and_cap() -> None:
    assert E.chunk_text("", filename="x.md") == []
    assert E.chunk_text("   \n\n\t ", filename="x.md") == []
    capped = E.chunk_text("汇报" * 20000, filename="x.md", max_chunks=5)
    assert len(capped) == 5


def test_query_gets_instruct_prefix_and_documents_do_not() -> None:
    q = E.query_text("预算超了多少")
    assert q.startswith("Instruct: ") and "\nQuery: 预算超了多少" in q
    doc = E.chunk_text("预算超了多少" * 20, filename="a.md")[0]
    assert "Instruct:" not in doc.payload, "文档侧带指令前缀会把向量拉向指令本身"


def test_int8_quantization_is_one_byte_per_dim_and_keeps_direction() -> None:
    rng = np.random.default_rng(7)
    vec = rng.standard_normal(EMBED_DIM).astype(np.float32)
    vec /= np.linalg.norm(vec)
    blob = E.quantize(vec)
    assert len(blob) == EMBED_DIM, "1024 维 int8 必须正好 1 KB / 块"
    back = E.dequantize([blob])
    assert back.shape == (1, EMBED_DIM)
    cos = float(back[0] @ vec / np.linalg.norm(back[0]))
    assert cos > 0.99, f"int8 量化后方向掉太多：cos={cos}"
    assert E.dequantize([]).shape == (0, EMBED_DIM)


def test_model_absent_is_a_normal_state_not_an_exception(tmp_path) -> None:
    root = str(tmp_path / "library")
    assert E.model_present(root) is False
    assert E.model_bytes_on_disk(root) == 0
    assert E.load_encoder(root) is None, "没权重必须返回 None（纯 FTS 是合法常态），不能抛"
    assert E.cache_dir(root).endswith(f"{EMBED_CACHE_DIRNAME}/{EMBED_MODEL_ID}")


# =============================================================================
# 假 encoder（服务层用；一次权重也不加载）
# =============================================================================


class FakeEncoder:
    """确定性假 encoder：词 → 固定基向量之和，同义词映到同一个基（这样向量腿真能召回 FTS 召不回的东西）。"""

    #: 「哪些串在语义上是一回事」。真模型靠权重学到这层关系，假 encoder 直接写死 ——
    #: 单字 `预` 也进表，因为 1 字 CJK 恰恰是 FTS 拦掉、只能靠向量腿答的那一类 query。
    SYNONYMS = {"预算": "budget", "预": "budget", "费用": "budget", "开销": "budget", "budget": "budget"}

    def __init__(self) -> None:
        self.calls = 0
        self.encoded: list[str] = []

    def _vec(self, text: str) -> np.ndarray:
        out = np.zeros(EMBED_DIM, dtype=np.float32)
        for word, concept in self.SYNONYMS.items():
            if word in text:
                idx = int(hashlib.sha256(concept.encode()).hexdigest()[:8], 16) % EMBED_DIM
                out[idx] += 1.0
        idx = int(hashlib.sha256(text.strip()[:32].encode()).hexdigest()[:8], 16) % EMBED_DIM
        out[idx] += 0.25
        norm = float(np.linalg.norm(out))
        return out / norm if norm else out

    def encode(self, texts: Sequence[str], **_kw: Any) -> np.ndarray:
        self.calls += 1
        self.encoded.extend(texts)
        return np.stack([self._vec(t) for t in texts]) if texts else np.zeros((0, EMBED_DIM), dtype=np.float32)

    def encode_query(self, query: str) -> np.ndarray:
        return self.encode([E.query_text(query)])[0]


@pytest.fixture()
def svc(tmp_path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))


@pytest.fixture()
def fake(monkeypatch) -> FakeEncoder:
    """把权重探测与会话构造替换掉 —— 服务层其余代码路径与真模型完全一致。

    顺带把 ``_kick_index`` 摁成 no-op：本文件要逐批数「这一轮嵌了几块」，而搜索会顺手起一个后台线程
    去建索引（那条行为由 ``test_search_kicks_the_background_index_queue_*`` 单独钉），不摁住就是
    与自己起的线程抢同一批文件。
    """
    encoder = FakeEncoder()
    monkeypatch.setattr(service_module.E, "model_present", lambda _root: True)
    monkeypatch.setattr(service_module.E, "load_encoder", lambda _root, **_kw: encoder)
    monkeypatch.setattr(LibraryService, "_kick_index", lambda _self: None)
    return encoder


def _index(svc: LibraryService) -> dict[str, Any]:
    """跑到队列空为止（不走后台线程，测试里同步跑）。"""
    total = {"files": 0, "chunks": 0}
    while True:
        batch = svc.embed_pending(max_files=8)
        total["files"] += batch["files"]
        total["chunks"] += batch["chunks"]
        if not batch["available"] or batch["files"] == 0:
            return {**total, "remaining": batch["remaining"]}


# =============================================================================
# 服务层
# =============================================================================


def test_embed_pending_is_a_noop_without_the_model(svc: LibraryService) -> None:
    svc.create_file("my-docs/a.md", "预算相关的记录".encode())
    svc.search("预算")  # 触发抽取，让 library_text 有行
    assert svc.embed_pending() == {"available": False, "files": 0, "chunks": 0, "remaining": 0}
    status = svc.embed_status()
    assert status["model"]["available"] is False and status["index"]["chunks"] == 0
    assert status["job"] is None
    with pytest.raises(LibraryError) as exc_info:
        svc.start_index_job()
    assert exc_info.value.code == "E_INVALID_STATE"


def test_embed_indexes_extracted_files_and_reports_progress(svc: LibraryService, fake: FakeEncoder) -> None:
    svc.create_file("my-docs/a.md", ("# 预算\n\n" + "本季度预算与费用明细。" * 40).encode())
    svc.create_file("my-docs/b.md", ("# 排期\n\n" + "研发排期与里程碑。" * 40).encode())
    svc.search("预算")  # 抽取
    before = svc.embed_status()["index"]
    assert before["files_total"] == 2 and before["files_pending"] == 2 and before["files_indexed"] == 0

    done = _index(svc)
    assert done["files"] == 2 and done["chunks"] > 0 and done["remaining"] == 0
    after = svc.embed_status()["index"]
    assert after["files_pending"] == 0 and after["files_indexed"] == 2 and after["chunks"] == done["chunks"]
    assert svc.embed_status()["model"] == {
        "available": True, "model_id": EMBED_MODEL_ID, "repo": EMBED_MODEL_REPO,
        "approx_bytes": EMBED_MODEL_APPROX_BYTES, "bytes_on_disk": 0,
    }
    # 队列空了就不再跑模型。
    calls = fake.calls
    assert svc.embed_pending() == {"available": True, "files": 0, "chunks": 0, "remaining": 0}
    assert fake.calls == calls


def test_reembed_only_touches_chunks_whose_text_changed(svc: LibraryService, fake: FakeEncoder) -> None:
    body = "# 预算\n\n" + "本季度预算与费用明细。" * 200
    row = svc.create_file("my-docs/a.md", body.encode())
    svc.search("预算")
    first = _index(svc)
    assert first["chunks"] >= 3

    # 只改最后一段：前面的块 hash 不变 → 不该重跑模型。
    svc.write_file(row["id"], body + "\n\n尾部追加一句新的内容。", expected_hash=row["content_hash"])
    svc.search("预算")  # text_status 被写回 pending，这里重新抽取
    fake.encoded.clear()
    second = _index(svc)
    assert second["files"] == 1
    assert 0 < second["chunks"] < first["chunks"], "改一句话不该把整份文档重嵌一遍"
    assert all("尾部追加" in payload for payload in fake.encoded), "重嵌的必须只是变化的那些块"


def test_rebuild_drops_every_vector_of_this_model(svc: LibraryService, fake: FakeEncoder) -> None:
    svc.create_file("my-docs/a.md", ("预算与费用。" * 60).encode())
    svc.search("预算")
    _index(svc)
    assert svc.embed_status()["index"]["chunks"] > 0

    conn = svc.db.connect()
    try:
        removed = svc.repo.delete_chunks(conn, model=EMBED_MODEL_ID)
        conn.commit()
    finally:
        conn.close()
    assert removed > 0
    svc._vec_cache = None
    assert svc.embed_status()["index"]["chunks"] == 0
    assert svc.embed_status()["index"]["files_pending"] == 1, "清空向量后文件必须回到队列里"


def test_trashing_a_file_takes_its_vectors_out_of_the_lane(svc: LibraryService, fake: FakeEncoder) -> None:
    row = svc.create_file("my-docs/a.md", ("预算与费用。" * 60).encode())
    svc.search("预算")
    _index(svc)
    svc.trash_file(row["id"])
    hits = svc.search("预算", mode="hybrid")["hits"]
    assert hits == [], "软删的文件不该继续在向量腿里出现"


def test_embed_cache_lives_under_the_library_root_but_is_never_indexed(svc: LibraryService) -> None:
    """权重目录挂在库根下 —— 树与全量扫描都只从可写顶层出发，因此 614 MB 不会被当成资料。"""
    import os

    cache = E.cache_dir(svc.root_path)
    os.makedirs(cache, exist_ok=True)
    with open(os.path.join(cache, "model_int8.onnx"), "wb") as fh:
        fh.write(b"not-a-real-model")
    tree = svc.tree()
    assert all(EMBED_CACHE_DIRNAME not in f["path"] for f in tree["folders"])
    stats = svc.rescan()
    assert stats["scanned"] == 0 and stats["added"] == 0, "权重目录被全量对账当成资料扫进来了"


def test_download_is_refused_when_the_model_is_already_there(svc: LibraryService, fake: FakeEncoder) -> None:
    with pytest.raises(LibraryError) as exc_info:
        svc.start_download_job()
    assert exc_info.value.code == "E_INVALID_STATE"


# =============================================================================
# 后台队列：什么时候踢、什么时候不踢
# =============================================================================


def test_search_kicks_the_background_index_queue_when_something_is_pending(
    svc: LibraryService, fake: FakeEncoder, monkeypatch
) -> None:
    """新写入 / 改过的文件靠搜索顺手踢一脚进后台队列。

    没有这一下，它们只能等用户点「重建索引」—— 那是把全库推倒重来，而这里要的是只补新的那几个。
    """
    kicks: list[int] = []
    monkeypatch.setattr(LibraryService, "_kick_index", lambda _self: kicks.append(1))

    svc.create_file("my-docs/a.md", ("预算与费用。" * 60).encode())
    svc.search("预算")  # 同一事务里先抽取，再数队列 → a.md 还没嵌过，必须踢
    assert kicks == [1]

    _index(svc)
    svc.search("预算")  # 队列空了就不该再起线程
    assert kicks == [1]


def test_search_never_kicks_the_index_queue_without_a_model(svc: LibraryService, monkeypatch) -> None:
    """没模型时连队列都不该去数 —— 这是现在唯一真跑的路径，不许为一个用不上的能力付钱。"""
    kicks: list[int] = []
    monkeypatch.setattr(LibraryService, "_kick_index", lambda _self: kicks.append(1))
    svc.create_file("my-docs/a.md", ("预算与费用。" * 60).encode())
    svc.search("预算", mode="hybrid")
    assert kicks == []


def test_rebuild_drops_the_index_and_puts_every_file_back_in_the_queue(svc: LibraryService, fake: FakeEncoder) -> None:
    svc.create_file("my-docs/a.md", ("预算与费用。" * 60).encode())
    svc.create_file("my-docs/b.md", ("研发排期。" * 60).encode())
    svc.search("预算")
    _index(svc)
    assert svc.embed_status()["index"]["files_pending"] == 0

    status = svc.rebuild_index()
    assert status["index"]["chunks"] == 0
    assert status["index"]["files_pending"] == 2, "清空向量后两个文件都得回到队列里"


def test_rebuild_is_refused_without_a_model_and_drops_nothing(svc: LibraryService, monkeypatch) -> None:
    """🔴 先判模型再清：反过来 = 没模型时点一下丢一次索引，且什么也建不回来。"""
    encoder = FakeEncoder()
    monkeypatch.setattr(service_module.E, "model_present", lambda _root: True)
    monkeypatch.setattr(service_module.E, "load_encoder", lambda _root, **_kw: encoder)
    monkeypatch.setattr(LibraryService, "_kick_index", lambda _self: None)
    svc.create_file("my-docs/a.md", ("预算与费用。" * 60).encode())
    svc.search("预算")
    _index(svc)
    chunks = svc.embed_status()["index"]["chunks"]
    assert chunks > 0

    # 权重目录被删 / 换了台机器：能力没了，索引还在。
    monkeypatch.setattr(service_module.E, "model_present", lambda _root: False)
    monkeypatch.setattr(service_module.E, "load_encoder", lambda _root, **_kw: None)
    svc._reset_encoder()
    with pytest.raises(LibraryError) as exc_info:
        svc.rebuild_index()
    assert exc_info.value.code == "E_INVALID_STATE"
    assert svc.embed_status()["index"]["chunks"] == chunks


def test_download_chains_into_indexing_only_after_the_job_stops_running(svc: LibraryService, monkeypatch) -> None:
    """下完 614 MB 必须接着建一次索引，否则用户等完只看到 files_pending 一动不动。

    🔴 同时钉住「踢队列在 finally **之后**」：作业是进程内单实例，还挂着 ``running`` 时
    起第二个会被自己的闸挡掉 —— 那样下载完等于什么也没发生。
    """
    running_at_kick: list[bool] = []
    monkeypatch.setattr(service_module.E, "download_model", lambda _root, **_kw: "")
    monkeypatch.setattr(LibraryService, "_kick_index", lambda self: running_at_kick.append(self._job.running))

    job = service_module._Job(kind="download", started_at=0.0)
    svc._job = job
    svc._run_download(job)

    assert job.running is False and job.error is None and job.finished_at is not None
    assert running_at_kick == [False]


def test_download_failure_does_not_chain_into_indexing(svc: LibraryService, monkeypatch) -> None:
    """下载失败还去建索引 = 拿一份不存在的权重起会话。"""

    def boom(_root, **_kw):
        raise RuntimeError("network down")

    kicks: list[int] = []
    monkeypatch.setattr(service_module.E, "download_model", boom)
    monkeypatch.setattr(LibraryService, "_kick_index", lambda _self: kicks.append(1))

    job = service_module._Job(kind="download", started_at=0.0)
    svc._job = job
    svc._run_download(job)

    assert job.error == "network down" and job.running is False
    assert kicks == []
