// ---- 多文件夹同步 (P3) — discover + whitelist (davmail-only) ----------------
//
// serve-api `GET /api/folder/discover` / `GET|PUT /api/folder/whitelist` 的 wire
// 形状 (src/api/routers/folder.py + src/mail/backend/imap_client.FolderInfo)。
// 白名单存 IMAP 原始名 (modified-UTF7 ASCII, 可能含逗号如 `&W,mL3VOGU,KLsF9V-`);
// display_name 是解码后中文, 仅展示。勾选用 imap_name 作 key, 展示用 display_name。
// 远程 (HttpApi 直连) + 本地 (Electron→daemon→serve-api 转发) 同一 wire。

/** 单个 Exchange 文件夹 (LIST → FolderInfo)。flat 列表带 `is_synced`; tree 节点
 *  额外带 `children` 但不带 `is_synced` (后端 build_folder_tree 用 bare to_dict)。 */
export interface FolderInfo {
  imap_name: string
  display_name: string
  delimiter: string
  special_use: string | null
  is_system: boolean
  has_children: boolean
  parent: string | null
  message_count: number | null
  /** 仅 discover 的 flat 列表带此字段 (= imap_name ∈ 当前白名单)。 */
  is_synced?: boolean
}

/** 嵌套树节点 = FolderInfo + children。 */
export interface FolderTreeNode extends FolderInfo {
  children: FolderTreeNode[]
}

export interface FolderDiscoverResult {
  folders: FolderInfo[]
  tree: FolderTreeNode[]
  /** 当前已同步的 imap_name 列表 (= SYNC_FOLDERS 白名单)。🔴 **保序** —— 数组序
   *  即用户自定义显示顺序 (设置页顺序列表 seed / 侧边栏同层级排序的权威)，
   *  后端不做字母排序，前端也不得 Set 化后再消费顺序。 */
  whitelist: string[]
}

export interface FolderWhitelistResult {
  /** 🔴 **保序** —— 同 `FolderDiscoverResult.whitelist`: 数组序即用户自定义显示
   *  顺序。侧边栏 `buildSidebarFolderTree` 直接吃这个数组的下标做同层级排序,
   *  Set 化 / 重排都会静默丢掉用户的顺序。 */
  folders: string[]
}

export interface FolderSetWhitelistResult {
  /** 后端去重**保序**后的实际落盘顺序 (数组序 = 自定义显示顺序)。 */
  folders: string[]
  /** 🔴 按**集合**是否变化判定 (不是「保存过就 true」): 增/删文件夹 → true (watcher
   *  消费 SYNC_FOLDERS 是集合语义, 需重启 mail-sync); **仅调整顺序 → false**
   *  (只影响显示, 不必重启)。 */
  restart_required: boolean
}

// 多文件夹同步 (P4) — 文件夹管理 (新建/重命名/删除)。serve-api
// `POST|PATCH|DELETE /api/folder/manage` 的 wire (davmail-only, 回写真实 Exchange
// + 本地副本)。失败时后端把本地树回滚到服务器真实状态, 前端 refetch discover。
export interface FolderManageResult {
  /** 操作影响后的 imap_name (新建 = 新文件夹名; 重命名 = 新名; 删除 = 已删名)。 */
  imap_name: string
  /** 删除/重命名牵动了白名单时为 true → 前端标记需重启同步服务。 */
  restart_required?: boolean
}

// 多文件夹同步 (P5) — 本地副本清理。serve-api `POST /api/folder/cleanup`
// body `{imap_name}` → 仅删本地已同步邮件 (email_metadata 级联 body/附件/FTS +
// 从白名单移除)。**不碰 Exchange 文件夹/邮件**, 非 davmail 也可 (纯本地操作)。
export interface FolderCleanupResult {
  /** 被清理的文件夹 imap_name。 */
  imap_name: string
  /** 实际删除的本地行数。 */
  affected_local_rows: number
  /** true → 白名单已变动, 需重启同步服务。 */
  restart_required: boolean
}

export interface FolderApi {
  // 多文件夹同步 (P3, davmail-only). discover 走 serve-api (IMAP LIST); 本地经
  // daemon 转发, 远程 HttpApi 直连。非 davmail 后端 serve-api 返回 400
  // E_INVALID_ARG → 抛带 code 的 Error (前端据此 gate)。
  discover(opts?: { counts?: boolean }): Promise<FolderDiscoverResult>
  getWhitelist(): Promise<FolderWhitelistResult>
  /** 覆盖式保存白名单 (imap 原始名)。**入参数组序 = 权威显示顺序**; 返回去重
   *  保序后的列表 + restart_required (集合变化才 true)。 */
  setWhitelist(imapNames: string[]): Promise<FolderSetWhitelistResult>
  // 文件夹管理 (P4, davmail-only). serve-api POST/PATCH/DELETE /api/folder/manage,
  // 回写真实 Exchange (新建 IMAP CREATE / 重命名 RENAME / 删除 DELETE + 清本地副本)。
  // 失败抛带 `code` 的 Error (本地树由后端回滚到服务器真实状态, 前端 refetch discover)。
  /** 在 parentImapName 下新建子文件夹 name (顶层 = parentImapName 传 null)。 */
  createFolder(parentImapName: string | null, name: string): Promise<FolderManageResult>
  /** 重命名 imapName → newName (叶子名, 后端拼父路径)。 */
  renameFolder(imapName: string, newName: string): Promise<FolderManageResult>
  /** 删除 imapName (含 Exchange 文件夹 + 本地已同步副本, 不可撤销)。 */
  deleteFolder(imapName: string): Promise<FolderManageResult>
  // 本地副本清理 (P5) — 仅删本地已同步邮件, 不碰 Exchange (非 davmail 也可)。
  /** 清理 imapName 对应的本地已同步邮件副本 + 从白名单移除; **不操作 Exchange**。 */
  cleanup(imapName: string): Promise<FolderCleanupResult>
}
