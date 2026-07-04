"""notion-agent Python 复刻测试 —— src/chat/notion_agent*（3b-2；现供 notion_agent_chat skill 直调）。

Python 侧逐一对齐 frontend ``notion_agent_backend.test.ts`` + ``notion_agent_gate.test.ts`` 的
语义契约（exit 75/77/127 分类 + thread 探测 + extractTurn + email context header + idle 超时 +
gate 串行 + safeErrorMessage 不泄漏 token_v2）。**mock subprocess**（注入 fake spawn），不依赖
真 notion-agent CLI。

async 用例沿用本仓既有范式 ``asyncio.run(_())``（无 asyncio_mode=auto，不用 pytest-asyncio
marker）。auth bypass 默认 ON（tests/api/conftest）。
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, List, Optional

from src.chat.notion_agent import (
    classify_exit,
    detect_new_thread_id,
    extract_turn,
    format_email_context_header,
    run_notion_agent,
    safe_error_message,
    snapshot_thread_files,
)
from src.chat.notion_agent_gate import NotionAgentSerialGate


# ── fake subprocess ─────────────────────────────────────────────────────────


class FakeProcess:
    """注入式 fake，复刻 ``_SubprocessHandle`` 接口（read_chunk/wait/read_stderr/kill）。

    chunks 逐次吐出后 EOF（b""）。``hold``=asyncio.Event → 吐完 chunks 后阻塞在 EOF 前（模拟
    子进程仍在跑、持有 gate）直到 test 放行。``hang_forever`` → 阻塞直到被 kill（模拟 hung CLI，
    供 idle 看门狗测试）。
    """

    def __init__(
        self,
        chunks=(),
        exit_code: Optional[int] = 0,
        stderr: str = "",
        *,
        hold: Optional[asyncio.Event] = None,
        hang_forever: bool = False,
        hang_wait: bool = False,
    ) -> None:
        self._chunks: List[bytes] = [
            c if isinstance(c, bytes) else c.encode("utf-8") for c in chunks
        ]
        self._exit_code = exit_code
        self._stderr = stderr
        self._hold = hold
        self._hang_forever = hang_forever
        self._hang_wait = hang_wait  # stdout EOF 后 wait() 阻塞直到被 kill（看门狗须覆盖 wait 阶段）
        self._killed = asyncio.Event()
        self.kill_count = 0

    async def read_chunk(self) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        if self._hang_forever:
            await self._killed.wait()  # 阻塞直到被 kill → 然后 EOF
            return b""
        if self._hold is not None:
            await self._hold.wait()  # 阻塞（持有 gate）直到 test 放行 → 然后 EOF
        return b""

    async def wait(self) -> Optional[int]:
        if self._hang_wait and not self._killed.is_set():
            await self._killed.wait()  # 阻塞直到被 kill → 模拟 EOF 后 hang 在退出
        return self._exit_code

    async def read_stderr(self) -> str:
        return self._stderr

    def kill(self) -> None:
        self.kill_count += 1
        self._killed.set()


def _fake_spawn(**proc_kwargs):
    """返回 (spawn, captured)：spawn 记录 bin/args/stdin，每次新建一个 FakeProcess(**proc_kwargs)。"""
    captured: Dict[str, Any] = {}

    async def spawn(bin_path: str, args: List[str], stdin_data: bytes):
        captured["bin"] = bin_path
        captured["args"] = list(args)
        captured["stdin"] = stdin_data
        return FakeProcess(**proc_kwargs)

    return spawn, captured


async def _collect(gen) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    async for ev in gen:
        out.append(ev)
    return out


def _req(
    content: str = "hi",
    *,
    thread_id: Optional[str] = None,
    model: Optional[str] = "opus-4.8",
    email_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """构造 ChatStreamRequest 子集。给 thread_id → 历史里塞一条带 metadata 的 assistant，
    extract_turn 即取到该 thread_id（续轮路径，跳过 THREADS_DIR snapshot）。"""
    history: List[Dict[str, Any]] = []
    if thread_id:
        history.append({"role": "user", "content": "earlier"})
        history.append(
            {
                "role": "assistant",
                "content": "prev",
                "model": "x",
                "metadata": json.dumps({"thread_id": thread_id}),
            }
        )
    history.append({"role": "user", "content": content})
    return {
        "history": history,
        "model": model,
        "agentPageId": None,
        "emailContext": email_context,
    }


def _fresh_gate() -> NotionAgentSerialGate:
    return NotionAgentSerialGate(get_min_interval_ms=lambda: 0.0)


# ── extractTurn ─────────────────────────────────────────────────────────────


def test_extract_turn_picks_latest_user() -> None:
    prompt, _ = extract_turn(
        {
            "history": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "hi"},
                {"role": "user", "content": "second"},
            ]
        }
    )
    assert prompt == "second"


def test_extract_turn_thread_from_metadata() -> None:
    _, tid = extract_turn(
        {
            "history": [
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": "hello",
                    "model": "claude-sonnet-4-6",
                    "metadata": json.dumps({"thread_id": "thr-new"}),
                },
                {"role": "user", "content": "follow up"},
            ]
        }
    )
    assert tid == "thr-new"


def test_extract_turn_thread_legacy_model() -> None:
    _, tid = extract_turn(
        {
            "history": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello", "model": "notion-agent:thr-old"},
                {"role": "user", "content": "follow up"},
            ]
        }
    )
    assert tid == "thr-old"


def test_extract_turn_metadata_precedence_over_legacy() -> None:
    _, tid = extract_turn(
        {
            "history": [
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": "hello",
                    "model": "notion-agent:thr-old",
                    "metadata": json.dumps({"thread_id": "thr-new"}),
                },
                {"role": "user", "content": "follow up"},
            ]
        }
    )
    assert tid == "thr-new"


def test_extract_turn_thread_none_when_absent() -> None:
    _, tid = extract_turn({"history": [{"role": "user", "content": "hi"}]})
    assert tid is None


# ── formatEmailContextHeader ────────────────────────────────────────────────


def test_email_header_with_notion_page_id() -> None:
    h = format_email_context_header({"notionPageId": "31a1-5375-830d", "internalId": 5})
    assert "https://www.notion.so/31a15375830d" in h  # dash 去除
    assert "[参考邮件]" in h


def test_email_header_fallback_metadata() -> None:
    h = format_email_context_header(
        {
            "notionPageId": None,
            "internalId": 42,
            "subject": "Hi",
            "senderName": "Bob",
            "senderAddr": "bob@x.com",
            "dateIso": "2026-06-05",
        }
    )
    assert "internal_id: 42" in h
    assert "主题: Hi" in h
    assert "发件人: Bob <bob@x.com>" in h
    assert "https://www.notion.so" not in h  # 无 notionPageId 不给 URL


def test_email_header_none() -> None:
    assert format_email_context_header(None) == ""


# ── classifyExit ────────────────────────────────────────────────────────────


def test_classify_exit_structured_codes_authoritative() -> None:
    assert classify_exit(75, "") == "E_NOTION_AGENT_RATE_LIMIT"
    # 结构化 exit 75 即便 stderr 看着像 auth 也 win。
    assert classify_exit(75, "token_v2 something") == "E_NOTION_AGENT_RATE_LIMIT"
    assert classify_exit(77, "") == "E_NOTION_AGENT_AUTH"
    assert classify_exit(127, "") == "E_NOTION_AGENT_NOT_INSTALLED"


def test_classify_exit_stderr_fallback() -> None:
    assert classify_exit(1, "token_v2 cookie expired") == "E_NOTION_AGENT_AUTH"
    assert classify_exit(1, "unauthorized") == "E_NOTION_AGENT_AUTH"
    assert classify_exit(1, "cloudflare blocked") == "E_NOTION_AGENT_NETWORK"
    assert classify_exit(1, "network unreachable") == "E_NOTION_AGENT_NETWORK"
    assert (
        classify_exit(1, "request failed: trust-rule-denied")
        == "E_NOTION_AGENT_RATE_LIMIT"
    )
    assert classify_exit(1, "unknown blowup") == "E_NOTION_AGENT_FAIL"


# ── safeErrorMessage（不泄漏 token_v2 cookie，C-04）─────────────────────────


def test_safe_error_message_no_token_v2_leak() -> None:
    code = classify_exit(1, "token_v2=deadbeef secret cookie")
    msg = safe_error_message(code, 1)
    assert code == "E_NOTION_AGENT_AUTH"
    assert "token_v2" not in msg
    assert "deadbeef" not in msg
    assert "notion-agent init" in msg


def test_safe_error_message_variants() -> None:
    assert "trust-rule" in safe_error_message("E_NOTION_AGENT_RATE_LIMIT", 75)
    assert "Cloudflare" in safe_error_message("E_NOTION_AGENT_NETWORK", 1)
    assert "not found on PATH" in safe_error_message("E_NOTION_AGENT_NOT_INSTALLED", 127)
    assert "code 9" in safe_error_message("E_NOTION_AGENT_FAIL", 9)


# ── detectNewThreadId / snapshot ────────────────────────────────────────────


def test_detect_new_thread_id(tmp_path, monkeypatch) -> None:
    threads = tmp_path / "threads"
    threads.mkdir()
    monkeypatch.setattr("src.chat.notion_agent.THREADS_DIR", str(threads))
    (threads / "a.json").write_text("{}")
    assert detect_new_thread_id({"a.json"}) is None  # snapshot 外无新增
    (threads / "new.json").write_text("{}")
    assert detect_new_thread_id({"a.json"}) == "new"  # 去 .json


def test_detect_new_thread_id_most_recent_wins(tmp_path, monkeypatch) -> None:
    threads = tmp_path / "threads"
    threads.mkdir()
    monkeypatch.setattr("src.chat.notion_agent.THREADS_DIR", str(threads))
    (threads / "x.json").write_text("{}")
    (threads / "y.json").write_text("{}")
    os.utime(str(threads / "x.json"), (100, 100))
    os.utime(str(threads / "y.json"), (200, 200))  # y 更新
    assert detect_new_thread_id(set()) == "y"


def test_snapshot_thread_files_missing_dir(monkeypatch) -> None:
    monkeypatch.setattr("src.chat.notion_agent.THREADS_DIR", "/nonexistent/threads/xyz")
    assert snapshot_thread_files() == set()


# ── happy path streaming ────────────────────────────────────────────────────


def test_happy_path_streaming_reuses_thread_id() -> None:
    async def _() -> None:
        spawn, captured = _fake_spawn(chunks=["Hello", " back", ".\n"], exit_code=0)
        events = await _collect(
            run_notion_agent(
                _req("again", thread_id="thr-001", model="opus-4.8"),
                spawn=spawn,
                gate=_fresh_gate(),
            )
        )
        # 首事件 running breadcrumb；末事件 done。
        assert events[0]["type"] == "tool_call" and events[0]["status"] == "running"
        assert events[-1]["type"] == "done"
        # 流式 delta 拼回全文。
        streamed = "".join(e["delta"] for e in events if e["type"] == "chunk")
        assert streamed == "Hello back.\n"
        usage = next(e for e in events if e["type"] == "usage")
        assert usage["model"] == "opus-4.8"
        assert usage["inputTokens"] == 0 and usage["outputTokens"] == 0
        assert usage["metadata"] == {"thread_id": "thr-001"}
        done = next(e for e in events if e["type"] == "done")
        assert done["finalContent"] == "Hello back."  # 尾换行 trim
        assert done["metadata"] == {"thread_id": "thr-001"}
        # argv：--stream + --thread-id thr-001 + --model；prompt 在 stdin、非 argv positional。
        assert captured["args"][:2] == ["chat", "--stream"]
        assert "--thread-id" in captured["args"] and "thr-001" in captured["args"]
        assert "--model" in captured["args"] and "opus-4.8" in captured["args"]
        assert "--json" not in captured["args"]
        assert "--agent-page-id" not in captured["args"]
        assert "again" not in captured["args"]  # prompt 不是 argv positional
        assert b"again" in captured["stdin"]  # prompt 走 stdin

    asyncio.run(_())


def test_first_turn_recovers_thread_id(tmp_path, monkeypatch) -> None:
    threads = tmp_path / "threads"
    threads.mkdir()
    monkeypatch.setattr("src.chat.notion_agent.THREADS_DIR", str(threads))

    async def _() -> None:
        captured: Dict[str, Any] = {}

        async def spawn(bin_path, args, stdin_data):
            captured["args"] = list(args)
            # 模拟 CLI 落 thread 状态文件（首轮 snapshot 之后）。
            (threads / "thr-fresh.json").write_text("{}")
            return FakeProcess(chunks=["Hi"], exit_code=0)

        events = await _collect(
            run_notion_agent(_req("hello", thread_id=None), spawn=spawn, gate=_fresh_gate())
        )
        done = next(e for e in events if e["type"] == "done")
        assert done["metadata"] == {"thread_id": "thr-fresh"}
        # 首轮无 --thread-id。
        assert "--thread-id" not in captured["args"]

    asyncio.run(_())


def test_first_turn_injects_email_context_header() -> None:
    async def _() -> None:
        spawn, captured = _fake_spawn(chunks=["ok"], exit_code=0)
        ctx = {"notionPageId": "abc-123", "internalId": 7}
        await _collect(
            run_notion_agent(
                _req("summarize", thread_id=None, email_context=ctx),
                spawn=spawn,
                gate=_fresh_gate(),
            )
        )
        stdin_text = captured["stdin"].decode("utf-8")
        # 首轮 stdin 前置 Notion 页 URL（让 agent loadPage）+ 用户问题。
        assert "https://www.notion.so/abc123" in stdin_text
        assert "我的问题：" in stdin_text
        assert "summarize" in stdin_text

    asyncio.run(_())


def test_followup_skips_email_context_header() -> None:
    async def _() -> None:
        spawn, captured = _fake_spawn(chunks=["ok"], exit_code=0)
        ctx = {"notionPageId": "abc-123", "internalId": 7}
        await _collect(
            run_notion_agent(
                _req("again", thread_id="thr-x", email_context=ctx),
                spawn=spawn,
                gate=_fresh_gate(),
            )
        )
        stdin_text = captured["stdin"].decode("utf-8")
        # 续轮（有 thread_id）跳过 email header —— thread_id 已带 context。
        assert "notion.so" not in stdin_text
        assert stdin_text == "again"

    asyncio.run(_())


# ── error paths ─────────────────────────────────────────────────────────────


def test_empty_history_invalid_arg_no_spawn() -> None:
    async def _() -> None:
        spawned = {"n": 0}

        async def spawn(*a):
            spawned["n"] += 1
            return FakeProcess()

        events = await _collect(
            run_notion_agent(
                {"history": [], "model": None, "agentPageId": None, "emailContext": None},
                spawn=spawn,
                gate=_fresh_gate(),
            )
        )
        assert events == [
            {
                "type": "error",
                "code": "E_INVALID_ARG",
                "message": "notion-agent backend: history has no user message to answer",
            }
        ]
        assert spawned["n"] == 0

    asyncio.run(_())


def test_nonzero_exit_token_v2_auth_no_leak() -> None:
    async def _() -> None:
        spawn, _c = _fake_spawn(
            chunks=[],
            exit_code=1,
            stderr="token_v2 cookie has expired, re-run notion-agent init",
        )
        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        last = events[-1]
        assert last["type"] == "error" and last["code"] == "E_NOTION_AGENT_AUTH"
        assert "token_v2" not in last["message"]  # 不泄漏 cookie（C-04）
        # error tool_call 的 detail 也是安全文案。
        err_tc = [e for e in events if e["type"] == "tool_call" and e["status"] == "error"]
        assert err_tc and "token_v2" not in err_tc[-1]["detail"]
        assert not any(e["type"] == "done" for e in events)  # 失败无 done/usage

    asyncio.run(_())


def test_exit_75_rate_limit() -> None:
    async def _() -> None:
        spawn, _c = _fake_spawn(chunks=[], exit_code=75, stderr="error: trust-rule-denied")
        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        last = events[-1]
        assert last["type"] == "error" and last["code"] == "E_NOTION_AGENT_RATE_LIMIT"
        assert not any(e["type"] == "done" for e in events)

    asyncio.run(_())


def test_exit_77_auth() -> None:
    async def _() -> None:
        spawn, _c = _fake_spawn(chunks=[], exit_code=77)
        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        assert events[-1]["code"] == "E_NOTION_AGENT_AUTH"

    asyncio.run(_())


def test_exit_127_not_installed() -> None:
    async def _() -> None:
        spawn, _c = _fake_spawn(chunks=[], exit_code=127)
        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        assert events[-1]["code"] == "E_NOTION_AGENT_NOT_INSTALLED"

    asyncio.run(_())


def test_idle_timeout_kills_and_reports(monkeypatch) -> None:
    monkeypatch.setenv("NOTION_AGENT_IDLE_TIMEOUT_MS", "40")

    async def _() -> None:
        box: Dict[str, FakeProcess] = {}

        async def spawn(*a):
            p = FakeProcess(chunks=[], hang_forever=True)  # 永不吐 chunk，直到被 kill
            box["p"] = p
            return p

        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        err = next(e for e in events if e["type"] == "error")
        assert err["code"] == "E_NOTION_AGENT_TIMEOUT"
        assert box["p"].kill_count >= 1  # 看门狗 kill 了子进程
        assert not any(e["type"] == "done" for e in events)

    asyncio.run(_())


def test_idle_timeout_on_hung_wait_after_eof(monkeypatch) -> None:
    # stdout EOF 后进程 hang 在退出（wait() 不返回）—— 看门狗须覆盖 wait 阶段，否则卡住的子进程
    # 永久 wedge 串行 gate（codex review HIGH）。idle 窗口 40ms：wait_for(proc.wait) 超时 → kill +
    # E_NOTION_AGENT_TIMEOUT。
    monkeypatch.setenv("NOTION_AGENT_IDLE_TIMEOUT_MS", "40")

    async def _() -> None:
        box: Dict[str, FakeProcess] = {}

        async def spawn(*a):
            # 吐完 chunk 即 EOF，但 wait() 阻塞直到被 kill（模拟关 stdout 后 hang 在 cleanup）。
            p = FakeProcess(chunks=["partial"], exit_code=0, hang_wait=True)
            box["p"] = p
            return p

        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        err = next(e for e in events if e["type"] == "error")
        assert err["code"] == "E_NOTION_AGENT_TIMEOUT"
        assert box["p"].kill_count >= 1  # 看门狗 kill 了卡在退出的子进程
        assert not any(e["type"] == "done" for e in events)

    asyncio.run(_())


def test_streaming_keeps_idle_watchdog_alive(monkeypatch) -> None:
    # 每 ~20ms 一个 chunk，50ms idle 窗口：每 chunk re-arm，总时长远超窗口却不误触发超时。
    monkeypatch.setenv("NOTION_AGENT_IDLE_TIMEOUT_MS", "50")

    class _SlowProc(FakeProcess):
        async def read_chunk(self) -> bytes:
            if self._chunks:
                await asyncio.sleep(0.02)
                return self._chunks.pop(0)
            return b""

    async def _() -> None:
        async def spawn(*a):
            return _SlowProc(chunks=["a", "b", "c", "d", "e"], exit_code=0)

        events = await _collect(
            run_notion_agent(_req("hi", thread_id="t1"), spawn=spawn, gate=_fresh_gate())
        )
        assert not any(e["type"] == "error" for e in events)  # 无误触发超时
        done = next(e for e in events if e["type"] == "done")
        assert done["finalContent"] == "abcde"

    asyncio.run(_())


# ── 串行 gate ───────────────────────────────────────────────────────────────


def test_gate_serializes_two_concurrent_calls() -> None:
    async def _() -> None:
        gate = _fresh_gate()
        hold = asyncio.Event()
        spawn_count = {"n": 0}

        async def spawn(bin_path, args, stdin_data):
            n = spawn_count["n"]
            spawn_count["n"] += 1
            # call#0 持有 gate（read 阻塞在 hold）；call#1 立即 EOF。
            return FakeProcess(chunks=["hi"], hold=hold if n == 0 else None)

        req = _req("x", thread_id="t1")
        t1 = asyncio.ensure_future(_collect(run_notion_agent(req, spawn=spawn, gate=gate)))
        t2 = asyncio.ensure_future(_collect(run_notion_agent(req, spawn=spawn, gate=gate)))
        await asyncio.sleep(0.05)
        assert spawn_count["n"] == 1  # 第二个尚未 spawn（gate 被 #0 持有）
        hold.set()  # #0 流结束 → 释放 gate → #1 才能 spawn
        await asyncio.gather(t1, t2)
        assert spawn_count["n"] == 2

    asyncio.run(_())


def test_gate_abort_while_queued_never_spawns() -> None:
    async def _() -> None:
        gate = _fresh_gate()
        hold = asyncio.Event()
        spawn_count = {"n": 0}

        async def spawn(bin_path, args, stdin_data):
            spawn_count["n"] += 1
            return FakeProcess(chunks=["hi"], hold=hold)

        req = _req("x", thread_id="t1")
        t_holder = asyncio.ensure_future(_collect(run_notion_agent(req, spawn=spawn, gate=gate)))
        t_queued = asyncio.ensure_future(_collect(run_notion_agent(req, spawn=spawn, gate=gate)))
        await asyncio.sleep(0.05)
        assert spawn_count["n"] == 1  # holder spawn 了；queued 卡在 gate 上
        t_queued.cancel()  # 排队中取消（abort）
        await asyncio.gather(t_queued, return_exceptions=True)
        assert spawn_count["n"] == 1  # 被取消的 queued 从未 spawn
        hold.set()
        await asyncio.gather(t_holder, return_exceptions=True)
        assert spawn_count["n"] == 1  # 始终只有 holder spawn 过（gate 未 wedge）

    asyncio.run(_())


# ── gate 单元（mutex / min-interval / release 幂等）──────────────────────────


def test_gate_mutex_second_waits() -> None:
    async def _() -> None:
        gate = _fresh_gate()
        r1 = await gate.acquire()
        assert gate.active
        granted = {"b": False}

        async def take():
            r = await gate.acquire()
            granted["b"] = True
            return r

        t = asyncio.ensure_future(take())
        await asyncio.sleep(0)
        assert granted["b"] is False  # mutex 被 #1 持有
        r1()
        r2 = await t
        assert granted["b"] is True
        r2()

    asyncio.run(_())


def test_gate_min_interval_spacing() -> None:
    async def _() -> None:
        recorded: List[float] = []

        async def fake_sleep(s):
            recorded.append(s)

        # 时钟冻结在 0 → 第二次 acquire 须等满 30s（从第一次起点测）。
        gate = NotionAgentSerialGate(
            get_min_interval_ms=lambda: 30_000.0, now=lambda: 0.0, sleep=fake_sleep
        )
        r1 = await gate.acquire()  # last_start = 0
        r1()
        r2 = await gate.acquire()  # wait = 0 + 30000 - 0 = 30000ms → sleep(30.0)
        r2()
        assert recorded == [30.0]

    asyncio.run(_())


def test_gate_min_interval_zero_no_wait() -> None:
    async def _() -> None:
        recorded: List[float] = []

        async def fake_sleep(s):
            recorded.append(s)

        gate = NotionAgentSerialGate(
            get_min_interval_ms=lambda: 0.0, now=lambda: 0.0, sleep=fake_sleep
        )
        r1 = await gate.acquire()
        r1()
        r2 = await gate.acquire()
        r2()
        assert recorded == []  # interval=0 不 spacing

    asyncio.run(_())


def test_gate_release_idempotent() -> None:
    async def _() -> None:
        gate = _fresh_gate()
        r1 = await gate.acquire()
        grant_count = {"n": 0}

        async def take():
            r = await gate.acquire()
            grant_count["n"] += 1
            return r

        t = asyncio.ensure_future(take())
        r1()
        r1()  # 第二次 release 是 no-op，不双 grant
        r2 = await t
        await asyncio.sleep(0)
        assert grant_count["n"] == 1
        r2()

    asyncio.run(_())
