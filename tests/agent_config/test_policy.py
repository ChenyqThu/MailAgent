"""PolicyRule 评估器单测（S2 W1，ADR-001 §6 D4）—— matcher 全语义 + context_mode 绑定 + fail-closed。

纯单测（tmp_path 直建库，不碰 env / 单例）。真实文件系统只用 tmp_path + 现存二进制（/bin/echo）
做 realpath 锚点，零真实 PII / 零外部依赖。
"""

from __future__ import annotations

import json
import os

import pytest

from src.agent_config import policy as P
from src.agent_config.store import AgentConfigStore

ECHO = os.path.realpath("/bin/echo")


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


def _exec_rule(store, matcher, *, context_mode="manual_chat"):
    return store.create_policy_rule(
        "exec", json.dumps(matcher), context_mode=context_mode
    )


# ── matcher: exec ────────────────────────────────────────────────────────────────


def test_exec_pin_and_any_match():
    m = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "status"}, {"any": True}]}
    )
    assert P._match_exec(m, {"argv": ["/bin/echo", "status", "anything"], "cwd": None}) is True


def test_exec_pin_mismatch():
    m = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "status"}]}
    )
    assert P._match_exec(m, {"argv": ["/bin/echo", "other"], "cwd": None}) is False


def test_exec_length_must_be_equal_no_cross_position_wildcard():
    m = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "a"}, {"any": True}]}
    )
    # 少一位 / 多一位都不匹配（模板逐位、长度严格相等）。
    assert P._match_exec(m, {"argv": ["/bin/echo", "a"], "cwd": None}) is False
    assert P._match_exec(m, {"argv": ["/bin/echo", "a", "b", "c"], "cwd": None}) is False


def test_exec_argv0_realpath_equality():
    m = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": []}
    )
    # 不同二进制 → 不匹配（argv0 realpath 等值）。
    assert P._match_exec(m, {"argv": ["/bin/cat"], "cwd": None}) is False
    assert P._match_exec(m, {"argv": ["/bin/echo"], "cwd": None}) is True


def test_exec_cwd_scope_boundary(tmp_path):
    scope = tmp_path / "proj"
    scope.mkdir()
    (scope / "sub").mkdir()
    m = P.ExecMatcher.model_validate(
        {"v": 1, "argv0_realpath": ECHO, "argv_template": [], "cwd_scope": str(scope)}
    )
    assert P._match_exec(m, {"argv": ["/bin/echo"], "cwd": str(scope / "sub")}) is True
    assert P._match_exec(m, {"argv": ["/bin/echo"], "cwd": str(tmp_path)}) is False  # 上级不在域内
    assert P._match_exec(m, {"argv": ["/bin/echo"], "cwd": None}) is False  # 要求 cwd 但未给 → 不匹配


def test_exec_unknown_version_rejected():
    with pytest.raises(Exception):
        P.ExecMatcher.model_validate({"v": 2, "argv0_realpath": ECHO})


def test_exec_argv0_must_be_absolute():
    with pytest.raises(Exception):
        P.ExecMatcher.model_validate({"v": 1, "argv0_realpath": "echo"})


def test_exec_extra_field_rejected():
    with pytest.raises(Exception):
        P.ExecMatcher.model_validate({"v": 1, "argv0_realpath": ECHO, "sneaky": 1})


# ── matcher: file ────────────────────────────────────────────────────────────────


def test_file_prefix_boundary():
    m = P.FileMatcher.model_validate({"v": 1, "realpath_prefix": "/tmp/foo"})
    assert P._match_file(m, {"path": "/tmp/foo/a.txt"}) is True
    assert P._match_file(m, {"path": "/tmp/foo"}) is True
    assert P._match_file(m, {"path": "/tmp/foobar/a.txt"}) is False  # /foo 不匹配 /foobar


def test_file_prefix_must_be_absolute():
    with pytest.raises(Exception):
        P.FileMatcher.model_validate({"v": 1, "realpath_prefix": "rel/dir"})


# ── matcher: web ─────────────────────────────────────────────────────────────────


def test_web_origin_port_fill_and_scheme():
    m = P.WebMatcher.model_validate({"v": 1, "origin": "https://example.com"})
    assert P._match_web(m, {"origin": "https://example.com:443"}) is True
    assert P._match_web(m, {"url": "https://example.com/path?q=1"}) is True
    assert P._match_web(m, {"origin": "http://example.com"}) is False  # scheme 不同
    assert P._match_web(m, {"origin": "https://evil.com"}) is False


def test_web_explicit_port_distinct():
    m = P.WebMatcher.model_validate({"v": 1, "origin": "https://example.com:8443"})
    assert P._match_web(m, {"origin": "https://example.com:8443"}) is True
    assert P._match_web(m, {"origin": "https://example.com"}) is False  # 默认 443 ≠ 8443


def test_web_invalid_origin_rejected():
    with pytest.raises(Exception):
        P.WebMatcher.model_validate({"v": 1, "origin": "ftp://example.com"})


