# 多文件夹同步 — 真机 e2e 验收清单（v0.5.0）

> 装机后逐项勾选。覆盖 P1-P6 全功能 + 横切铁律 + 回归。
> **构建标识**：StatusBar 底部应显示 `v0.5.0 · <hash>`，hash = feature 分支最终 commit 的 short hash（以交付消息给出的为准；`git rev-parse --short HEAD` 可查）—— 先确认这个，否则装错了构建。

## 0.5 已自动验证（CLI/后端层，对真实 davmail Exchange · 无副作用只读）
> 这层我已跑过 `mailagent folder discover`（合并后的代码），以下已坐实，你可略过、专注 renderer 渲染/交互：
- [x] folder discover 对真实 Exchange 列出 18 文件夹
- [x] 中文名解码：DMS固件发布 / 对话历史记录 / 存档(17313) / 待办 / 必要文档路径
- [x] **逗号名 `&W,mL3VOGU,KLsF9V-` → 对话历史记录**（JSON 白名单命根，CSV 会劈坏）
- [x] 嵌套检测：对话历史记录 `has_children=true`
- [x] 系统文件夹保护：INBOX/Sent/Drafts/Junk/Trash `is_system=true`
- [x] 空格名 `Unsent Messages`（quote_mailbox）+ STATUS 计数（Jira 3462 等）
- [x] 🔒 whitelist 空=零激活
> ⚠️ 未自动验证（有副作用，留给你 UI 操作）：实际勾选→同步落库/Notion、标旗/归档/移动/回复、文件夹 CRUD（这些会写真实 Exchange/Notion，不宜我代跑）。

## 0. 前置（已确认 ✓）
- [x] davmail-poc 桥在线（`pm2 list`）—— 本功能 **davmail-only**，桥必须跑
- [x] pm2 `mail-sync` 已停 —— 用 .app 时必停，防与内嵌后端双写
- [ ] 后端模式 = davmail：app 内 设置→同步 应是 davmail；若是 applescript，文件夹功能会门控关闭（见 §H4）
- [ ] **装机**：退出旧 app → `ditto dist/mac-arm64/MailAgent.app /Applications/MailAgent.app` → 打开
  - 升级会跳过 onboarding（userData 保留）；想验 onboarding（§F）需用全新 userData 或新账号

---

## A. 配置页 — 文件夹发现 + 勾选（P3，照 mockup ①）
- [ ] 设置 → 同步 → 「自定义文件夹同步」区出现
- [ ] **FolderPicker 树**实时从后端拉取，列出 Exchange 文件夹（含中文名如 DMS固件发布/对话历史记录）
- [ ] 嵌套文件夹有缩进层级，可展开/收起
- [ ] 勾选若干（如 Jira / Notion / 一个中文名）→ 保存 → 提示「需重启生效」类
- [ ] 🔴 **「首次同步窗口（天）」+「单文件夹上限（封）」两个数字框能改并保存成功**（不报 E_INVALID_KEY）—— 这是本次修的 env-keys 白名单 bug，重点验
- [ ] 空态（一个都不选）显示正常，不报错

## B. Sidebar 树形（P3，照 mockup ③④）
- [ ] 重启后 MAILBOXES 段出现勾选的文件夹（树形 + 缩进）
- [ ] 中文文件夹**显示叶子名**（不是 modified-UTF7 乱码、不是全路径）
- [ ] 有邮件计数
- [ ] 点击文件夹 → 邮件列表过滤到该文件夹（嵌套用全路径过滤，不串味）
- [ ] 列表头部面包屑显示该文件夹层级（叶子名段）

## C. 自定义文件夹邮件走主链路（P1/P2）
- [ ] 点开文件夹 → 邮件列表加载（正文/附件能点开看）
- [ ] **AI 分类**：该文件夹邮件有 AI Action / Priority（除非该文件夹在 `FOLDER_LLM_DISABLED`）
- [ ] **Notion 同步**：邮件落 Notion，且 Notion 里 `Mailbox` 字段 = 文件夹名（中文名正确）
- [ ] **全文搜索**：搜索框能搜到该文件夹的邮件正文
- [ ] **线程**：同线程邮件正确折叠/关联
- [ ] **通知降噪**：自定义文件夹默认**不**推飞书（除非在 `FOLDER_NOTIFY_ENABLED`）

