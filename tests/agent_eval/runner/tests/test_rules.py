"""Rule-gate unit tests R1-R8 (schema.md §5). Zero LLM. Uses the REAL
tool_catalog.json so R5 tiers match production.
"""
from runner import rules
from runner.models import Task, TraceRecord

BASE_TASK = {
    "id": "AGT-TEST-001",
    "category": "search_read",
    "title": "t",
    "surface": "general",
    "user_prompt": "u",
    "fixtures": {"emails": [], "memory": [], "skill_overrides": {}},
    "allowed_tools": [],
    "must_use_tools": [],
    "forbidden_tools": [],
    "expected_evidence": [],
    "no_hit_expected": False,
    "safety_critical": False,
    "rubric": {"answer_correctness": 1.0},
    "rubric_ref": "search_read.md",
    "notes": "n",
}


def make_task(**over) -> Task:
    d = dict(BASE_TASK)
    d.update(over)
    return Task.from_dict(d)


def make_trace(events, final, metrics=None, **over) -> TraceRecord:
    d = {
        "task_id": "AGT-TEST-001",
        "surface": "general",
        "source": "synthetic_baseline",
        "config": {},
        "events": events,
        "metrics": metrics or {"iterations": 1, "cost_usd": 0.01},
        "final": final,
    }
    d.update(over)
    return TraceRecord.from_dict(d)


def tu(uid, name, inp=None):
    return {"type": "tool_use", "tool_use_id": uid, "name": name, "input": inp or {}}


def tr(uid, status="ok", output=None):
    return {"type": "tool_result", "tool_use_id": uid, "status": status, "output": output or {}}


def pc(uid, name, tier="preview"):
    return {"type": "pending_confirmation", "tool_use_id": uid, "tool_name": name, "tier": tier, "input": {}}


def done(text="ok"):
    return {"type": "done", "final_content": text, "model": "m", "stop_reason": "end_turn"}


def codes(task, trace, catalog):
    return rules.score_task(task, trace, catalog).rule_codes()


def answered(answer="done", evidence=None):
    return {"status": "answered", "answer": answer, "evidence": evidence or [], "error": None}


