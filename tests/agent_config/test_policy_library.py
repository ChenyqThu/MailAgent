"""P2-L3 B —— 资料库无人值守免卡（design §5.3）的策略层单测。

**地板比免卡重要**：本文件里凡带「地板」字样的用例都是正面钉死「必须弹卡」的那一半 ——
`my-docs/` / 挂载根 / 投影区 / `.trash` 在 headless 恒 ask；`library_move` / `library_delete`
永不进这条通道；manual_chat 永远走 per-tool 档（本通道对它逐字节不生效）。

纯单测（tmp_path 直建 agent_config.db，resolver 是本地假回调），零真实 PII / 零外部依赖。
"""

from __future__ import annotations

import json

import pytest

from src.agent_config import policy as P
from src.agent_config.store import AgentConfigStore
from src.library.constants import TEXT_WRITE_MAX_BYTES

ASK = {"decision": "ask", "rule_id": None}
ALLOW = {"decision": "auto_allow", "rule_id": None}

HEADLESS_MODES = ("cron_headless", "untrusted_trigger")


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


def _resolver(mapping: dict[int, str]):
    """file_id → 虚拟路径（服务端事实）。不在表里 = 行不存在 / 非 present → None。"""

    def _resolve(file_id: int):
        return mapping.get(int(file_id))

    return _resolve


def _ev(store, action, mode, *, resolver=None, agent_id="dms"):
    return P.evaluate(
        store,
        "domain_write",
        action,
        mode,
        agent_id=agent_id,
        library_path_resolver=resolver,
    )


# ── 免卡通道本身（design §5.3 B）─────────────────────────────────────────────────────


@pytest.mark.parametrize("mode", HEADLESS_MODES)
def test_append_to_agent_docs_auto_allows_in_both_headless_modes(tmp_path, mode):
    st = _store(tmp_path)
    action = {"tool": "library_append", "file_id": 7, "size_bytes": 120}
    assert _ev(st, action, mode, resolver=_resolver({7: "agent-docs/atlas/log.md"})) == ALLOW


def test_write_create_new_under_agent_docs_auto_allows(tmp_path):
    """create_new 没有 file_id：目标就是入参 path（服务端也拿这个 path 去建）。"""
    st = _store(tmp_path)
    action = {"tool": "library_write", "path": "agent-docs/atlas/notes.md", "size_bytes": 4096}
    assert _ev(st, action, "cron_headless") == ALLOW


def test_write_overwrite_of_an_agent_docs_file_auto_allows(tmp_path):
    st = _store(tmp_path)
    action = {"tool": "library_write", "file_id": 12, "size_bytes": 900}
    assert _ev(st, action, "cron_headless", resolver=_resolver({12: "agent-docs/x.md"})) == ALLOW


def test_auto_allow_needs_no_db_rule_and_reports_no_rule_id(tmp_path):
    """内建通道不是 policy_rules 行：命中时 rule_id 恒 None（审计里区别于白名单命中）。"""
    st = _store(tmp_path)
    assert st.candidate_policy_rules("domain_write", "cron_headless", agent_id="dms") == []
    verdict = _ev(
        st,
        {"tool": "library_append", "file_id": 1, "size_bytes": 1},
        "cron_headless",
        resolver=_resolver({1: "agent-docs/a.md"}),
    )
    assert verdict == {"decision": "auto_allow", "rule_id": None}


def test_channel_works_without_agent_id_too(tmp_path):
    """主 agent 的无人值守 run（无 per-agent 身份）走同一条通道 —— 判据是路径不是身份。"""
    st = _store(tmp_path)
    action = {"tool": "library_append", "file_id": 3, "size_bytes": 10}
    assert _ev(st, action, "cron_headless", resolver=_resolver({3: "agent-docs/a.md"}), agent_id=None) == ALLOW


# ── 地板①：manual_chat 不受本改动影响（仍走 per-tool 档）─────────────────────────────


def test_floor_manual_chat_never_auto_allows(tmp_path):
    """地板：manual 面的 domain_write 不经本通道 —— 逐字节等于改动前（无规则 → ask）。"""
    st = _store(tmp_path)
    action = {"tool": "library_append", "file_id": 7, "size_bytes": 10}
    assert _ev(st, action, "manual_chat", resolver=_resolver({7: "agent-docs/atlas/log.md"}), agent_id=None) == ASK
    assert _ev(st, action, "manual_chat", resolver=_resolver({7: "agent-docs/atlas/log.md"})) == ASK


# ── 地板②：my-docs/ 与挂载根 headless 恒卡（design §5.3「不变的地板」）──────────────


