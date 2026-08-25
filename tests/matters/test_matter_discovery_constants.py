"""资料发现的**数值契约**闸（0812 codex review + 内部审计各点名一次）。

背景：`src/matters/service.py` 的候选/评分是一串手调常量（DF 分档比例、各项分数上限、
扫描窗口、积压上限）。实测把当年的 `RESOURCE_KEYWORD_RECALL_MIN_WEIGHT` 从 3 改成 1，
整个 matters 测试套仍然全绿 —— 也就是说这些数字**一个都没有被钉住**。本批 `service.py`
还被清零重建过：如果重放时损坏的是一个数字，测试同样抓不到。

所以这里是表驱动的**数值**闸，判据不是"行为大致对"而是"数就是这个数"：
  · 档位边界（500 文档语料下 common 从第 25 篇起算）；
  · 分数常量（干系人单命中恰好 0.25 = 准入线；加分封顶 0.06）；
  · 扫描窗口 500 / 积压上限 10。

🔴 除纯函数那两组外，分数一律**走真实评分链路**（候选引擎返回的 `confidence` =
`round(min(score, 0.98), 3)`），不在测试里复刻公式 —— 复刻公式的"闸"只会和实现一起漂。

⚠️ task 08-25（owner 0825「置信度非常低，反而徒增烦恼」）：关键词命中式的资料推荐整条
退役，候选引擎只剩只读候选（`list_resource_candidates`）这一个调用面 —— 入选判据只有
durable 硬锚（同线程 / 干系人），词表分档只剩「加不加分」这一个作用。原先钉「rare+normal
恰好过线 / 关键词封顶 0.40」的两组端到端用例、以及权重表与准入权重两个常量的数值断言，
随那两个常量一起删除。外扩若复活，从 git 历史（本批之前的这个文件）把它们捞回来。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import (
    RESOURCE_DISCOVERY_SCAN_LIMIT,
    RESOURCE_SUGGESTION_BACKLOG_CAP,
    MatterService,
)

# ── 纯函数：档位边界与权重表 ─────────────────────────────────────────────────

DOC_TOTAL = 500


@pytest.mark.parametrize(
    ("term", "df_count", "expected"),
    [
        # common：df >= max(5, 500 × 0.05) = 25 —— 第 25 篇是边界内的第一个 common。
        ("probetok", 25, "common"),
        ("probetok", 24, "normal"),
        ("probetok", 500, "common"),
        # rare：df <= max(2, 500 × 0.01) = 5。
        ("probetok", 6, "normal"),
        ("probetok", 5, "rare"),
        ("probetok", 2, "rare"),
        # distinctive：拉丁 token（len ≥ 3）且 df <= max(1, 500 × 0.002) = 1。
        ("probetok", 1, "distinctive"),
        # 🔴 中文二元组恒 len==2 ⇒ 拿不到 distinctive 那一档，单命中最多算 rare（权重 2）。
        ("甲乙", 1, "rare"),
        ("甲乙", 25, "common"),
    ],
)
def test_term_tier_boundaries_at_500_docs(term, df_count, expected):
    assert MatterService._term_tier(term, df_count, DOC_TOTAL) == expected


@pytest.mark.parametrize(
    ("df_count", "expected"),
    [
        # 语料只有 10 篇时比例全部失效，MIN_DOCS 接管：common ≥ 5 篇、rare ≤ 2 篇、
        # distinctive ≤ 1 篇。少了这层保护，测试库/新装机器上每个词都会被判成虚词，召回归零。
        (5, "common"),
        (4, "normal"),
        (3, "normal"),
        (2, "rare"),
        (1, "distinctive"),
    ],
)
def test_term_tier_min_docs_floor_protects_small_corpora(df_count, expected):
    assert MatterService._term_tier("probetok", df_count, 10) == expected


def test_scan_window_and_backlog_cap():
    assert RESOURCE_DISCOVERY_SCAN_LIMIT == 500
    assert RESOURCE_SUGGESTION_BACKLOG_CAP == 10


# ── 端到端：DF 受控的 500 篇语料，直接读 confidence ──────────────────────────

TARGET_ID = 5000
STAKEHOLDER_EMAIL = "anchor@probe.test"

#: 目标邮件的主题：所有探针词各出现一次（DF 由下面的填充行调到位）。
TARGET_SUBJECT = (
    "commonone commontwo commonthree normaltok normalalt raretok distincttok "
    "boostone boosttwo boostthree boostfour 甲乙 丙丁"
)

#: (词, 目标邮件之外还要出现在多少行里) —— 加上目标邮件那一行就是最终 DF。
_PLANTED = (
    ("commonone", 24),  # DF 25 → common
    ("commontwo", 24),
    ("commonthree", 24),
    ("normaltok", 9),  # DF 10 → normal
    ("normalalt", 9),
    ("raretok", 2),  # DF 3 → rare
    # distincttok / boost* / 甲乙 / 丙丁 只出现在目标邮件 → DF 1
)
TOTAL_ROWS = 500


@pytest.fixture
def corpus(tmp_path):
    """恰好 500 行（= 扫描窗口），每个探针词的 DF 精确可控。"""
    path = tmp_path / "discovery-constants.db"
    SyncStore(str(path))
    rows = [
        (
            TARGET_ID,
            f"message-{TARGET_ID}",
            "target-thread",
            TARGET_SUBJECT,
            "sender@probe.test",
            f"owner@example.com, {STAKEHOLDER_EMAIL}",
            "2026-08-11T09:00:00Z",
            "",
        )
    ]
    planted = [term for term, extra in _PLANTED for _ in range(extra)]
    for index in range(TOTAL_ROWS - 1):
        internal_id = 600_000 + index
        word = planted[index] if index < len(planted) else "fillerword"
        rows.append(
            (
                internal_id,
                f"message-{internal_id}",
                f"filler-thread-{index}",
                f"{word} 填充主题",
                f"colleague{index % 20}@example.com",
                "owner@example.com",
                f"2026-07-{index % 28 + 1:02d}T09:00:00Z",
                "",
            )
        )
    with sqlite3.connect(path) as conn:
        conn.executemany(
            "INSERT INTO email_metadata "
            "(internal_id,message_id,thread_id,subject,sender,to_addr,date_received,snippet) "
            "VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.commit()
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000), path


def _matter(service, *, background: str = "") -> str:
    """标题/背景有意用中文且与目标邮件零交集 —— 不给 boost 分留后门。"""
    created = service.create_matter(
        {"title": "数值契约用例", "background": background},
        idempotency_key="create-constants",
        source="desktop_ui",
    )
    return created["matter"]["public_id"]


def _anchored(service, *, background: str = "") -> str:
    """建事项 + 把目标邮件的收件人立成干系人（唯一的 durable 硬锚）。"""
    public_id = _matter(service, background=background)
    service.create_stakeholder(
        public_id,
        {"email": STAKEHOLDER_EMAIL},
        expected_version=service.get_matter(public_id)["matter"]["version"],
        idempotency_key="add-stakeholder",
        source="desktop_ui",
    )
    return public_id


def _candidates(service, public_id) -> dict[str, float]:
    result = service.list_resource_candidates(public_id)
    return {item["external_key"]: item["confidence"] for item in result["items"]}


def test_single_stakeholder_hit_lands_exactly_on_the_admission_line(corpus):
    """干系人单命中 = 0.20 + 1 × 0.05 = 0.25 = 准入线（`score < 0.25` 恰好不成立）。

    🔴 这个"恰好"是有意的（见 service.py 注释）：干系人是 durable 硬锚，必须**自己**站得住，
    不许再靠虚词堆出来的关键词分托过线。任何一侧动一点点，这封就整个消失。
    """
    service, _ = corpus
    assert _candidates(service, _anchored(service)) == {f"email:{TARGET_ID}": 0.25}


@pytest.mark.parametrize(
    ("background", "expected_confidence", "why"),
    [
        # 干系人硬锚 0.25，1 个加分词：+0.02 × 1。
        ("boostone", 0.27, "加分 = 0.02 × 非虚词命中数"),
        # 4 个加分词：0.25 + min(0.06, 0.08) —— 封顶。
        ("boostone boosttwo boostthree boostfour", 0.31, "加分封顶 0.06"),
        # 🔴 虚词**恒不计分**：三个 common 词一分都加不上，分数与零加分词时一模一样。
        ("commonone commontwo commonthree", 0.25, "虚词一分不加"),
    ],
)
def test_boost_score_multiplier_and_cap(corpus, background, expected_confidence, why):
    """boost 词来自**事项文档**，只加分、永远不能自己把一封邮件拉进来（召回靠 durable 锚）。"""
    service, _ = corpus
    hits = _candidates(service, _anchored(service, background=background))
    assert hits[f"email:{TARGET_ID}"] == expected_confidence, why


def test_matter_prose_alone_cannot_admit_an_email(corpus):
    """没有 durable 锚时，事项文档里把探针词写全也召不回任何东西（`local` 档硬要求）。"""
    service, _ = corpus
    public_id = _matter(service, background=TARGET_SUBJECT)
    assert _candidates(service, public_id) == {}
