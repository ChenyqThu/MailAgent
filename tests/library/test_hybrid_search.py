"""混合检索：无模型 = 纯 FTS（形状不变）· 向量腿补 FTS 的空 · RRF 融合与 lane 标注（design §9.1）。

🔴 一律走假 encoder，**不依赖 614 MB 权重**。
"""

from __future__ import annotations

import pytest

from src.library import service as service_module
from src.library.constants import EMBED_MODEL_ID, SEARCH_LANES
from src.library.repository import rrf_fuse
from src.library.service import LibraryError, LibraryService

from .test_embed import FakeEncoder

_DOCS = {
    # FTS 与向量腿各自能召回什么，靠这三份文件区分开：
    "my-docs/budget.md": "# 预算\n\n" + "本季度预算与费用明细都在这里。" * 30,   # 字面含「预算」→ 两条腿都能中
    "my-docs/cost.md": "# 开销\n\n" + "这份文档只谈开销与费用，不写那两个字。" * 30,  # 只有同义词 → 只有向量腿能中
    "my-docs/schedule.md": "# 排期\n\n" + "研发排期与里程碑安排。" * 30,          # 与预算无关 → 谁都不该中
}


@pytest.fixture()
def svc(tmp_path) -> LibraryService:
    service = LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))
    for path, body in _DOCS.items():
        service.create_file(path, body.encode())
    service.search("预算", mode="fts")  # 触发抽取，让 library_text 有行
    return service


@pytest.fixture()
def fake(monkeypatch) -> FakeEncoder:
    encoder = FakeEncoder()
    monkeypatch.setattr(service_module.E, "model_present", lambda _root: True)
    monkeypatch.setattr(service_module.E, "load_encoder", lambda _root, **_kw: encoder)
    return encoder


def _index(service: LibraryService) -> None:
    while True:
        batch = service.embed_pending(max_files=8)
        if not batch["available"] or batch["files"] == 0:
            return


def _names(result: dict) -> list[str]:
    return [h["filename"] for h in result["hits"]]


# =============================================================================
# 没模型 —— 现在唯一能真跑的路径
# =============================================================================


def test_hybrid_without_model_degrades_to_pure_fts_with_identical_shape(svc: LibraryService) -> None:
    """没下载权重时 ``mode=hybrid`` 必须退化成纯 FTS，且返回体与 ``mode=fts`` **逐键同形**。"""
    hybrid = svc.search("预算", mode="hybrid")
    fts = svc.search("预算", mode="fts")

    assert hybrid.keys() == fts.keys()
    assert set(hybrid) == {"query", "mode", "search_mode", "semantic", "hits", "warnings"}
    assert hybrid["search_mode"] == "fts", "没模型时 search_mode 必须说实话"
    assert fts["search_mode"] == "fts"
    assert hybrid["semantic"] == {"available": False, "model": None, "chunks": 0}
    assert hybrid["semantic"] == fts["semantic"]
    # 能力缺席不进 warnings：那里只放这次 query 自身的事，否则下载前每次搜索都挂一条同样的提示。
    assert hybrid["warnings"] == fts["warnings"] == []

    assert _names(hybrid) == _names(fts) == ["budget.md"]
    assert [h.keys() for h in hybrid["hits"]] == [h.keys() for h in fts["hits"]]
    for hit in hybrid["hits"]:
        assert hit["lane"] == "fts" and hit["lane"] in SEARCH_LANES
        assert hit["match"] in ("filename", "text"), "lane 与 match 是两个词表，不能互相顶替"
    # 两条路径的命中体（除 lane 外）完全一致 —— 退化不是「另一套结果」。
    assert [{k: v for k, v in h.items() if k != "lane"} for h in hybrid["hits"]] == [
        {k: v for k, v in h.items() if k != "lane"} for h in fts["hits"]
    ]


def test_degraded_path_keeps_the_p1_cjk_disciplines(svc: LibraryService) -> None:
    """1 字拦截 / 2 字 LIKE 这些 P1 纪律，在 hybrid 请求下没模型时原样保留。"""
    one = svc.search("预", mode="hybrid")
    assert one["mode"] == "too_short" and one["hits"] == []
    assert one["warnings"] == ["cjk_too_short:预"], "能力缺席不该混进 query 级 warnings"
    two = svc.search("预算", mode="hybrid")
    assert two["mode"] == "like" and all(h["rank"] is None for h in two["hits"])


