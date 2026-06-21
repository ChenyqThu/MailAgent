#!/usr/bin/env python3
"""导出 MailAgent skill pack —— 交给第三方 agent（OpenClaw / Claude Code / MCP client）。

产物（默认 ``dist/mailagent-skill-pack/``，gitignore 友好）：
    README.md · mcp-config.example.json · manifest.json · openapi.json · selftest.sh
    skills/<skill>/SKILL.md ×5

manifest / openapi 从 Python 权威 registry 生成（单一真源，不手抄）。SKILL.md 从
``src/skills/docs/`` 拷贝。

用法：
    python3 scripts/export_skill_pack.py [--out dist/mailagent-skill-pack]
"""

from __future__ import annotations

import argparse
import json
import shutil
import stat
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DOCS_DIR = _REPO_ROOT / "src" / "skills" / "docs"

_README = """# MailAgent Skill Pack

Standard delivery surface for external agents (OpenClaw / Claude Code / any MCP client)
to call MailAgent-native capabilities through a **scoped Bearer API key**.

## 1. Get a key

On the MailAgent host:

```bash
mailagent --api-key <CLI_TOKEN> api-key create --label my-agent --preset handoff
```

`--preset handoff` grants `email:read, attachment:read, report:read, report:run` (read +
report execution; **no** send / notion-agent). The plaintext key (`mak_...`) is shown **once**.

## 2a. MCP (recommended)

Add `mcp-config.example.json` to your MCP client (fill in base URL + key):

```json
{
  "mcpServers": {
    "mailagent": {
      "command": "mailagent-mcp",
      "env": {
        "MAILAGENT_API_BASE": "https://mail.chenge.ink",
        "MAILAGENT_AGENT_KEY": "mak_xxx"
      }
    }
  }
}
```

Tools appear as `mailagent_<skill>_<tool>` (e.g. `mailagent_search_email_search`).

## 2b. Raw REST

```
GET  {BASE}/api/skills            Authorization: Bearer mak_xxx     → manifest (scoped)
POST {BASE}/api/skills/invoke     Authorization: Bearer mak_xxx
     body: {"skill":"search","tool":"email_search","input":{"q":"redis"}}
```

## 3. Self-test

```bash
MAILAGENT_API_BASE=https://mail.chenge.ink MAILAGENT_AGENT_KEY=mak_xxx bash selftest.sh
```

## Files

- `manifest.json` — full Skill manifest v1 (tools, schemas, scopes, side-effects).
- `openapi.json` — OpenAPI for `/api/skills` + `/api/skills/invoke`.
- `skills/<skill>/SKILL.md` — per-skill human docs.
- `selftest.sh` — safe smoke (health + manifest + search + report list/get).

## Safety

- Keys are scoped; read-only by default. `report:run` / `email:write` / `notion_agent:invoke`
  are separate grants.
- Send/draft tools always require `confirm: true` and never ship in the default key.
"""

_MCP_CONFIG = {
    "mcpServers": {
        "mailagent": {
            "command": "mailagent-mcp",
            "env": {
                "MAILAGENT_API_BASE": "https://mail.chenge.ink",
                "MAILAGENT_AGENT_KEY": "mak_REPLACE_ME",
            },
        }
    }
}

