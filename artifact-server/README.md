# Canvas Artifact Server (Cloudflare Workers + D1 + KV / R2)

Self-hosted interactive Artifact hosting, versioning, share links, and MCP Streamable HTTP server for MailAgent (`https://canvas.chenge.ink`).

## Architecture

- **Compute**: Cloudflare Worker (`src/index.ts`, `src/mcp.ts`, `src/ui.ts`)
- **Metadata**: Cloudflare D1 (`artifacts`, `artifact_versions`, `artifact_comments`)
- **Blob Storage**: Dual adapter (`src/blobs.ts`):
  - **Cloudflare Workers KV (`ARTIFACTS_KV`)** — default deployment (no R2 dashboard activation required; up to 25 MiB per file)
  - **Cloudflare R2 (`BUCKET`)** — optional drop-in upgrade if bound in `wrangler.jsonc` (recommended later for large video/bundle files >25 MiB)
- **Isolation**: `/raw/:slug/vN/*` and `/raw/t/:shareToken/:slug/vN/*` enforce `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals` and `Access-Control-Allow-Origin: *` (supporting both single-file HTML5 and multi-file Vite ESM bundles).
- **Auth**:
  - MCP `/mcp`: `Authorization: Bearer <AGENT_API_TOKEN>`
  - Browser UI `/`, `/a/:slug`, `/api/artifacts/*`: password session cookie (`ADMIN_PASSWORD`, optionally Cloudflare Access when `ALLOW_CF_ACCESS="true"`), plus capability share tokens (`/s/:shareToken` or `/raw/t/:shareToken/...`) for `unlisted` links.

## Cloudflare Deployment (`canvas.chenge.ink`, D1 + KV Default)

```bash
cd artifact-server

# 1. Authenticate Wrangler
npx wrangler login

# 2. Create D1 & KV and place IDs into wrangler.jsonc
npx wrangler d1 create canvas-artifacts-db
npx wrangler kv namespace create ARTIFACTS_KV

# 3. Apply D1 schema migration
npx wrangler d1 migrations apply canvas-artifacts-db --remote

# 4. Write secrets (never commit .dev.vars or pass secrets as CLI args)
npx wrangler secret put AGENT_API_TOKEN
npx wrangler secret put ADMIN_PASSWORD

# 5. Deploy Worker + Custom Domain route (canvas.chenge.ink)
pnpm deploy
```

> **Optional R2 Upgrade**: Once R2 is enabled in Cloudflare Dashboard, create `canvas-artifacts-r2`, bind `"r2_buckets": [{ "binding": "BUCKET", "bucket_name": "canvas-artifacts-r2" }]` in `wrangler.jsonc`, and redeploy — `src/blobs.ts` automatically prefers `BUCKET` when bound.

## Connect in MailAgent

1. Open **Settings → Connectors** in MailAgent Desktop.
2. Select **Artifact Server** under External Connections.
3. Keep URL `https://canvas.chenge.ink/mcp` and paste `AGENT_API_TOKEN` (stored locally in `artifact-server/.dev.vars`).
4. Click **Connect & Sync**.

## Local Verification

```bash
pnpm --dir artifact-server exec tsc --noEmit
pnpm --dir artifact-server exec vitest run
pnpm --dir artifact-server exec wrangler deploy --dry-run
```
