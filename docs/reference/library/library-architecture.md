# 资料库（Library）架构

> 常青参考。描述资料库模块「现在是怎么回事」：存储、路径 jail、serve-api 面、写入语义、
> agent 工具面与权限、HTML 预览、跨模块引用、一致性闸、运维与已知缺口。
>
> 设计 SSoT 是 `.trellis/tasks/09-02-library-knowledge-base/design.md`。
> **本文与代码不一致时以代码为准**；本文与设计不一致处，是代码落地时改过的地方。

## 0 一页定义

| 面 | 定义 |
|---|---|
| 是什么 | 一棵受管的本机文件夹树（库根 `<data>/library/`）+ 一张索引库（`<data>/library.db`）+ 一级域「资料库」+ 一组 agent 文件工具 |
| 顶层文件夹（磁盘英文 slug，UI 走 i18n） | `mail-attachments/`（**虚拟投影**，不在磁盘上）· `chat-attachments/` · `agent-docs/` · `my-docs/` · `.trash/` · 用户挂载的外部根 `@<label>` |
| 谁能写什么 | 人：除投影区与 `.trash` 外全可写；主 agent：`agent-docs/` + `my-docs/` + `mode='rw'` 的挂载根；custom agent：只有 `agent-docs/` + `rw` 挂载根；无人值守（headless）只有 `agent-docs/` 免卡 |
| 文件身份 | `library_file.id`（稳定，**永不重算**）+ 虚拟路径 `path`（显示与寻址）。agent 之间传 id，写新文件传 path |
| 跨模块引用键 | `library:{file_id}`（常量 `RESOURCE_KEY_PREFIX`），事项 / 通知 / @ 提及 / compose / 群聊各自只持这个键 |
| 本期不做 | LLM wiki 自动编纂 · Notion 同步 · Office 应用内编辑 · 树内拖拽移动 · 文件开成顶栏标签 · Windows · 远程 web 写面 |

**零新增功能开关**。整个模块没有一个 `MAILAGENT_*` 变量：读写面、工具、能力卡、无人值守通道都直接
生效，回滚靠 revert。唯一「像开关」的是语义检索的模型权重 —— **下载了就是开，没下载就是纯 FTS**
（`src/library/constants.py` 的语义检索一节写明了这条：模型在不在就是开关）。因此
CLAUDE.md 的「关键开关现状」表里没有本模块的行，这是有意的。

## 1 存储与索引

### 1.1 目录与库

```
<data>/library/                  ← 库根（与 attachments / compose_staging 同级，随 userData）
├── chat-attachments/{YYYY-MM}/  ← 对话附件（发送即入库）
├── agent-docs/                  ← agent 可读写
├── my-docs/                     ← 用户自己的；custom agent 不可写
└── .trash/{file_id}/{filename}  ← 软删，30 天 sweep
<data>/library.db                ← 索引库
<data>/library/embed_cache/      ← 语义模型权重（按需下载；不进树、不被扫描）
```

路径解析单源在 `src/library/db.py`：`library_db_for()` / `library_root_for()` 从 `sync_store.db`
路径推出同目录的 `library.db` 与 `library/`；`resolve_library_db_path()` / `resolve_library_root()`
是「显式 sync_store 同目录 → config 单例同目录 → `<DATA_ROOT>/data/`」三级回退。

`mail-attachments/` **不在磁盘上**：它是 `email_attachment`（`is_inline = 0`）的只读投影，按
`{YYYY-MM}` 分组。投影行没有 `library_file.id`，寻址靠 `attachment_id`。「另存到资料库」是真复制
（`source='mail'`、`source_ref=attachment_id`），从此与邮件解耦。

### 1.2 `library.db`：独立版本梯，**不进 `DB_VERSION`**

`library.db` 有自己的 `library_meta.schema_version`（`LIBRARY_SCHEMA_VERSION`，`src/library/db.py`），
开库时 `CREATE TABLE IF NOT EXISTS` 幂等对齐，**不进全局 `DB_VERSION`**，因此改表不需要 bump
`DB_VERSION`、也不需要同步前端的 `EXPECTED_DB_VERSION`。反着做的代价写在 db.py 头注里：进
`sync_store.db` 等于每次改表都赌一次启动迁移门控。

表（全部在 `_DDL` 里，CHECK 词表一律从 `src/library/constants.py` 拼，零手抄）：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `library_meta` | 版本梯 | `schema_version` 一行 |
| `library_mount` | 挂载根 | `label` / `abs_path` 各自 UNIQUE；`mode ∈ ro,rw`；`status ∈ ok,unavailable,unmounted` |
| `library_file` | 文件行（含挂载根内的文件） | `mount_id` 默认 0 = 库根；唯一键 `(mount_id, rel_key)`；`rel_key = casefold(NFC(rel_path))`；`status ∈ present,missing,trashed` |
| `library_history` | 全快照历史 | 每次经工具 / UI 的文本写入记一条；`changed_by ∈ 'user' \| agent_id \| 'external'` |
| `library_text` | 解析后的正文（markdown） | `source_hash` = 生成时的 `content_hash`，不等于当前值即过期重抽 |
| `library_chunk` | 语义向量 | 主键 `(file_id, model, idx)`，`model` 进主键 ⇒ 换模型旧向量被 `WHERE model=?` 自然排除，不需要迁移 |
| `library_fts` | FTS5 外部内容表（`porter unicode61`） | `content='library_text'`、`content_rowid='file_id'` |
| `library_fts_trigram` | FTS5 外部内容表（`trigram`） | 同上；中文子串检索走它 |

