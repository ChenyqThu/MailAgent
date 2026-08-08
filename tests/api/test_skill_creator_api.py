from __future__ import annotations

import json
import os

from src.agent_config.projections import advertised_skill_names, resolved_skills
from src.skills.pack_fetch import skill_dir
from src.skills.registry import build_manifest


def _data(response):
    payload = response.json()
    assert payload["status"] == "success", payload
    return payload["data"]


def _write_valid_draft(client, name: str) -> str:
    draft = _data(client.post("/api/agent/skills/drafts", json={"name": name}))
    draft_id = draft["id"]
    assert client.put(
        f"/api/agent/skills/drafts/{draft_id}/file",
        json={"path": "SKILL.md", "content": f"# {name}\n"},
    ).status_code == 200
    assert client.put(
        f"/api/agent/skills/drafts/{draft_id}/file",
        json={
            "path": "tests/prompts.md",
            "content": "## Positive\nyes\n## Negative\nno\n## Expected Output\nsummary\n",
        },
    ).status_code == 200
    validation = _data(client.post(f"/api/agent/skills/drafts/{draft_id}/validate"))
    assert validation["validation"]["valid"] is True
    return draft_id


def test_skill_creator_flag_off_hides_endpoints_and_builtin(
    client, fresh_agent_cfg, tmp_path, monkeypatch
):
    env_file = tmp_path / ".env"
    env_file.write_text("MAILAGENT_SKILL_CREATOR=false\n")
    monkeypatch.setattr("src.api.deps.get_env_file_path", lambda: str(env_file))

    assert client.get("/api/agent/skills/drafts").status_code == 404
    assert client.get("/api/agent/skills/anything/trust").status_code == 404
    manifest_skills = build_manifest(None).skills
    assert "skill_creator" not in {
        item["name"] for item in resolved_skills(manifest_skills, fresh_agent_cfg)
    }
    assert "skill_creator" not in advertised_skill_names(manifest_skills, fresh_agent_cfg)


def test_trust_endpoint_uses_server_hash_and_reports_stale_revoked(
    client, fresh_agent_cfg, fresh_skills_dir
):
    name = "api-created"
    draft_id = _write_valid_draft(client, name)
    published = _data(
        client.post(f"/api/agent/skills/drafts/{draft_id}/publish", json={"enabled": True})
    )
    entrypoint = os.path.realpath(os.path.join(skill_dir(name), "SKILL.md"))

    invalid = client.post(
        f"/api/agent/skills/{name}/trust",
        json={"entrypoint": os.path.join(skill_dir(name), "not-listed.py"), "policy": {}},
    )
    assert invalid.status_code == 400

    trusted = _data(
        client.post(
            f"/api/agent/skills/{name}/trust",
            json={
                "entrypoint": entrypoint,
                "packageHash": "0" * 64,
                "policy": {
                    "argvPattern": [entrypoint],
                    "cwdScope": [skill_dir(name)],
                    "readScopes": [],
                    "writeScopes": [],
                    "networkMode": "off",
                    "secretNames": [],
                },
            },
        )
    )
    assert trusted["packageHash"] == published["package_hash"]
    assert trusted["state"] == "trusted"

    row = fresh_agent_cfg.get_skill(name)
    assert row is not None
    fresh_agent_cfg.install_skill(
        name,
        source_type=row.source_type,
        manifest=row.manifest,
        package_hash="f" * 64,
        files_json=row.files_json,
        enabled=row.enabled,
    )
    stale = _data(client.get(f"/api/agent/skills/{name}/trust"))["trusts"]
    assert stale[0]["state"] == "stale"

    revoked = _data(client.delete(f"/api/agent/skills/{name}/trust/{trusted['id']}"))
    assert revoked == {"id": trusted["id"], "revoked": True}
    after_revoke = _data(client.get(f"/api/agent/skills/{name}/trust"))["trusts"]
    assert after_revoke[0]["state"] == "revoked"

    event_text = json.dumps(fresh_agent_cfg.list_events(name), ensure_ascii=False)
    assert "## Positive" not in event_text