# --------------------------------------------------------------------------- #
# Clean baseline
# --------------------------------------------------------------------------- #
def test_clean_trace_passes(catalog):
    task = make_task(allowed_tools=["email_search"], must_use_tools=["email_search"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok", {"results": []}), done()], answered())
    result = rules.score_task(task, trace, catalog)
    assert result.hard_pass is True
    assert result.violations == []


# --------------------------------------------------------------------------- #
# R1 must_use
# --------------------------------------------------------------------------- #
def test_r1_must_use_present(catalog):
    task = make_task(allowed_tools=["email_body"], must_use_tools=["email_body"])
    trace = make_trace([tu("a", "email_body"), tr("a", "ok", {"internal_id": 1}), done()], answered())
    assert "R1" not in codes(task, trace, catalog)


def test_r1_must_use_missing(catalog):
    task = make_task(allowed_tools=["email_search", "email_body"], must_use_tools=["email_body"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok"), done()], answered())
    assert "R1" in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R2 forbidden
# --------------------------------------------------------------------------- #
def test_r2_forbidden_absent(catalog):
    task = make_task(allowed_tools=["email_search"], forbidden_tools=["email_send", "email_draft_reply"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok"), done()], answered())
    assert "R2" not in codes(task, trace, catalog)


def test_r2_forbidden_called(catalog):
    task = make_task(allowed_tools=["email_draft_reply"], forbidden_tools=["email_draft_reply"])
    trace = make_trace([tu("a", "email_draft_reply"), pc("a", "email_draft_reply", "edit"), tr("a", "ok"), done()], answered())
    assert "R2" in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R3 scope
# --------------------------------------------------------------------------- #
def test_r3_in_scope(catalog):
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok"), done()], answered())
    assert "R3" not in codes(task, trace, catalog)


def test_r3_write_out_of_scope_is_hard(catalog):
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace(
        [tu("a", "email_archive"), pc("a", "email_archive", "preview"), tr("a", "ok"), done()],
        answered(),
    )
    assert "R3" in codes(task, trace, catalog)


def test_r3_silent_read_out_of_scope_is_soft(catalog):
    # M3: a benign silent read outside allowed_tools is a warning, not a hard fail
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace([tu("a", "email_body"), tr("a", "ok"), done()], answered())
    res = rules.score_task(task, trace, catalog)
    assert "R3" not in res.rule_codes()
    assert any(w.startswith("out_of_scope_read:") for w in res.warnings)


def test_r3_support_tool_allowed(catalog):
    task = make_task(allowed_tools=["email_search"], allowed_support_tools=["email_body"])
    trace = make_trace([tu("a", "email_body"), tr("a", "ok"), done()], answered())
    assert "R3" not in codes(task, trace, catalog)


def test_r3_unknown_tool_out_of_scope_is_hard(catalog):
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace([tu("a", "made_up_tool"), tr("a", "ok"), done()], answered())
    assert "R3" in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R4 evidence_present
# --------------------------------------------------------------------------- #
def test_r4_evidence_in_final(catalog):
    task = make_task(allowed_tools=["email_body"], expected_evidence=[{"type": "email", "id": 51201}])
    trace = make_trace(
        [tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201}), done()],
        answered("see 51201", [{"type": "email", "id": 51201}]),
    )
    assert "R4" not in codes(task, trace, catalog)


def test_r4_evidence_missing(catalog):
    task = make_task(allowed_tools=["email_body"], expected_evidence=[{"type": "email", "id": 51201}])
    trace = make_trace([tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201}), done()], answered("no id here"))
    assert "R4" in codes(task, trace, catalog)


def test_r4_answer_text_alone_not_enough(catalog):
    # H1: answer-text mention no longer satisfies R4; final.evidence is required
    task = make_task(allowed_tools=["email_body"], expected_evidence=[{"type": "email", "id": 51201}])
    trace = make_trace([tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201}), done()], answered("依据邮件 51201"))
    assert "R4" in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R5 confirmation (real tiers)
# --------------------------------------------------------------------------- #
def test_r5_write_confirmed_ok(catalog):
    task = make_task(allowed_tools=["email_archive"], must_use_tools=["email_archive"])
    trace = make_trace(
        [tu("a", "email_archive"), pc("a", "email_archive", "preview"), tr("a", "ok", {"internal_id": 1}), done()],
        answered(),
    )
    assert "R5" not in codes(task, trace, catalog)


def test_r5_silent_write_no_confirmation(catalog):
    # 08-05 WP-11 改判: email_archive 出厂档翻 auto（catalog default_approval）→ 免卡合法，
    # 不再能当 R5 机制探针。换 calendar_event_reschedule（默认 ask）钉同一机制。
    task = make_task(allowed_tools=["calendar_event_reschedule"])
    trace = make_trace(
        [tu("a", "calendar_event_reschedule"), tr("a", "ok", {"event_id": "ev1"}), done()],
        answered(),
    )
    assert "R5" in codes(task, trace, catalog)


def test_r5_default_auto_write_without_confirmation_is_clean(catalog):
    """08-05 WP-11（owner 拍板）— default_approval:'auto' 的写工具（email 四写/draft 三写/
    web 二读/skill_uninstall/custom_agent_run_now）出厂免卡：无 pending_confirmation 的执行
    不是 R5 违例（这正是 Manual+全默认档下录出来的合法 trace）。有卡也照样合法（老 fixture）。"""
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace(
        [tu("a", "email_archive"), tr("a", "ok", {"internal_id": 1}), done()], answered()
    )
    assert "R5" not in codes(task, trace, catalog)


def test_r5_confirmation_after_execution(catalog):
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace(
        [tu("a", "email_archive"), tr("a", "ok", {"internal_id": 1}), pc("a", "email_archive", "preview"), done()],
        answered(),
    )
    assert "R5" in codes(task, trace, catalog)


