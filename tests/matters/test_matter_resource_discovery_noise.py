"""资料发现的**噪音回归网**（0812 dogfood「拉了一大堆无关的信息进来」批）。

样本不是编的：语料照抄 owner 活库里那 20 条 confidence=0.36 建议的真实形状 ——
撤回通知、Confluence daily digest、Teams 未读提醒、同线程「Omada Config Tool v2.0优化」
三连（原件 + 两条回复），以及事项文档散文里那些近乎全域命中的虚词
（`邮件`/`需求`/`确认`/`时间`/`项目`，活库最近 500 封里命中率 5%~8%）。

🔴 光证明「变少了」不算数：每条「该挡的」旁边都钉一条「该留的」——同线程、干系人命中、
专有名词（项目代号）单命中 —— 断言它们**仍然入选**。否则修法退化成「把召回关掉」。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService

# 事项文档散文（照抄活库 MAT-0002 的形状）：其中「未见**邮件**记录」正是把标题带
# 「已撤回**邮件**」的撤回通知拉进来的那句话。
MATTER_DESCRIPTION = (
    "Gary Wen 于 2026-08-11（口头/IM 安排，未见邮件记录）布置：汇总 2025 年度目标"
    "完成度及工作亮点情况，交付给 Gary。需求输入与时间安排待确认，项目材料来源包括"
    "2025 Annual Business Review Meeting 材料与年度目标收集列表。"
)

# ——— 噪音：与事项零 durable 关联，只共享虚词 ————————————————————————
NOISE_EMAILS = [
    # 撤回通知：标题里带「邮件」，被事项描述里的「未见邮件记录」勾中（活库实证）。
    (
        1000012428, "recall-thread",
        '已撤回邮件:"撤回: 意大利Omada CBC单Site支持5K设备测试报告需求"',
        "Office365Reports@microsoft.com", "邮件已撤回，无需确认",
    ),
    # Confluence 每日摘要（= LinkedIn digest 同型）：机器发的、每天一封、内容全是虚词。
    (
        1000012439, "digest-thread",
        "YUANQUAN CHEN, don't miss out on your daily digest",
        "confluence@tp-link-global.atlassian.net",
        "Zhuoran Zhou has made updates 项目 需求 确认",
    ),
    # Teams 未读提醒。
    (
        1000012433, "teams-thread",
        "Xiaojia Chen and Elliot Huang 向你的聊天发送了 2 条消息",
        "no-reply@teams.mail.microsoft", "查看邮件与时间安排",
    ),
    # 同线程三连：活库里这三封各占一个名额，把 10 条配额吃掉三成。
    (
        1000012431, "config-thread", "回复: Omada Config Tool v2.0优化",
        "liuzhu@tp-link.com.hk", "Config Tool 优化需求确认",
    ),
    (
        1000012434, "config-thread", "回复: Omada Config Tool v2.0优化",
        "meihao@tp-link.com.hk", "Config Tool 优化需求确认",
    ),
    (
        1000012436, "config-thread", "答复: Omada Config Tool v2.0优化",
        "yangxin3@tp-link.com.hk", "Config Tool 优化需求确认",
    ),
]

ANCHOR_ID = 1000010133
THREAD_REPLY_ID = 1000010134
STAKEHOLDER_ID = 1000010135
PROJECT_CODE_ID = 1000010136
# 排序用的一对：强证据那封**故意最旧**，弱证据那封最新。
RANK_STRONG_ID = 1000010137
RANK_WEAK_ID = 1000010138
FILLER_TOTAL = 300


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "matter-noise.db"
    SyncStore(str(path))
    service = MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)
    return service, path


def _insert(path, rows) -> None:
    with sqlite3.connect(path) as conn:
        conn.executemany(
            "INSERT INTO email_metadata "
            "(internal_id,message_id,thread_id,subject,sender,to_addr,date_received,snippet) "
            "VALUES (?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.commit()


def _seed_corpus(path) -> None:
    """语料 = 300 封虚词填充 + 6 封真噪音 + 4 封真信号。

    300 封是**必要**的：DF 分档要有统计意义（虚词要真的落进 common 档、同线程三连共享的
    词要真的落进 rare 档），几封邮件的玩具库分不出档，小语料保护会把它们全判成非虚词。
    """
    rows = []
    # 填充：只用虚词，保证 `项目/需求/确认/时间/邮件/安排` 落进 common 档。
    for index in range(FILLER_TOTAL):
        internal_id = 900_000 + index
        rows.append((
            internal_id, f"filler-{internal_id}", f"filler-thread-{index}",
            f"项目周报 需求 确认 {index}", f"colleague{index % 20}@example.com",
            "owner@example.com", f"2026-07-{index % 28 + 1:02d}T09:00:00Z",
            "邮件 时间 安排 项目 进展同步",
        ))
    for internal_id, thread_id, subject, sender, snippet in NOISE_EMAILS:
        rows.append((
            internal_id, f"message-{internal_id}", thread_id, subject, sender,
            "owner@example.com", "2026-08-11T12:00:00Z", snippet,
        ))
    rows.extend([
        # 信号 ①/②：锚点邮件与它的同线程回复。
        (
            ANCHOR_ID, f"message-{ANCHOR_ID}", "cbc-thread",
            "意大利Omada CBC单Site支持5K设备测试报告需求", "echo.liu@omadanetworks.com",
            "owner@example.com", "2026-08-05T09:00:00Z", "测试报告需求",
        ),
        (
            THREAD_REPLY_ID, f"message-{THREAD_REPLY_ID}", "cbc-thread",
            "回复: 意大利Omada CBC单Site支持5K设备测试报告需求",
            "echo.liu@omadanetworks.com", "owner@example.com",
            "2026-08-06T09:00:00Z", "补充测试数据",
        ),
        # 信号 ③：干系人命中，线程与事项无关。
        (
            STAKEHOLDER_ID, f"message-{STAKEHOLDER_ID}", "kevin-thread",
            "Port Security configured through controller webUI",
            "kevin.berry@example.com", "owner@example.com",
            "2026-08-07T09:00:00Z", "roadmap question",
        ),
        # 信号 ④：专有名词/项目代号，全库只此一封。
        (
            PROJECT_CODE_ID, f"message-{PROJECT_CODE_ID}", "firmware-thread",
            "马来西亚功能需求反馈-ER706W-4G Version 2 Firmware",
            "echo.liu@omadanetworks.com", "owner@example.com",
            "2026-08-08T09:00:00Z", "固件版本确认",
        ),
        # 排序对照组：Omicron+Lambda 双低频命中（强）但日期最旧；Kappa 单命中（弱）最新。
        (
            RANK_STRONG_ID, f"message-{RANK_STRONG_ID}", "rank-strong-thread",
            "Omicron Lambda 立项材料", "lead@example.com", "owner@example.com",
            "2026-08-01T09:00:00Z", "两项低频锚点齐全",
        ),
        (
            RANK_WEAK_ID, f"message-{RANK_WEAK_ID}", "rank-weak-thread",
            "Kappa 汇总", "lead@example.com", "owner@example.com",
            "2026-08-20T09:00:00Z", "只有一个低频锚点",
        ),
    ])
    _insert(path, rows)


def _mutation(version: int, key: str) -> dict[str, object]:
    return {"expected_version": version, "idempotency_key": key, "source": "desktop_ui"}


def _keys(result) -> set[str]:
    return {item["resource"]["external_key"] for item in result["items"]}


NOISE_KEYS = {f"email:{row[0]}" for row in NOISE_EMAILS}


def _anchored_matter(service, path, *, with_anchor: bool = True):
    _seed_corpus(path)
    created = service.create_matter(
        {"title": "汇总 2025 目标完成度与工作亮点", "description": MATTER_DESCRIPTION},
        idempotency_key="create-noise",
        source="desktop_ui",
    )
    public_id = created["matter"]["public_id"]
    version = created["version"]
    if with_anchor:
        linked = service.add_resource(
            public_id,
            {"provider": "mailagent", "kind": "email", "external_key": f"email:{ANCHOR_ID}"},
            **_mutation(version, "link-anchor"),
        )
        version = linked["version"]
        stakeholder = service.create_stakeholder(
            public_id,
            {"email": "kevin.berry@example.com", "display_name": "Kevin Berry"},
            **_mutation(version, "add-stakeholder"),
        )
        version = stakeholder["version"]
    return public_id, version


def test_local_pass_keeps_durable_anchors_and_drops_every_noise_sample(env):
    """本地那一趟：同线程 + 干系人**照常入选**，六条噪音一条都不进。"""
    service, path = env
    public_id, _ = _anchored_matter(service, path)

    result = service.discover_resource_suggestions(public_id)

    assert _keys(result) == {f"email:{THREAD_REPLY_ID}", f"email:{STAKEHOLDER_ID}"}
    assert _keys(result) & NOISE_KEYS == set()


def test_matter_prose_alone_never_recalls_anything(env):
    """🔴 事项散文不是检索条件（修法 3）。

    没有 query 的外扩 = 旧 `context_snapshot` 自签 `context_gap` 那条路径的形状，
    活库 20 条噪音全部由它产出。现在它一条都出不来。
    """
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    result = service.discover_resource_suggestions(
        public_id, expand_reason="context_gap", limit=10
    )

    assert result["expanded"] is True
    assert result["items"] == []


def test_generic_query_terms_alone_recall_nothing(env):
    """全是虚词的 query（`确认 邮件 时间 项目 需求 安排`）不该把全库拉进来。

    🔴 变异点：把 common 档（停用词表）拿掉，这些词各值 1 分、凑够 3 分就召回 ⇒ 300 封
    填充邮件全部入选，本用例当场红。
    """
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    result = service.discover_resource_suggestions(
        public_id, query="确认 邮件 时间 项目 需求 安排",
        expand_reason="verification", limit=10,
    )

    assert result["items"] == []


def test_specific_query_recalls_topic_and_still_excludes_noise(env):
    """真话题 query：命中该命中的，句子里的虚词不把无关邮件顺带捞进来。

    ⚠️ 撤回通知（1000012428）在**这条** query 下**有意**仍然入选：它的标题逐字包含
    「意大利Omada CBC单Site支持5K设备测试报告需求」，对显式问这个话题的人来说
    「那封原件已被撤回」是有效答案。它当初是噪音，病在**根本没有 query**（服务自签
    context_gap）——那条路径已由 `test_matter_prose_alone_never_recalls_anything` 钉死。
    要把系统通知整类挡掉需要发件人/通知分类器，那是另一件事，不在本批。
    """
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    result = service.discover_resource_suggestions(
        public_id, query="确认 意大利 CBC 测试报告 的时间安排",
        expand_reason="verification", limit=10,
    )

    keys = _keys(result)
    # cbc-thread 两封折成一封（修法 6）。
    assert len(keys & {f"email:{ANCHOR_ID}", f"email:{THREAD_REPLY_ID}"}) == 1
    # 摘要机器人 / Teams 提醒这类纯虚词邮件一条都不进。
    assert keys & {"email:1000012439", "email:1000012433"} == set()


def test_project_code_single_hit_still_recalls(env):
    """专有名词/项目代号单命中的特例：靠一个 ER706W 就该把那封邮件关联上。"""
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    result = service.discover_resource_suggestions(
        public_id, query="ER706W", expand_reason="verification", limit=10
    )

    assert _keys(result) == {f"email:{PROJECT_CODE_ID}"}


def test_same_thread_noise_collapses_to_one_slot(env):
    """同线程三连只占一个名额（修法 6）—— 候选池是 email 粒度，线程只能折叠不能刷屏。"""
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    result = service.discover_resource_suggestions(
        public_id, query="Omada Config Tool", expand_reason="verification", limit=10
    )

    config_hits = _keys(result) & {
        "email:1000012431", "email:1000012434", "email:1000012436"
    }
    assert len(config_hits) == 1


def test_expanded_ranking_reflects_evidence_strength_not_recency(env):
    """🔴 变异点（修法 1）：常量托底会把所有外扩候选压成同一个分。

    confidence 恒等 ⇒ `sort(key=-confidence)` 退化成恒等排序 ⇒ `combined[:limit]` 拿到的
    「Top N」其实是 date_received DESC 的前 N。这里让**证据最强的那封恰好最旧**：分数
    一旦被拍平，它就会掉到列表后面。
    """
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    result = service.discover_resource_suggestions(
        public_id,
        query="Omicron Lambda Kappa",
        expand_reason="verification",
        limit=10,
    )

    ordered = [
        (item["resource"]["external_key"], item["confidence"]) for item in result["items"]
    ]
    assert [key for key, _ in ordered] == [
        f"email:{RANK_STRONG_ID}",  # 双低频命中，日期最旧
        f"email:{RANK_WEAK_ID}",  # 单命中，日期最新
    ]
    # 分数不是同一个常量 —— 排序还有意义。
    assert ordered[0][1] > ordered[1][1]


def test_suggestion_backlog_cap_stops_piling_up(env):
    """已经挂满一屏待审建议就不再堆（修法 6 的第二半）。"""
    service, path = env
    public_id, version = _anchored_matter(service, path, with_anchor=False)
    with sqlite3.connect(path) as conn:
        matter_id = conn.execute(
            "SELECT id FROM matter WHERE public_id=?", (public_id,)
        ).fetchone()[0]
        for index in range(10):
            conn.execute(
                "INSERT INTO resource (kind,provider,external_key,metadata_json,"
                "access_policy,created_at,updated_at) VALUES ('email','mailagent',?,'{}',"
                "'allowed',1,1)",
                (f"email:{700_000 + index}",),
            )
            resource_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            conn.execute(
                "INSERT INTO matter_resource (matter_id,resource_id,pinned,added_by_kind,"
                "provenance_json,sub_state,created_at,updated_at) "
                "VALUES (?,?,0,'agent','{}','none',1,1)",
                (matter_id, resource_id),
            )
        conn.commit()
    del version

    result = service.discover_resource_suggestions(
        public_id, query="ER706W", expand_reason="verification", limit=10
    )

    assert result == {
        "items": [],
        "suppressed": [],
        "local_candidate_count": 0,
        "expanded": False,
        "backlog_capped": True,
    }


def test_rejection_survives_a_reworded_matter_summary(env):
    """🔴 修法 7：改一句 `current_summary` 不该让抑制失效。

    旧实现把 `keyword:*`（来自整份事项文档的 bigram）一起哈希进指纹，于是用户拒掉一条
    垃圾建议后，下一次跟进 run 只要重写了摘要，指纹就变、抑制当场失效、同一封原样回来 ——
    与 docstring 承诺的语义正好相反。
    """
    service, path = env
    public_id, version = _anchored_matter(service, path)

    discovered = service.discover_resource_suggestions(public_id)
    suggestion = next(
        item for item in discovered["items"]
        if item["resource"]["external_key"] == f"email:{THREAD_REPLY_ID}"
    )
    rejected = service.reject_resource_suggestion(
        public_id, suggestion["resource"]["id"], reason="not relevant",
        **_mutation(version + 1, "reject-thread-reply"),
    )
    service.patch_matter(
        public_id,
        {"current_summary": "改写后的摘要：等待意大利侧回复测试数据，需求与时间待确认。"},
        **_mutation(rejected["version"], "reword-summary"),
    )

    repeated = service.discover_resource_suggestions(public_id)

    assert _keys(repeated) == set()
    assert repeated["suppressed"] == [
        {"external_key": f"email:{THREAD_REPLY_ID}", "reason": "rejected_same_evidence"}
    ]
