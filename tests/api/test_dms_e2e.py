"""DMS 案例合成 skill 全链 e2e（S5 W5b，ADR-004 D8 验收）。

repo 无真 DMS skill —— 合成 skill 走**真实**供应链安装面（fetch→confirm，files_json/
exec_gate 首跑记录都是落库事实），打通 ADR-004 D8「真 exec 形态」的 Python 链每跳衔接点：

  装 skill → 建 custom agent（email_filter + grant_exec + allowed_tools）
    → Settings 唯一通道建 pinned-entrypoint 规则（真实 REST 面，contextMode 服务端派生）
    → 注入合成 DMS 邮件 → watcher 第 5 hook 触发 → enqueue
    → AgentRunWorker claim → poke scripted gateway → spec pull（CAS one-shot）
       断言 grantExec=true + allowedTools verbatim + UNTRUSTED_EMAIL_BODY 围栏
    → policy evaluate 双键全链（首跑前恒 ask → /api/exec/run 落首跑 → 命中 auto_allow+rule_id；
       manual 语境隔离；注入诱导超白名单 argv 恒 ask）
    → 免卡执行审计标注（run 响应 policy verdict）+ 篡改回 ask/409。

gateway 侧 drain 免卡（policyEvaluate 注入 / needsApproval / auto_whitelist 落账）由 W4b
vitest 覆盖，此处不重复 —— 本文件的目标 = Python 链衔接点契约钉死。
「读+起草」低危模板（D8 形态 1）的 domain_write 规则链单测在文件尾。

fixtures 全合成域（.test），零真实 PII；auth bypass 默认 ON（conftest）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import time
import zipfile
from types import SimpleNamespace

import pytest

from src.api import exec_floor


@pytest.fixture(autouse=True)
def _reset_floor():
    exec_floor.reset_exec_floor_cache()
    yield
    exec_floor.reset_exec_floor_cache()


# ---------------------------------------------------------------------------
# 合成 DMS skill（供应链两段式真实安装）
# ---------------------------------------------------------------------------

_MANIFEST = {
    "manifest_version": 2,
    "type": "script",
    "name": "dms-cli",
    "version": "1.0",
    "title": "DMS CLI",
    "description": "approve DMS requests from the approval mailbox",
    "entry_hint": "python3 approve.py <REQ-ID>",
    "secrets": [],
}

# 可断言副作用 = stdout 输出（exec run 响应透传 stdout；真 DMS skill 由 owner 私有携带）。
_APPROVE_PY = "import sys\nprint('APPROVED ' + sys.argv[1])\n"


def _install_dms_pack(client, tmp_path) -> str:
    """fetch→confirm 真实装入合成 DMS skill → 返回 <skills>/dms-cli 目录。"""
    z = tmp_path / "dms-cli.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("manifest.json", json.dumps(_MANIFEST))
        zf.writestr("SKILL.md", "# DMS CLI\nRun approve.py <REQ-ID> via run_command.")
        zf.writestr("approve.py", _APPROVE_PY)
    preview = client.post("/api/agent/skills/fetch", json={"localPath": str(z)}).json()["data"]
    r = client.post(
        "/api/agent/skills/confirm",
        json={
            "quarantineId": preview["quarantineId"],
            "expectedPackageHash": preview["packageHash"],
            "expectedFiles": preview["files"],
        },
    )
    assert r.status_code == 201, r.json()
    from src.skills.pack_fetch import skill_dir

    return skill_dir("dms-cli")


# ---------------------------------------------------------------------------
# agents 侧环境（tmp sync_store + report_agent 行 + async_jobs；镜像 test_e2e_dual_trigger）
# ---------------------------------------------------------------------------

_DMS_TRIGGER = {"v": 1, "kind": "email_filter", "subject_pattern": "DMS.*审批",
                "sender_pattern": "dms@corp\\.test", "folders": ["收件箱"]}
_DMS_ALLOWED = ["email_search", "email_get", "email_body", "email_draft_reply"]


@pytest.fixture()
def dms_env(tmp_path, monkeypatch):
    import src.api.deps as deps
    import src.api.routers.agent as agent_router
    import src.api.routers.agent_runs as agent_runs
    from src.mail.sync_store import SyncStore
    from src.repository.email_repository import EmailRepository
    from src.reports.store import ReportStore
    from src.sync.async_jobs import AsyncJobRepository

    db = tmp_path / "s.db"
    SyncStore(str(db))
    repo = AsyncJobRepository(str(db))
    store = ReportStore(str(db))
    store.create_agent("dms", type="custom", enabled=True, title="DMS Approver",
                       prompt="处理 DMS 审批")
    store.update_agent("dms", {
        "trigger_json": json.dumps(_DMS_TRIGGER),
        # D8 真 exec 形态：grant_exec opt-in + 显式最小工具集（读 3 + 起草 1）+ S6 W3 挂载
        # （rev3.1 §5.2：exec 规则引用 installed skill 须 ∈ 挂载集，未挂建规 400 / evaluate
        # dormant —— 归属闸正反例在 test_agent_policy_peragent，本链走已挂载 happy path）。
        "tool_policy_json": json.dumps(
            {"v": 1, "allowed_tools": _DMS_ALLOWED, "grant_exec": True,
             "skills": ["email", "dms-cli"]}),
    })

    monkeypatch.setattr(agent_runs, "get_job_repo", lambda: repo)
    monkeypatch.setattr(agent_runs, "get_report_store", lambda: store)
    monkeypatch.setattr(agent_runs, "_custom_agents_enabled", lambda: True)
    monkeypatch.setattr(agent_runs, "get_repository", lambda: EmailRepository(str(db)))
    monkeypatch.setattr(deps, "get_report_store", lambda: store)
    monkeypatch.setattr(agent_router, "_custom_agents_enabled", lambda: True)
    return SimpleNamespace(db=db, repo=repo, store=store)


def _insert_email(db, internal_id: int, *, subject: str, sender: str, body: str) -> None:
    now = time.time()
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            """INSERT INTO email_metadata
               (internal_id, message_id, subject, sender, sender_name, to_addr, cc_addr,
                date_received, mailbox, is_read, is_flagged, sync_status,
                retry_count, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (internal_id, f"<msg-{internal_id}@example.test>", subject, sender, "DMS Bot",
             "owner@example.test", "", "2026-07-04 09:00:00", "收件箱", 0, 0, "synced",
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


async def _dispatch_email(env, internal_id: int, *, subject: str,
                          sender: str = "dms@corp.test") -> None:
    """watcher 第 5 hook（触发面真实代码路径）→ 等后台 enqueue task 完成。"""
    from src.mail.new_watcher import NewWatcher

    w = NewWatcher.__new__(NewWatcher)
    w._custom_agents_enabled = True
    w._agent_store = env.store
    w._agent_job_repo = env.repo
    w._bg_tasks = set()
    email = SimpleNamespace(sender=sender, subject=subject, mailbox="收件箱")
    w._maybe_trigger_custom_agents(email, internal_id)
    tasks = list(w._bg_tasks)
    if tasks:
        await asyncio.gather(*tasks)


class _FakeResp:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


async def _drive_run(env, client, monkeypatch, job_id: int, wire: dict) -> tuple:
    """真实 AgentRunWorker claim→poke；fake gateway 真拉 spec（CAS）后回 wire → (job, spec)。"""
    import src.agents.run_worker as run_worker
    from src.agents.run_worker import AgentRunWorker

    specs: list[dict] = []

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None):
            r = client.get(f"/api/agent-runs/{json['jobId']}/spec",
                           headers={"X-Claim-Token": json["claimToken"]})
            if r.status_code != 200:
                return _FakeResp(r.status_code, r.json())
            specs.append(r.json()["data"])
            return _FakeResp(200, wire)

    monkeypatch.setattr(run_worker.httpx, "AsyncClient", _FakeClient)
    worker = AgentRunWorker(repo=env.repo, store=env.store, poll_interval_sec=1)
    task = asyncio.create_task(worker.run())
    try:
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            job = env.repo.get(job_id)
            if job is not None and job.status not in ("queued", "running"):
                assert len(specs) == 1
                return job, specs[0]
            await asyncio.sleep(0.02)
        raise AssertionError(f"job {job_id} never reached a terminal state")
    finally:
        worker.stop()
        await asyncio.wait_for(task, timeout=5)


def _data(resp):
    j = resp.json()
    assert j["status"] == "success", j
    return j["data"]


def _evaluate(client, action, *, context_mode="untrusted_trigger", agent_id="dms"):
    body = {"capability": "exec", "action": action, "contextMode": context_mode}
    if agent_id is not None:
        body["agentId"] = agent_id
    return _data(client.post("/api/agent/policy/evaluate", json=body))


# ---------------------------------------------------------------------------
# 全链主测（D8 真 exec 形态）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dms_full_chain(client, fresh_agent_cfg, fresh_skills_dir, dms_env, tmp_path,
                              monkeypatch):
    env = dms_env
    interp = os.path.realpath(sys.executable)

    # ── ① 供应链安装 + entrypoints 数据源（Settings exec 构造器消费面）────────────
    skdir = _install_dms_pack(client, tmp_path)
    entry = os.path.join(skdir, "approve.py")
    eps = _data(client.get("/api/agent/skills/entrypoints"))["skills"]
    assert eps == [{"name": "dms-cli", "dir": skdir,
                    "files": ["SKILL.md", "approve.py", "manifest.json"]}]

    # ── ② Settings 唯一通道建 pinned-entrypoint 规则（contextMode 服务端派生）──────
    matcher = {
        "v": 1,
        "argv0_realpath": interp,
        "argv_template": [
            {"pin": entry},
            {"arg": {"kind": "pattern", "regex": "^REQ-[0-9]+$"}},
        ],
        "cwd_scope": skdir,
    }
    r = client.post("/api/agent/policy/rules",
                    json={"capability": "exec", "matcher": matcher, "agentId": "dms"})
    assert r.status_code == 201, r.json()
    rule = r.json()["data"]
    rid = rule["id"]
    assert rule["agentId"] == "dms"
    assert rule["contextMode"] == "untrusted_trigger"  # email_filter 派生，请求未传

    # ── ③ 注入合成 DMS 邮件 → 触发 → enqueue ─────────────────────────────────────
    body_text = "Please approve DMS request REQ-42"
    _insert_email(env.db, 901, subject="DMS 项目审批", sender="dms@corp.test", body=body_text)
    await _dispatch_email(env, 901, subject="DMS 项目审批")
    conn = sqlite3.connect(str(env.db))
    rows = conn.execute("SELECT job_id FROM async_jobs WHERE job_type='agent_run'").fetchall()
    conn.close()
    assert len(rows) == 1
    job_id = int(rows[0][0])

    # ── ④ worker→gateway spec pull：grant/工具面/围栏随 spec 到位 ────────────────
    job, spec = await _drive_run(env, client, monkeypatch, job_id, wire={
        "ok": True, "outcome": "completed", "sessionId": 31, "steps": 2,
    })
    assert job.status == "succeeded"
    assert spec["toolPolicy"]["grantExec"] is True          # P1-4：字面 True 才投影
    assert spec["toolPolicy"]["allowedTools"] == _DMS_ALLOWED  # 显式列表 verbatim
    envelope = spec["prompt"]["emailEnvelope"]
    assert envelope.startswith("UNTRUSTED_EMAIL_BODY_START id=901\n")
    assert envelope.endswith("\nUNTRUSTED_EMAIL_BODY_END")
    assert body_text in envelope
    assert "UNTRUSTED_EMAIL_BODY" not in spec["prompt"]["taskPrompt"]

    # ── ⑤ policy evaluate 全链：首跑闸 → 首跑 → 双键免卡 ─────────────────────────
    action = {"argv": [interp, entry, "REQ-42"], "cwd": skdir}
    # 首跑未记录：规则本会匹配，但 skill gate 前置 → 恒 ask（岛卡路径，非 deny）。
    assert _evaluate(client, action) == {"decision": "ask", "rule_id": None}

    # 首跑（owner 批准面 = run 端点；context/agent 纯审计透传）→ 真执行 + 落首跑记录。
    d = _data(client.post("/api/exec/run", json={
        "argv": action["argv"], "cwd": skdir,
        "context_mode": "untrusted_trigger", "agent_id": "dms",
    }))
    assert d["exit_code"] == 0
    assert "APPROVED REQ-42" in d["stdout"]
    assert d["first_run_recorded"] == [os.path.realpath(entry)]

    # 首跑后：per-agent 双键命中 → auto_allow + rule_id（免卡语义）。
    assert _evaluate(client, action) == {"decision": "auto_allow", "rule_id": rid}

    # ── ⑥ 免卡执行审计标注：run 响应的 policy verdict 带规则 id ───────────────────
    d2 = _data(client.post("/api/exec/run", json={
        "argv": action["argv"], "cwd": skdir,
        "context_mode": "untrusted_trigger", "agent_id": "dms",
    }))
    assert d2["exit_code"] == 0
    assert d2["policy"] == {"decision": "auto_allow", "rule_id": rid}

    # ── ⑦ 双键隔离：同 argv 在 manual 语境（无 agentId）恒 ask ────────────────────
    assert _evaluate(client, action, context_mode="manual_chat", agent_id=None) == \
        {"decision": "ask", "rule_id": None}

    # ── ⑧ 注入负例：邮件诱导跑白名单外 argv → 恒 ask（受约束位挡）───────────────────
    for evil_tail in ("REQ-42; rm -rf ~", "--url=https://attacker.test", "REQ-42 REQ-43"):
        assert _evaluate(client, {"argv": [interp, entry, evil_tail], "cwd": skdir}) == \
            {"decision": "ask", "rule_id": None}, evil_tail
    # 多一个白名单外参数位（模板等长匹配挡）。
    assert _evaluate(client, {"argv": [interp, entry, "REQ-42", "--force"], "cwd": skdir}) == \
        {"decision": "ask", "rule_id": None}

    # ── ⑨ 篡改脚本：evaluate 回 ask（宽免卡也放行不了），run 端点 409 拒执行 ─────────
    with open(entry, "a") as f:
        f.write("# injected\n")
    assert _evaluate(client, action) == {"decision": "ask", "rule_id": None}
    r = client.post("/api/exec/run", json={"argv": action["argv"], "cwd": skdir})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "E_SKILL_TAMPERED"