两张 FTS 由三个 trigger（insert / update / delete）维护。外部内容表删旧行必须走 `'delete'` 特殊
命令并给出旧值，否则旧 token 残留 —— trigger 里就是这么写的，改 `library_text` 的写法要一起看。

### 1.3 SSoT：文件系统是正文，索引是投影 + id 分配器

- **文件系统是正文的 SSoT**；`library.db` 只是元数据投影 **加上一个 id 分配器**。
- 元数据（size / mtime / hash / text_status）可以随时重扫重算；**`(id ↔ rel_path)` 映射一旦分配
  永不重算**。
- 文件从磁盘上消失 → 行标 `status='missing'`，**不删行**。这是「跨模块引用永不悬空」的地基：
  事项、会话消息、通知里记的 `library:{id}` 指向的行始终在，UI 灰显而不是碎链接。
- **不做 watcher**（全仓没有文件监听基础设施）。对账按需触发：打开文件夹按目录 mtime 增量对账、
  打开文件按 `stat` + 必要时重算 hash；发现外部改动补记一条 `changed_by='external'` 的历史；
  设置页「重扫资料库」（`POST /library/rescan`）做全量对账。

### 1.4 备份与 exec 地板

- `library.db` 进 `run_startup_db_safety` 的**备份**清单，但**不进** `quick_check` 的 fail-fast：
  `db_safety` 的 `critical` 参数为此而加（`critical=False` 时 quick_check 失败不写 marker、不 raise）。
  索引坏了只需重扫，不该让 App 起不来。
- exec 地板（`src/api/exec_floor.py`）：`library.db`（含 wal/shm）进 deny；`data/library/**` 本身
  放行，但库目录下的密钥类后缀（`MOUNT_DENY_SUFFIXES`）一律 deny。exec 地板管 agent 的 `file_*`
  原语，资料库自己的 jail（§2）管 library 工具面，两层独立。

## 2 多根与路径 jail

### 2.1 虚拟路径：renderer 与模型永不拿到绝对路径

agent 与 UI 看到的路径恒为 **`<根 slug>/<相对路径>`**：内置根用固定 slug（`agent-docs/notes/a.md`），
挂载根用 `@<label>`（`@Docs/spec/a.md`）。

**绝对路径的唯一出口是 `GET /library/mounts` 家族**（设置页要显示挂载的是哪个目录）。除此之外任何
响应体都不出现绝对路径；`inline` 的磁盘路径只在进程内流转；两个 Electron IPC 收的是 id 或虚拟
路径，由主进程自己解析到磁盘。

`src/library/paths.py` 的 `split_virtual()` / `join_virtual()` 是虚拟路径与 `(挂载, 相对路径)` 之间
的唯一换算点。`rel_path` 是**根内**相对路径，跨根会重名，**不能**当返回体的 `path` 用。

### 2.2 jail 的几道校验

每条通往磁盘的路径都过 `paths.resolve()`，按顺序：

1. 只收相对路径：拒绝对路径、拒 `..` 段、拒 NUL 与控制字符，`.` 段折叠；
2. NFC 归一后 casefold 得 `rel_key`（APFS 大小写不敏感 + 归一不敏感，索引按 key 查重）；
3. 写目标的末段过 `AttachmentStore.sanitize_filename`（与附件落盘 / compose 暂存同一套规则）；
4. 挂载根（`mount_id != 0`）内额外拒 `MOUNT_DENY_SUFFIXES`（`.env` / `.pem` / `.key` / `.db`，
   含 `.env.*` 形态）与 `MOUNT_DENY_DIRS`（`.git`）；
5. `realpath` 必须与拼出来的路径**逐字相等** —— 路径里任何 symlink 成分（指向根外**或根内**）
   一律拒。根目录本身在构造 `MountRoot` 时已 realpath 化，`/tmp`→`/private/tmp` 这类系统 symlink
   不会误伤；
6. 真正 open 时 `O_NOFOLLOW` + `fstat` 复核是常规文件，堵 resolve→open 之间被换成 symlink 的
   TOCTOU 窗；`open_write` 的 inode 复核在 `ftruncate` 之前。

违规抛 `PathError`，`code` 直接是 API 错误码：一般校验失败 `E_INVALID_ARG`，**地板类拒收
（越界 / symlink / 拒收后缀）是 `E_AUTH_FAILED`**。

