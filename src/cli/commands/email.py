"""mailagent email — CRUD / 搜索 / 重传 (RFC v2 §4.2).

US-003: get / body
US-004: list / search (text / json / ndjson)
US-005: resync (单封 + dry-run, 含 auth)
"""

from __future__ import annotations

import typer

app = typer.Typer(name="email", help="邮件 CRUD / 搜索 / 重传", no_args_is_help=True)