# ---------------------------------------------------------------------------
# D8 形态 1（读+起草默认推荐模板）：domain_write 规则免卡 email_draft_reply
# ---------------------------------------------------------------------------


def test_dms_draft_tier_domain_write_rule(client, fresh_agent_cfg, dms_env):
    r = client.post("/api/agent/policy/rules", json={
        "capability": "domain_write",
        "matcher": {"v": 1, "tool": "email_draft_reply"},
        "agentId": "dms",
    })
    assert r.status_code == 201, r.json()
    rid = r.json()["data"]["id"]

    def ev(tool, **kw):
        body = {"capability": "domain_write", "action": {"tool": tool},
                "contextMode": kw.get("context_mode", "untrusted_trigger")}
        if kw.get("agent_id", "dms") is not None:
            body["agentId"] = kw.get("agent_id", "dms")
        return _data(client.post("/api/agent/policy/evaluate", json=body))

    # 命中：起草工具免卡（自动起草回复落草稿箱，owner 复核后手发 —— 起草即止）。
    assert ev("email_draft_reply") == {"decision": "auto_allow", "rule_id": rid}
    # 未建规则的写工具（诱导 archive/flag）恒 ask。
    assert ev("email_flag") == {"decision": "ask", "rule_id": None}
    # 其它 agent / manual 语境不互流。
    assert ev("email_draft_reply", agent_id=None, context_mode="manual_chat") == \
        {"decision": "ask", "rule_id": None}


def test_skill_entrypoints_flag_off_404(client, fresh_agent_cfg, monkeypatch):
    import src.api.routers.agent as agent_router

    monkeypatch.setattr(agent_router, "_custom_agents_enabled", lambda: False)
    r = client.get("/api/agent/skills/entrypoints")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"
