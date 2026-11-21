-- Artifact Server D1 schema (v3): per-user revocable MCP bearer tokens

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  owner_label TEXT NOT NULL,
  label TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role_scope TEXT NOT NULL DEFAULT 'member',
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user
  ON mcp_tokens(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash
  ON mcp_tokens(token_hash);
