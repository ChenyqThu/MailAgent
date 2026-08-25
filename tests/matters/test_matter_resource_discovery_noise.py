"""资料发现的**噪音回归网**（0812 dogfood「拉了一大堆无关的信息进来」批）。

样本不是编的：语料照抄 owner 活库里那 20 条 confidence=0.36 建议的真实形状 ——
撤回通知、Confluence daily digest、Teams 未读提醒、同线程「Omada Config Tool v2.0优化」
三连（原件 + 两条回复），以及事项文档散文里那些近乎全域命中的虚词
（`邮件`/`需求`/`确认`/`时间`/`项目`，活库最近 500 封里命中率 5%~8%）。

🔴 光证明「变少了」不算数：每条「该挡的」旁边都钉一条「该留的」——同线程、干系人命中 ——
断言它们**仍然入选**。否则修法退化成「把召回关掉」。

🔴 task 08-25（owner 0825「置信度非常低，反而徒增烦恼」）：关键词命中式的资料推荐整条
退役 —— `discover_resource_suggestions` / REST discover 端点 / gateway
`matter_suggest_related_resources` 三个写入口全删。候选引擎 `_email_resource_candidates`
留着，但**只剩只读候选**（`list_resource_candidates`，owner 手动挑）这一个调用面，而它
有意不接 `query` / `expand_reason` —— 于是外扩那一趟（`scope='expanded'`：关键词召回、
分数排序、同线程折叠、backlog 守卫）**当前没有任何消费者**。本文件因此只保留 `local` 档
的用例；外扩那 6 条（虚词 query 不召回 / 专有名词单命中 / 同线程折叠 / 证据强度排序 /
积压守卫 / 事项散文不作检索条件）随之删除 —— 让测试绿着调用无人可达的代码是恒绿装饰。
外扩若复活，从 git 历史（本批之前的这个文件）把它们捞回来。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.resource_identity import evidence_fingerprint, rejection_resource_key
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
    return {item["external_key"] for item in result["items"]}


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

    result = service.list_resource_candidates(public_id)

    assert _keys(result) == {f"email:{THREAD_REPLY_ID}", f"email:{STAKEHOLDER_ID}"}
    assert _keys(result) & NOISE_KEYS == set()


def test_matter_prose_alone_never_recalls_anything(env):
    """🔴 事项散文不是检索条件（修法 3）。

    病根形态：`context_snapshot` 自签 `context_gap` 去做全库 keyword 检索，活库 20 条噪音
    全部由它产出。零 durable 锚点的事项现在一条候选都出不来 —— 事项文档里那些近乎全域
    命中的虚词只**加分**，永远不能独自把一封邮件拉进来。
    """
    service, path = env
    public_id, _ = _anchored_matter(service, path, with_anchor=False)

    assert service.list_resource_candidates(public_id)["items"] == []


def test_rejection_fingerprint_survives_a_reworded_matter_summary(env):
    """🔴 修法 7：改一句 `current_summary` 不该让抑制失效。

    旧实现把 `keyword:*`（来自整份事项文档的 bigram）一起哈希进指纹，于是用户拒掉一条
    垃圾建议后，只要下一轮重写了摘要，指纹就变、抑制当场失效、同一封原样回来 —— 与
    docstring 承诺的语义正好相反。抑制判据本身（`evidence_fingerprint` 只吃 durable
    anchor）没随关键词推荐退役，所以这条继续钉着：**同一封邮件的候选证据，在摘要被改写
    前后必须给出同一个指纹**。
    """
    service, path = env
    public_id, version = _anchored_matter(service, path)

    def fingerprint_of(external_key: str) -> str:
        candidate = next(
            item
            for item in service.list_resource_candidates(public_id)["items"]
            if item["external_key"] == external_key
        )
        return evidence_fingerprint(
            rejection_resource_key("mailagent", "email", external_key),
            candidate["evidence"],
        )

    target = f"email:{THREAD_REPLY_ID}"
    before = fingerprint_of(target)
    service.patch_matter(
        public_id,
        {"current_summary": "改写后的摘要：等待意大利侧回复测试数据，需求与时间待确认。"},
        **_mutation(version, "reword-summary"),
    )

    assert fingerprint_of(target) == before