# ── canonical origin（S6 W3，ADR-004 rev3.1 D-fix-4 测试矩阵）────────────────────────
# `_normalize_origin` 是四个消费处（规则存储校验 / 策略匹配 / web.py redirect 逐跳 / TS 预览
# 回显）的唯一权威实现 —— 等值/不等值/拒绝三组逐项钉死。


@pytest.mark.parametrize(
    "a,b",
    [
        ("HTTPS://Example.COM", "https://example.com:443"),        # 大小写 + 默认端口显式化
        ("https://x.com", "https://x.com:443"),                    # 默认端口补齐
        ("http://x.com", "http://x.com:80"),
        ("https://bücher.example", "https://xn--bcher-kva.example"),  # IDN unicode ≡ punycode
        ("https://BÜCHER.example", "https://xn--bcher-kva.example"),  # IDN 大小写
        ("https://example.com.", "https://example.com"),           # 尾点 host
        ("https://example.com/path?q=1#f", "https://example.com"),  # path/query/fragment 丢弃
    ],
)
def test_normalize_origin_equivalence(a, b):
    na, nb = P._normalize_origin(a), P._normalize_origin(b)
    assert na is not None and na == nb


@pytest.mark.parametrize(
    "a,b",
    [
        ("http://x.com", "https://x.com"),                # scheme 变化
        ("https://x.com:8443", "https://x.com"),          # 端口变化
        ("https://sub.example.com", "https://example.com"),  # 子域
        ("https://evil-example.com", "https://example.com"),  # 前缀攻击
    ],
)
def test_normalize_origin_non_match(a, b):
    na, nb = P._normalize_origin(a), P._normalize_origin(b)
    assert na is not None and nb is not None and na != nb


@pytest.mark.parametrize(
    "bad",
    [
        "https://user:pass@x.com",   # userinfo 拒（与 ssrf.validate_url 同向）
        "https://user@x.com",        # 仅 username 也拒
        "ftp://x.com",               # 非 http(s)
        "https://",                  # 缺 host
        "",                          # 空
        None,                        # 非字符串
        "https://x.com:99999",       # 非法端口
    ],
)
def test_normalize_origin_rejects(bad):
    assert P._normalize_origin(bad) is None


def test_normalize_origin_idn_match_via_rule():
    """IDN 规则与 punycode 动作互相命中（matcher 每次匹配时归一 → 函数升级对存量规则均匀生效）。"""
    m = P.WebMatcher.model_validate({"v": 1, "origin": "https://bücher.example"})
    assert P._match_web(m, {"url": "https://xn--bcher-kva.example/seite?x=1"}) is True
    assert P._match_web(m, {"url": "https://buecher.example/"}) is False


def test_normalize_origin_single_source_with_web_router(monkeypatch):
    """跨消费面一致性（D-fix-4 ④）：web.py redirect 检查侧与策略匹配侧是**同一个函数对象**。"""
    # standalone 跑 tests/agent_config 时本测试是 src.api 的首个进入点，需自备两个
    # 全量跑时由别处满足的前置（全量跑时 tests/api/conftest 收集期 export auth env +
    # 先加载过 src.api.app，本测试命中 sys.modules 缓存，以下两步均 inert）：
    # ① src.api.auth 有 import-time fail-fast（一种鉴权方式都没配即 RuntimeError）——
    #    喂 dummy 本地 token 过闸（不走 dev bypass，鉴权语义不在断言面内）；
    # ② app↔routers 的环设计上只支持 app 为入口（app.py 底部回头 include_router(web)，
    #    以 web 为入口会撞半初始化模块）——先 import app 固定入口方向。
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "test-order-independence")
    import src.api.app  # noqa: F401

    import src.api.routers.web as web_router

    assert web_router._normalize_origin is P._normalize_origin


# ── evaluate: context_mode 绑定 + use_count + fail-closed ─────────────────────────


def test_evaluate_auto_allow_and_use_count(tmp_path):
    st = _store(tmp_path)
    rule = _exec_rule(st, {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "hi"}]})
    res = P.evaluate(st, "exec", {"argv": ["/bin/echo", "hi"], "cwd": None}, "manual_chat")
    assert res == {"decision": "auto_allow", "rule_id": rule.id}
    row = st.get_policy_rule(rule.id)
    assert row.use_count == 1 and row.last_used_at is not None
    # 再命中 → 计数递增。
    P.evaluate(st, "exec", {"argv": ["/bin/echo", "hi"], "cwd": None}, "manual_chat")
    assert st.get_policy_rule(rule.id).use_count == 2


def test_evaluate_context_mode_binding_red_line(tmp_path):
    """红线①：manual_chat 规则永不匹配 untrusted_trigger / cron_headless 查询。"""
    st = _store(tmp_path)
    _exec_rule(st, {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "hi"}]},
               context_mode="manual_chat")
    action = {"argv": ["/bin/echo", "hi"], "cwd": None}
    assert P.evaluate(st, "exec", action, "manual_chat")["decision"] == "auto_allow"
    assert P.evaluate(st, "exec", action, "untrusted_trigger")["decision"] == "ask"
    assert P.evaluate(st, "exec", action, "cron_headless")["decision"] == "ask"


