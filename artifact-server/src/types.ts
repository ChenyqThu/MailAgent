export const ARTIFACT_TYPES = ['dashboard', 'slides', 'report', 'diagram', 'app'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export const ARTIFACT_VISIBILITIES = ['private', 'unlisted', 'public'] as const
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number]

export const COMMENT_STATUSES = ['open', 'resolved'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

export const USER_ROLES = ['admin', 'member'] as const
export type UserRole = (typeof USER_ROLES)[number]

export interface UserRow {
  id: string
  email: string
  display_name: string
  role: UserRole
  password_hash: string
  pwd_version: number
  disabled: number
  created_at: number
  updated_at: number
}

export interface SafeUser {
  id: string
  email: string
  display_name: string
  role: UserRole
  disabled: boolean
  created_at: number
  updated_at: number
}

export interface AuthIdentity {
  actor: string
  user: SafeUser | null
  role: UserRole | 'agent' | 'bootstrap_admin'
  isAdmin: boolean
  isBootstrap: boolean
}

export interface Env {
  DB: D1Database
  BUCKET?: R2Bucket
  ARTIFACTS_KV?: KVNamespace
  PUBLIC_BASE_URL?: string
  SERVER_NAME?: string
  ALLOW_CF_ACCESS?: string
  AGENT_API_TOKEN?: string
  ADMIN_PASSWORD?: string
  SESSION_SECRET?: string
}

export class ArtifactServerError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface ArtifactRow {
  slug: string
  title: string
  artifact_type: ArtifactType
  project: string
  visibility: ArtifactVisibility
  share_token: string
  latest_version: number
  created_at: number
  updated_at: number
}

export interface ArtifactListItem extends ArtifactRow {
  open_comment_count: number
  total_comment_count: number
}

export interface VersionRow {
  id: number
  slug: string
  version: number
  entry_path: string
  r2_prefix: string
  file_count: number
  size_bytes: number
  sha256: string
  change_note: string | null
  created_by: string
  created_at: number
}

export interface CommentRow {
  id: string
  slug: string
  version: number
  author: string
  body: string
  anchor: string | null
  status: CommentStatus
  parent_id: string | null
  created_at: number
  updated_at: number
}

export interface ArtifactFileInput {
  path: string
  content: string
  content_type?: string
  encoding?: 'utf8' | 'base64'
}

export interface PublishArtifactInput {
  slug: string
  title?: string
  artifact_type?: ArtifactType
  project?: string
  visibility?: ArtifactVisibility
  html?: string
  files?: ArtifactFileInput[]
  entry_path?: string
  change_note?: string
  created_by?: string
}

export interface ArtifactLinks {
  review_url: string
  share_url: string
  raw_url: string
  artifact_url: string
}

export interface PublishArtifactResult {
  ok: true
  slug: string
  title: string
  artifact_type: ArtifactType
  project: string
  visibility: ArtifactVisibility
  version: number
  entry_path: string
  file_count: number
  size_bytes: number
  sha256: string
  links: ArtifactLinks
  review_url: string
  share_url: string
  raw_url: string
}
