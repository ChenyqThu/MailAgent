# Skill Creator

Use this skill only in a manual chat when the owner asks to turn a successful workflow into a reusable Skill.

## Workflow

1. Understand the successful scenario and extract a narrow trigger description.
2. Create a draft, then write a non-empty `SKILL.md` and a strict manifest v2.
3. Add optional `references/`, `assets/`, or `scripts/` files only when they materially improve reliability.
4. For every file under `scripts/`, include `script_notes["scripts/<file>"]` with all seven fields: `why_script`, `reads`, `writes`, `network`, `secrets`, `entrypoint`, and `smoke`.
5. Add tests under `tests/`. The recommended single-file shape is `tests/prompts.md` with the headings `## Positive`, `## Negative`, and `## Expected Output`. Split files are also accepted when those markers remain present across the test text.
6. Run `skill_draft_validate`, fix every named error, then show the user the file tree, package-hash preview, script permissions, and test summary.
7. Call `skill_draft_publish` only after the user reviews the server-fetched approval card. Publishing defaults to enabled.

## Security Boundaries

- Drafts are isolated and are never executable. Publish the draft before any installed-skill execution is possible.
- Generating is not publishing. Publishing is not trusting. Trusting a version is not arbitrary Exec.
- Version trust is granted only by the owner in Settings → Skills and binds the current package hash and one declared entrypoint.
- Headless card-free execution still requires all of: the version is trusted, the Skill is mounted on the Agent, `grant_exec` is enabled, a structured per-Agent rule matches, and the package hash has not changed.
- The first run still requires one approval in a manual conversation before a headless rule can pass the existing first-run gate.
- `cwdScope`, read/write scopes, network mode, and secret names are recorded and displayed as a version-trust snapshot. In v1, runtime enforcement remains the existing PolicyRule shape gate and Exec safety floor; network mode has no independent sandbox enforcement surface.
- Never place secret values in draft files, validation output, events, or logs. Declare secret names only.
