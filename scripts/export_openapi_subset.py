"""Export OpenAPI JSON Schema subset for SuccessEnvelope-typed routes (Wave 4B codegen pilot)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Allow importing app in isolated/CI shells without .env
os.environ.setdefault("NOTION_TOKEN", "openapi-dummy")
os.environ.setdefault("EMAIL_DATABASE_ID", "openapi-dummy")
os.environ.setdefault("USER_EMAIL", "openapi@example.test")
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")


def extract_typed_envelope_openapi() -> dict:
    from src.api.app import app

    full = app.openapi()
    schemas = full.get("components", {}).get("schemas", {})
    typed_roots = sorted(name for name in schemas if name.startswith("SuccessEnvelope_"))
    return {
        "openapi": full.get("openapi", "3.1.0"),
        "typed_envelope_count": len(typed_roots),
        "typed_roots": typed_roots,
        "components": {"schemas": schemas},
    }


def main() -> int:
    payload = extract_typed_envelope_openapi()
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        out_path = Path(sys.argv[1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