## D. 写操作泛化（P4）
- [ ] 在自定义文件夹内**标旗**某邮件 → Mail.app + Notion 同步翻转
- [ ] **归档**自定义文件夹的邮件 → 正确移到 Archive（src 解析对，不是写死从 INBOX 归档）
- [ ] **移动**邮件到另一个文件夹 → 生效
- [ ] **回复 / 回复所有 / 转发**该文件夹邮件 → compose 面板预填正确 → 真实发送成功

## E. 文件夹管理 CRUD（P4，照 mockup ⑤）
- [ ] 树行 hover/⋯ 菜单出：新建子文件夹 / 重命名 / 删除
- [ ] **新建**子文件夹 → Exchange 端真建出 + 树刷新可见
- [ ] **重命名** → Exchange 改名 + 本地 mailbox 跟着改（含其子文件夹前缀）
- [ ] **删除**（二次确认弹窗，说明影响真实 Exchange + 本地副本）→ Exchange 删 + 本地邮件级联清（body/附件/FTS/附件目录）
- [ ] **系统文件夹保护**：收件箱/发件箱/已发送/草稿 的菜单禁用新建/改名/删除

## F. Onboarding（P4，照 mockup ②）—— 需全新 userData
- [ ] 新用户向导出现「文件夹勾选」步
- [ ] 树形多选可勾选
- [ ] 可**跳过**（不阻塞流程）
- [ ] 系统文件夹锁定 / 大文件夹有提示

## G. 边界打磨（P5）
- [ ] **大文件夹**（如 Jira 几千封）勾选 → 不卡死 UI（窗口 `FOLDER_SYNC_PAST_DAYS` + 上限 `FOLDER_SYNC_MAX_MESSAGES` 截断最新 N 封）
- [ ] **取消勾选**某文件夹时，出现「同时清理本地副本」选项（默认**保留**）
- [ ] 勾「清理」→ 本地该文件夹邮件清掉，**Exchange 端不受影响**（去 Outlook/OWA 确认邮件还在）

## H. 横切铁律
- [ ] **🌐 i18n**：设置切换 中文 ⇄ English，所有文件夹相关文案都翻译（无 raw key 如 `settings.folder.*`，无残留硬编码中文）
- [ ] **🎨 主题**：亮 ⇄ 暗 切换，FolderPicker 树 + Sidebar 树 + 管理菜单取色都正确（对照 mockup 两套基准，无突兀色）
- [ ] **🔒 隔离不变量**：把 `SYNC_FOLDERS` 清空 → 重启 → 收件箱主路径与开功能前**逐字节一致**（Sidebar 无多余文件夹行，同步行为不变）
- [ ] **🔴 AppleScript 门控**：临时切 `MAILAGENT_BACKEND=applescript` → 文件夹配置区/管理优雅禁用（davmail-only 提示），**不报错崩溃**

## I. 回归（合并了 main 的 chat dogfood，别坏）
- [ ] 收件箱正常同步 + 列表/正文/搜索正常
- [ ] **旧「存档/草稿箱」入口已删**：Sidebar 不再有这俩死链接，点其它导航无 404（P6 删了老展示链路）
- [ ] chat 多轮对话 / 报告（日周月报）/ 日历 等 main 功能正常（合并带入的）

---

## 验收完成后（你来 / 点头我来）
真机全过后，最终落 main + 打 tag（纯快进，零冲突）：
```bash
cd /Users/chenyuanquan/Documents/MailAgent          # 主 worktree (main)
git merge claude/charming-ritchie-754f5b            # 纯 FF
git tag -a v0.5.0 -m "多文件夹同步：自定义 Exchange 文件夹并入主链路"
```

## 已知非阻塞
- 后端 9 个 pre-existing 测试失败（7 calendar/reverse_sync + 2 main 侧 env-snapshot env 耦合）与本功能无关，已 spawn_task 单独修。
- renderer 自动化 e2e（computer-use）受限于 Accessibility 权限 + 疑似 Retina 命中 bug，故转人工逐项验收。
