#!/usr/bin/env python3
"""狼人杀实验的 manual lane 跑分脚本（g3 AC8；**不进 CI**，一局有真实费用）。

三条腿，各自打不同的面 —— 没有一条能替另外两条：

  ① 建局打 serve-api（``POST /api/agent/labs/werewolf/new-game``）。同机放行靠
     ``X-MailAgent-Local-Token``，其值由 Electron 主进程每次启动随机生成、只在内存里，
     pm2 起的 serve-api 没有它。所以 token 从 env ``MAILAGENT_LOCAL_API_TOKEN`` 读，
     缺席直接 exit 2 并打印两条可操作路径 —— **不**静默改打别的面。
  ② 投递打 gateway（``POST /api/ai/group-chat``，loopback 无鉴权）。serve-api 的
     ``/chat/sessions/{id}/messages`` 只写库不进调度器，从那边投一句话不会开局。
  ③ 轮询 / 汇总直读 ``ai_chat.db``（WAL 并发安全）。group-metrics 是单群 + 滚动窗口口径，
     做不了「一局合计」，费用汇总也要区分 NULL 与 0.0。

用法::

    venv/bin/python scripts/werewolf_lab_run.py --dry-run       # 先确认三条腿都通
    venv/bin/python scripts/werewolf_lab_run.py --seed 1

退出码：0 = 到达终局（法官以 ``GAME_OVER_PREFIX`` 开头的那条消息）且全部判据通过；
1 = 判据失败；2 = 环境不可用；3 = 超时。
（1 与 3 分开，便于「跑 3 局 ≥ 2 局」这类统计。）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence, Tuple

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from src.chat.group_limits import (  # noqa: E402
    GAME_OVER_PREFIX,
    WEREWOLF_HOURLY_TOKENS,
    WEREWOLF_HOURLY_USD,
    WEREWOLF_SESSION_TURN_CAP,
    WEREWOLF_SILENT_RATE_MAX_PCT,
)

EXIT_OK = 0
EXIT_JUDGE_FAILED = 1
EXIT_ENV_UNAVAILABLE = 2
EXIT_TIMEOUT = 3

#: serve-api 的同机放行 header（src/api/auth.py LOCAL_TOKEN_HEADER，改一处必须改这里）。
LOCAL_TOKEN_HEADER = "X-MailAgent-Local-Token"
LOCAL_TOKEN_ENV = "MAILAGENT_LOCAL_API_TOKEN"

#: 法官宣布夜/昼的两个阶段词（脚本只用它们切区间，**不**据此判游戏正确性）。
NIGHT_MARK = "天黑"
DAY_MARK = "天亮"


# ── HTTP（只用 stdlib：脚本不引第三方依赖）────────────────────────────────


def _http(
    method: str, url: str, body: Optional[dict] = None, headers: Optional[dict] = None
) -> Tuple[int, Any]:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"raw": raw}
    except OSError as exc:  # 连不上 / DNS / 超时
        return 0, {"error": str(exc)}


def _unwrap(payload: Any) -> Any:
    """serve-api 的 envelope（``{status, data, error}``）→ data；非 envelope 原样返回。"""
    if isinstance(payload, dict) and "status" in payload and "data" in payload:
        return payload.get("data")
    return payload


# ── 判据（纯函数：三个构造 summary 就能单测，不用真跑一局）──────────────


def judge(summary: Dict[str, Any]) -> Tuple[int, List[str]]:
    """汇总 → (退出码, 失败原因)。数值全部来自 group_limits，本函数零裸数字。"""
    reasons: List[str] = []
    if summary.get("group_stop"):
        reasons.append(f"出现 group_stop 行（reason={summary.get('stop_reason')}）")
    turns = int(summary.get("turns") or 0)
    if turns > WEREWOLF_SESSION_TURN_CAP:
        reasons.append(f"turn {turns} > {WEREWOLF_SESSION_TURN_CAP}")
    cost = summary.get("cost_usd")
    if cost is None:
        # 定价缺失时金额判据不生效，退到 tokens 判据（必须显式说出来，不然读汇总的人
        # 会把「没报超支」当成「花得起」）。
        tokens = int(summary.get("tokens") or 0)
        if tokens > WEREWOLF_HOURLY_TOKENS:
            reasons.append(f"tokens {tokens} > {WEREWOLF_HOURLY_TOKENS}（定价缺失，退 tokens 判据）")
    elif cost > WEREWOLF_HOURLY_USD:
        reasons.append(f"cost ${cost:.2f} > ${WEREWOLF_HOURLY_USD}")
    silent = summary.get("silent_rate")
    if silent is not None and silent * 100 > WEREWOLF_SILENT_RATE_MAX_PCT:
        reasons.append(f"silent 率 {silent * 100:.1f}% > {WEREWOLF_SILENT_RATE_MAX_PCT}%")
    if summary.get("night_violation"):
        reasons.append("夜晚区间主群出现玩家发言")
    if not summary.get("game_over"):
        if summary.get("timed_out"):
            reasons.append("超时仍未到达" + GAME_OVER_PREFIX)
            return EXIT_TIMEOUT, reasons
        reasons.append("未到达" + GAME_OVER_PREFIX)
    return (EXIT_JUDGE_FAILED if reasons else EXIT_OK), reasons


def night_violation(rows: Sequence[Dict[str, Any]], judge_agent_id: str) -> bool:
    """主群里「天黑」到「天亮」之间有没有玩家发言（结构判据，不看内容对不对）。"""
    in_night = False
    for row in rows:
        if row.get("role") != "assistant":
            continue
        speaker = row.get("speaker_agent_id")
        content = row.get("content") or ""
        if speaker == judge_agent_id:
            if NIGHT_MARK in content:
                in_night = True
            if DAY_MARK in content:
                in_night = False
            continue
        if in_night:
            return True
    return False


# ── 回放（列口径与 ai-gateway/groupReplay.ts 同表，见 13.29.9）───────────

_OUTCOME_NOTE = {
    "silent": "(沉默)",
    "held_dup": "(重复折叠)",
    "failed": "(失败)",
}


def _turn_note(turn: Dict[str, Any]) -> str:
    outcome = turn.get("outcome")
    if outcome == "skipped":
        return f"(跳过:{turn.get('error') or 'unknown'})"
    if outcome == "stopped":
        return f"(停止:{turn.get('error') or 'unknown'})"
    return _OUTCOME_NOTE.get(str(outcome), f"({outcome})")


def _system_note(metadata: Optional[str]) -> Optional[str]:
    if not metadata:
        return None
    try:
        parsed = json.loads(metadata)
    except json.JSONDecodeError:
        return None
    kind = parsed.get("kind")
    if kind == "game_over":
        return "(游戏结束)"
    if kind == "group_stop":
        return f"(停止:{parsed.get('reason') or 'unknown'})"
    return None


def render_replay(
    groups: Sequence[Tuple[int, str]],
    messages: Dict[int, List[Dict[str, Any]]],
    turns: Dict[int, List[Dict[str, Any]]],
) -> str:
    """时间 | 群 | 发言者 | 内容 | outcome，按时间升序（并列时消息在前）。"""
    lines = ["| 时间 | 群 | 发言者 | 内容 | outcome |", "|---|---|---|---|---|"]
    titles = dict(groups)
    rows: List[Tuple[int, int, str]] = []
    for sid, _ in groups:
        for msg in messages.get(sid, []):
            note = _system_note(msg.get("metadata")) if msg.get("role") == "system" else None
            if msg.get("role") == "system" and note is None:
                continue
            text = note or (msg.get("content") or "").replace("\n", " ").replace("|", "\\|")
            speaker = msg.get("speaker_agent_id") or msg.get("role") or ""
            rows.append(
                (int(msg.get("created_at") or 0), 0, f"| {msg.get('created_at')} | "
                 f"{titles.get(sid, sid)} | {speaker} | {text} | |")
            )
        for turn in turns.get(sid, []):
            if turn.get("messageId") is not None:
                continue
            rows.append(
                (int(turn.get("startedAt") or 0), 1, f"| {turn.get('startedAt')} | "
                 f"{titles.get(sid, sid)} | {turn.get('agentId')} | {_turn_note(turn)} | "
                 f"{turn.get('outcome')} |")
            )
    rows.sort(key=lambda r: (r[0], r[1]))
    lines.extend(row[2] for row in rows)
    return "\n".join(lines) + "\n"


# ── 主流程 ───────────────────────────────────────────────────────────────


def _fail_env(message: str, *hints: str) -> int:
    print(f"[env] {message}", file=sys.stderr)
    for hint in hints:
        print(f"      → {hint}", file=sys.stderr)
    return EXIT_ENV_UNAVAILABLE


def _labs_on(api_base: str, token: str) -> Tuple[bool, str]:
    status, payload = _http("GET", f"{api_base}/agent/labs", headers={LOCAL_TOKEN_HEADER: token})
    if status != 200:
        return False, f"GET /agent/labs → HTTP {status} {payload}"
    data = _unwrap(payload) or {}
    return data.get("groupAgents") == "on", json.dumps(data, ensure_ascii=False)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="狼人杀实验 manual lane 跑分（不进 CI）")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--judge-model", default=None)
    parser.add_argument("--player-model", default=None)
    parser.add_argument("--max-minutes", type=int, default=30)
    parser.add_argument("--poll-seconds", type=int, default=5)
    parser.add_argument("--api-base", default="http://127.0.0.1:8200/api")
    parser.add_argument("--gateway-base", default="http://127.0.0.1:8300")
    parser.add_argument(
        "--out",
        default=os.path.join(_REPO_ROOT, "dist", "werewolf-runs"),
        help="回放 markdown 与判据 JSON 的落地目录",
    )
    parser.add_argument("--dry-run", action="store_true", help="只检查三条腿，不建局不花钱")
    args = parser.parse_args(argv)

    from src.chat.db import ChatDb, resolve_ai_chat_db_path

    token = os.environ.get(LOCAL_TOKEN_ENV, "").strip()
    if not token:
        return _fail_env(
            f"缺 env {LOCAL_TOKEN_ENV}（serve-api 同机放行 token，App 每次启动随机生成）",
            f"从运行中的 App 取到该值后 export {LOCAL_TOKEN_ENV}=…",
            "或另起一个 dev serve-api：MAILAGENT_API_AUTH_DISABLED=true MAILAGENT_API_DEV=true",
        )

    db_path = resolve_ai_chat_db_path()
    print(f"[env] token 来源 env {LOCAL_TOKEN_ENV}（长度 {len(token)}）")
    # 🔴 打包 App 的活库在 userData（~/Library/Application Support/mailagent-frontend/data/
    # frontend/ai_chat.db），不是仓库 data/ 下那份 —— 跑装机版时必须用 AI_CHAT_DB_PATH 指过去，
    # 否则轮询的是一个永远不会有这局消息的库。
    print(f"[env] ai_chat.db = {db_path}（跑装机版请用 AI_CHAT_DB_PATH 指向 userData 那份）")
    if not os.path.exists(db_path):
        return _fail_env(f"ai_chat.db 不存在：{db_path}", "先启动一次 App（前端建库）",
                         "或 export AI_CHAT_DB_PATH=<userData 下那份>")

    on, detail = _labs_on(args.api_base, token)
    if not on:
        return _fail_env(f"labs 群聊多 agent 未开启或 serve-api 不可达：{detail}",
                         "设置 → 实验室 → 打开「群聊多 agent」")
    print("[env] serve-api 可达且 labs=on")

    gw_status, _ = _http("POST", f"{args.gateway_base}/api/ai/group-chat", body={})
    if gw_status == 0:
        return _fail_env(f"gateway 不可达：{args.gateway_base}", "确认 App 正在运行（内嵌 gateway）")
    print(f"[env] gateway 可达（探针 HTTP {gw_status}，400 = 端点在、body 空）")

    if args.dry_run:
        print("[dry-run] 三条腿都通，可以真跑一局（会产生真实费用）")
        return EXIT_OK

    body: Dict[str, Any] = {"seed": args.seed}
    if args.judge_model:
        body["judgeModel"] = args.judge_model
    if args.player_model:
        body["playerModel"] = args.player_model
    status, payload = _http(
        "POST",
        f"{args.api_base}/agent/labs/werewolf/new-game",
        body=body,
        headers={LOCAL_TOKEN_HEADER: token},
    )
    if status != 200:
        return _fail_env(f"建局失败 HTTP {status}: {json.dumps(payload, ensure_ascii=False)}")
    game = _unwrap(payload) or {}
    main_id = int(game["mainSessionId"])
    wolf_id = int(game["wolfSessionId"])
    seer_id = int(game["seerSessionId"])
    judge_agent_id = str(game["judgeAgentId"])
    # 🔴 roles / players 只留在应答里：不打印、不落 JSON（打印一次就是一次泄漏）。
    print(f"[game] 主群={main_id} 狼群={wolf_id} 预言家群={seer_id} seed={game.get('seed')} "
          f"reused={game.get('reusedAgents')} configApplied={game.get('configApplied')}")

    gw_status, gw_payload = _http(
        "POST",
        f"{args.gateway_base}/api/ai/group-chat",
        body={"sessionId": main_id, "userText": "@法官 开始游戏"},
    )
    if gw_status != 200:
        return _fail_env(f"开局投递失败 HTTP {gw_status}: {gw_payload}")

    db = ChatDb(db_path)
    groups = [(main_id, "主群"), (wolf_id, "狼群"), (seer_id, "预言家群")]
    deadline = time.time() + args.max_minutes * 60
    messages: Dict[int, List[Dict[str, Any]]] = {}
    turns: Dict[int, List[Dict[str, Any]]] = {}
    game_over = False
    stopped_reason: Optional[str] = None
    timed_out = False
    while True:
        for sid, _ in groups:
            messages[sid] = db.list_messages(sid)
            turns[sid] = db.list_group_turns(sid, limit=500)["turns"]
        for row in messages[main_id]:
            note = _system_note(row.get("metadata")) if row.get("role") == "system" else None
            if note == "(游戏结束)":
                game_over = True
        for sid, _ in groups:
            for row in messages[sid]:
                if row.get("role") != "system":
                    continue
                try:
                    parsed = json.loads(row.get("metadata") or "{}")
                except json.JSONDecodeError:
                    continue
                if parsed.get("kind") == "group_stop":
                    stopped_reason = str(parsed.get("reason") or "unknown")
        if game_over or stopped_reason is not None:
            break
        if time.time() >= deadline:
            timed_out = True
            break
        time.sleep(max(1, args.poll_seconds))

    all_turns = [t for sid, _ in groups for t in turns.get(sid, [])]
    costs = [t.get("costUsd") for t in all_turns]
    cost_total = None if any(c is None for c in costs) or not costs else sum(costs)
    if cost_total is None:
        print("[cost] 定价缺失（部分 turn 的 cost_usd 为 NULL）→ 金额判据不生效，退 tokens 判据")
    silent_outcomes = {"silent", "held_dup", "skipped"}
    silent_rate = (
        sum(1 for t in all_turns if t.get("outcome") in silent_outcomes) / len(all_turns)
        if all_turns
        else None
    )
    summary = {
        "seed": args.seed,
        "mainSessionId": main_id,
        "turns": len(all_turns),
        "tokens": sum((t.get("tokensInput") or 0) + (t.get("tokensOutput") or 0) for t in all_turns),
        "cost_usd": cost_total,
        "silent_rate": silent_rate,
        "game_over": game_over,
        "group_stop": stopped_reason is not None,
        "stop_reason": stopped_reason,
        "night_violation": night_violation(messages[main_id], judge_agent_id),
        "timed_out": timed_out,
    }
    code, reasons = judge(summary)
    summary["exit_code"] = code
    summary["reasons"] = reasons

    os.makedirs(args.out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    replay_path = os.path.join(args.out, f"werewolf-{args.seed}-{stamp}.md")
    json_path = os.path.join(args.out, f"werewolf-{args.seed}-{stamp}.json")
    with open(replay_path, "w", encoding="utf-8") as fh:
        fh.write(render_replay(groups, messages, turns))
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(f"[out] 回放 {replay_path}")
    print(f"[out] 判据 {json_path}")
    for reason in reasons:
        print(f"[judge] {reason}", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