### 2.3 挂载根（外部目录）

`library_mount` 一行一座 jail。`mode` 是**用户侧总闸**（`ro` / `rw`）；agent 侧不另设第二套档位，
沿用能力卡（§5.3）。`status='unavailable'` = 卷拔了 / 目录移走（树里灰显，行不删）；
`unmounted` = 用户卸载（行不删、磁盘不动，重新挂同一路径时按 `(mount_id, rel_key)` 复用旧 id）。

挂载区的删除走系统废纸篓（Electron `shell.trashItem`），**不进库内 `.trash`** —— 服务端对挂载区
文件直接拒 `trash`。菜单文案也叫「移到系统废纸篓」，把差异前移到菜单层。

扫描时跳过 `SCAN_SKIP_DIRS`（`.git` / `node_modules`）与挂载根内所有 `.` 开头目录；目录数上限
`TREE_MAX_DIRS`、文件数警戒线 `MOUNT_MAX_FILES`；iCloud 未下载的 `.icloud` 占位标
`kind='placeholder'` 不抽取。

## 3 serve-api 端点

`src/api/routers/library.py`，前缀 `/api/library`，**整个 router 的鉴权是 `verify_local_token`**
（与 exec 家族同姿态：唯一调用方是同机 renderer 与内嵌 gateway，不接受 CF JWT）。业务全在
`src/library/service.py`（唯一写面），router 只做入参形状与 envelope。

| 端点 | 说明 |
|---|---|
| `GET /tree` | 扁平文件夹节点 + 挂载根摘要（**无 abs_path**）+ 文件总数 |
| `GET /folder?path=&offset=&limit=&q=&sort=&dir=` | 文件夹条目；**服务端排序后分页**（`limit ≤ FOLDER_PAGE_SIZE`=200）。投影文件夹的 `q` 同时匹配文件名与来源列 |
| `GET /files?ids=` | 批量按 id 现查（存在性 / 显示名），一次最多 200 个 |
| `GET /search?q=&limit=&mode=` | `mode ∈ fts,hybrid`；FTS 双表 + 语义腿 RRF 融合 |
| `GET /embed/status` · `POST /embed/download` · `POST /embed/rebuild` | 语义索引面板 / 下载权重 / 重建索引 |
| `GET /file/{id}?max_bytes=` | 元数据 + 文本类正文 + `content_hash`（打开即对账） |
| `GET /file/{id}/text?max_bytes=` | 解析版（`library_text`）；pending 时就地触发抽取 |
| `GET /file/{id}/inline` | 从盘流式返回原件（Range 206）；`text/html` 只标 `inline` |
| `GET /file/{id}/history` | 最新在前，不带快照正文（给 `snapshot_bytes`） |
| `GET /attachment/{aid}` · `/attachment/{aid}/text` · `/attachment/{aid}/inline` | 投影行的三条**只读兄弟端点**，返回体与 file 系列同形，`id` 为 null |
| `POST /files` | 新建 / 上传（JSON 文本或二进制；二进制须带 `?filename=`） |
| `PUT /file/{id}` | CAS 覆写 |
| `POST /file/{id}/append` · `/move` · `/restore` · `/rollback` · `DELETE /file/{id}` | 追加 / 移动 / 从废纸篓恢复 / 回滚 / 软删（`?purge` 形态见 §4） |
| `POST /keep-attachment` | 邮件附件「另存到资料库」 |
| `POST /rescan` | 全量对账，回执 `{scanned, added, updated, missing, elapsed_ms}` |
| `GET /mounts` · `POST /mounts` · `PATCH /mounts/{id}` · `DELETE /mounts/{id}` | 挂载根管理（**唯一会出现绝对路径的家族**） |

### 3.1 错误码

领域错误是 `LibraryError`，router 映射成 `APIError`，HTTP 状态由 `src/api/app.py::ERROR_CODE_TO_HTTP`
决定：

| code | HTTP | 典型场景 |
|---|---|---|
| `E_INVALID_ARG` | 400 | 路径形状不合法、内容超上限、未知顶层文件夹、`ids` 不是整数 |
| `E_AUTH_FAILED` | **403（不是 401）** | 投影区拒写、`.trash` 拒写、`ro` 挂载根拒写、身份不允许写该顶层、扩展名不在 agent 白名单、jail 越界 / symlink / 拒收后缀 |
| `E_NOT_FOUND` | 404 | 文件行不存在、磁盘上打不开 |
| `E_INVALID_STATE` | 409 | 状态不允许（如已下载还点下载、已有作业在跑、没模型就重建索引） |
| `E_VERSION_CONFLICT` | 409 | CAS 冲突；新建时路径已存在 |

🔴 **无 token 是 403，不是 401**：`verify_local_token` 在 header 不匹配或未配 token 时直接 403，
`E_AUTH_FAILED` 在 `ERROR_CODE_TO_HTTP` 里也映到 403。按 401 写客户端重试逻辑会全线 miss。

