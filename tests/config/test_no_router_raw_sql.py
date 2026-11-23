"""静态闸: 禁止 FastAPI 路由层 (src/api/routers/*.py) 直接写裸 SQL 或直连 sqlite3。

所有 SQL 查询与数据库连接生命周期必须下沉至领域 repository / queries 模块。
"""

from __future__ import annotations

import ast
from pathlib import Path

ROUTERS_DIR = Path(__file__).resolve().parents[2] / "src" / "api" / "routers"


def test_routers_have_zero_raw_sql_execute_and_sqlite_connect():
    violations: list[str] = []

    for py_path in sorted(ROUTERS_DIR.glob("*.py")):
        src = py_path.read_text(encoding="utf-8")
        tree = ast.parse(src, filename=str(py_path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Attribute) and node.func.attr == "execute":
                    violations.append(f"{py_path.name}:L{node.lineno}: .execute()")
                elif (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr == "connect"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "sqlite3"
                ):
                    violations.append(f"{py_path.name}:L{node.lineno}: sqlite3.connect()")

    assert not violations, (
        "FastAPI routers must not contain raw SQL or direct sqlite3.connect():\n  "
        + "\n  ".join(violations)
    )