_SELFTEST = """#!/usr/bin/env bash
# MailAgent skill pack self-test —— SAFE actions only (no send, no writes).
# Usage: MAILAGENT_API_BASE=... MAILAGENT_AGENT_KEY=mak_... bash selftest.sh
set -euo pipefail
BASE="${MAILAGENT_API_BASE:-http://127.0.0.1:8200}"
: "${MAILAGENT_AGENT_KEY:?set MAILAGENT_AGENT_KEY (mak_...)}"
AUTH=(-H "Authorization: Bearer ${MAILAGENT_AGENT_KEY}")
JSON=(-H "Content-Type: application/json")

echo "1) health"
curl -fsS "${BASE}/api/health" >/dev/null && echo "   ok"

echo "2) skills manifest"
curl -fsS "${AUTH[@]}" "${BASE}/api/skills" >/dev/null && echo "   ok"

echo "3) email_search"
curl -fsS "${AUTH[@]}" "${JSON[@]}" -X POST "${BASE}/api/skills/invoke" \\
  -d '{"skill":"search","tool":"email_search","input":{"q":"the","limit":1}}' >/dev/null \\
  && echo "   ok"

echo "4) report_list"
curl -fsS "${AUTH[@]}" "${JSON[@]}" -X POST "${BASE}/api/skills/invoke" \\
  -d '{"skill":"report","tool":"report_list","input":{"limit":1}}' >/dev/null \\
  && echo "   ok"

# 5) report_run is the full handoff acceptance — it calls the LLM and burns tokens, so it is
#    OPT-IN. Set MAILAGENT_SELFTEST_RUN_REPORT=1 and MAILAGENT_SELFTEST_AGENT=<id> to exercise
#    report.run + report.get end-to-end (still no send).
if [ "${MAILAGENT_SELFTEST_RUN_REPORT:-0}" = "1" ]; then
  AGENT="${MAILAGENT_SELFTEST_AGENT:?set MAILAGENT_SELFTEST_AGENT}"
  echo "5) report_run (${AGENT}) + report_get"
  RID=$(curl -fsS "${AUTH[@]}" "${JSON[@]}" -X POST "${BASE}/api/skills/invoke" \\
    -d "{\\"skill\\":\\"report\\",\\"tool\\":\\"report_run\\",\\"input\\":{\\"agent_id\\":\\"${AGENT}\\"}}" \\
    | sed -n 's/.*"report_id":"\\([^"]*\\)".*/\\1/p')
  echo "   report_id=${RID}"
  curl -fsS "${AUTH[@]}" "${JSON[@]}" -X POST "${BASE}/api/skills/invoke" \\
    -d "{\\"skill\\":\\"report\\",\\"tool\\":\\"report_get\\",\\"input\\":{\\"report_id\\":\\"${RID}\\"}}" >/dev/null \\
    && echo "   ok"
fi

echo "self-test PASSED"
"""


def _build_openapi(manifest: dict) -> dict:
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "MailAgent Skills API",
            "version": manifest.get("server_version", "3.0.0"),
            "description": "Scoped Bearer-key surface for external agents.",
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "mak_*"}
            }
        },
        "security": [{"bearerAuth": []}],
        "paths": {
            "/api/skills": {
                "get": {
                    "summary": "List the Skill manifest (scoped to the key)",
                    "responses": {"200": {"description": "manifest v1"}},
                }
            },
            "/api/skills/invoke": {
                "post": {
                    "summary": "Invoke a skill tool",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["skill", "tool"],
                                    "properties": {
                                        "skill": {"type": "string"},
                                        "tool": {"type": "string"},
                                        "input": {"type": "object"},
                                        "confirm": {"type": "boolean"},
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {"description": "success envelope"},
                        "403": {"description": "scope denied / confirmation required"},
                        "404": {"description": "unknown skill/tool"},
                    },
                }
            },
        },
    }


def export(out_dir: Path) -> None:
    from src.skills.registry import build_manifest

    manifest = build_manifest(None, generated_at="").model_dump()
    # generated_at 留空 → 可重复导出零 diff（时间戳由调用方填 / 不入 pack）。

    if out_dir.exists():
        shutil.rmtree(out_dir)
    (out_dir / "skills").mkdir(parents=True, exist_ok=True)

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "openapi.json").write_text(
        json.dumps(_build_openapi(manifest), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "README.md").write_text(_README, encoding="utf-8")
    (out_dir / "mcp-config.example.json").write_text(
        json.dumps(_MCP_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    selftest = out_dir / "selftest.sh"
    selftest.write_text(_SELFTEST, encoding="utf-8")
    selftest.chmod(selftest.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # SKILL.md ×N — 从 src/skills/docs 拷贝（缺失则报错，防 pack 不完整）。
    for skill in manifest["skills"]:
        name = skill["name"]
        src = _DOCS_DIR / name / "SKILL.md"
        if not src.exists():
            raise SystemExit(f"missing SKILL.md for skill {name!r}: {src}")
        dst = out_dir / "skills" / name / "SKILL.md"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)

    print(f"skill pack exported → {out_dir}")
    print(f"  skills: {[s['name'] for s in manifest['skills']]}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the MailAgent skill pack.")
    parser.add_argument(
        "--out", default=str(_REPO_ROOT / "dist" / "mailagent-skill-pack"),
        help="output directory (default: dist/mailagent-skill-pack)",
    )
    args = parser.parse_args()
    export(Path(args.out))


if __name__ == "__main__":
    main()
