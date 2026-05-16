"""mailagent admin — 统计 / 健康 / db-version (RFC v2 §4.8).

US-006: stats / health / db-version (PR-2 MVP)
"""

from __future__ import annotations

import typer

app = typer.Typer(name="admin", help="统计 / 健康 / db-version", no_args_is_help=True)