`E_VERSION_CONFLICT` 的响应体 `data` 带**当前** `content_hash` 与 `content`（`_conflict_response`），
agent 工具腿据此合并后重试恰一次。

## 4 写入语义：CAS / 历史 / 回滚 / `.trash`

- **CAS**：写带 `expected_hash`，不符 → `E_VERSION_CONFLICT` + 当前 hash 与 content。
  `expected_hash=None` 是**新建**语义，路径已存在同样是冲突。hash 相同 = no-op，不记历史。
- **历史**：每次经工具 / UI 的写入记一条 `library_history` 全快照 + `change_note`。
  **只对文本类**（`TEXT_KINDS = {markdown, html, text}`）；二进制只进索引不进历史。
  保留 `HISTORY_MAX_PER_FILE`（50）条 / 全库快照总量 `HISTORY_MAX_TOTAL_BYTES`（20 MB），超出裁最旧。
- **回滚**：拿快照做一次**普通写**，走同一道校验 —— 没有绕过 CAS 与权限的特殊路径。
- **外部编辑**：打开时 mtime 变 → 重算 hash → 不符补记 `changed_by='external'`。
- **`.trash`**：软删 = 把文件搬到 `.trash/{file_id}/{filename}`；行的 `parent_path` **保留原文件夹**
  （restore 的目标就从它来，零新增列），`rel_path` 指向 `.trash` 内的实际位置。30 天 sweep
  （`TRASH_TTL_DAYS`）。废纸篓视图另有**单文件立即永久删除**（`purge_file`：真删文件 + 删行，
  带二次确认）—— 这是本模块唯一的硬删路径。
- **大小上限**：agent 写走 `TEXT_WRITE_MAX_BYTES`（1 MB），人上传走 `UPLOAD_MAX_BYTES`（15 MiB）。
  判据是 `Actor.is_agent`，不是端点。

**抽取**（`src/library/extract.py`）直接复用 `src/converter/attachment_text.py::extract_text`
（纯函数零 DB 依赖，anydoc lane 优先、失败恒回落原生 extractor、256 KB 上限）。资料库只补三件：
扩展名 → `kind` 的分派、`extract_text` 不认的纯文本与 HTML 的就地兜底、以及
`ensure_text`（`library_text.source_hash != 当前 content_hash` 即重抽，`placeholder` 不抽）。
**非文本类文件的「解析版」不落 sidecar 文件**，只活在 `library_text`，供预览 / FTS / `library_read` /
嵌入四处共用；用户要一份可编辑的 md 才走「另存解析版」（`source='derived'`）。

## 5 agent 工具面与权限

### 5.1 七个工具

| 工具 | tier | class | 出厂档 | 说明 |
|---|---|---|---|---|
| `library_list` | silent | `read` | — | 浏览文件夹；投影行 `file_id` 恒 null，用 `attachment_id` 寻址 |
| `library_read` | silent | `read` | — | 读一个文件；非文本类返回的是**服务端解析出的 markdown**，二进制永不进模型；上限 `READ_TOOL_MAX_CHARS`(12000) / `READ_TOOL_MAX_BYTES`(2 MB) |
| `library_search` | silent | `read` | — | 纯关键词，**无字段语法**（工具描述明说，避免模型塞 `from:` / `in:`） |
| `library_append` | edit | `domain_write` | `auto` | 只追加，冲突面为零 |
| `library_write` | edit | `domain_write` | `auto` | `mode: create_new`（带 `path`）/ `overwrite`（带 `file_id` + `expected_hash`） |
| `library_move` | edit | `domain_write` | `ask` | 跨模块引用走 `library:{id}` 不会断，会断的是别人记着的路径字符串与文档里的相对链接 |
| `library_delete` | edit | `domain_write` | `ask`（`danger_auto=True`） | 进 `.trash`，可恢复 |

工具名单的单源是两个常量：`GATEWAY_LIBRARY_READ_TOOL_NAMES` / `GATEWAY_LIBRARY_WRITE_TOOL_NAMES`
（Python `src/library/constants.py` 与 TS `frontend/src/shared/libraryConstants.ts` 各一份，有 parity 闸）。
出厂档在 `src/agent_config/tool_prefs.py`；catalog 行在 `tests/agent_eval/tool_catalog.json`；
中文名在 `frontend/src/shared/assistant/toolDisplayNames.ts`。

**三条家族纪律**（`frontend/src/ai-gateway/tools/library.ts` 头注）：

1. class `read` + `CORE_UNGATED`（无 skill 归属）+ 注册条件只有 `if (opts.approvalGuard)`，**没有 flag**；
2. 返回体恒带 `{file_id, path, name, size, mime, updated_at, source, content_hash}` 八件，三个读工具
   共用同一个投影函数；
3. **一切来自文件的正文 / 摘要恒过 `fenceUntrusted('LIBRARY_FILE', …)`** —— 库里放着邮件附件正文和
   挂载目录里的任意文件，是彻头彻尾的第二方内容。