def test_evaluate_no_match_returns_ask(tmp_path):
    st = _store(tmp_path)
    _exec_rule(st, {"v": 1, "argv0_realpath": ECHO, "argv_template": [{"pin": "hi"}]})
    assert P.evaluate(st, "exec", {"argv": ["/bin/echo", "bye"], "cwd": None}, "manual_chat") == {
        "decision": "ask",
        "rule_id": None,
    }


def test_evaluate_empty_store_asks(tmp_path):
    st = _store(tmp_path)
    assert P.evaluate(st, "exec", {"argv": ["/bin/echo"]}, "manual_chat")["decision"] == "ask"


def test_evaluate_unknown_capability_or_mode_asks(tmp_path):
    st = _store(tmp_path)
    assert P.evaluate(st, "nonsense", {"argv": ["/bin/echo"]}, "manual_chat")["decision"] == "ask"
    assert P.evaluate(st, "exec", {"argv": ["/bin/echo"]}, "bogus_mode")["decision"] == "ask"


def test_evaluate_malformed_rule_is_skipped_not_crash(tmp_path):
    """坏 matcher_json（缺 argv0_realpath）→ 该规则解析失败被跳过，不放行也不崩 → ask。"""
    st = _store(tmp_path)
    st.create_policy_rule("exec", json.dumps({"v": 1}), context_mode="manual_chat")  # 缺必填
    assert P.evaluate(st, "exec", {"argv": ["/bin/echo", "hi"], "cwd": None}, "manual_chat") == {
        "decision": "ask",
        "rule_id": None,
    }


def test_evaluate_store_exception_fails_closed():
    """store 抛异常 → evaluate 顶层兜底 ask（绝不放行）。"""

    class _BrokenStore:
        def candidate_policy_rules(self, capability, context_mode):
            raise RuntimeError("db exploded")

    assert P.evaluate(_BrokenStore(), "exec", {"argv": ["/bin/echo"]}, "manual_chat") == {
        "decision": "ask",
        "rule_id": None,
    }


def test_evaluate_file_capability(tmp_path):
    st = _store(tmp_path)
    work = tmp_path / "work"
    work.mkdir()
    rule = st.create_policy_rule(
        "file_read", json.dumps({"v": 1, "realpath_prefix": str(work)}), context_mode="manual_chat"
    )
    assert P.evaluate(st, "file_read", {"path": str(work / "a.txt")}, "manual_chat") == {
        "decision": "auto_allow",
        "rule_id": rule.id,
    }
    # 写能力与读能力规则不串（capability 严格等值）。
    assert P.evaluate(st, "file_write", {"path": str(work / "a.txt")}, "manual_chat")["decision"] == "ask"


# ── 危险 argv0 ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "basename,expected",
    [
        ("bash", True), ("sh", True), ("zsh", True), ("python", True), ("python3", True),
        ("python3.11", True), ("node", True), ("git", True), ("npm", True), ("env", True),
        ("sudo", True), ("osascript", True), ("uv", True),
        # W1a-fix P2-1: macOS / *nix 关键脚枪补充
        ("open", True), ("ssh", True), ("scp", True), ("sftp", True),
        ("nc", True), ("ncat", True), ("socat", True),
        ("vim", True), ("vi", True), ("view", True), ("nano", True), ("emacs", True),
        ("tar", True), ("sqlite3", True), ("gdb", True), ("lldb", True), ("dtrace", True),
        ("tclsh", True), ("expect", True), ("lua", True), ("Rscript", True),
        ("ffmpeg", False), ("mytool", False), ("cat", False), ("ls", False),
    ],
)
def test_is_dangerous_argv0(basename, expected):
    assert P.is_dangerous_argv0(f"/usr/local/bin/{basename}") is expected


def test_rule_is_dangerously_wide():
    # 危险 argv0 + {any} → 危险宽规则。
    assert P.rule_is_dangerously_wide(
        {"v": 1, "argv0_realpath": "/usr/bin/git", "argv_template": [{"any": True}]}
    ) is True
    # 危险 argv0 但全 pin → 非宽（安全）。
    assert P.rule_is_dangerously_wide(
        {"v": 1, "argv0_realpath": "/usr/bin/git", "argv_template": [{"pin": "status"}]}
    ) is False
    # 非危险 argv0 + {any} → 非危险宽。
    assert P.rule_is_dangerously_wide(
        {"v": 1, "argv0_realpath": "/opt/mytool", "argv_template": [{"any": True}]}
    ) is False
    # 非 exec matcher / 非法 → False。
    assert P.rule_is_dangerously_wide({"v": 1, "realpath_prefix": "/tmp"}) is False
    assert P.rule_is_dangerously_wide({"garbage": True}) is False
