---
title: "Automation Environment Install and Configuration"
description: "Get the mailagent CLI running in an automation environment: venv install, config precedence chain, the load_cli_config factory, MAILAGENT_CLI_API_KEY, and shell completion."
---

This page explains how to get the `mailagent` CLI running inside CI / cron / an agent runner, and how to understand its configuration load order — the latter directly determines "whether the value I set actually took effect."

## Installation

The CLI is installed via `pip`'s optional-dependencies. From the repository root (with a venv already present), run:

```bash
source venv/bin/activate
pip install -e ".[cli,dev]"
#   cli: typer / rich / pyyaml
#   dev: pytest + jsonschema>=4.18 + referencing (needed for schema validation runs)
```

Verify:

```bash
which mailagent        # should be <project>/venv/bin/mailagent
mailagent --version    # prints the version number
mailagent --help       # lists the 10 groups + global flags
```

:::caution[venv and PATH]
`pip install -e .` installs the `mailagent` console_script into `venv/bin/`. In an automation environment, **do not** rely on an interactive shell's PATH — either `source venv/bin/activate` or use the absolute path `/path/to/project/venv/bin/mailagent` directly. The latter is more robust in cron / systemd / GitHub Actions.
:::

:::caution[macOS Full Disk Access]
On the local machine, reading Mail.app's SQLite / executing AppleScript requires **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access) granted to the terminal / runner that runs the CLI. Reading only `data/sync_store.db` (already-synced data) does not require FDA; only commands that reach into Mail.app, such as `debug applescript-fetch` / `debug mail-structure`, require it.
:::

## Configuration Precedence Chain

At startup, the CLI loads configuration in the following order, with **later sources overriding earlier ones**:

| Precedence | Source | Notes |
|---|---|---|
| 1 (lowest) | `~/.config/mailagent/config.toml` | User-level, optional |
| 2 | `<project>/.env` | The pydantic Config shared with the service |
| 3 | `--config PATH` | Config file explicitly specified on the CLI |
| 4 | `MAILAGENT_*` environment variables | e.g. `MAILAGENT_CLI_API_KEY` |
| 5 (highest) | Command-line flags | `--db-path` / `--api-key`, etc. |

Example: `mailagent --config x.toml email get 53675` uses the `db_path` from `x.toml` rather than from `.env`.

```bash
# db-path override: temporarily point at another database (e.g. the app DB vs the main-repo PM2 DB)
mailagent --db-path ~/Library/Application\ Support/mailagent-frontend/data/sync_store.db \
  -o json email list --limit 5

# API key override (write command): env beats .env, flag beats env
MAILAGENT_CLI_API_KEY=xxx mailagent email flag 53675 --is-read
mailagent --api-key xxx email flag 53675 --is-read
```

## The `load_cli_config()` Factory — Why Configuration Is Guaranteed to Take Effect

The CLI does **not** use a module-level singleton `from src.config import config`. The reason: pydantic Settings loads `.env` immediately at import time, which makes the `--config` flag arrive too late to override it.

The CLI instead uses an explicit factory, `load_cli_config(config_path, env_overrides, flag_overrides)`: it **reconstructs a fresh Config instance** at every startup following the precedence chain above. This means:

- The `--config` / `--db-path` / `--api-key` you pass are **guaranteed** to take effect and won't be overridden by an import-time-locked `.env`.
- Server-side processes (`main.py` / pm2) still use the global singleton and don't interfere with the CLI path — the CLI is a short-lived process that loads cleanly each time.

:::note
This is an agent-friendly hard guarantee: **on the same machine, you can use `--config` / `--db-path` to point the CLI at any database / config without affecting the service**. A common use is to temporarily compare the packaged app's DB (`~/Library/Application Support/mailagent-frontend/data/sync_store.db`) against the main-repo PM2 DB (`data/sync_store.db`).
:::

## `MAILAGENT_CLI_API_KEY`

Write commands require authentication (read commands do not). In an automation environment, **inject it via an environment variable** — don't put it on the `--api-key` command line (which ends up in shell history / the process list):

```bash
# CI / cron: inject the env var from the secret store
export MAILAGENT_CLI_API_KEY="$(cat /run/secrets/mailagent_cli_key)"
mailagent email flag 53675 --is-read       # automatically uses the key from env
```

The server-side `.env` also sets a `MAILAGENT_CLI_API_KEY` of the same name, and the CLI compares them with `hmac.compare_digest`. For the full rules (list of read/write commands, `--dry-run` skipping auth, dev-bypass risk), see [Write-Command Authentication Contract](/agent/auth/).

:::danger[Must never enter .env]
`MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` is a development-mode escape hatch (it lets write commands through when the server has no token configured). It **must never enter `.env` or a CI environment** — once it's present, "forgetting to configure a token" becomes equivalent to "no protection at all." See [Authentication Contract](/agent/auth/).
:::

## Shell Completion

`mailagent` is built on typer and ships shell completion:

```bash
# install completion for the current shell (zsh / bash / fish)
mailagent --install-completion zsh
# or just print the completion script and decide how to source it yourself
mailagent --show-completion zsh
```

Completion covers resources, actions, and flags, and is enumerable — this is exactly the autocomplete dividend that design principle 2, "resource-action consistency," gives agents.

## Common Installation Issues

| Symptom | Cause | Fix |
|---|---|---|
| `mailagent: command not found` | venv not activated / PATH doesn't include venv/bin | `source venv/bin/activate` or use the absolute path |
| Write command reports `E_AUTH_FAILED` (exit 4) | `MAILAGENT_CLI_API_KEY` not passed | Inject the env var; see [Authentication](/agent/auth/) |
| Read command reports a SQLite permission error | Missing Full Disk Access | Grant FDA to the runner |
| `admin db-version` reports `E_SCHEMA_MISMATCH` (exit 5) | `db_version` does not match expected | Run the backend first to apply DB migrations; see [Exit Codes](/agent/exit-codes/) |

## Learn More

- [Global Flags and Output Formats](/en/agent/output-formats/)
- [Write-Command Authentication Contract](/agent/auth/)
- Install / auth spec: [`docs/reference/cli/cli-reference.md`](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/cli-reference.md) · [`agent-cli-rfc.md` §5.4 / §6.5](https://github.com/ChenyqThu/MailAgent/blob/main/docs/reference/cli/agent-cli-rfc.md)