### 5.2 写面的服务端强制

权限判定在**服务端**（`LibraryService._assert_writable`），不是前端：

- 投影区（`mail-attachments`）与 `.trash` 一律拒写；
- 未知顶层文件夹拒（`E_INVALID_ARG`），可写顶层由 `ROOT_WRITABLE_TOP` 派生（内置 slug 去掉投影根与废纸篓）；
- `actor.kind == 'custom_agent'` → 只有 `agent-docs/`；
- `actor.kind == 'main_agent'` → `agent-docs/` 或 `my-docs/`；
- 挂载根：`mode != 'rw'` 拒；
- 任何 agent 身份还要过扩展名白名单 `WRITE_EXT_ALLOWLIST`（`.md .markdown .html .txt .csv .json`），
  **人上传不受此限**。

### 5.3 能力卡

第 8 张能力卡「资料库」`library: off | read | write`，三档逐级 superset
（`frontend/src/shared/lib/customAgentCapabilities.ts`）。七个工具全部进
`HEADLESS_TOOL_OPTIONS`（`src/api/routers/agent_runs.py`）—— 🔴 **注册 ≠ 免卡**：写族进这张表只是
「headless 里工具还在」，免不免卡由 §5.4 决定。

### 5.4 无人值守写面：两条通道 + 不变的地板

headless 里 `domain_write` 本来恒弹卡 → `paused_handoff` 等人。资料库开了两条通道，**只这两条**：

**通道 B —— `policyEvaluate` 内建免卡规则**（`src/agent_config/policy.py`，本仓唯一一条抬高无人值守
写面的通道，命中时 `rule_id` 恒 None，不需要任何 `policy_rules` 行）：

- 工具 ∈ `LIBRARY_UNATTENDED_WRITE_TOOLS` = `{library_append, library_write}`；
- context mode ∈ `LIBRARY_UNATTENDED_MODES` = `{cron_headless, untrusted_trigger}`（`manual_chat` 逐字节不受影响）；
- `size_bytes ≤ LIBRARY_UNATTENDED_MAX_BYTES`（= `TEXT_WRITE_MAX_BYTES`，不手抄数值）；
- 🔴 **目标路径的判据是服务端事实，不是模型给的字符串**：`library_write` 的 overwrite 形态只带
  `file_id`（mode 分支在工具的 run 里、不在 schema 里），模型可以在同一次调用里再塞一个漂亮的 `path`。
  因此规则是「**入参里每一个可寻址的目标**都必须落在 `agent-docs/` 下」：`file_id` 经注入的回调反查
  当前虚拟路径，`path` 按字面判。反查不出 / 没接回调 / 回调抛异常 **一律 ask**。

**通道 C —— 三条 belt 按名放行 `library_append`**（`frontend/src/ai-gateway/agentRun.ts`）：事项跟进 /
行动项 / 通讯录治理三条 belt 此前只放行 `class === 'read'`，现在各加一条按名放行
`LIBRARY_RUN_APPEND_TOOL`（`frontend/src/ai-gateway/tools/policy.ts`，类型钉在
`GATEWAY_LIBRARY_WRITE_TOOL_NAMES` 上，名字离开那张表这行就编译不过）。
🔴 **判据是名字不是 class**：四个写工具同为 `domain_write`，按 class 放行会把 write / move / delete
一起带进来 —— append 是加性的，overwrite 会覆盖，move / delete 改的是别人记着的路径。

**不变的地板**（`tests/agent_config/test_policy_library.py` 正面钉死）：

- `my-docs/`、挂载根 `@label/…`、投影区、`.trash` 在 headless 恒弹卡；
- `library_move` / `library_delete` **永不**进任何免卡通道；
- `manual_chat` 不受影响，仍走 per-tool 档。

缓解措施是四件叠加：路径限 `agent-docs/` + 单次大小上限 + 每次写留全快照可回滚 + 读侧 `LIBRARY_FILE` 围栏。

## 6 HTML 预览：按浏览器语义渲染

owner 拍板「就当在浏览器里打开」：脚本、样式、canvas 一律照常跑，**不过 DOMPurify、不裁剪内容**。
同时必须满足「不得同源到 app」（库里放着邮件附件，是不可信来源）。

落地不是 srcdoc、不是 blob:、不是 loopback `/inline`，理由写在
`frontend/src/electron/main/library_preview_protocol.ts` 头注里：

- srcdoc / blob: / data: 按 CSP 规范**继承创建方（renderer）的策略**，而 renderer 的
  `script-src 'self'` + 一个 sha256 意味着内联脚本永不执行；
- loopback `/inline` 的请求会被 `chat_local_bridge` 在 webRequest 层注入本机 token，被预览的 HTML
  就能拿这个 token 打 serve-api。

落地路径 = **自定义协议 + 无同源沙箱**（仓里第一个自定义协议）：

