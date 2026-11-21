-- Artifact Server D1 schema (v1)

CREATE TABLE IF NOT EXISTS artifacts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artifact_type TEXT NOT NULL DEFAULT 'app',
  project TEXT NOT NULL DEFAULT 'default',
  visibility TEXT NOT NULL DEFAULT 'unlisted',
  share_token TEXT NOT NULL UNIQUE,
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES artifacts(slug) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  entry_path TEXT NOT NULL DEFAULT 'index.html',
  r2_prefix TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  change_note TEXT,
  created_by TEXT NOT NULL DEFAULT 'agent',
  created_at INTEGER NOT NULL,
  UNIQUE(slug, version)
);

CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL REFERENCES artifacts(slug) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  anchor TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project_updated
  ON artifacts(project, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_versions_slug_version
  ON artifact_versions(slug, version DESC);

CREATE INDEX IF NOT EXISTS idx_comments_slug_version
  ON artifact_comments(slug, version, created_at ASC);
