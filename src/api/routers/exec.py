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

鉴权与 domainClient 消费的既有端点一致（``verify_cf_access``：本地 token 腿 / CF JWT 腿）——
owner-only（本机用户）。W1a 一切调用都是 owner 亲手的 manual_chat 语境；policy 评估用 manual_chat
仅作**审计透传**（``policy`` 字段），门禁在 gateway 层。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.exec_floor import FloorDenied, get_exec_floor
from src.skills.secret_names import build_fixed_base_env

router = APIRouter(prefix="/api/exec", tags=["exec"])

# ── 硬编码合理默认（单本机 owner 工具，不进 config.py）─────────────────────────────────
_DEFAULT_TIMEOUT_MS = 60_000
_MAX_TIMEOUT_MS = 600_000
_OUTPUT_CAP_BYTES = 256 * 1024  # stdout / stderr 各自返回上限（超出截断 + 标记）
_DEFAULT_MAX_READ = 256 * 1024
_MAX_READ_BYTES = 2 * 1024 * 1024

# W1a 端点是 owner 亲手动作；policy 评估仅审计透传（真门禁在 gateway needsApproval + ApprovalGuard）。
_AUDIT_CONTEXT_MODE = "manual_chat"


class RunRequest(BaseModel):
    argv: list[str] = Field(min_length=1)
    cwd: Optional[str] = None
    timeout_ms: int = Field(default=_DEFAULT_TIMEOUT_MS, ge=1, le=_MAX_TIMEOUT_MS)

    @field_validator("argv")
    @classmethod
    def _nonempty_argv0(cls, v: list[str]) -> list[str]:
        if not v[0]:
            raise ValueError("argv[0] must be a non-empty program name")
        return v


class FileReadRequest(BaseModel):
    path: str = Field(min_length=1)
    max_bytes: int = Field(default=_DEFAULT_MAX_READ, ge=1, le=_MAX_READ_BYTES)


class FileWriteRequest(BaseModel):
    path: str = Field(min_length=1)
    content: str
    mode: Literal["overwrite", "append", "create_new"] = "create_new"


def _evaluate(capability: str, action: dict[str, Any]) -> dict[str, Any]:
    """policy 评估（审计透传）：命中结构化白名单 → auto_allow + rule_id，否则 ask。评估器自身
    fail-closed（异常→ask），故这里无需再兜底。"""
    from src.agent_config.policy import evaluate
    from src.agent_config.store import get_agent_config_store

    return evaluate(get_agent_config_store(), capability, action, _AUDIT_CONTEXT_MODE)


# ── run_command ─────────────────────────────────────────────────────────────────


async def _spawn(argv: list[str], cwd: str, timeout_ms: int) -> dict[str, Any]:
    """spawn argv（**绝不** shell）→ 固定 env → wait_for(timeout) → 超时 kill 防孤儿。stdout/stderr
    各截 256KiB。抄 cli_runner 的 spawn+wait+kill 模板，但 env **不继承** os.environ。"""
    env = build_fixed_base_env()
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

    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(), timeout=timeout_ms / 1000.0
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
    out, out_trunc = _cap(stdout_b)
    err, err_trunc = _cap(stderr_b)
    return {
        "exit_code": proc.returncode if proc.returncode is not None else -1,
        "stdout": out,
        "stderr": err,
        "truncated": out_trunc or err_trunc,
        "duration_ms": duration_ms,
    }


def _cap(raw: Optional[bytes]) -> tuple[str, bool]:
    if not raw:
        return "", False
    truncated = len(raw) > _OUTPUT_CAP_BYTES
    return raw[:_OUTPUT_CAP_BYTES].decode("utf-8", errors="replace"), truncated


@router.post("/run", dependencies=[Depends(verify_cf_access)])
async def run_command(request: Request, body: RunRequest):
    """执行一条命令（argv 数组，**无 shell**）。固定 env 白名单基底（不继承全局密钥）；run_command
    地板只静态标红（floor_hits），不阻断——批准后即任意执行（无沙箱，见模块 docstring）。"""
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

    # W4: skill integrity + first-run gate hook (ADR-002 §5). 当 argv 路径实参命中
    # DATA_ROOT/data/skills/<name>/ 时，W4 在此处（**先于**任何 policy auto_allow / spawn）做逐文件
    # sha256 校验（对 agent_skills.files_json）+ 首跑闸（绑 version+entrypoint hash）；篡改 → 拒执行。
    # 本 wave 不实现，仅留锚点。

    result = await _spawn(body.argv, run_cwd, body.timeout_ms)
    result["cwd"] = run_cwd
    result["floor_hit"] = bool(floor_hits)
    result["floor_hits"] = floor_hits
    result["policy"] = _evaluate("exec", {"argv": body.argv, "cwd": run_cwd})
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


@router.post("/file_read", dependencies=[Depends(verify_cf_access)])
async def file_read(request: Request, body: FileReadRequest):
    """读一个文件（deny 地板硬拒敏感目标；inode 复核挡 hardlink/TOCTOU）。返回 utf-8 lossy 文本 +
    截断标记 + 文件真实字节大小。"""
    try:
        result = await run_in_threadpool(_do_file_read, body.path, body.max_bytes)
    except FloorDenied as exc:
        raise APIError("E_EXEC_FLOOR_DENIED", str(exc), http_status=403, source="exec") from exc
    except OSError as exc:
        raise _map_file_oserror(exc, body.path) from exc
    result["policy"] = _evaluate("file_read", {"path": body.path})
    return success_envelope(result, request=request, source="exec")


@router.post("/file_write", dependencies=[Depends(verify_cf_access)])
async def file_write(request: Request, body: FileWriteRequest):
    """写一个文件（deny 地板硬拒；overwrite 的截断推迟到 inode 复核之后，防 hardlink 抹敏感文件）。
    mode ∈ overwrite / append / create_new（默认 create_new，已存在则 409）。父目录须存在。"""
    try:
        result = await run_in_threadpool(_do_file_write, body.path, body.content, body.mode)
    except FloorDenied as exc:
        raise APIError("E_EXEC_FLOOR_DENIED", str(exc), http_status=403, source="exec") from exc
    except OSError as exc:
        raise _map_file_oserror(exc, body.path) from exc
    result["policy"] = _evaluate("file_write", {"path": body.path})
    return success_envelope(result, request=request, source="exec")