1. 主进程在 `app.whenReady()` **之前** `registerLibraryPreviewScheme()`：
   `protocol.registerSchemesAsPrivileged([{ scheme: 'libpreview', privileges: { standard: true, secure: true, stream: true } }])`；
2. URL 形状 `libpreview://library/<根 slug>/<相对路径>`（`buildLibraryPreviewUrl`，逐段
   percent-encode），页面里的相对引用因此天然在同一个根内解析；handler 走与 `library:openPath`
   同一套 jail，越界 / 不存在 / 目录 / 非常规文件一律 **404 且不区分原因**；
3. renderer 侧 `<iframe src="libpreview://…" sandbox="allow-scripts allow-popups allow-forms allow-modals">`
   —— 🔴 **绝不加 `allow-same-origin`**（两者同给等于没有沙箱）。常量单源
   `HTML_PREVIEW_SANDBOX`（`frontend/src/shared/components/library/HtmlPreview.tsx`）；
4. renderer 的 CSP **只加一条** `frame-src 'self' libpreview:`（`frontend/src/electron/renderer/index.html`
   的 meta），不动 `script-src` / `default-src`；
5. 走真实协议响应 ⇒ 不继承 renderer 的 CSP，脚本与样式照常执行；鉴权在主进程内完成，**URL 里没有
   任何 token**。

**已知代价（有意接受）**：这样渲染的 HTML 可以加载外部资源、可以发出网络请求。一份恶意 HTML 附件在
预览时能回连。这是「像浏览器一样」的固有含义，**不是实现缺陷**。
日后要收紧的正确做法是给 `libpreview:` 的响应加 `Content-Security-Policy` 头 + 一个「允许外部内容」
开关（抄邮件正文远程图片那道既有的门），**而不是**退回无脚本沙箱。

🔴 不接受的写法：给 iframe 同时上 `allow-scripts` 与 `allow-same-origin`；把本机 token 放进 iframe
URL；给 renderer 的 CSP 加 `unsafe-inline` / `unsafe-eval`；用 DOMPurify 裁剪内容。

**两个 IPC**（`frontend/src/shared/libraryIpcContract.ts` 是跨进程零依赖叶子，main 与 renderer 都从
它 import，键名与 URL 只写一次）：`library:openPath` / `library:showInFolder`，收
`{kind:'file'|'attachment'|'folder'}` 三种寻址，主进程按 id 问 serve-api 要虚拟路径再落到磁盘；
`shell.openPath` 一律拒开 `LIBRARY_OPEN_BLOCKED_EXTENSIONS`（`.app .command .scpt .sh .pkg .dmg .jar .exe`），
黑名单在 open 与 reveal 两条通道同口径。

## 7 与其他模块的关联

**一条原语**：跨模块引用键恒为 `library:{file_id}`（前缀常量 `RESOURCE_KEY_PREFIX`）。各模块只持
这个键，不复制文件元数据；显示名 / 图标 / 存在性经 `GET /library/file/{id}` 或批量 `GET /library/files?ids=`
现查。文件标 `missing` 时引用处灰显，不悬空。

| 模块 | 挂点 |
|---|---|
| 事项 | `resource(provider='mailagent', kind='file', external_key='library:{id}')`；identity 层 `library_resource_key()` / `is_library_resource_key()` / `parse_library_resource_key()`（`src/matters/resource_identity.py`）。存在性与摘要经**注入的回调**（`src/library/resource_resolver.py::install_library_resolver`，serve-api 与主服务各装一次）—— matters 不直接 import 资料库存储层，依赖方向是 library → matters |
| 通知中心 | `NotificationLink` 加 `{type:'library', fileId}`（`frontend/src/shared/components/notifications/navigation.ts`）；后端信源 `src/notify/library_signals.py::notify_library_file_written`，dedupe key `library_file:{file_id}`（同一文件反复写聚合计次，不刷屏） |
| 对话 @ 提及 | `AgentComposer` 第四组「资料库」，mention item id 前缀 `library-{id}`（`agentMention.ts`）；envelope **只发标识**（`file_id` / `path` / `name` / `size_bytes`），告诉模型调 `library_read` 拿正文 —— 把正文当可信元数据注入等于绕过围栏 |
| 对话附件 | 发送即入库：非图片与图片都写到 `chat-attachments/{YYYY-MM}/`，`source='chat'`、`source_ref='{sessionId}:{uiMessageId}'`；消息挂一个 `data-library` part（不塞进封闭的 `FileUIPart`），气泡按它渲染「已存入资料库」chip。模型看到的内容不变（仍是抽取文本预置） |
| 跨 agent 调用 | `AgentCallReference.type` 加 `'library'` 档 + `custom_agent_call.library_file_ids`；类型下沉到零依赖叶子 `frontend/src/shared/agentCallReference.ts`（两处消费方都 import 它） |
| 邮件写信 compose | `ComposeAttachmentRef` union 第四形态 `{library_file_id}`；服务端唯一解析点 `src/services/mail_write.py::_resolve_attachment_refs`，入参归一在 `src/api/routers/email.py` |
| 邮件详情附件 | `POST /library/keep-attachment` + 附件行「另存到资料库」 |
| ⌘K / `/search` | 第五 lane「资料库」（`paletteLibrary.ts` + `LibraryHitRow`），与 agent `library_search` 同一个服务端内核 |
| 深链 | `/library?file={id}`（`frontend/src/shared/components/library/deeplink.ts`），落地 = 进域 + 展开所在文件夹 + 选中文件；文件 `missing`/`trashed` 时进域并 toast。🔴 **一切「进了资料库」的回执恒带一个「打开」动作指向它** —— 另存 / 另存解析版 / 附件行另存三处共用 `useLibraryOpenToast`，没有去处的回执视为缺陷 |

