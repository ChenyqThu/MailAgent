"""cron / email 双触发全链 e2e（S4 W4，ADR D1/D2/D4/D5 + prd「触发→入队→执行→终态」）。

Python 可及范围 = 触发（tick_loop / watcher 第 5 hook）→ enqueue（幂等 + runs/day 门）→
AgentRunWorker claim → set_claim_token → poke **scripted fake gateway** → 终态回写。
fake gateway 收到 poke 后**真调** TestClient 的 ``GET /api/agent-runs/{id}/spec``（W2 端点，
CAS one-shot + claim token 校验在全链生效），再按脚本回 wire 响应——session 落库在 Node 侧
（W3 vitest 已测），此处不重复。

另含路径 B 冻结守护：``run_tool_loop`` 的调用方集合 == 冻结清单（prd「断言不走路径 B」的
机械化——任何新调用方出现即红）。

鉴权前置：``MAILAGENT_API_AUTH_DISABLED=true`` 关掉 TestClient 的 verify_local_token 腿；
真实环境两端点恒挂 verify_local_token（W2 test_spec_endpoint 已单测 403 面），本文件断言的
是 token 之上的 claim/CAS 语义。fixtures 全合成域（.test），零真实 PII。
"""
from __future__ import annotations

import os
import tempfile

# --- MUST run before importing src.api.* (import-time env reads) --------------
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")
os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(tempfile.mkdtemp(prefix="mailagent-test-s4w4-"), "agent_config.db"),
)

import asyncio  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import sqlite3  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from pathlib import Path  # noqa: E402
from types import SimpleNamespace  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# 🔴 先 import app 再取 agent_runs 模块（循环导入陷阱, 同 test_spec_endpoint 注记）。
from src.api.app import app  # noqa: E402
import src.api.routers.agent_runs as agent_runs  # noqa: E402
import src.agents.run_worker as run_worker  # noqa: E402
from src.agents import trigger_worker as tw  # noqa: E402
from src.agents.run_state import derive_agent_run_state  # noqa: E402
from src.agents.run_worker import AgentRunWorker  # noqa: E402
from src.mail.new_watcher import NewWatcher  # noqa: E402
from src.mail.sync_store import SyncStore  # noqa: E402
from src.reports.store import ReportStore  # noqa: E402
from src.repository.email_repository import EmailRepository  # noqa: E402
from src.sync.async_jobs import AsyncJobRepository  # noqa: E402


# ---------------------------------------------------------------------------
# fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def env(tmp_path, monkeypatch):
    db = tmp_path / "s.db"
    sync_store = SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    store = ReportStore(str(db))
    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "get_report_store", lambda: store)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=db, sync_store=sync_store, repo=repo, store=store)


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


_CRON = {"v": 1, "kind": "cron", "cron": "0 9 * * *", "timezone": "Asia/Shanghai"}
_EMAIL = {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批",
          "sender_pattern": "dms@corp\\.test", "folders": ["收件箱"]}


def _seed_custom(store, agent_id="dms", *, trigger, budget=None, prompt="处理 DMS 审批",
                 title="DMS Approver"):
    store.create_agent(agent_id, type="custom", enabled=True, title=title, prompt=prompt)
    patch = {"trigger_json": json.dumps(trigger)}
    if budget is not None:
        patch["budget_json"] = json.dumps(budget)
    store.update_agent(agent_id, patch)


def _agent_job_rows(db) -> list[sqlite3.Row]:
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT * FROM async_jobs WHERE job_type='agent_run' ORDER BY job_id"
        ).fetchall()
    finally:
        conn.close()


