"""Follow-up chips 供给义务的行为闸（0805 owner 反馈）— zero LLM.

owner 观察：「follow up 好像只有第一次会话有」。活库 2/2 复现，且两次的第二轮**都是用户点
chip 发起的**（user_prompt 与上一轮建议逐字相同）。结构性原因全部排除过——注册无条件、非
skill-gated、非审批门、prompt 每轮都注入、step 上限没撞、前端 `isLast` 判据反而对第二轮有利
——第二轮的数据里根本没有 tool part，是模型自己决定不调。病因指向措辞：两处提示都只说
"exactly once" 而**没把作用域限定到本轮**，于是「整段对话给过一次」与「用户采纳了建议、闭环
了」都是合理读法。

这一层此前**零闸**（只有 tool_catalog 的登记行和 followup_tool.test.ts 的注册/停机/清洗单
测），所以回归能一直存在。本 suite 把它钉住：

  1. baselines/followups.jsonl 两条 trace 校验干净且 hard_pass；
  2. 002 的 user_prompt 逐字等于 001 trace 里 suggest_followups 的某一条建议 —— 这层耦合正是
     「点 chip 发起的续轮」这个形态本身，断了它这条用例就退化成普通第二轮；
  3. 每轮恰好一次 suggest_followups，且是本轮最后一个 tool_use（对齐 hasToolCall 停机条件）、
     silent 无审批卡（R5 双向）；
  4. **负例（真正的闸）**：把 002 trace 里的 suggest_followups 摘掉 —— 即「第二轮不给 chips」
     的现场 —— 必须是 R1 硬失败；
  5. catalog 侧 manual_only 不变（headless 结构上拿不到这个工具，措辞改动不该让它外溢）。

措辞两处口径由 frontend/tests/ai-gateway/followup_tool.test.ts 盯（per-reply 作用域 + chip 续
轮 carve-out）；本文件盯行为。rules.py / models.py / loader.py 未改，只加数据 + 测试。
"""
import json
import os

from runner import loader, rules
from runner.models import TraceRecord

FOLLOWUP_TASK_IDS = ["AGT-FOLLOWUP-001", "AGT-FOLLOWUP-002"]
SUGGEST = "suggest_followups"


def _load_lane(eval_root):
    path = os.path.join(eval_root, "baselines", "followups.jsonl")
    with open(path, "r", encoding="utf-8") as fh:
        return {json.loads(ln)["task_id"]: json.loads(ln) for ln in fh if ln.strip()}


def _tasks(eval_root):
    return {t.id: t for t in loader.load_tasks(os.path.join(eval_root, "tasks"))}


def test_followups_baseline_validates_and_hard_passes(eval_root, catalog):
    """两条 trace 结构 + 任务一致性校验干净，并在未改动的 rules.py 下 hard_pass。"""
    path = os.path.join(eval_root, "baselines", "followups.jsonl")
    tasks = _tasks(eval_root)
    assert loader.validate_trace_file(path, {tid: t.raw for tid, t in tasks.items()}, catalog) == []
    lane = _load_lane(eval_root)
    assert sorted(lane) == sorted(FOLLOWUP_TASK_IDS)
    for tid, d in lane.items():
        res = rules.score_task(tasks[tid], TraceRecord.from_dict(d), catalog)
        assert res.hard_pass, (tid, [v.as_dict() for v in res.violations])


def test_second_turn_is_verbatim_a_first_turn_suggestion(eval_root):
    """002 = 点 chip 发起的续轮：它的 user_prompt 必须逐字出现在 001 的建议里。

    这不是形式主义 —— 活库里两次「第二轮没 chips」的第二轮都恰好是这个形态（chips 是
    autoSend，点了就直接发），断开这层耦合，002 就只是又一条普通第二轮，测不到病灶。
    """
    lane = _load_lane(eval_root)
    prompts = [
        e["input"]["prompts"]
        for e in lane["AGT-FOLLOWUP-001"]["events"]
        if e["type"] == "tool_use" and e["name"] == SUGGEST
    ]
    assert len(prompts) == 1
    tasks = _tasks(eval_root)
    assert tasks["AGT-FOLLOWUP-002"].raw["user_prompt"] in prompts[0]


def test_each_turn_calls_it_once_last_and_silently(eval_root, catalog):
    """每轮恰好一次、位于本轮最后一个 tool_use、且无审批卡（silent read，R5 双向）。"""
    assert catalog.tier(SUGGEST) == "silent"
    for tid, d in _load_lane(eval_root).items():
        uses = [e for e in d["events"] if e["type"] == "tool_use"]
        assert [e["name"] for e in uses].count(SUGGEST) == 1, tid
        # 对齐 chatRun 的 stopWhen: hasToolCall('suggest_followups') —— 调完即停，后面不再有工具
        assert uses[-1]["name"] == SUGGEST, tid
        assert [e for e in d["events"] if e["type"] == "pending_confirmation"] == [], tid


def test_second_turn_without_the_call_fails_r1(eval_root, catalog):
    """负例 = 回归现场本体：第二轮答完就结束、不给 chips ⇒ R1 硬失败。

    events 直接照搬 002 的 trace 再摘掉 suggest_followups 的 use/result —— 与活库里 msg 391 /
    395 的 part 序列（止于 text）同形。
    """
    lane = _load_lane(eval_root)
    d = json.loads(json.dumps(lane["AGT-FOLLOWUP-002"]))
    dropped = {e["tool_use_id"] for e in d["events"] if e.get("name") == SUGGEST}
    d["events"] = [e for e in d["events"] if e.get("tool_use_id") not in dropped]
    d["metrics"]["tool_calls"] = len([e for e in d["events"] if e["type"] == "tool_use"])

    res = rules.score_task(_tasks(eval_root)["AGT-FOLLOWUP-002"], TraceRecord.from_dict(d), catalog)
    assert not res.hard_pass
    assert any(v.rule == "R1" and SUGGEST in v.detail for v in res.violations), [
        v.as_dict() for v in res.violations
    ]


def test_suggest_followups_stays_manual_only(eval_root):
    """措辞改动不得让这个工具外溢到 headless：catalog 行仍是 manual_only 的 silent 读。

    headless run 的工具集是服务端钉死的，而 hasToolCall(suggest_followups) 是 manual 回合的停机
    条件 —— 漏进无人值守的 run 会让它提前收尾（policy.test.ts 的 MANUAL_ONLY_READ_TOOLS 盯 TS
    侧注册，这里盯 catalog 这份投影，HEADLESS_TOOL_OPTIONS 据它裁剪）。
    """
    with open(os.path.join(eval_root, "tool_catalog.json"), "r", encoding="utf-8") as fh:
        row = json.load(fh)["tools"][SUGGEST]
    assert row["manual_only"] is True
    assert row["tier"] == "silent" and row["write"] is False
