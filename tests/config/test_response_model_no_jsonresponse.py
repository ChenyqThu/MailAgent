"""静态闸: 声明了 ``response_model=SuccessEnvelope[...]`` 的路由禁止返回裸 JSONResponse / success_envelope.

原因: FastAPI 对直接返回 ``Response`` / ``JSONResponse`` 实例的路由 handler 会完全跳过
``response_model`` 的运行时 Pydantic 校验与序列化，把类型契约退化成"假校验"。
此类路由必须返回原生 dict（即 ``success_payload(...)``）。
"""

from __future__ import annotations

import ast
from pathlib import Path

ROUTERS_DIR = Path(__file__).resolve().parents[2] / "src" / "api" / "routers"


def _is_success_envelope_expr(node: ast.AST) -> bool:
    if isinstance(node, ast.Subscript):
        return _is_success_envelope_expr(node.value)
    if isinstance(node, ast.Name):
        return node.id == "SuccessEnvelope"
    if isinstance(node, ast.Attribute):
        return node.attr == "SuccessEnvelope"
    return False


def _has_success_envelope_response_model(call: ast.Call) -> bool:
    for kw in call.keywords:
        if kw.arg == "response_model" and _is_success_envelope_expr(kw.value):
            return True
    return False


def _find_banned_calls(func_node: ast.AST) -> list[str]:
    hits: list[str] = []
    for child in ast.walk(func_node):
        if isinstance(child, ast.Call):
            name = None
            if isinstance(child.func, ast.Name):
                name = child.func.id
            elif isinstance(child.func, ast.Attribute):
                name = child.func.attr
            if name in ("success_envelope", "JSONResponse"):
                hits.append(f"L{child.lineno}:{name}()")
    return hits


def test_response_model_routes_never_bypass_validation_with_jsonresponse():
    """所有带 response_model=SuccessEnvelope[...] 的路由不得调用 success_envelope/JSONResponse."""
    violations: list[str] = []
    checked_routes = 0

    for py_path in sorted(ROUTERS_DIR.glob("*.py")):
        src = py_path.read_text(encoding="utf-8")
        tree = ast.parse(src, filename=str(py_path))

        funcs_by_name: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                funcs_by_name[node.name] = node
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and _has_success_envelope_response_model(dec):
                        checked_routes += 1
                        banned = _find_banned_calls(node)
                        if banned:
                            violations.append(
                                f"{py_path.name}:{node.name} -> {', '.join(banned)}"
                            )

        # Also check imperative add_api_route(..., handler_fn, response_model=SuccessEnvelope[...])
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_api_route"
                and _has_success_envelope_response_model(node)
            ):
                checked_routes += 1
                target_fn = None
                for arg in node.args[1:2]:
                    if isinstance(arg, ast.Name):
                        target_fn = funcs_by_name.get(arg.id)
                for kw in node.keywords:
                    if kw.arg == "endpoint" and isinstance(kw.value, ast.Name):
                        target_fn = funcs_by_name.get(kw.value.id)
                if target_fn is not None:
                    banned = _find_banned_calls(target_fn)
                    if banned:
                        violations.append(
                            f"{py_path.name}:{target_fn.name} (add_api_route) -> {', '.join(banned)}"
                        )

    # Canary: at least contacts(27) + ai(2) + notifications(9) + folder(9) + history_sync(3) = 50
    assert checked_routes >= 50, f"expected >=50 SuccessEnvelope routes, got {checked_routes}"
    assert not violations, (
        "response_model=SuccessEnvelope[...] routes must return dict via success_payload(), "
        f"never JSONResponse/success_envelope(): {violations}"
    )
