"""exec / 文件工具执行端点 — /api/exec/* (S2 W1, agent openness).

TS 薄壳（``frontend/src/ai-gateway/tools/exec.ts``，W1b）→ 本 Python 端点执行（业务权威在 Python +
远程 parity）。三工具 ``run_command`` / ``file_read`` / ``file_write``，在 gateway 侧 **恒 edit-tier
人审、不进 auto-approve**；结构化白名单命中时 gateway 的 needsApproval 免卡（另经
``/api/agent/policy/evaluate``）。本层只负责真实执行 + deny 地板 + 固定 env，**不做审批**（审批权在
gateway ApprovalGuard）。

🔴 安全（本 wave 重心）：
  - **固定 env 白名单基底**（``build_fixed_base_env``，PATH 硬编码，**绝不** ``dict(os.environ)`` 继承）
    → 子进程看不到 NOTION_TOKEN / MAILAGENT_* / AWS_* 等（防经 ``env``/``printenv`` 回显全局密钥）。
  - **deny 地板**（``exec_floor``，inode 级）：``file_read`` / ``file_write`` 对敏感文件（.env / *.db /
    token.dat / ssh key / venv / skill_secrets.key / .quarantine）**硬拒**（open→fstat 复核，挡 hardlink
    + TOCTOU）；``run_command`` 地板只**静态标红**（``floor_hits``），批准后即任意执行——诚实边界：
    exec 无沙箱，最终防线是 HITL + 白名单窄度 + 固定 env（ADR-001 §7）。
  - **绝不 ``shell=True``**（argv 数组直传 → shell 元字符作字面参数，无注入面）。

🔴 鉴权 = ``verify_local_token``（**仅**本地 ephemeral token 腿，**不接受 CF JWT**）——对标
island ``/agent/announce``（``island.py:141``）。唯一调用方是 Electron 主进程内嵌 gateway 的
domainClient（同机 loopback，恒带 ``X-MailAgent-Local-Token``）。收窄理由：serve-api 经 cloudflared
暴露公网，若挂 ``verify_cf_access`` 则持/窃 owner CF 会话者可远程 curl ``/api/exec/run`` 拿 RCE，
绕过 gateway 的 HITL / policy engine。W1a 一切调用都是 owner 亲手的 manual_chat 语境；policy 评估用
manual_chat 仅作**审计透传**（``policy`` 字段），门禁在 gateway 层。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from loguru import logger
from pydantic import BaseModel, Field, field_validator

from src.api.app import APIError, success_envelope
from src.api.auth import verify_local_token
from src.api.exec_floor import FloorDenied, get_exec_floor
from src.skills.secret_names import build_fixed_base_env

router = APIRouter(prefix="/api/exec", tags=["exec"])

# ── 硬编码合理默认（单本机 owner 工具，不进 config.py）─────────────────────────────────
_DEFAULT_TIMEOUT_MS = 60_000
_MAX_TIMEOUT_MS = 600_000
_OUTPUT_CAP_BYTES = 256 * 1024  # stdout / stderr 各自返回上限（超出截断 + 标记）
_DEFAULT_MAX_READ = 256 * 1024
_MAX_READ_BYTES = 2 * 1024 * 1024

# policy 评估的缺省审计语境（W1a：一切调用都是 owner 亲手的 manual_chat）。S5 W4c（ADR-004 D4
# 附带项）起 gateway 可随请求透传真实 context_mode + agent_id 作**纯审计标注** —— 授权判定仍全在
# gateway 矩阵 + evaluate，端点不据此做门禁（模块 docstring 的职责边界不变）。
_AUDIT_CONTEXT_MODE = "manual_chat"

# 审计标注字段的公共形状（三个请求模型共用）。
_AuditContextMode = Optional[Literal["manual_chat", "untrusted_trigger", "cron_headless"]]


class RunRequest(BaseModel):
    argv: list[str] = Field(min_length=1)
    cwd: Optional[str] = None
    timeout_ms: int = Field(default=_DEFAULT_TIMEOUT_MS, ge=1, le=_MAX_TIMEOUT_MS)
    context_mode: _AuditContextMode = None
    agent_id: Optional[str] = None

    @field_validator("argv")
    @classmethod
    def _nonempty_argv0(cls, v: list[str]) -> list[str]:
        if not v[0]:
            raise ValueError("argv[0] must be a non-empty program name")
        return v


class FileReadRequest(BaseModel):
    path: str = Field(min_length=1)
    max_bytes: int = Field(default=_DEFAULT_MAX_READ, ge=1, le=_MAX_READ_BYTES)
    context_mode: _AuditContextMode = None
    agent_id: Optional[str] = None


class FileWriteRequest(BaseModel):
    path: str = Field(min_length=1)
    content: str
    mode: Literal["overwrite", "append", "create_new"] = "create_new"
    context_mode: _AuditContextMode = None
    agent_id: Optional[str] = None


def _evaluate(
    capability: str,
    action: dict[str, Any],
    *,
    context_mode: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> dict[str, Any]:
    """policy 评估（审计透传）：命中结构化白名单 → auto_allow + rule_id，否则 ask。评估器自身
    fail-closed（异常→ask），故这里无需再兜底。``context_mode``/``agent_id`` 缺省 = W1a 现状
    （manual_chat / 全局候选）。

    S6 W3（rev3.1 §5.2）：per-agent exec 评估补传挂载集 —— 让本端点的审计 verdict 与 gateway
    /policy/evaluate 的免卡判决同判（挂载闸生效于两处，审计不撒谎）。仅 exec + agent_id 非空
    才读 agent 行（flag off / 读失败 → None/空集，evaluate 恒 dormant，fail-closed）。"""
    from src.agent_config.policy import evaluate
    from src.agent_config.store import get_agent_config_store

    mounted_skills = None
    if agent_id is not None and capability == "exec":
        try:
            from src.api import deps
            from src.api.routers import agent as agent_router
            from src.api.routers.agent_runs import resolve_mounted_skills

            # flag off = custom agents 不存在 → 不读 store（None → evaluate 恒 dormant）。
            if agent_router._custom_agents_enabled():
                mounted_skills = resolve_mounted_skills(
                    deps.get_report_store().get_agent(agent_id)
                )
        except Exception:  # noqa: BLE001 — store 不可达 → 空集（dormant，审计 verdict 恒 ask）
            mounted_skills = frozenset()
    return evaluate(
        get_agent_config_store(),
        capability,
        action,
        context_mode or _AUDIT_CONTEXT_MODE,
        agent_id=agent_id,
        mounted_skills=mounted_skills,
    )


# ── run_command ─────────────────────────────────────────────────────────────────


# 增量读的保留余量（D4-③）：redact 先于 cap 是 W3 语义（密钥值恰跨 cap 边界时需要边界后的文本
# 才能整段命中替换）——源头只保留 cap+margin 字节，margin 覆盖任何现实尺寸的 secret 值；margin 外
# 的字节在管道读取时即丢弃（**不再全量 buffer**，防大输出 OOM）。
_DRAIN_KEEP_MARGIN = 64 * 1024
_DRAIN_CHUNK = 64 * 1024


async def _drain_capped(
    stream: Optional[asyncio.StreamReader], keep: int
) -> tuple[bytes, bool]:
    """增量读一条子进程管道（ADR-004 D4-③）：只保留前 ``keep`` 字节，其余持续排水丢弃。
    返回 ``(kept, overflowed)``。排水**不中断** —— 停读会让管道写满反压、子进程卡死。"""
    if stream is None:
        return b"", False
    kept = bytearray()
    overflowed = False
    while True:
        chunk = await stream.read(_DRAIN_CHUNK)
        if not chunk:
            break
        if len(kept) < keep:
            room = keep - len(kept)
            kept.extend(chunk[:room])
            if len(chunk) > room:
                overflowed = True
        else:
            overflowed = True
    return bytes(kept), overflowed


async def _spawn(
    argv: list[str],
    cwd: str,
    timeout_ms: int,
    env: dict[str, str],
    redact: Optional[list[tuple[str, str]]] = None,
) -> dict[str, Any]:
    """spawn argv（**绝不** shell）→ 给定 env → wait_for(timeout) → 超时 kill 防孤儿。stdout/stderr
    各截 256KiB —— **增量读**（D4-③）：cap+margin 之外的字节在读取时即丢弃，不再 ``communicate``
    全量 buffer（headless 免卡 = 无人在环时跑飞的程序不能打满内存）。抄 cli_runner 的
    spawn+wait+kill 模板，但 env 由调用方构造（**不继承** os.environ）。

    ``env`` = 固定白名单基底（+ 命中 skill 目录时叠加的 per-skill 密钥，W3）。``redact`` = 注入的
    (secret_name, value) 对：对 stdout/stderr 做**精确子串**替换 → ``[REDACTED:<name>]`` 后再返回/落审计
    （诚实边界：base64/转码后的值躲得过精确匹配，残余风险接受 —— 值本来就是 owner 自己的）。
    """
    started = time.perf_counter()
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
        )
    except FileNotFoundError as exc:
        raise APIError("E_NO_BIN", f"command not found: {argv[0]}", http_status=400, source="exec") from exc
    except PermissionError as exc:
        raise APIError("E_NO_BIN", f"not executable: {argv[0]}", http_status=400, source="exec") from exc
    except (ValueError, OSError) as exc:  # 内嵌 null / 非法 argv
        raise APIError("E_INVALID_ARG", f"cannot spawn: {exc}", http_status=400, source="exec") from exc

    keep = _OUTPUT_CAP_BYTES + _DRAIN_KEEP_MARGIN
    try:
        (stdout_b, out_over), (stderr_b, err_over), _ = await asyncio.wait_for(
            asyncio.gather(
                _drain_capped(proc.stdout, keep),
                _drain_capped(proc.stderr, keep),
                proc.wait(),
            ),
            timeout=timeout_ms / 1000.0,
        )
    except asyncio.TimeoutError as exc:
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        raise APIError(
            "E_EXEC_TIMEOUT", f"command exceeded {timeout_ms}ms", http_status=504, source="exec"
        ) from exc

    duration_ms = int((time.perf_counter() - started) * 1000)
    out, out_trunc = _finalize_output(stdout_b, redact, overflowed=out_over)
    err, err_trunc = _finalize_output(stderr_b, redact, overflowed=err_over)
    return {
        "exit_code": proc.returncode if proc.returncode is not None else -1,
        "stdout": out,
        "stderr": err,
        "truncated": out_trunc or err_trunc,
        "duration_ms": duration_ms,
    }


def _finalize_output(
    raw: Optional[bytes],
    redact: Optional[list[tuple[str, str]]],
    *,
    overflowed: bool = False,
) -> tuple[str, bool]:
    """截断 + 脱敏 stdout/stderr。``overflowed`` = 源头排水已丢字节（增量读，D4-③）——
    截断标记与 cap 语义同 W1a 现状（超 256KiB 即 truncated=True）。

    无脱敏（含普通非 skill 命令）→ 原字节截断快路径（零开销）。有脱敏 → **先解码保留段 + 替换
    密钥值再截断**（``redact`` 早于 cap 是关键：byte-cap 在前会把恰跨截断边界的密钥值切一半 →
    半个值泄漏；保留段 = cap+margin，跨界密钥落在 margin 内整段命中）。
    """
    if not raw:
        return "", overflowed
    if not redact:
        truncated = overflowed or len(raw) > _OUTPUT_CAP_BYTES
        return raw[:_OUTPUT_CAP_BYTES].decode("utf-8", errors="replace"), truncated
    text = raw.decode("utf-8", errors="replace")
    # 按值长度**降序**替换（W3 review P2-①）：两 secret 值互为前缀时（如 ``TOKENabc`` 与
    # ``TOKENabc123``），若短值先替换会把长值的前缀吃掉、泄漏其尾部（``123``）。长值先替换则整段命中。
    # 保留所有非空值脱敏（不设长度下限跳过）——脱敏是 best-effort 回显防护（ADR-002 §7 已声明非外发
    # 防线，base64/转码可逃逸），不为可用性开「超短值不脱敏」的泄漏口。
    for name, value in sorted(redact, key=lambda nv: len(nv[1]), reverse=True):
        if value:
            text = text.replace(value, f"[REDACTED:{name}]")
    truncated = overflowed or len(text) > _OUTPUT_CAP_BYTES
    if len(text) > _OUTPUT_CAP_BYTES:
        text = text[:_OUTPUT_CAP_BYTES]
    return text, truncated


def _skill_secret_overlay(names: frozenset) -> tuple[dict[str, str], list[str]]:
    """命中 ``<skills>/<name>/`` 的 run → 该 skill 声明(manifest.secrets) ∩ 已存储密钥，解密成 env
    overlay（叠在固定基底之上）。非 skill 命令 → ``({}, [])`` 零注入（基底行为 W1a 零变化）。

    ``names`` = 共享 probe（``exec_gate.probe_skill_exec``，W4 单源 —— 路径判定与完整性/首跑闸
    逐字同一份）命中的 skill 名。**命中多个不同 skill → 保守零注入**（避免把 skill A 的密钥注入
    触达 skill B 的命令 → 二阶泄漏），warning 记之。声明侧读**已安装行的 manifest**（confirm 落库
    的权威事实，非可变的盘上 manifest.json）；注入侧再过 ``validate_secret_name`` 二重校验。
    """
    if len(names) != 1:
        if len(names) > 1:
            logger.warning(
                "run_command touches multiple skill dirs {} — injecting no secrets (ambiguous)",
                sorted(names),
            )
        return {}, []

    skill_name = next(iter(names))
    from src.agent_config.secrets import get_secrets_for_skill
    from src.agent_config.store import get_agent_config_store

    store = get_agent_config_store()
    skill = store.get_skill(skill_name)
    manifest = skill.manifest if skill else None
    if not manifest:
        return {}, []  # 非已安装 skill / builtin 懒行（无 manifest）→ 不知声明的 secret，零注入
    declared = {
        s.get("name")
        for s in (manifest.get("secrets") or [])
        if isinstance(s, dict) and s.get("name")
    }
    if not declared:
        return {}, []

    stored = get_secrets_for_skill(skill_name, store=store)  # 已过注入侧二重校验 + 解密
    overlay: dict[str, str] = {}
    injected: list[str] = []
    for name in sorted(declared):
        if name in stored:  # 只注入「声明 ∩ 已存储」
            overlay[name] = stored[name]
            injected.append(name)
    return overlay, injected


def _skill_unresolved_problem(store: Any, argv: list[str], run_cwd: str) -> Optional[str]:
    """盲区独立 deny 地板（ADR-004 D4-②，unflagged 安全修复）：spawn 前对 argv 做内容完整性
    地板 —— **独立于审批，「人批了也不跑」**。返回问题描述（→ 409 E_SKILL_UNRESOLVED），None = 过。

    判定（范围**只限 skills root 内**，root 外 manual 语义零变化，codex P2-1）：
      - argv 任一位（含 argv[0]）为路径样 token（绝对 / 含分隔符 / ``.`` 开头）且 realpath 落
        skills root 内，但**不在任何** ``agent_skills.files_json`` 供应链清单内（含 ``.quarantine``
        内容 / 目录本身 / 不存在路径 / 无行 skill）→ 拒；
      - cwd 在 skills root 内时，**裸 token**（无分隔符）若按 cwd join 后是**现存**路径，同样必须
        在清单内（直接盲区形状 ``cd <skills>/x && python3 rogue.py`` —— probe 不落地、gate 无对象）；
        join 后不存在的裸 token 是普通实参（子命令 / flag），不拒。

    与既有 E_SKILL_TAMPERED 的分工：gate 对 probe **落地**的触达文件做 hash 校验（tampered 先判，
    错误码不变）；本地板兜「probe 认不出执行对象」的形状 —— skills 目录只应有供应链管控内容
    （§13.17.3），岛卡/审批卡上语义不明的裸引用不应等于放行未受管内容。诚实边界：清单内但 probe
    不落地的裸 token（如 manifest 内 ``main.py``）通过本地板但**不经 hash 校验** —— headless 侧由
    evaluate 恒 ask 兜底，manual 侧 owner 卡上可见完整 argv+cwd。
    """
    import json
    import os

    try:
        from src.skills.pack_fetch import skills_data_root

        skills_root = os.path.realpath(skills_data_root())
    except Exception:  # noqa: BLE001 — skills 根不可得（裸 worktree）→ 无 skill 概念，地板不适用
        return None

    def _within(rp: str) -> bool:
        return rp == skills_root or rp.startswith(skills_root + os.sep)

    try:
        cwd_rp = os.path.realpath(run_cwd)
    except (OSError, ValueError):
        cwd_rp = run_cwd
    cwd_in_skills = _within(cwd_rp)

    manifest_cache: dict[str, Optional[set]] = {}

    def _manifest_rels(name: str) -> Optional[set]:
        if name not in manifest_cache:
            row = store.get_skill(name)
            try:
                data = json.loads(row.files_json) if row and row.files_json else None
            except (ValueError, TypeError):
                data = None
            manifest_cache[name] = set(data) if isinstance(data, dict) else None
        return manifest_cache[name]

    for tok in argv:
        if not isinstance(tok, str) or not tok:
            continue
        pathish = os.path.isabs(tok) or os.sep in tok or tok.startswith(".")
        if pathish:
            cand = tok if os.path.isabs(tok) else os.path.join(run_cwd, tok)
        elif cwd_in_skills:
            cand = os.path.join(run_cwd, tok)
            if not os.path.lexists(cand):
                continue  # 纯实参（子命令/flag），非内容引用
        else:
            continue
        try:
            rp = os.path.realpath(cand)
        except (OSError, ValueError):
            continue  # 解析不动的 token 不落 skills 判定（root 外语义零变化）
        if not _within(rp):
            continue
        if rp == skills_root:
            return f"argv references the skills root directory itself ({tok!r})"
        first = rp[len(skills_root) + 1:].split(os.sep, 1)[0]
        skdir = skills_root + os.sep + first
        rel = rp[len(skdir) + 1:].replace(os.sep, "/") if rp.startswith(skdir + os.sep) else None
        rels = _manifest_rels(first) if first != ".quarantine" else None
        if rels is None or rel is None or rel not in rels:
            return (
                f"argv references {rp} inside the managed skills directory but it is not part of "
                "any installed skill's file manifest"
            )
    return None


def _shell_wrapped_skill_problem(argv: list[str], run_cwd: str) -> Optional[str]:
    """壳包装盲区的独立 deny 地板（issue #62）——「危险解释器 + token 文本引用 skills 目录 + 该
    token realpath 不落 skills」→ 完整 409 文案（含修复路径），None = 过。判定本体是
    ``exec_gate.shell_wrapped_skill_ref``（**单源**，与 evaluate 侧 ``policy._skill_gate_forces_ask``
    的 belt 逐字同一份）。

    补的是 :func:`_skill_unresolved_problem` 的漏判：``["/bin/sh","-lc","cd <skills>/x && python3
    f.py"]`` 里整条 shell 命令是**单个** token，``os.sep in tok`` 为真但 realpath 不落 skills →
    那边 ``continue`` 放行；而 ``cd`` 发生在 shell 内部、``run_cwd`` 仍是默认 data root ⇒ probe
    的 ``names``/``touched_files`` 双空 ⇒ 完整性校验 / 首跑记录 / **secret 注入**三个消费者一起
    fail-open。安全面之外更痛的是功能面：skill 作者声明了 secret、owner 也填了值，助手用这个最自然
    的写法一跑，脚本 ``os.environ`` 就是空的（零攻击者即触发）。

    修复路径 = 绝对路径 argv（``["python3", "<skills>/x/f.py"]``）—— 该形状 probe 正常落地，
    三者自动恢复。文案直白给出这个写法：模型读得到 409 message，能自我纠正。
    """
    import os

    try:
        from src.skills.exec_gate import shell_wrapped_skill_ref
        from src.skills.pack_fetch import skills_data_root

        skills_root = os.path.realpath(skills_data_root())
    except Exception:  # noqa: BLE001 — skills 根不可得（裸 worktree）→ 无 skill 概念，地板不适用
        return None
    tok = shell_wrapped_skill_ref(argv, run_cwd, skills_root)
    if tok is None:
        return None
    return (
        f"argv wraps a reference to the managed skills directory inside an interpreter argument "
        f"({tok!r}) — the integrity check, the first-run record and the skill's secret injection "
        "all resolve the SCRIPT PATH out of argv, so a shell-wrapped command silently runs with "
        "NO integrity check and NO secrets in its environment. Run the script by absolute path "
        "instead, e.g. argv=[\"python3\", \"<skill dir>/main.py\"] (add a cwd if the script needs "
        "one) — no `cd`, no `sh -c`, no `&&`."
    )


@router.post("/run", dependencies=[Depends(verify_local_token)])
async def run_command(request: Request, body: RunRequest):
    """执行一条命令（argv 数组，**无 shell**）。固定 env 白名单基底（不继承全局密钥）；run_command
    地板只静态标红（floor_hits），不阻断——批准后即任意执行（无沙箱，见模块 docstring）。
    skills root 内的未清单化内容另有独立 deny 地板（``_skill_unresolved_problem``，409 硬拒）。"""
    from src.api.exec_floor import _data_root

    floor = get_exec_floor()
    if body.cwd is not None:
        import os

        run_cwd = os.path.realpath(body.cwd)
        if not os.path.isdir(run_cwd):
            raise APIError("E_BAD_CWD", f"cwd is not a directory: {body.cwd}", http_status=400, source="exec")
    else:
        run_cwd = _data_root()

    floor_hits = floor.run_command_floor_hits(body.argv, run_cwd)

    # W4: skill integrity + first-run gate (ADR-002 §5 D3)。共享 probe（exec_gate 单源）命中
    # <skills>/<name>/ 的触达文件在 spawn 之前逐一 sha256 对 agent_skills.files_json：不符 / 不在
    # 清单（含无行、无 files_json）→ 409 E_SKILL_TAMPERED + last_error='tampered:<relpath>'，绝不
    # 执行。首跑闸：触达文件无有效记录（无记录 / version 变 / hash 变）→ 视为首跑，**执行并落记录**
    # —— 能到达此端点 = owner 批准面（chat 路径因 /policy/evaluate 前置 gate 恒 ask 必过审批卡；
    # owner API 直调 = owner 行为）。顺序：完整性 → 首跑 → secret overlay → spawn。
    from src.agent_config.store import get_agent_config_store
    from src.skills.exec_gate import check_skill_gates, probe_skill_exec

    probe = probe_skill_exec(body.argv, run_cwd)
    store = get_agent_config_store()
    gate_checks = check_skill_gates(store, probe)
    for check in gate_checks:
        if check.tampered:
            store.set_skill_last_error(check.skill_name, check.tampered)
            raise APIError(
                "E_SKILL_TAMPERED",
                f"skill {check.skill_name!r} integrity check failed ({check.tampered}); "
                "re-install or re-trust it from Settings",
                http_status=409,
                source="exec",
            )

    # ADR-004 D4-②：盲区独立 deny —— probe 认不出执行对象的 skills-root 内引用（裸 token /
    # 目录 / quarantine / 清单外路径）硬拒，**独立于审批**（人批了也不跑）。409 文案给修复路径。
    unresolved = _skill_unresolved_problem(store, body.argv, run_cwd)
    if unresolved is not None:
        raise APIError(
            "E_SKILL_UNRESOLVED",
            f"{unresolved}; move the script outside the skills directory to run it manually, "
            "or install it via the skill supply chain (Settings → Skills) so it enters the manifest",
            http_status=409,
            source="exec",
        )

    # issue #62：同族的壳包装盲区（``sh -lc "cd <skills>/x && …"``）—— 上面那条按 realpath 判定，
    # 对单 token 的整条 shell 命令必然漏判。文本 belt 与 evaluate 侧同一单源，同样独立于审批链。
    shell_wrapped = _shell_wrapped_skill_problem(body.argv, run_cwd)
    if shell_wrapped is not None:
        raise APIError("E_SKILL_UNRESOLVED", shell_wrapped, http_status=409, source="exec")

    # W3: 命中 skill 目录 → 该 skill 声明 ∩ 已存储密钥叠加进子进程 env（固定基底之上）；stdout/stderr
    # 精确脱敏。非 skill 命令 → 零注入（基底 W1a 行为不变）。密钥值任何形态**不进响应/日志/异常**。
    overlay, injected_names = _skill_secret_overlay(probe.names)
    env = build_fixed_base_env()
    env.update(overlay)  # secret 名过 validate_secret_name → 保证不覆盖任何基底名
    redact = [(name, overlay[name]) for name in injected_names]

    result = await _spawn(body.argv, run_cwd, body.timeout_ms, env, redact)
    # 首跑记录在 spawn 之后落（spawn 前抛错 —— E_NO_BIN 等 —— 不算一次首跑）。
    first_run_recorded: list[str] = []
    for check in gate_checks:
        if check.pending_first_run:
            store.merge_first_run_approved(check.skill_name, check.pending_first_run)
            first_run_recorded.extend(sorted(check.pending_first_run))
        # issue #62 ③：清掉「本次真的验过的那个文件」记下的 tampered。``last_error`` 的唯一落点是
        # 上面的 409 分支，而清除此前只发生在 install/confirm 的 upsert —— 修好文件后再跑成功，
        # Settings 仍会长期标红一个已不存在的错误。
        # 🔴 只认 ``check.verified``（本次逐字节校验通过的标签），**不**因为闸整体通过就无条件清：
        # 一个 skill 有多个文件时，跑 main.py 不代表 helper.py 的篡改也没了 —— 那样会在设置界面上
        # 造出 false-green。有错才写（避免每次 run 都 bump updated_at）。
        row = store.get_skill(check.skill_name)
        if row is not None and row.last_error in check.verified:
            store.set_skill_last_error(check.skill_name, None)
    result["cwd"] = run_cwd
    result["floor_hit"] = bool(floor_hits)
    result["floor_hits"] = floor_hits
    result["injected_secret_names"] = injected_names  # W4 审批卡展示；值不在此
    result["first_run_recorded"] = first_run_recorded  # W4 首跑闸：本次落记录的 entrypoint
    result["policy"] = _evaluate(
        "exec",
        {"argv": body.argv, "cwd": run_cwd},
        context_mode=body.context_mode,
        agent_id=body.agent_id,
    )
    return success_envelope(result, request=request, source="exec")


# ── file_read / file_write ───────────────────────────────────────────────────────


def _do_file_read(path: str, max_bytes: int) -> dict[str, Any]:
    """open（deny 地板 path+inode 双检 + O_NOFOLLOW）→ 读 ≤max_bytes → utf-8 lossy 解码。"""
    import os

    floor = get_exec_floor()
    fd = floor.open_checked_read(path)
    try:
        size = os.fstat(fd).st_size
        raw = os.read(fd, max_bytes + 1)  # 多读 1 字节判是否截断
    finally:
        os.close(fd)
    truncated = len(raw) > max_bytes
    if truncated:
        raw = raw[:max_bytes]
    return {"content": raw.decode("utf-8", errors="replace"), "truncated": truncated, "size": size}


def _do_file_write(path: str, content: str, mode: str) -> dict[str, Any]:
    """open（deny 地板 + inode 复核先于任何截断）→ 写 content（utf-8）。父目录须存在（不递归建）。"""
    import os

    floor = get_exec_floor()
    fd, created = floor.open_checked_write(path, mode)
    try:
        data = content.encode("utf-8")
        written = os.write(fd, data)
    finally:
        os.close(fd)
    return {"bytes_written": written, "created": created}


def _map_file_oserror(exc: OSError, path: str) -> APIError:
    """把 open/read/write 的 OSError 映成结构化端点错误码。"""
    if isinstance(exc, FileExistsError):
        return APIError("E_FILE_EXISTS", f"file already exists: {path}", http_status=409, source="exec")
    if isinstance(exc, FileNotFoundError):
        return APIError("E_BAD_PATH", f"parent directory does not exist: {path}", http_status=400, source="exec")
    if isinstance(exc, IsADirectoryError):
        return APIError("E_BAD_PATH", f"path is a directory: {path}", http_status=400, source="exec")
    # ELOOP（O_NOFOLLOW 遇 symlink）/ EACCES / 其它 → 通用坏路径。
    return APIError("E_BAD_PATH", f"cannot open {path}: {exc}", http_status=400, source="exec")


@router.post("/file_read", dependencies=[Depends(verify_local_token)])
async def file_read(request: Request, body: FileReadRequest):
    """读一个文件（deny 地板硬拒敏感目标；inode 复核挡 hardlink/TOCTOU）。返回 utf-8 lossy 文本 +
    截断标记 + 文件真实字节大小。"""
    try:
        result = await run_in_threadpool(_do_file_read, body.path, body.max_bytes)
    except FloorDenied as exc:
        raise APIError("E_EXEC_FLOOR_DENIED", str(exc), http_status=403, source="exec") from exc
    except OSError as exc:
        raise _map_file_oserror(exc, body.path) from exc
    result["policy"] = _evaluate(
        "file_read", {"path": body.path},
        context_mode=body.context_mode, agent_id=body.agent_id,
    )
    return success_envelope(result, request=request, source="exec")


@router.post("/file_write", dependencies=[Depends(verify_local_token)])
async def file_write(request: Request, body: FileWriteRequest):
    """写一个文件（deny 地板硬拒；overwrite 的截断推迟到 inode 复核之后，防 hardlink 抹敏感文件）。
    mode ∈ overwrite / append / create_new（默认 create_new，已存在则 409）。父目录须存在。"""
    try:
        result = await run_in_threadpool(_do_file_write, body.path, body.content, body.mode)
    except FloorDenied as exc:
        raise APIError("E_EXEC_FLOOR_DENIED", str(exc), http_status=403, source="exec") from exc
    except OSError as exc:
        raise _map_file_oserror(exc, body.path) from exc
    result["policy"] = _evaluate(
        "file_write", {"path": body.path},
        context_mode=body.context_mode, agent_id=body.agent_id,
    )
    return success_envelope(result, request=request, source="exec")