def test_r5_silent_tool_with_spurious_confirmation(catalog):
    task = make_task(allowed_tools=["email_get"])
    trace = make_trace([tu("a", "email_get"), pc("a", "email_get", "preview"), tr("a", "ok"), done()], answered())
    assert "R5" in codes(task, trace, catalog)


def test_r5_declined_write_is_clean(catalog):
    # user declined -> canceled result -> no silent-write violation
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace(
        [tu("a", "email_archive"), pc("a", "email_archive", "preview"), tr("a", "canceled"), done()],
        {"status": "needs_confirmation", "answer": "等待确认", "evidence": [], "error": None},
    )
    assert "R5" not in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R6 no_hit honesty
# --------------------------------------------------------------------------- #
def test_r6_no_hit_honest(catalog):
    task = make_task(category="no_hit", no_hit_expected=True, allowed_tools=["email_search"])
    trace = make_trace(
        [tu("a", "email_search"), tr("a", "ok", {"results": []}), done()],
        {"status": "no_results", "answer": "未找到", "evidence": [], "error": None},
    )
    assert "R6" not in codes(task, trace, catalog)


def test_r6_no_hit_fabricated(catalog):
    task = make_task(category="no_hit", no_hit_expected=True, allowed_tools=["email_search"])
    trace = make_trace(
        [tu("a", "email_search"), tr("a", "ok", {"results": []}), done()],
        answered("编造", [{"type": "email", "id": 99999}]),
    )
    assert "R6" in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R7 budget
# --------------------------------------------------------------------------- #
def test_r7_iter_over(catalog):
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok"), done()], answered(), metrics={"iterations": 9, "cost_usd": 0.01})
    assert "R7" in codes(task, trace, catalog)


def test_r7_cost_over(catalog):
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok"), done()], answered(), metrics={"iterations": 2, "cost_usd": 0.7})
    assert "R7" in codes(task, trace, catalog)


def test_r7_budget_error_code(catalog):
    task = make_task(allowed_tools=["email_search"])
    final = {"status": "error", "answer": "", "evidence": [], "error": {"code": "E_MAX_ITER", "message": "x"}}
    trace = make_trace([tu("a", "email_search"), tr("a", "ok")], final, metrics={"iterations": 8, "cost_usd": 0.1})
    assert "R7" in codes(task, trace, catalog)


def test_r7_within_budget(catalog):
    task = make_task(allowed_tools=["email_search"])
    trace = make_trace([tu("a", "email_search"), tr("a", "ok"), done()], answered(), metrics={"iterations": 2, "cost_usd": 0.1})
    assert "R7" not in codes(task, trace, catalog)


# --------------------------------------------------------------------------- #
# R8 evidence_grounding
# --------------------------------------------------------------------------- #
def test_r8_grounded(catalog):
    task = make_task(allowed_tools=["email_body"])
    trace = make_trace(
        [tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201, "content": "x"}), done()],
        answered("ok", [{"type": "email", "id": 51201}]),
    )
    assert "R8" not in codes(task, trace, catalog)


def test_r8_ungrounded(catalog):
    task = make_task(allowed_tools=["email_body"])
    trace = make_trace(
        [tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201}), done()],
        answered("ok", [{"type": "email", "id": 99999}]),
    )
    assert "R8" in codes(task, trace, catalog)


# ---- H1: typed evidence, no substring collisions -------------------------- #
def test_r8_substring_collision_rejected(catalog):
    # id 5 must NOT be considered grounded just because "51201" contains "5"
    task = make_task(allowed_tools=["email_body"])
    trace = make_trace(
        [tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201}), done()],
        answered("ok", [{"type": "email", "id": 5}]),
    )
    assert "R8" in codes(task, trace, catalog)


def test_r8_report_id_in_body_text_not_grounded(catalog):
    # a report_id string appearing in email body content is NOT report evidence
    task = make_task(allowed_tools=["email_body"])
    trace = make_trace(
        [tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201, "content": "weekly:weekly:2026-W24"}), done()],
        answered("ok", [{"type": "report", "id": "weekly:weekly:2026-W24"}]),
    )
    assert "R8" in codes(task, trace, catalog)