def test_invalid_mode_is_rejected(svc: LibraryService) -> None:
    with pytest.raises(LibraryError) as exc_info:
        svc.search("预算", mode="semantic")
    assert exc_info.value.code == "E_INVALID_ARG"


# =============================================================================
# 有模型（假 encoder）
# =============================================================================


def test_vector_lane_answers_a_one_char_cjk_query_that_fts_intercepts(svc: LibraryService, fake: FakeEncoder) -> None:
    """中文 1 字 query 走不了 FTS（P1 恒拦截），向量腿照常出结果 —— 这是语义腿的头号价值。"""
    _index(svc)
    result = svc.search("预", mode="hybrid")
    assert result["mode"] == "too_short", "FTS 那条腿仍然一个字都不查"
    assert result["search_mode"] == "hybrid" and result["semantic"]["available"] is True
    assert result["semantic"]["model"] == EMBED_MODEL_ID and result["semantic"]["chunks"] > 0
    assert set(_names(result)) == {"budget.md", "cost.md"}, "向量腿该出两份预算相关的，且不带上排期那份"
    assert {h["lane"] for h in result["hits"]} == {"vec"}


def test_rrf_marks_files_hit_by_both_lanes_and_ranks_them_first(svc: LibraryService, fake: FakeEncoder) -> None:
    _index(svc)
    result = svc.search("预算", mode="hybrid")
    lanes = {h["filename"]: h["lane"] for h in result["hits"]}
    assert lanes == {"budget.md": "both", "cost.md": "vec"}
    assert "schedule.md" not in lanes, "无关文件不该被向量腿的地板放进来"
    assert _names(result)[0] == "budget.md", "两条腿都命中的必须排在只中一条的前面"
    ranks = [h["rank"] for h in result["hits"]]
    assert all(isinstance(r, float) and r < 0 for r in ranks), "融合后的 rank = -rrf_score（越小越相关）"
    assert ranks == sorted(ranks)


def test_vector_only_hit_carries_a_snippet_from_its_best_chunk(svc: LibraryService, fake: FakeEncoder) -> None:
    _index(svc)
    hit = next(h for h in svc.search("预算", mode="hybrid")["hits"] if h["filename"] == "cost.md")
    assert hit["snippet"], "只有向量腿命中的文件也要有 snippet（FTS 的 snippet() 没跑）"
    assert "开销" in hit["snippet"] or "费用" in hit["snippet"]


def test_nonsense_query_returns_nothing_from_either_lane(svc: LibraryService, fake: FakeEncoder) -> None:
    """点积排序没有「不相关」这个概念 —— 没有地板的话这里会返回全部三份文件。"""
    _index(svc)
    result = svc.search("zzzqqq", mode="hybrid")
    assert result["hits"] == [] and result["search_mode"] == "hybrid"


def test_rrf_fusion_is_position_based_and_matches_the_email_core_k() -> None:
    fused = rrf_fuse({"fts": [7, 3], "vec": [3, 9]}, limit=10)
    assert [fid for fid, _s, _l in fused] == [3, 7, 9], "两条腿都中的 3 必须压过各只中一条的 7 / 9"
    assert [lane for _f, _s, lane in fused] == ["both", "fts", "vec"]
    assert fused[0][1] == pytest.approx(1 / 60 + 1 / 61)
    assert rrf_fuse({"fts": [1, 2, 3]}, limit=2) == [(1, pytest.approx(1 / 60), "fts"), (2, pytest.approx(1 / 61), "fts")]


def test_rrf_k_matches_email_repository() -> None:
    """🔴 资料库与邮件核的融合口径不许分裂（两处各改一半 = 排序在两个域里悄悄不一致）。"""
    from src.library.constants import SEARCH_RRF_K
    from src.repository.email_repository import _RRF_K

    assert float(SEARCH_RRF_K) == float(_RRF_K)
