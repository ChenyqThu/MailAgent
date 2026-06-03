"""Output rendering — text / json / yaml / ndjson (RFC v2 §5.1).

Wrapper schema (RFC §5.1.2):
    {"status": "success" | "error" | "partial_failure",
     "schema_version": 1,
     "data" | "error": {...},
     "meta": {"duration_ms": int, ...}}
"""

from __future__ import annotations

import json
import sys
from typing import Any, Iterable, Optional, TYPE_CHECKING

import typer

from src.cli.exceptions import CODE_TO_EXIT

if TYPE_CHECKING:
    from src.cli.context import CliContext
    from src.services.errors import ServiceError


SCHEMA_VERSION = 1


# Leaf-command 输出格式校验 (PR-3: 5 个新命令组用同一份, 别重复定义).
VALID_LEAF_OUTPUT = ("text", "json", "yaml", "ndjson")


def apply_local_output(ctx: "typer.Context", output: Optional[str]) -> None:
    """允许 ``-o json`` 写在 leaf command 后 (gh/kubectl 风格).

    parent typer App 的全局 ``-o`` 只在 subcommand **之前** 生效;
    每个 leaf 暴露同名 flag, 若用户在 leaf 后传则覆盖 ``ctx.obj.output``。
    未知值走 typer.BadParameter (exit 2, 与 RFC §5.2 一致), 不 silent fallback。
    """
    if output is None or ctx.obj is None:
        return
    if output.lower() not in VALID_LEAF_OUTPUT:
        raise typer.BadParameter(
            f"--output must be one of {VALID_LEAF_OUTPUT}, got {output!r}",
            param_hint="-o/--output",
        )
    ctx.obj.output = output.lower()


def _json_default(obj: Any) -> Any:
    """让 json.dumps 容忍 dataclass / Path / set 等 — fallback 走 str()。"""
    try:
        # dataclass → dict
        if hasattr(obj, "__dataclass_fields__"):
            from dataclasses import asdict
            return asdict(obj)
    except Exception:
        pass
    return str(obj)


def emit(
    ctx: "CliContext",
    data: Any,
    *,
    meta_extra: Optional[dict] = None,
    stream: bool = False,
) -> None:
    """Render ``data`` per ``ctx.output``.

    Args:
        ctx: CliContext
        data: 业务数据 (单 object for get / list of object for list /
            iterable of object for ndjson stream)
        meta_extra: 附加到 meta 段的额外字段 (如 ``{'total': N, 'limit': 50}``)
        stream: 仅 ndjson 模式有效；True 时 data 视为 iterable, 逐行 emit。
    """
    meta: dict[str, Any] = {"duration_ms": ctx.elapsed_ms()}
    if meta_extra:
        meta.update({k: v for k, v in meta_extra.items() if v is not None})

    output_fmt = ctx.output.lower()

    if output_fmt == "ndjson":
        _emit_ndjson(data, meta)
        return

    if output_fmt == "json":
        payload = {
            "status": "success",
            "schema_version": SCHEMA_VERSION,
            "data": data,
            "meta": meta,
        }
        print(json.dumps(payload, ensure_ascii=False, default=_json_default))
        return

    if output_fmt == "yaml":
        import yaml  # 延迟 import — pyyaml 是 [cli] extras

        payload = {
            "status": "success",
            "schema_version": SCHEMA_VERSION,
            "data": data,
            "meta": meta,
        }
        yaml.safe_dump(
            json.loads(json.dumps(payload, default=_json_default)),
            sys.stdout, allow_unicode=True, sort_keys=False,
        )
        return

    # text (default) — caller 应自行渲染表格; emit() 走通用 fallback
    _emit_text(data)
    if not ctx.quiet:
        _emit_text_summary(meta)