@pytest.mark.parametrize("mode", HEADLESS_MODES)
@pytest.mark.parametrize(
    "path",
    [
        "my-docs/notes.md",
        "my-docs/sub/notes.md",
        "@notes/x.md",  # 挂载根（§8）
        "@notes/agent-docs/x.md",  # 挂载根内叫 agent-docs 的子目录 ≠ 库里的 agent-docs
        "mail-attachments/2026-09/a.pdf",  # 投影区
        ".trash/agent-docs/x.md",  # 软删区
        "chat-attachments/2026-09/a.docx",
        "agent-docs",  # 根目录本身不是文件
        "agent-docs/",
        "agent-docs-2/x.md",  # 前缀陷阱
        "agent-docsX/x.md",
        "AGENT-DOCS/x.md",  # 大小写：只认逐字
        "/agent-docs/x.md",  # 绝对路径
        "agent-docs/../my-docs/x.md",  # .. 逃逸
        "../agent-docs/x.md",
        "",
    ],
)
def test_floor_non_agent_docs_targets_always_ask(tmp_path, mode, path):
    """地板：create_new 形态的入参 path 只要不是 `agent-docs/<文件>` 一律弹卡。"""
    st = _store(tmp_path)
    action = {"tool": "library_write", "path": path, "size_bytes": 10}
    assert _ev(st, action, mode) == ASK


@pytest.mark.parametrize("path", ["my-docs/notes.md", "@notes/x.md", "mail-attachments/2026-09/a.pdf"])
def test_floor_overwrite_of_a_non_agent_docs_file_always_asks(tmp_path, path):
    """🔴 地板（本 lane 最易做错的一处）：overwrite 只带 file_id，目标路径必须按 file_id 反查。

    模型可以在同一次调用里塞一个漂亮的 `path`；判据只认服务端反查出来的那一条。
    """
    st = _store(tmp_path)
    resolver = _resolver({9: path})
    # 只有 file_id
    assert _ev(st, {"tool": "library_write", "file_id": 9, "size_bytes": 10}, "cron_headless", resolver=resolver) == ASK
    # file_id + 伪造的 agent-docs path：反查出来的真实路径不在 agent-docs ⇒ 照样弹卡
    forged = {"tool": "library_write", "file_id": 9, "path": "agent-docs/looks-fine.md", "size_bytes": 10}
    assert _ev(st, forged, "cron_headless", resolver=resolver) == ASK
    # append 同理（它只有 file_id 形态）
    assert _ev(st, {"tool": "library_append", "file_id": 9, "size_bytes": 10}, "cron_headless", resolver=resolver) == ASK


def test_floor_agent_docs_file_id_with_a_non_agent_docs_path_also_asks(tmp_path):
    """反向：file_id 落在 agent-docs 但入参 path 指向 my-docs —— 两个可寻址目标都得干净。"""
    st = _store(tmp_path)
    action = {"tool": "library_write", "file_id": 5, "path": "my-docs/x.md", "size_bytes": 10}
    assert _ev(st, action, "cron_headless", resolver=_resolver({5: "agent-docs/ok.md"})) == ASK


@pytest.mark.parametrize("bad", [None, "", 0, -1, "7", 7.5, True])
def test_floor_unresolvable_or_junk_file_id_asks(tmp_path, bad):
    """地板：反查不出路径（行不存在 / 非 present / 脏 id）→ 弹卡，绝不「读不到就放行」。"""
    st = _store(tmp_path)
    action = {"tool": "library_append", "file_id": bad, "size_bytes": 10}
    assert _ev(st, action, "cron_headless", resolver=_resolver({})) == ASK


def test_floor_missing_resolver_asks(tmp_path):
    """地板：调用方没接反查回调 = 判不了 ⇒ 弹卡（未接线恒更窄）。"""
    st = _store(tmp_path)
    action = {"tool": "library_append", "file_id": 7, "size_bytes": 10}
    assert _ev(st, action, "cron_headless", resolver=None) == ASK


def test_floor_resolver_exception_asks(tmp_path):
    """地板：反查抛异常 → 弹卡（fail-closed，不崩）。"""
    st = _store(tmp_path)

    def _boom(_file_id):
        raise RuntimeError("library.db locked")

    action = {"tool": "library_append", "file_id": 7, "size_bytes": 10}
    assert _ev(st, action, "cron_headless", resolver=_boom) == ASK


def test_floor_no_addressable_target_asks(tmp_path):
    """地板：既没 file_id 也没 path ⇒ 无从判目标 ⇒ 弹卡。"""
    st = _store(tmp_path)
    assert _ev(st, {"tool": "library_append", "size_bytes": 10}, "cron_headless") == ASK