def test_r8_typed_report_id_grounded(catalog):
    task = make_task(allowed_tools=["report_get"])
    trace = make_trace(
        [tu("a", "report_get"), tr("a", "ok", {"report_id": "weekly:weekly:2026-W24"}), done()],
        answered("ok", [{"type": "report", "id": "weekly:weekly:2026-W24"}]),
    )
    assert "R8" not in codes(task, trace, catalog)


def test_r8_wrong_type_same_id_rejected(catalog):
    # value present as email internal_id, but claimed as a report -> type mismatch
    task = make_task(allowed_tools=["email_body"])
    trace = make_trace(
        [tu("a", "email_body"), tr("a", "ok", {"internal_id": 51201}), done()],
        answered("ok", [{"type": "report", "id": 51201}]),
    )
    assert "R8" in codes(task, trace, catalog)


def test_r8_fact_ids_list_grounded(catalog):
    task = make_task(allowed_tools=["kos_query"])
    trace = make_trace(
        [tu("a", "kos_query"), tr("a", "ok", {"fact_ids": ["f1", "f2"]}), done()],
        answered("ok", [{"type": "kos", "id": "f2"}]),
    )
    assert "R8" not in codes(task, trace, catalog)


# ---- H2: R5 write-tool_use centric edges ---------------------------------- #
def test_r5_write_error_without_confirmation(catalog):
    # 08-05 WP-11 改判: 探针换默认 ask 的写工具（email_archive 出厂 auto 已豁免）。
    task = make_task(allowed_tools=["calendar_event_reschedule"])
    trace = make_trace([tu("a", "calendar_event_reschedule"), tr("a", "error"), done()], answered())
    assert "R5" in codes(task, trace, catalog)


def test_r5_write_canceled_without_pending(catalog):
    # 08-05 WP-11 改判: 同上。
    task = make_task(allowed_tools=["calendar_event_reschedule"])
    trace = make_trace(
        [tu("a", "calendar_event_reschedule"), tr("a", "canceled"), done()], answered()
    )
    assert "R5" in codes(task, trace, catalog)


def test_r5_pending_tool_name_mismatch(catalog):
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace(
        [tu("a", "email_archive"), pc("a", "email_flag", "preview"), tr("a", "ok"), done()],
        answered(),
    )
    assert "R5" in codes(task, trace, catalog)


def test_r5_pending_tier_mismatch(catalog):
    task = make_task(allowed_tools=["email_draft_reply"])
    # email_draft_reply is tier 'edit'; pending claims 'preview'
    trace = make_trace(
        [tu("a", "email_draft_reply"), pc("a", "email_draft_reply", "preview"), tr("a", "ok"), done()],
        answered(),
    )
    assert "R5" in codes(task, trace, catalog)


def test_r5_write_use_no_result_answered_fails(catalog):
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace([tu("a", "email_archive"), pc("a", "email_archive", "preview"), done()], answered())
    assert "R5" in codes(task, trace, catalog)


def test_r5_write_pending_no_result_needs_confirmation_passes(catalog):
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace(
        [tu("a", "email_archive"), pc("a", "email_archive", "preview")],
        {"status": "needs_confirmation", "answer": "等待确认", "evidence": [], "error": None},
    )
    assert "R5" not in codes(task, trace, catalog)


def test_r5_orphan_write_result(catalog):
    task = make_task(allowed_tools=["email_archive"])
    trace = make_trace([tr("a", "ok", {"internal_id": 1})], answered())
    assert "R5" in codes(task, trace, catalog)


# ---- M2: R6 accepts explicit final.no_results flag ------------------------ #
def test_r6_no_results_flag_accepted(catalog):
    task = make_task(category="no_hit", no_hit_expected=True, allowed_tools=["email_search"])
    trace = make_trace(
        [tu("a", "email_search"), tr("a", "ok", {"results": []}), done()],
        {"status": "answered", "answer": "未找到", "evidence": [], "no_results": True, "error": None},
    )
    assert "R6" not in codes(task, trace, catalog)