def _emit_ndjson(data: Any, meta: dict[str, Any]) -> None:
    """NDJSON: 每行一 object + 最后一行 ``{_meta: ...}``."""
    if data is None:
        items: Iterable[Any] = []
    elif isinstance(data, list):
        items = data
    elif hasattr(data, "__iter__") and not isinstance(data, (str, bytes, dict)):
        items = data
    else:
        items = [data]
    for item in items:
        if hasattr(item, "__dataclass_fields__"):
            from dataclasses import asdict
            print(json.dumps(asdict(item), ensure_ascii=False, default=_json_default))
        else:
            print(json.dumps(item, ensure_ascii=False, default=_json_default))
    print(json.dumps({"_meta": meta}, ensure_ascii=False, default=_json_default))


def _emit_text(data: Any) -> None:
    """text 模式 fallback — caller 通常会 override (rich 表格)。"""
    if data is None:
        return
    if isinstance(data, dict):
        for key, value in data.items():
            print(f"{key}: {value}")
    elif isinstance(data, list):
        for item in data:
            print(item)
    else:
        print(data)


def _emit_text_summary(meta: dict[str, Any]) -> None:
    duration_ms = meta.get("duration_ms")
    extras = []
    for key in ("count", "total", "total_hits"):
        if key in meta and meta[key] is not None:
            extras.append(f"{key}={meta[key]}")
    if duration_ms is not None and (extras or duration_ms > 100):
        suffix = ", ".join(extras + [f"{duration_ms}ms"])
        print(f"({suffix})", file=sys.stderr)


def emit_error(
    ctx: "CliContext",
    code: str,
    message: str,
    *,
    exit_code: int = 1,
    hint: Optional[str] = None,
    context: Optional[dict] = None,
) -> "typer.Exit":
    """输出 error wrapper 到合适的流, 然后 raise ``typer.Exit(exit_code)``.

    json / yaml 模式 → stderr (避免污染 stdout 的 JSON 流);
    text 模式 → stderr ``Error [code]: message``。

    Returns:
        typer.Exit — caller 应 ``raise emit_error(...)`` 来终止命令。
    """
    error_payload: dict[str, Any] = {"code": code, "message": message}
    if hint:
        error_payload["hint"] = hint
    if context:
        error_payload["context"] = context

    output_fmt = ctx.output.lower() if ctx else "text"
    meta: dict[str, Any] = {"duration_ms": ctx.elapsed_ms() if ctx else 0}

    if output_fmt == "json":
        wrapper = {
            "status": "error",
            "schema_version": SCHEMA_VERSION,
            "error": error_payload,
            "meta": meta,
        }
        print(
            json.dumps(wrapper, ensure_ascii=False, default=_json_default),
            file=sys.stderr,
        )
    elif output_fmt == "yaml":
        import yaml

        wrapper = {
            "status": "error",
            "schema_version": SCHEMA_VERSION,
            "error": error_payload,
            "meta": meta,
        }
        yaml.safe_dump(
            json.loads(json.dumps(wrapper, default=_json_default)),
            sys.stderr, allow_unicode=True, sort_keys=False,
        )
    elif output_fmt == "ndjson":
        print(
            json.dumps({"_error": error_payload}, ensure_ascii=False, default=_json_default),
            file=sys.stderr,
        )
        print(
            json.dumps({"_meta": meta}, ensure_ascii=False, default=_json_default),
            file=sys.stderr,
        )
    else:
        # text
        prefix = f"Error [{code}]: {message}"
        if hint:
            prefix += f"\nhint: {hint}"
        print(prefix, file=sys.stderr)

    return typer.Exit(code=exit_code)


def emit_cli_error(ctx: "CliContext", err: "ServiceError") -> "typer.Exit":
    """Adapter — 从 ServiceError / CliError 派生 emit_error 调用。

    ``exit_code``: ``CliError`` 子类自带 (逐字段不变); service 层抛的 transport-neutral
    ``ServiceError`` 没有 exit_code → 按 ``code`` 查 ``CODE_TO_EXIT`` 回填 (CLI transport
    拥有退出码语义)。未知 code → 1 (与历史 ``CliError`` 默认一致)。"""
    exit_code = getattr(err, "exit_code", None)
    if exit_code is None:
        exit_code = CODE_TO_EXIT.get(err.code, 1)
    return emit_error(
        ctx,
        err.code,
        err.message,
        exit_code=exit_code,
        hint=err.hint,
        context=err.context,
    )