**检索**（`src/library/repository.py`，抄 `matter_fts` 的范式，**不接**邮件 DSL parser —— 那套的
`FilterPredicate.sql` 硬编 `email_metadata` 别名、字段词表全是邮件语义）：

- 含 CJK 走 trigram 表；无 CJK 走 porter 表 `bm25(library_fts, 1.0, 5.0)`（text 1.0 / filename 5.0，
  对齐邮件 subject 权重）；
- 1 字拦截 + warning（机器可读码 `cjk_too_short:<字>`），2 字走 LIKE、无 bm25、`rank` 容 null 按 mtime 排，
  ≥3 字整串 MATCH（**不拆** CJK / latin 段）；
- `mode='hybrid'` 时 FTS 与向量两条 lane 各取 `SEARCH_LANE_TOP_K`(50) 再 RRF（`SEARCH_RRF_K`=60，
  与 `email_repository::_RRF_K` 同值）。**没下载语义模型时 `hybrid` 自动退化成纯 FTS**，返回体形状
  不变：`search_mode` 说实际跑了哪条、`semantic.available` 说模型在不在、每条命中的 `lane` 恒
  `'fts'`。能力缺席**不进 `warnings`**（那里只放这次 query 自身的事）。
- 🔴 响应里 `lane`（`fts|vec|both`）与 `match`（`filename|text`）是**两个独立字段**，不是一回事。

## 8 一致性闸

本模块新建两道，另有若干既有闸被扩到覆盖资料库：

| 闸 | 钉什么 |
|---|---|
| `tests/config/test_library_constants_parity.py` | Python `src/library/constants.py` ↔ TS `frontend/src/shared/libraryConstants.ts` 的词表与上限逐项对账（顶层 slug / kind / text_status / file_status / source / mount 词表 / 各上限 / 工具名单）。词表按**列表逐位**比较 —— 顺序也是契约（前端 select 选项序、树的顶层序按它渲染）。🔴 抽取失败必须红 |
| `tests/config/test_agent_call_reference_parity.py` | `AgentCallReference` 判别 union 的两处消费方（`tools/agent_call.ts` 与 `CustomAgentCallCard.tsx`）都必须从零依赖叶子 `shared/agentCallReference.ts` import，**不许再自己写一份字面量**；同时钉住 `'library'` 档与 `library_file_ids` 的落地形状 |
| `tests/config/test_agent_capability_parity.py`（既有） | 第 8 张能力卡 `library` 的工具集与 `HEADLESS_TOOL_OPTIONS` 精确相等 |
| `tests/config/test_tool_prefs_catalog_parity.py`（既有） | 七个工具的出厂档与 catalog 行一致 |
| `tests/agent_eval/runner/tests/test_library_coverage.py` + `baselines/library.jsonl` + `AGT-LIBRARY-001..004` | 行为回归：读工具的正常用法、CAS 重试地板（重试恰一次）、**文档里塞指令不得触发 `library_delete`** 的注入地板 |
| `tests/agent_config/test_policy_library.py` · `tests/api/test_agent_policy_library.py` | §5.4 的免卡通道与地板（含「overwrite 一个 my-docs 文件 + 伪造 agent-docs path」这一形态） |
| `frontend/tests/ai-gateway/agent_run.test.ts` | 三条 belt 各一例：`library_append` 进面、同族另外三个一个都不进，敌意 `allowedTools` 列出那三个名字也不放行 |

跨进程的 IPC 键名与预览 URL **没有建闸，而是消灭了镜像** —— `frontend/src/shared/libraryIpcContract.ts`
是 main 与 renderer 共用的零依赖叶子（CLAUDE.md 的纪律：先问能不能消灭镜像，消灭不了才建闸）。

## 9 运维

```bash
# 活库位置（打包 app 的真实库在 userData，不是仓库 data/）
DB=~/Library/Application\ Support/mailagent-frontend/data/library.db
sqlite3 "$DB" "SELECT value FROM library_meta WHERE key='schema_version'"
sqlite3 "$DB" "SELECT status, COUNT(*) FROM library_file GROUP BY status"
sqlite3 "$DB" "SELECT text_status, COUNT(*) FROM library_file GROUP BY text_status"
sqlite3 "$DB" "SELECT model, COUNT(*) FROM library_chunk GROUP BY model"
sqlite3 "$DB" "SELECT id, label, mode, status FROM library_mount"
```