def _insert_email(db, internal_id: int, *, subject: str, sender: str, body: str,
                  sender_name: str = "DMS Bot") -> None:
    """向真实 SyncStore schema 插一封邮件（metadata + body, FTS trigger 自动跟写）。"""
    now = time.time()
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, sender_name, to_addr, cc_addr,
                date_received, mailbox, is_read, is_flagged, sync_status,
                retry_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (internal_id, f"<msg-{internal_id}@example.test>", subject, sender, sender_name,
             "owner@example.test", "", "2026-07-03 09:00:00", "收件箱", 0, 0, "synced",
             0, now, now),
        )
        conn.execute(
            """INSERT INTO email_body
               (internal_id, message_id, body_html, body_markdown, body_format,
                body_size_bytes, has_inline_images, fetched_at, fetched_source)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (internal_id, f"<msg-{internal_id}@example.test>", f"<p>{body}</p>", body,
             "html", len(body), 0, now, "davmail"),
        )
        conn.commit()
    finally:
        conn.close()


class _FakeResp:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class _ScriptedGateway:
    """scripted fake gateway：收到 poke 后真调 TestClient 的 spec 端点再按脚本回响应。

    每次 poke 顺带演练两条 HTTP 契约（记录、由测试体断言）：
      ① 错 claim token 先试一次 → 403 **且不消费**（正确 token 随后仍 200）；
      ② 拉到 spec 后再 pull 一次 → 409 E_SPEC_ALREADY_CLAIMED（CAS one-shot 全链生效）。
    """

    def __init__(self, client: TestClient, script):
        self.client = client
        self.script = script  # callable(spec_dict) -> wire dict（gateway 200 响应体）
        self.pokes: list[dict] = []
        self.specs: list[dict] = []
        self.wrong_token_statuses: list[int] = []
        self.second_pull: list[tuple[int, str]] = []  # (status, error_code)

    def handle_poke(self, body: dict) -> _FakeResp:
        self.pokes.append(dict(body))
        job_id, token = body["jobId"], body["claimToken"]
        url = f"/api/agent-runs/{job_id}/spec"
        # ① 错 token → 403 不消费
        bad = self.client.get(url, headers={"X-Claim-Token": token + "-WRONG"})
        self.wrong_token_statuses.append(bad.status_code)
        # 正确 token → 200（若上面误消费了 CAS, 这里会 409 → 测试红）
        r = self.client.get(url, headers={"X-Claim-Token": token})
        if r.status_code != 200:
            return _FakeResp(r.status_code, r.json())
        spec = r.json()["data"]
        self.specs.append(spec)
        # ② 双 pull → 409
        r2 = self.client.get(url, headers={"X-Claim-Token": token})
        self.second_pull.append((r2.status_code, r2.json()["error"]["code"]))
        return _FakeResp(200, self.script(spec))


def _install_gateway(monkeypatch, gw: _ScriptedGateway) -> None:
    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None):
            return gw.handle_poke(json)

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)


async def _drive_worker_until_terminal(env, job_id: int, timeout: float = 8.0):
    """起真实 AgentRunWorker 主循环（claim → poke → 终态），等 job 落终态后停 worker。"""
    worker = AgentRunWorker(repo=env.repo, store=env.store, poll_interval_sec=1)
    task = asyncio.create_task(worker.run())
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = env.repo.get(job_id)
            if job is not None and job.status not in ("queued", "running"):
                return job
            await asyncio.sleep(0.02)
        raise AssertionError(f"job {job_id} never reached a terminal state")
    finally:
        worker.stop()
        await asyncio.wait_for(task, timeout=5)


def _assert_gateway_contracts(gw: _ScriptedGateway) -> None:
    """两条随链演练的 HTTP 契约（③ 错 token 403 不消费已由主 pull 200 隐含证明）。"""
    assert gw.wrong_token_statuses and all(s == 403 for s in gw.wrong_token_statuses)
    assert gw.second_pull and all(
        (s, c) == (409, "E_SPEC_ALREADY_CLAIMED") for s, c in gw.second_pull
    )


async def _fire_cron_once(env, now_utc: datetime) -> int:
    """真跑 AgentTriggerWorker tick_loop 若干 tick（冻结时间）→ 返回入队的 job_id。

    多 tick + 幂等键/marker 去重 → 恒一行（断言在此做掉）。
    """
    ev = asyncio.Event()
    task = asyncio.create_task(tw.tick_loop(
        sync_store=env.sync_store, store=env.store, repo=env.repo,
        shutdown_event=ev, interval_sec=0.01, now_fn=lambda: now_utc,
    ))
    await asyncio.sleep(0.06)  # 跑多个 tick
    ev.set()
    await asyncio.wait_for(task, timeout=2)
    rows = _agent_job_rows(env.db)
    assert len(rows) == 1, "cron 多 tick 必须幂等成一行（marker + 幂等键双去重）"
    return int(rows[0]["job_id"])


# 09:00:30 Asia/Shanghai == 01:00:30 UTC —— 命中 0 9 * * * 的 30min fire window。
_CRON_NOW = datetime(2026, 7, 3, 1, 0, 30, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# cron 链：触发→入队→claim→poke→spec pull→三种 scripted 结局
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cron_chain_completed(env, client, monkeypatch):
    _seed_custom(env.store, trigger=_CRON)
    job_id = await _fire_cron_once(env, _CRON_NOW)

    gw = _ScriptedGateway(client, script=lambda spec: {
        "ok": True, "outcome": "completed", "sessionId": 12, "steps": 3,
        "summary": "已处理", "usage": {"inputTokens": 100, "outputTokens": 40},
    })
    _install_gateway(monkeypatch, gw)
    job = await _drive_worker_until_terminal(env, job_id)

    # 终态：succeeded + result_json 形状（wire 透传字段）
    assert job.status == "succeeded"
    assert job.last_error is None
    assert job.result["outcome"] == "completed"
    assert job.result["sessionId"] == 12 and job.result["steps"] == 3
    assert job.result["summary"] == "已处理"
    assert job.result["usage"] == {"inputTokens": 100, "outputTokens": 40}
    assert "approval_state" not in job.result

    # poke 带的 claimToken == job 行里 worker 写入的 claim_token（能力令牌闭环）
    row = _agent_job_rows(env.db)[0]
    assert gw.pokes == [{"jobId": job_id, "claimToken": row["claim_token"]}]

    # spec 形状：cron 派生面（无 envelope）+ firedAt = occurrence 时刻（09:00 CST = 01:00 UTC）
    spec = gw.specs[0]
    assert spec["trigger"]["kind"] == "cron"
    assert spec["trigger"]["firedAt"] == "2026-07-03T01:00:00+00:00"
    assert "emailEnvelope" not in spec["prompt"]
    assert spec["prompt"]["taskPrompt"] == "处理 DMS 审批"

    _assert_gateway_contracts(gw)
    # 读侧单源 helper 对真实行给出「成功完成」
    assert derive_agent_run_state(dict(row) | {"status": "succeeded",
                                               "result": job.result}) == "completed"


@pytest.mark.asyncio
async def test_cron_chain_paused_handoff(env, client, monkeypatch):
    _seed_custom(env.store, trigger=_CRON)
    job_id = await _fire_cron_once(env, _CRON_NOW)

    gw = _ScriptedGateway(client, script=lambda spec: {
        "ok": True, "outcome": "paused_handoff", "sessionId": 5, "steps": 2,
        "summary": "等待批准草稿",
    })
    _install_gateway(monkeypatch, gw)
    job = await _drive_worker_until_terminal(env, job_id)

    # 「等审批」= succeeded + approval_state=pending（≠ 成功完成, ADR D4 纪律）
    assert job.status == "succeeded"
    assert job.result["outcome"] == "paused_handoff"
    assert job.result["approval_state"] == "pending"
    _assert_gateway_contracts(gw)
    # 读侧 helper：新鲜 pending → paused_pending, 绝不 completed
    row = dict(_agent_job_rows(env.db)[0])
    assert derive_agent_run_state(row) == "paused_pending"


@pytest.mark.asyncio
async def test_cron_chain_error(env, client, monkeypatch):
    _seed_custom(env.store, trigger=_CRON)
    job_id = await _fire_cron_once(env, _CRON_NOW)

    gw = _ScriptedGateway(client, script=lambda spec: {
        "ok": False, "outcome": "error", "sessionId": None, "steps": 0,
        "error": "E_BUDGET_TIME",
    })
    _install_gateway(monkeypatch, gw)
    job = await _drive_worker_until_terminal(env, job_id)

    assert job.status == "failed"
    assert job.last_error == "E_BUDGET_TIME"
    _assert_gateway_contracts(gw)
    assert derive_agent_run_state(dict(_agent_job_rows(env.db)[0])) == "failed"


# ---------------------------------------------------------------------------
# email 链：watcher 第 5 hook → matcher → 入队（runs/day 门）→ 同下游
# ---------------------------------------------------------------------------


def _watcher(env) -> NewWatcher:
    w = NewWatcher.__new__(NewWatcher)
    w._custom_agents_enabled = True
    w._agent_store = env.store
    w._agent_job_repo = env.repo
    w._bg_tasks = set()
    return w


async def _dispatch_email(env, w, internal_id: int, *, subject: str,
                          sender: str = "dms@corp.test") -> None:
    email = SimpleNamespace(sender=sender, subject=subject, mailbox="收件箱")
    w._maybe_trigger_custom_agents(email, internal_id)
    tasks = list(w._bg_tasks)
    if tasks:
        await asyncio.gather(*tasks)
    w._bg_tasks = set()


@pytest.mark.asyncio
async def test_email_chain_full(env, client, monkeypatch):
    _seed_custom(env.store, trigger=_EMAIL,
                 budget={"v": 1, "max_runs_per_day": 1})
    body = "Please approve DMS request #42"
    _insert_email(env.db, 777, subject="DMS 项目审批", sender="dms@corp.test", body=body)
    # spec 端点的 envelope 从真实 EmailRepository 读同一 DB（真实链路, 非 stub 形状）。
    monkeypatch.setattr(agent_runs, "get_repository",
                        lambda: EmailRepository(str(env.db)))

    # ① 触发：watcher 第 5 hook → matcher 命中 → 入队
    w = _watcher(env)
    await _dispatch_email(env, w, 777, subject="DMS 项目审批")
    rows = _agent_job_rows(env.db)
    assert len(rows) == 1
    job_id = int(rows[0]["job_id"])

    # ② runs/day 门：budget=1，第二封被拦，但写一条可见的 skipped 审计记录。
    _insert_email(env.db, 778, subject="DMS 二次审批", sender="dms@corp.test", body="again")
    await _dispatch_email(env, w, 778, subject="DMS 二次审批")
    gated_rows = _agent_job_rows(env.db)
    assert len(gated_rows) == 2, "runs/day 门未留下 skipped 审计记录"
    skipped = dict(gated_rows[1])
    assert derive_agent_run_state(skipped) == "skipped"
    assert json.loads(skipped["result_json"]) == {
        "outcome": "skipped",
        "reason": "daily_run_limit",
        "runsToday": 1,
        "maxRunsPerDay": 1,
        "steps": 0,
    }

    # ③ 执行：claim → poke → spec pull（envelope 在场且围栏完整）→ completed
    gw = _ScriptedGateway(client, script=lambda spec: {
        "ok": True, "outcome": "completed", "sessionId": 9, "steps": 2,
    })
    _install_gateway(monkeypatch, gw)
    job = await _drive_worker_until_terminal(env, job_id)
    assert job.status == "succeeded"
    assert job.result["outcome"] == "completed"
    _assert_gateway_contracts(gw)

    spec = gw.specs[0]
    assert spec["trigger"]["kind"] == "email_filter"
    assert spec["trigger"]["emailInternalId"] == 777
    assert spec["trigger"]["matchedRule"] == {
        "subjectPattern": "DMS.*审批", "senderPattern": "dms@corp\\.test",
        "folders": ["收件箱"],
    }
    envelope = spec["prompt"]["emailEnvelope"]
    assert envelope.startswith("UNTRUSTED_EMAIL_BODY_START id=777\n")
    assert envelope.endswith("\nUNTRUSTED_EMAIL_BODY_END")
    assert "subject: DMS 项目审批" in envelope
    assert "DMS Bot <dms@corp.test>" in envelope
    assert body in envelope
    # taskPrompt（可信）与 envelope（untrusted）物理分隔
    assert spec["prompt"]["taskPrompt"] == "处理 DMS 审批"
    assert "UNTRUSTED_EMAIL_BODY" not in spec["prompt"]["taskPrompt"]


@pytest.mark.asyncio
async def test_email_chain_unmatched_never_reaches_queue(env, client):
    _seed_custom(env.store, trigger=_EMAIL)
    _insert_email(env.db, 780, subject="普通周报", sender="colleague@example.test",
                  body="hello")
    w = _watcher(env)
    await _dispatch_email(env, w, 780, subject="普通周报", sender="colleague@example.test")
    assert _agent_job_rows(env.db) == []


# ---------------------------------------------------------------------------
# 路径 B 冻结守护：run_tool_loop 调用方集合 == 冻结清单（新调用方即红）
# ---------------------------------------------------------------------------

_SRC_ROOT = Path(__file__).resolve().parents[2] / "src"

# 冻结清单（S4 现状, ADR-003 §12「路径 B 冻结兑现」）：
#   - 定义: src/llm_agent/client.py（LLMClient.run_tool_loop 本体）
#   - 调用方: src/reports/summarizer.py（report agent 唯一既有消费面, D1「冻结不扩权」）
#     + src/llm_agent/processor.py（邮件预处理分类, MCP connector PR3 —— 见下）
# custom agent 的执行只允许走 gateway 路径 C（prepareChatRun, 有审批/围栏/矩阵）。要给
# run_tool_loop 加新调用方 = 绕过审批门的架构决定, 必须先改 ADR 再改这份清单。
#
# 🔴 processor.py 这一项是**有决策来源的扩项**, 不是顺手加的（08-01 MCP connector task
# PRD 决策 8 + grill Q4=A: 邮件预处理分类是 connector 的第四个调用方; PRD「坑 3」逐条写了
# lethal trifecta 与收紧手段）。它**不**构成「第二套 custom agent 运行时」——冻结要防的正是
# 那个 —— 因为四条性质都被结构钉死, 缺一即该重新审这条:
#   1. 单一固定用途（分类一封邮件, final_tool 恒 classify_email）, 不接受任意 taskPrompt;
#   2. 工具集**只可能是 read 类** connector 工具（llm_tools 工厂 + PREPROCESS_CONNECTOR_CEILING
#      硬编码 'read'）, 没有写工具 ⇒ 没有该被审批却没审批的动作;
#   3. 授权面独立且默认关（connector.preprocess_enabled, owner 逐个 opt-in）,
#      灰度开关 MAILAGENT_MCP_CONNECTORS 默认 off ⇒ 默认态与本 task 前逐字节相同;
#   4. 服务端二道闸（connectors/service.invoke_connector_tool）与 gateway 面同一份, 且
#      返回内容套 UNTRUSTED_MCP_TOOL 围栏。
# 再要加调用方, 同样标准: 先有决策来源, 且逐条说明它为什么不是「绕开审批门的 agent 运行时」。
_FROZEN_DEFINITIONS = {"src/llm_agent/client.py"}
_FROZEN_CALLERS = {"src/reports/summarizer.py", "src/llm_agent/processor.py"}

_CALL_RE = re.compile(r"\.\s*run_tool_loop\s*\(")
_DEF_RE = re.compile(r"def\s+run_tool_loop\s*\(")


def test_path_b_frozen_run_tool_loop_has_no_new_callers():
    definitions, callers = set(), set()
    for path in sorted(_SRC_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "run_tool_loop" not in text:
            continue
        rel = str(path.relative_to(_SRC_ROOT.parent))
        if _DEF_RE.search(text):
            definitions.add(rel)
        if _CALL_RE.search(text):
            callers.add(rel)
    assert definitions == _FROZEN_DEFINITIONS, (
        f"run_tool_loop 定义面变了: {definitions} — 路径 B 是冻结面, 先改 ADR-003"
    )
    assert callers == _FROZEN_CALLERS, (
        f"run_tool_loop 出现新调用方: {callers - _FROZEN_CALLERS or callers} — "
        "custom agent 执行只许走 gateway 路径 C（prepareChatRun）, 见 ADR-003 D1/§12"
    )
    # src/agents/（触发/执行外壳）不得 import 路径 B 入口
    for path in (_SRC_ROOT / "agents").rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        assert "run_tool_loop" not in text, f"{path.name} 触碰了路径 B"
        assert "llm_agent" not in text, f"{path.name} import 了路径 B 宿主模块"