# ── 地板③：move / delete 不进本通道 ──────────────────────────────────────────────────


@pytest.mark.parametrize("tool", ["library_move", "library_delete"])
@pytest.mark.parametrize("mode", HEADLESS_MODES)
def test_floor_move_and_delete_never_auto_allow(tmp_path, tool, mode):
    """地板：即便目标就在 agent-docs/ 下、大小也合规，move / delete 也恒弹卡。"""
    st = _store(tmp_path)
    resolver = _resolver({7: "agent-docs/atlas/log.md"})
    action = {"tool": tool, "file_id": 7, "path": "agent-docs/atlas/log.md", "size_bytes": 0}
    assert _ev(st, action, mode, resolver=resolver) == ASK


def test_floor_other_domain_write_tools_never_auto_allow(tmp_path):
    """地板：通道按工具名开口 —— 别的 domain_write 工具蹭不到（哪怕带一条 agent-docs 路径）。"""
    st = _store(tmp_path)
    for tool in ("email_flag", "matter_update", "contact_set_kind", "library_appendx", ""):
        action = {"tool": tool, "path": "agent-docs/x.md", "size_bytes": 10}
        assert _ev(st, action, "cron_headless") == ASK, tool


# ── 地板④：大小上限 ─────────────────────────────────────────────────────────────────


def test_size_cap_is_the_library_constant_not_a_hand_copy():
    assert P.LIBRARY_UNATTENDED_MAX_BYTES == TEXT_WRITE_MAX_BYTES


def test_floor_oversize_write_asks(tmp_path):
    st = _store(tmp_path)
    ok = {"tool": "library_write", "path": "agent-docs/x.md", "size_bytes": TEXT_WRITE_MAX_BYTES}
    assert _ev(st, ok, "cron_headless") == ALLOW
    over = dict(ok, size_bytes=TEXT_WRITE_MAX_BYTES + 1)
    assert _ev(st, over, "cron_headless") == ASK


@pytest.mark.parametrize("bad", [None, -1, "10", 10.5, True])
def test_floor_missing_or_junk_size_asks(tmp_path, bad):
    """地板：拿不到本次写入的字节数就判不了上限 ⇒ 弹卡。"""
    st = _store(tmp_path)
    action = {"tool": "library_write", "path": "agent-docs/x.md", "size_bytes": bad}
    assert _ev(st, action, "cron_headless") == ASK


# ── 与既有 domain_write 白名单规则并存（互不干扰）──────────────────────────────────


def test_existing_domain_write_rule_still_wins_for_its_own_tool(tmp_path):
    """既有 per-agent domain_write 规则的行为逐字节不变（本通道只是多一条并行开口）。"""
    st = _store(tmp_path)
    rule = st.create_policy_rule(
        "domain_write",
        json.dumps({"v": 1, "tool": "email_flag"}),
        context_mode="untrusted_trigger",
        agent_id="dms",
    )
    res = _ev(st, {"tool": "email_flag"}, "untrusted_trigger")
    assert res == {"decision": "auto_allow", "rule_id": rule.id}


def test_library_channel_does_not_shadow_a_db_rule_for_move(tmp_path):
    """owner 手动为 library_move 建过规则 → 仍按规则放行（本通道不管、也不拦）。"""
    st = _store(tmp_path)
    rule = st.create_policy_rule(
        "domain_write",
        json.dumps({"v": 1, "tool": "library_move"}),
        context_mode="cron_headless",
        agent_id="dms",
    )
    res = _ev(st, {"tool": "library_move", "file_id": 7}, "cron_headless")
    assert res == {"decision": "auto_allow", "rule_id": rule.id}


# ── 路径判定纯函数（把边界情形钉在最小单元上）──────────────────────────────────────


@pytest.mark.parametrize(
    "path,expected",
    [
        ("agent-docs/a.md", True),
        ("agent-docs/sub/a.md", True),
        ("agent-docs/./a.md", True),
        ("agent-docs//a.md", True),
        ("agent-docs", False),
        ("agent-docs/", False),
        ("agent-docs/..", False),
        ("agent-docs/../my-docs/a.md", False),
        ("my-docs/a.md", False),
        ("@m/agent-docs/a.md", False),
        ("/agent-docs/a.md", False),
        ("agent-docs/a\x00.md", False),
        (" agent-docs/a.md", True),  # 两端空白 strip 后仍是同一条虚拟路径
        (None, False),
        (42, False),
        (b"agent-docs/a.md", False),
    ],
)
def test_under_agent_docs_predicate(path, expected):
    assert P._library_path_under_agent_docs(path) is expected