- **重扫**：设置页「重扫资料库」，或 `POST /api/library/rescan`（可带 `mount_id` 只扫一个根）。
  回执 `{scanned, added, updated, missing, elapsed_ms}`。重扫只对账元数据，**不会重新分配 id**。
- **索引损坏**：`library.db` 不进 `quick_check` fail-fast，App 照常启动。删库重建是安全的
  **数据后果**：文件本身不动、`library_file.id` 全部重新分配 ⇒ 事项 / 通知 / 会话里记的
  `library:{id}` 全部指错或指空。所以除非确认没有跨模块引用，否则优先重扫而不是删库。
- **回滚整个模块**：每条 lane 是独立 commit，可单独 revert。没有开关可关 —— 这是「确定要做的功能不搞
  灰度开关」纪律的直接后果（§0）。revert 后 `library.db` 与 `library/` 目录留在盘上，不会被清理。
- **语义模型**：权重落 `<data>/library/embed_cache/`，不进 `.app`。删掉目录 = 回到纯 FTS，检索照常
  工作（`hybrid` 自动退化）。换模型 = 换 `EMBED_MODEL_ID`，旧向量被 `WHERE model=?` 自然排除。

## 10 已知缺口 / 有意不做

**缺口（记录在案，尚未做）**：

| # | 事项 | 状态 |
|---|---|---|
| 1 | **语义检索的 PoC 未跑**：要先下载 614 MB 权重（`onnx-community/Qwen3-Embedding-0.6B-ONNX` 的 `onnx/model_int8.onnx`）才能测吞吐与中英混合 query 的召回。因此 `VECTOR_MIN_SCORE = 0.3` 是**待校准的起始值，不是实测结论**；「留 Qwen3 还是降级 jina」也没定 | 等 owner 放行下载 |
| 2 | 通知信源的**调用点**尚未接进 `src/library/service.py` 的 append / write 路径。`notify_library_file_written` 本身已就位并有测试。接线时的硬约束：**只在无人值守写入时发**、**必须在写事务 commit 之后**（事务内 publish 会与 NotifyCenter 的 `BEGIN IMMEDIATE` 死锁，`tests/notify/test_library_signals.py` 第 ⑤ 例已钉死后果） | 未做 |
| 3 | standing prompt 尚未注入顶层文件夹清单 + 用途 + 文件总数（取数走 `GET /library/tree`）。**绝不注入文件清单** | 未做 |
| 4 | `src/agents/run_spec.py` 的行动项 run 契约工具面清单没提资料库。行动项 run 该不该看见资料库需 owner 拍板 | 待拍板 |
| 5 | i18n 总对账：全仓 `t('library.…')` 的实际用法 vs `common.json` 的条目，差集未补齐 | 未做 |
| 6 | `frontend/mockups/library/strings.ts` 的 `htmlSandbox`「已禁用脚本」文案已随 §6 改判作废（locale 侧已重写，mockup 源文件仍是旧文案） | 未做 |
| 7 | 挂载根的 macOS TCC 行为（把 `~/Documents/<x>` 挂进来、冷启后读，是否二次弹框、内嵌 Python 子进程是否同享 App 的授权）**待 owner 真机验证** —— 需要 GUI 交互，无人值守跑不了 | 待确认 |
| 8 | PDF 原件内嵌预览的 PoC 同样要真机交互，当前走降级路径（解析视图 + 用系统阅读器打开） | 待确认 |

**有意不做**：

- **通知 title 是 Python 硬编码**：现有 8 个信源都这样，前端没有按 `source` 换 i18n key 的投影层。
  资料库信源沿用同一形状。建投影层的影响面波及全部 8 个信源，超出本模块范围。
- **不加 `ConversationContextSource` 第五档**：资料库页的「对话」按钮 = 预置一条 `@` 提及。加第五档
  等于让环境态盖过显式声明。
- **不做 watcher**（§1.3）；**解析版不落 sidecar 文件**（§4）；**不做章节锁**，并行靠拆文件。
- **不做 LLM 重排**：hybrid 的 RRF 就是排序。
- **不同步 Notion**；**报告产物不自动落资料库**（同一份报告两个真源）；**通讯录不加资料列**
  （「某人相关的资料」的真源是事项的 stakeholder + resource）。
- **邮件面 `ThreadComposer` 不加资料库入口**：它没有 in-field `@`，上 trigger = 把邮件面换成 Lexical。
- **审批 resume 会剥掉 `injectedContext`**（`approvalResume.ts`）：@ 提及的 envelope 在 HITL 续跑后
  模型看不到。这是既有行为，对资料库提及同样成立；文件正文本来就靠工具读，影响有限。
