"""`mailagent` CLI subprocess runner for the FastAPI remote-access backend.

Python re-write of the Electron main-process runner
(frontend/src/electron/main/cli_runner.ts). The FastAPI write endpoints do NOT
touch SQLite directly — every mutating operation forks the SAME `mailagent` CLI
that mail-sync / the desktop app use, so the outbox-SSoT invariant (Sprint 15)
and the auth policy (`MAILAGENT_CLI_API_KEY`) hold in one place.

Why this file is non-trivial (mirrors the TS file's design notes + one extra
finding the TS file gets wrong for our environment):

  - The CLI's `-o json` wrapper lands on a DIFFERENT stream depending on exit:
      * exit 0  → wrapper on STDOUT  (stderr empty)
      * non-0   → wrapper on STDERR  (stdout empty), e.g. the E_NOT_FOUND error
        wrapper `email get <missing>` emits.
    So we parse stdout first, then FALL BACK to stderr to recover the
    self-reported `error.code` / `message` / `hint`. The TS runner assumes
    stdout-only because Electron's stdio plumbing differs; do not copy that
    assumption here. (Verified against the installed venv CLI.)
  - `--api-key` and `-o json` are ROOT Typer options (src/cli/main.py callback),
    NOT subcommand options — they MUST come BEFORE the subcommand name, else
    Typer errors `No such option: --api-key`. We group globals up front.
  - Non-zero exit is NOT an exception from `subprocess` (we read `returncode`),
    so we dispatch ALL exit codes (0/1/2/4/5/6/7/8/9/130 + our local timeout
    sentinel) and always surface an `E_<NAME>` code even on a raw crash that
    never emitted JSON.
  - `MAILAGENT_CLI_API_KEY` is read from the SERVER env and injected into the
    child's `--api-key`. It is never returned to a caller and never reaches the
    web bundle (REMOTE-ACCESS §6.4 G3). Read endpoints pass `api_key=None`.
  - The CLI is run from the project root so pydantic BaseSettings finds `.env`
    (NOTION_TOKEN / EMAIL_DATABASE_ID / USER_EMAIL are required fields); without
    the right cwd the CLI dies in Config() before reaching typer.

Long-running spawns (backfill / batch-resync with streamed stdout) are NOT this
file's job — this covers the <=60s request/response shape only, exactly like the
TS counterpart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("mailagent.api.cli_runner")

# --- bin resolution ---------------------------------------------------------
# Resolution order (parallels getMailagentBin in cli_runner.ts):
#   1. $MAILAGENT_BIN                       (explicit override)
#   2. <project venv>/bin/mailagent         (the dev / prod layout)
#   3. <project venv>/bin/python3 -m src.cli.main   (fallback if the console
#      entry-point wasn't installed, e.g. a bare `pip install` without [cli])
#
# Unlike the Electron build we do NOT consult PATH: the API process is launched
# by pm2 with `--interpreter ./venv/bin/python3`, so the venv is known and a
# PATH lookup would only add ambiguity (and a Spotlight stall on macOS).

_DEFAULT_PROJECT_ROOT = Path("/Users/chenyuanquan/Documents/MailAgent")
_DEFAULT_VENV_BIN = _DEFAULT_PROJECT_ROOT / "venv" / "bin"


def get_project_root() -> Path:
    """Project root that contains `.env` — the CLI's working directory.

    Override with $MAILAGENT_PROJECT_ROOT (matches the env var the Electron
    BackendLifecycleManager injects). Defaults to the main worktree so the API
    process reuses the production `.env` + `data/sync_store.db`.
    """
    from_env = os.environ.get("MAILAGENT_PROJECT_ROOT")
    if from_env:
        return Path(from_env)
    return _DEFAULT_PROJECT_ROOT


def _venv_bin_dir() -> Path:
    """Directory holding the `mailagent` console script + `python3`.

    Derived from $MAILAGENT_PROJECT_ROOT/venv/bin when set, else the default
    main-worktree venv. Kept separate from get_project_root() because the API
    may run with a project root that differs from where the venv lives only in
    exotic setups; in practice they share the same tree.
    """
    root = get_project_root()
    candidate = root / "venv" / "bin"
    if (candidate / "python3").exists() or (candidate / "mailagent").exists():
        return candidate
    return _DEFAULT_VENV_BIN


# Resolved once, lazily, and cached (the `which mailagent` once-at-load trick
# from the TS file, minus the actual `which`).
_argv0_cache: Optional[list[str]] = None


def get_mailagent_argv0() -> list[str]:
    """Return the argv prefix that invokes the CLI (everything before args).

    Either `["/.../bin/mailagent"]` or, as a fallback,
    `["/.../bin/python3", "-m", "src.cli.main"]`. Cached after first resolution.
    """
    global _argv0_cache
    if _argv0_cache is not None:
        return list(_argv0_cache)

    override = os.environ.get("MAILAGENT_BIN")
    if override:
        _argv0_cache = [override]
        return list(_argv0_cache)

    bindir = _venv_bin_dir()
    console_bin = bindir / "mailagent"
    if console_bin.exists():
        _argv0_cache = [str(console_bin)]
        return list(_argv0_cache)

    python_bin = bindir / "python3"
    if python_bin.exists():
        # `-m src.cli.main` resolves the Typer app from the project root cwd.
        _argv0_cache = [str(python_bin), "-m", "src.cli.main"]
        return list(_argv0_cache)

    raise CliRunnerError(
        code="E_NO_BIN",
        exit_code=-1,
        message=(
            "mailagent CLI not found. Tried $MAILAGENT_BIN, "
            f"{console_bin}, and {python_bin}."
        ),
        hint="Install with `pip install -e '.[cli]'` or set MAILAGENT_BIN.",
    )


# --- exit-code → error-code map ---------------------------------------------
# Mirror of docs/cli-schema/error-codes.md (and src/cli/exceptions.py). -1 is
# our local timeout / no-bin sentinel (no real CLI process produces it).
EXIT_CODE_MAP: dict[int, str] = {
    0: "OK",
    1: "GENERIC",
    2: "INVALID_ARG",
    4: "AUTH",
    5: "UPSTREAM",
    6: "PARTIAL",
    7: "ABORTED",
    8: "MAX_FAILURES",
    9: "PM2_CONFLICT",
    130: "SIGINT2",
    -1: "TIMEOUT",
}

# Subset of exit codes that are "successful" from the process's POV but may
# carry a partial_failure wrapper (batch range/ids commands). The CLI exits 6
# for partial failures with a wrapper whose status == "partial_failure".
_PARTIAL_EXIT = 6


class CliRunnerError(Exception):
    """Structured CLI failure carrying the CLI's self-reported error fields.

    `code` is the `E_*` enum (from the parsed wrapper when available, else
    derived from the exit code). `exit_code` is the raw process exit code (or
    -1 for timeout / missing-bin). `stdout` / `stderr` are retained raw for
    logging by the router; never echo them to the wire verbatim.
    """

    def __init__(
        self,
        *,
        code: str,
        exit_code: int,
        message: str,
        hint: Optional[str] = None,
        context: Optional[dict[str, Any]] = None,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        super().__init__(f"mailagent exit={exit_code} code={code}: {message}")
        self.code = code
        self.exit_code = exit_code
        self.message = message
        self.hint = hint
        self.context = context
        self.stdout = stdout
        self.stderr = stderr


@dataclass
class CliResult:
    """Successful CLI invocation result.

    `data` is the unwrapped `data` payload from the CLI's success wrapper —
    the SAME shape the matching `docs/cli-schema/*.schema.json` describes, so
    routers can re-emit it under the FastAPI envelope unchanged.

    `meta` is the CLI's own `meta` object (`duration_ms`, plus any
    `total`/`limit`/`offset`/`count`/`query`/`total_hits`). Routers merge their
    own timing + `source="cli"` on top.

    `status` is "success" or "partial_failure". For partial_failure, `data` is
    the `{succeeded, failed, summary}` object and the router should map it to
    HTTP 207.
    """

    data: Any
    meta: dict[str, Any] = field(default_factory=dict)
    status: str = "success"
    exit_code: int = 0
    raw_stdout: str = ""
    raw_stderr: str = ""

    @property
    def is_partial_failure(self) -> bool:
        return self.status == "partial_failure"


def _parse_wrapper(text: str) -> Optional[dict[str, Any]]:
    """Parse a CLI stdout/stderr buffer into the wrapper dict, or None."""
    text = text.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def _build_argv(
    args: list[str],
    *,
    api_key: Optional[str],
    extra_globals: Optional[list[str]] = None,
) -> list[str]:
    """Compose the full argv: [argv0..., -o json, --api-key KEY?, *globals, *args].

    Globals MUST precede the subcommand (Typer root options). `api_key` is
    injected only when provided (write commands); read commands pass None.
    """
    argv = list(get_mailagent_argv0())
    argv += ["-o", "json"]
    if api_key:
        argv += ["--api-key", api_key]
    if extra_globals:
        argv += list(extra_globals)
    argv += list(args)
    return argv


def get_cli_api_key() -> Optional[str]:
    """Server-side CLI API key from env (never reaches the web bundle).

    Returns None when unset/empty; the CLI itself enforces the write-auth policy
    (exit 4 E_AUTH_FAILED) when a write command runs without a key and without
    MAILAGENT_CLI_ALLOW_UNAUTH_WRITES. Routers that perform writes should fetch
    this and pass it as `api_key=` to run_cli().
    """
    key = os.environ.get("MAILAGENT_CLI_API_KEY", "").strip()
    return key or None


async def run_cli(
    args: list[str],
    *,
    api_key: Optional[str] = None,
    timeout: int = 60,
    extra_globals: Optional[list[str]] = None,
    cwd: Optional[str] = None,
) -> CliResult:
    """Run `mailagent <args>` and return the unwrapped CLI result.

    Parameters
    ----------
    args:
        The subcommand + its options, e.g.
        ``["email", "resync", "53675", "--replace-existing", "--allow-concurrent"]``.
        Do NOT include `-o json` or `--api-key` — they are injected here. The
        caller is responsible for write-command flags like ``--allow-concurrent``
        (email flag/resync) and ``--yes`` (email send) and ``--dry-run``.
    api_key:
        Injected as ``--api-key`` BEFORE the subcommand for write commands.
        Pass ``get_cli_api_key()`` for writes; pass ``None`` for reads /
        ``--dry-run`` (which skip auth).
    timeout:
        Per-call wall-clock timeout in seconds (default 60, matching the TS
        runner). Long jobs must NOT use this path.
    extra_globals:
        Extra root-level options to inject before the subcommand (rarely
        needed; e.g. ``["--db-path", "/x"]``).
    cwd:
        Working directory; defaults to ``get_project_root()`` so `.env` is found.

    Returns
    -------
    CliResult
        ``status`` in {"success", "partial_failure"}; ``data`` is the unwrapped
        CLI ``data`` payload; ``meta`` is the CLI's meta object.

    Raises
    ------
    CliRunnerError
        On any non-zero exit, timeout, missing bin, unparseable success output,
        or a `status: error` wrapper. ``.code`` / ``.exit_code`` / ``.hint`` are
        populated for the router to map to an HTTP status + envelope.
    """
    argv = _build_argv(args, api_key=api_key, extra_globals=extra_globals)
    run_cwd = cwd or str(get_project_root())

    # Inherit the server env so the CLI sees MAILAGENT_BACKEND, SYNC_STORE_DB_PATH,
    # MAILAGENT_OUTBOX_ENABLED, etc. exactly as configured for this deployment.
    child_env = dict(os.environ)

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=run_cwd,
            env=child_env,
        )
    except FileNotFoundError as exc:  # argv0 vanished between resolve and spawn
        raise CliRunnerError(
            code="E_NO_BIN",
            exit_code=-1,
            message=f"failed to spawn mailagent CLI: {exc}",
            hint="Check MAILAGENT_BIN / venv layout.",
        ) from exc

    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        # Best-effort kill so we don't orphan the child (the TS file's
        # before-quit killAll analogue, per-call).
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        raise CliRunnerError(
            code="E_TIMEOUT",
            exit_code=-1,
            message=f"CLI exceeded {timeout}s",
            hint="Long-running operations must not use the request/response path.",
        ) from exc

    stdout = stdout_b.decode("utf-8", errors="replace") if stdout_b else ""
    stderr = stderr_b.decode("utf-8", errors="replace") if stderr_b else ""
    exit_code = proc.returncode if proc.returncode is not None else -1

    # The success wrapper rides stdout; the error wrapper rides stderr (verified
    # against the installed CLI). Parse stdout first, then stderr, so we recover
    # the structured wrapper regardless of which stream it landed on.
    wrapper = _parse_wrapper(stdout) or _parse_wrapper(stderr)

    if exit_code == 0:
        if wrapper is None:
            raise CliRunnerError(
                code="E_INTERNAL",
                exit_code=exit_code,
                message=(
                    "CLI exited 0 but stdout did not parse as JSON "
                    f"({len(stdout)} bytes)."
                ),
                stdout=stdout,
                stderr=stderr,
            )
        status = wrapper.get("status")
        if status == "success":
            return CliResult(
                data=wrapper.get("data"),
                meta=wrapper.get("meta") or {},
                status="success",
                exit_code=exit_code,
                raw_stdout=stdout,
                raw_stderr=stderr,
            )
        # exit 0 with a non-success wrapper is an upstream contract bug;
        # surface via the error path rather than silently returning undefined.
        err = wrapper.get("error") or {}
        raise CliRunnerError(
            code=err.get("code") or "E_INTERNAL",
            exit_code=exit_code,
            message=err.get("message")
            or f"CLI wrapper.status={status!r} on exit 0",
            hint=err.get("hint"),
            context=err.get("context"),
            stdout=stdout,
            stderr=stderr,
        )

    if exit_code == _PARTIAL_EXIT and wrapper and wrapper.get("status") == "partial_failure":
        # Batch range/ids partial success: the router maps this to HTTP 207 and
        # re-emits the {succeeded, failed, summary} data block.
        return CliResult(
            data=wrapper.get("data"),
            meta=wrapper.get("meta") or {},
            status="partial_failure",
            exit_code=exit_code,
            raw_stdout=stdout,
            raw_stderr=stderr,
        )

    # Any other non-zero exit → error. Prefer the wrapper's self-reported code,
    # fall back to EXIT_CODE_MAP so we always emit a meaningful E_<NAME>.
    err = (wrapper or {}).get("error") or {}
    fallback_code = f"E_{EXIT_CODE_MAP.get(exit_code, f'EXIT_{exit_code}')}"
    structured_message = err.get("message")
    if structured_message:
        # Structured CLI wrapper: `message` is a designed, user-readable string
        # (e.g. "email not found", "archive requires davmail"). Surface as-is.
        message = structured_message
    else:
        # C4 (security): an unstructured failure — a raw crash / config error
        # whose `stderr` may carry absolute paths, argv, or env. NEVER put that
        # on the wire. Log the raw streams server-side and return a generic,
        # path/argv/env-free message. The raw buffers are still attached to the
        # exception (`.stdout`/`.stderr`) for server-side recovery only (e.g.
        # llm._recover_selftest_data); routers must not echo them.
        logger.error(
            "mailagent CLI failed (exit=%s, code=%s) — raw stdout/stderr "
            "follow (server-side only):\nstdout: %s\nstderr: %s",
            exit_code,
            fallback_code,
            stdout,
            stderr,
        )
        message = f"CLI command failed (exit {exit_code})"
    raise CliRunnerError(
        code=err.get("code") or fallback_code,
        exit_code=exit_code,
        message=message,
        hint=err.get("hint"),
        context=err.get("context"),
        stdout=stdout,
        stderr=stderr,
    )
