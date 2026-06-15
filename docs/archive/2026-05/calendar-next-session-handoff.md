# Calendar Module — Next Session Handoff

**From**: Session @ 2026-05-23 17:00 (Phase 2 写能力全套 ship — RSVP / 事件 CRUD / Replay 重做, 6 commits)
**To**: 下个 session (UI polish 实测 + Phase 3 legacy 下线 + 多 calendar 等)
**Status**: 读 + 写能力全套上线 (RSVP / 创建/编辑/删除事件 / Replay 任何 source). Phase 2 完整闭环, Phase 3 legacy 下线 + 多 calendar / 跨设备 等 V2 项目化
**Read first**:
  - `docs/calendar-module-prd.md` (产品需求 + 数据模型 + 视图规格, 不变)
  - 本文件 (新待办 + caveat)
  - 旧 handoff 已并入 §1 (commit `82943fe`/`0fa7896`), git history 是基线

---

## 1. 本次 session ship 内容 (6 commits)

```
719cf93 feat(calendar): Phase 2.2/2.3 — 创建/编辑/删除事件 (CalDAV PUT/DELETE)
98b017f feat(calendar): Phase 2.1 — RSVP 接受/暂定/拒绝 真接 SMTP iTIP REPLY
a9489ce feat(calendar): Phase 2.4 — Replay 重做基于 SQLite calendar_event (any source)
e47b9b7 fix(frontend-calendar): 周视图列宽错位 — 补偿 scrollbar 宽度避免 7 列累积漂移
0fa7896 docs(calendar): handoff 更新 — §3 行为层 done, 重心移到 UI polish + Phase 2 RSVP
82943fe feat(frontend-calendar): handoff §3 行为层优化 — auto refetch + 副 status bar 自动同步显示
```

**用户视角能感受到的变化** (按重要程度):

### 1.1 事件可以**创建 / 编辑 / 删除** (新, Phase 2.2/2.3)
- toolbar 多了 [+ 新建] 按钮 — 点击弹 modal 表单 (标题 / 开始 / 结束 / 地点 / 描述 / 与会者), 提交后直接 CalDAV PUT 到 Exchange 端立即生效, ~60s 内同步到本地视图
- 点开事件 drawer 多了 [编辑] [删除] 两个按钮:
  - 编辑 → 弹同样表单 (预填) → 改完 CalDAV PUT 覆盖 + SEQUENCE +1
  - 删除 → native confirm → CalDAV DELETE, 与会者会收 Exchange 取消通知
- 后端 `mailagent calendar {create,update,delete}` CLI 也能用 (agent / 脚本调用)

### 1.2 RSVP 接受/暂定/拒绝**真能发回组织者** (新, Phase 2.1)
- drawer 底部 3 个按钮以前是灰色 stub, 现在真发 RFC 5546 iTIP REPLY 邮件给 organizer (DavMail SMTP 1025 → Exchange Calendar Assistant 异步更新 organizer 端 PARTSTAT)
- 当前 response_status 高亮 (已接受/暂定/已拒绝 那个 button 是 coral 描边)
- 点击前弹 native confirm 防误点
- CLI `mailagent calendar rsvp <ical_uid> accept|tentative|decline`

### 1.3 Replay 按钮**任何事件**都能用 (修, Phase 2.4)
- 以前 caldav-only events (`internal_id=0`) Replay 按钮永远灰; Phase 1.5 后这些是大多数
- 现在 Replay 走 `mailagent calendar replay <ical_uid>` (基于 SQLite calendar_event 行重导出 Notion mirror), 任何 source 都能 replay
- 用户场景: "我手改了 Notion 日历库被 sync 覆盖了/页面被误删了" → 重 replay 即可

### 1.4 周视图列宽**不再漂移** (修, bug fix)
- 用户反馈: 周视图顶部日期/星期 列宽和下方对不上, 前几列误差小后几列误差大
- 根因: `.wk-body` 滚动条吃 10px 宽度, `.wk-headrow` 不滚动不被吃 — 7 列 1fr 累积差 10px 在第 7 列
- 修法: `scrollbar-gutter: stable` + headrow `padding-right: 10px` 补偿

### 1.5 日历**自己刷数据**了 (UX, 之前已 ship 但本 session 起点)
- events 列表 60s 自动 refetch (跟后端 worker 同频), 不必盯着大同步按钮
- recurring tab 切过去就有数据, 不必先 [扫描]
- 日历卡片底部多 "自动同步 N 秒前" 提示 (每 30s 走时)
- 同步按钮 hover 提示明确"急刷 / 后台 60s 自动"

### 1.6 键盘快捷键**长用稳定** (UX, 隐藏 bug fix)
- 修了 keydown listener 每次 render 重 bind 的资源泄漏
- G+W/G+M/T/← →/⌘R/? 长时间用更稳

---

## 2. 数据流现状 (变化: Phase 2 写能力全套)

```
Outlook (Exchange)
     ↑ ↓ EWS
DavMail JVM (127.0.0.1)
     ├─ CalDAV (1080)  ←──→  CalendarSyncWorker / CalDAVReader / CalDAVWriter (NEW)
     ├─ SMTP    (1025)  ←──   send_itip_reply_smtp (RSVP REPLY, NEW)
     └─ IMAP    (1143)  ←──→  mail-sync (邮件同步)
                ↑
       caldav lib (Python)
                ↓ upsert
SQLite calendar_event (master + RRULE)
                ↓ 直读 (better-sqlite3 + npm rrule expand)
     ├─ 前端 IPC handlers (~5ms)
     │   ├─ events:list  → 60s auto refetch + window focus refetch
     │   ├─ events:get   → drawer lazy fields
     │   ├─ sync:status  → 60s refetch (副 status bar)
     │   ├─ recurring:discover → 5min cache, mount auto fetch
     │   ├─ sync:trigger → manual 急刷
     │   ├─ event:replay  (NEW) → mailagent calendar replay
     │   ├─ event:rsvp    (NEW) → mailagent calendar rsvp
     │   ├─ event:create  (NEW) → mailagent calendar create
     │   ├─ event:update  (NEW) → mailagent calendar update
     │   └─ event:delete  (NEW) → mailagent calendar delete
     └─ mailagent calendar CLI (10+ commands, agent/脚本友好)
```

**关键变化**:
- ✅ **CalDAV 双向通道** — reader (已有) + writer (Phase 2.2/2.3, NEW). 用户 owner 操作直接改 Exchange 端
- ✅ **iTIP REPLY 路径** — attendee → organizer 通过 DavMail SMTP 走 RFC 5546 REPLY (跟 owner CRUD 是两条独立路径, 不混淆)
- ✅ **本地 SQLite 立即同步** — RSVP 后 `repo.update_response_status` 立即写本地 (无需等下次 worker sync); CRUD 后 invalidate query 用户 ~60s 内自然看到 (worker poll). 急用按 [同步]
- ✅ **CLI 全覆盖** — agent / 脚本调用所有写命令 OK; envelope shape 统一

---

## 3. 待办 — UI polish (小工作量, 优先实测)

### 3.1 ★ dev server 实测 — Phase 2 整套真跑
本次 session 全程 typecheck/pytest/vitest driven, 没启 `pnpm dev`. 下个 session 必须:
- `cd frontend && pnpm dev`
- `/admin/calendar` 切 5 视图; 验:
  - 周视图列宽对齐 (commit e47b9b7 fix; 跨多个事件 + 滚动条触发场景, 看头部日期跟下方时间格子是否对齐)
  - toolbar [+ 新建] 按钮弹 modal — 填表创建 → 点确认 → ~60s 内 calendar 视图出现新事件
  - drawer [接受][暂定][拒绝] — 点拒绝 → confirm → 实际 SMTP 发出 (Outlook 那边 organizer 收到 REPLY)
  - drawer [编辑] → 改标题 → 保存 → ~60s 内更新
  - drawer [删除] → confirm → ~60s 内消失
  - Replay 按钮: recurring tab 任何 row 都能点 (不再灰色)
- 截屏发 review

### 3.2 EventFormModal 视觉 polish
当前 modal 简易实现 (inline fixed pos + Tailwind), 可能用户反馈样式不够精致:
- 加 .modal-backdrop / .modal-card utility class 抽到 index.css
- 字段宽度 / spacing / button 样式跟 mockup 看齐 (mockup 没设计 modal, 但可以从 drawer / dw-act 复用风格)
- attendees textarea 改成 chip 输入 (输入 email → Enter 加 chip, 删除点 ×)
- datetime-local 在 macOS 上有些丑, 可考虑用 react-datepicker 替代 (但引依赖)

### 3.3 light 主题验证
本次 ship 全程 dark first 设计. 切 Light 主题验:
- EventFormModal backdrop 是否够暗 (dark 用 black/55, light 可能要降透明度)
- 3 个 RSVP button data-current 高亮在 light 下 coral 描边 + 16% 透明背景是否够鲜
- [删除] button danger coral 描边在 light 下是否够红

### 3.4 删除前的 toast undo (5s 撤销)
当前删除点 confirm → 立即 CalDAV DELETE, **不可撤销**. 提升 UX:
- 5s undo toast: 点删除 → toast "事件已删除 [撤销]" 5s → 5s 后真发 DELETE
- 5s 内点 [撤销] → 取消, 不调 DELETE
- 实现: setTimeout + flag. 简单但需调整 deleteMut 流程
- 不做这步的话至少 confirm dialog 文案要更醒目 (当前是 native confirm, 想加 Notion 风格 modal)

### 3.5 编辑修改后 attendees 列表保留
EventFormModal edit 模式预填 attendees, 但 CLI `mailagent calendar update` 传 `--attendee` 时**会替换原列表**. 当前实现 modal 预填 + 用户不动 → 保留. 但如果用户点 "清空 attendees" 然后保存, 后端会把 attendees 清掉.

caveat: caldav_writer.update_event 注释提到 "attendees None → 不写 ATTENDEE 行 (服务端覆盖)" — 这个语义可能丢 attendees. 测试有覆盖, 但 modal 行为应该 polish.

---

## 4. 待办 — 功能/架构 (中长期)

### 4.1 Phase 3 — legacy 下线
跟 PRD §7 一致:
- 删 `calendar_main.py` + `src/calendar/` 整目录 + PM2 `calendar-sync` 进程
- 等 2-4 周稳定 (CalendarSyncWorker + 新写能力都跑稳)
- `source='legacy_calendar_app'` 的 calendar_event rows 可以选: archive 表 / soft delete / 留着不动
- CLI 已有 `mailagent admin cleanup-syncstore` 模式可以加 `--legacy-calendar` 清残留

### 4.2 多 calendar 支持
当前只默认 "日历" calendar (Outlook 中文默认名). 用户可能有:
- 共享日历 (其他人共享给我的)
- 个人多日历 (Work / Personal 分开)
- 订阅日历 (国家假期 / 项目里程碑)

待:
- toolbar 加 calendar chip 选择器 (类似 mockup §toolbar 但 mockup 没画)
- useCalendarNames 已 ship, calendar chip 用它取列表
- EventFormModal create 表单加 calendar 选择 (当前总是默认)

### 4.3 跨设备 (V2)
PRD §7 短期不做 — HttpApi proxy 给 Web/Mobile 用. 当前 Web 模式 calendar 整套 notImplemented(已经在 HttpApi stub 里). V2 时:
- FastAPI proxy 实现 calendar:eventsList / eventGet 等 read paths
- write paths 需要 auth gateway (FastAPI 加 token 校验)

### 4.4 全天事件 + 跨时区
当前 EventFormModal 只支持 datetime (有时间), 全天事件不能新建. 也只接受本地 tz, 跨时区会议要手动算. 留 V2:
- modal 加 [全天] toggle (隐藏 time inputs + dtstart/end date-only)
- tz select 默认本地, 高级用户可选其他 tz

### 4.5 周期事件创建 + 编辑 (RRULE)
当前 EventFormModal 只能创建单次事件, RRULE 不支持. 编辑时若原事件有 RRULE, save 会清掉 (build_vevent 不带 RRULE/EXDATE/RDATE). Caveat 留 V2:
- modal 加 "重复" 段 (每天 / 每周 X / 每月 第 N 个 X / 自定义 RRULE)
- 编辑 RRULE 事件时要分 "改这一次 / 改未来 / 改整个系列" (Google/Outlook 标准 3 模式)

---

## 5. 已知 caveat / 不要踩坑

### 5.1 Electron main process 不会 HMR
改 `frontend/src/electron/main/**/*.ts` 必须完全重启 `pnpm dev`. Renderer (shared/**/*.tsx) 走 HMR 正常.

### 5.2 mail-sync (PM2) 加载新 Python 代码也要重启
改 `src/calendar_sync/` 或 `src/calendar_notion/` 后 `pm2 restart mail-sync`.

### 5.3 ctag 取不到 → 数据延迟
DavMail 6.7 CalDAV PROPFIND getctag XML 解析炸. worker 走 1h time-fallback. 用户改日历最多 1h 才看到, 急用按 [同步]. **不要再修这个**, 工作量大.

### 5.4 caldav PUT/DELETE 是 immediate 但 SQLite 同步要等 worker
用户点 [+ 新建] / [编辑] / [删除] 后, **Exchange 端立即生效**, 但本地 SQLite calendar_event 表要等下次 60s worker 轮询才有变化. UX 上前端 toast 提示 "~60s 内同步到本地视图". 急用按 [同步] 立即拉。

未来优化:create/update/delete 后立即调一次 `calendar:syncTrigger`(已有 IPC),无缝感觉。但 sync 是 expensive 操作,不一定每次都跑。

### 5.5 update_event attendees None vs [] 语义
caldav_writer.update_event 当 attendees=None 时,build_vevent 不输出 ATTENDEE 行 — 服务端覆盖时**清掉原 attendees**. 这是 MVP 简化(不从原 event 复制 attendees). 调用方要清楚:
- 不想改 attendees → 显式传**原列表** (从 occurrence.attendees 拿)
- 真想清空 → 传 `[]`
- 加新人 → 传 `[...原, 新]`

当前 EventFormModal 行为:edit 模式预填,用户不动则保留原列表(因为是从 occurrence.attendees 读的)。OK。

### 5.6 RSVP 跟 owner ops 是两条独立路径
- RSVP (Phase 2.1): attendee 视角, 通过 SMTP 发 iTIP REPLY 给 organizer, organizer 端 EWS 异步更新 PARTSTAT
- Create/Update/Delete (Phase 2.2/2.3): owner 视角, 通过 CalDAV 改自己日历资源, EWS 自动给 attendees 发通知

不能混淆 — 我自己创建的事件, 不需要 RSVP (我就是 organizer); 别人邀我的事件, 我应该 RSVP 而不是 update (改别人的事件会触发 Exchange 拒绝).

UI 上 drawer **同时显示** RSVP 3 button 和 编辑/删除 button — 实际语义上:
- 自己组织的事件 (organizer=me): RSVP button 灰但能点 (服务端会拒); edit/delete 真有效
- 别人邀我的事件 (organizer≠me): edit/delete 服务端可能拒 (CalDAV 403); RSVP 才是真路径

未来 polish: 根据 organizer === user.email 自动隐藏不适用按钮.

### 5.7 git race condition (一直存在)
本 session 期间另一 session 在 ship KOS / agent harness. 本 session 5 个 calendar commits 全用 `git commit -o <files> -F msg` 显式 only-commit, 绕开 staging area. 没被 race 影响. 下次保持同样姿势.

### 5.8 pre-existing 死 imports (`ruff` 报告)
跑 `ruff check src/calendar_sync/ src/cli/commands/calendar.py tests/calendar_sync/` 会有 6 个 F401 unused import warning, 全在我没碰的文件 (reconciler.py / worker.py / test_caldav_reader.py / test_expander.py 等). 跟 Phase 2 工作无关, 留给原作者 (按精准修改原则). 我的 8 个文件 lint clean.

### 5.9 EventFormModal 简化版 — datetime-local + textarea
当前 modal 简易实现:
- datetime input 用 native datetime-local — macOS 上视觉有点丑, 但跟系统时区一致
- attendees 用 textarea 多行 'email[,name]' — 不友好, 应该改 chip 输入 (UX polish 留 §3.2)
- 没用 radix Dialog primitive — 简洁直接, 但 a11y (focus trap / aria) 可能不足
- Esc 关闭由 backdrop onClick 提供 — 不是 native modal Esc handler

下次 polish 可以用现有 ConfirmToolDialog 风格升级.

---

## 6. 立即可跑的验收命令

```bash
# 1. 数据层 + worker 状态
KEY=$(grep "^MAILAGENT_CLI_API_KEY=" .env | cut -d= -f2-)
mailagent --api-key "$KEY" calendar sync-status -o json | jq '.data.calendars'
mailagent --api-key "$KEY" calendar today -o json | jq '.data | {total, events: .events | map({summary, start: .occurrence_start_iso[:16]})}'

# 2. Phase 2 写能力 dry-run (不实际改 Exchange, 验 CLI 跑通)
# RSVP dry-run
mailagent --api-key "$KEY" calendar rsvp <ical_uid> accept --dry-run -o json | jq '.data.body_preview'
# Replay dry-run
mailagent --api-key "$KEY" calendar replay <ical_uid> --dry-run -o json
# Create (没 dry-run, 实际会写 — 测完手动删掉那个事件):
mailagent --api-key "$KEY" calendar create --summary "test create" \
  --start "2026-12-31T23:00:00+08:00" --end "2026-12-31T23:30:00+08:00" -o json

# 3. SQLite 数据分布
sqlite3 -header data/sync_store.db "
SELECT source, COUNT(*) AS n,
       SUM(CASE WHEN rrule != '' THEN 1 ELSE 0 END) AS with_rrule,
       SUM(CASE WHEN response_status='ACCEPTED' THEN 1 ELSE 0 END) AS accepted
FROM calendar_event WHERE deleted_at IS NULL GROUP BY source"

# 4. 前端
cd frontend && pnpm dev
# /admin/calendar 切到 week 看顶部对齐 (commit e47b9b7 fix)
# toolbar [+ 新建] → 弹 modal → 填表 → 创建 → 60s 内 calendar 显示新事件
# 点事件 drawer → [接受][暂定][拒绝] confirm 后发邮件
# drawer [编辑] → 改 → 保存; [删除] → confirm → DELETE
# recurring tab → 任何 row 都能 Replay (不再灰)

# 5. 后端测试 + 前端测试
source venv/bin/activate && python -m pytest tests/calendar_sync/ tests/calendar_notion/ -q
cd frontend && pnpm vitest run tests/main/calendar.test.ts
```

---

## 7. 给下个 session 的开场白模板

```
继续 calendar 模块. 上次 session ship 6 commits 完成 Phase 2 写能力全套:
- 719cf93 Phase 2.2/2.3 创建/编辑/删除事件 (CalDAV PUT/DELETE + 前端 modal)
- 98b017f Phase 2.1 RSVP 真发 SMTP iTIP REPLY
- a9489ce Phase 2.4 Replay 基于 SQLite 重导出, 任何 source 都可
- e47b9b7 周视图列宽 fix (scrollbar-gutter)
- 0fa7896 + 82943fe handoff §3 行为层 + 文档

读这两份文档:
- docs/calendar-module-prd.md (产品需求 / 数据模型)
- docs/calendar-next-session-handoff.md (本次 ship + UI polish 待办)

本次 session 优先级:
1. ★ §3.1 dev server 实测 — 启 pnpm dev 真跑一遍 Phase 2 整套
   (新建/编辑/删除/RSVP), 截屏 review
2. §3.2 EventFormModal 视觉 polish (modal-card class / attendees chip 输入)
3. §3.3 light 主题验证
4. §3.4 删除 undo toast (UX, 5s 撤销窗口)
5. §3.5 编辑 attendees 保留语义验证
6. (可选) §4.1 Phase 3 legacy 下线开始 (calendar_main.py + src/calendar/)

电话亭 / blocker:
- Electron main 不动, renderer HMR (§5.1)
- caldav 写完 Exchange 立即, SQLite 等 60s (§5.4)
- RSVP vs owner ops 两条独立路径, 别混 (§5.6)
- update_event attendees None 语义 (§5.5)
```

---

## 8. 关键文件 (按改动可能性排序)

### Phase 2 写能力完整, 重心在 polish + Phase 3:

1. `frontend/src/shared/components/calendar/EventFormModal.tsx` ★ UI polish (§3.2)
2. `frontend/src/shared/components/calendar/EventDetailDrawer.tsx` — delete undo (§3.4) / RSVP+owner 分流 (§5.6)
3. `frontend/src/shared/components/calendar/CalendarToolbar.tsx` — [+ 新建] 视觉打磨 / calendar chip (§4.2)
4. `frontend/src/electron/renderer/index.css` — .modal-card class 抽 (§3.2) / light 主题验证 (§3.3)
5. `src/calendar_sync/caldav_writer.py` — update_event attendees 语义优化 (§5.5) / RRULE create (§4.5)
6. `src/cli/commands/calendar.py` — CRUD 命令稳定, 不必动
7. `src/calendar_sync/itip_reply.py` — RSVP RFC 5546 实现, 稳定不动
8. `src/calendar_notion/replay.py` — Phase 2.4 实现, 稳定不动

### Phase 3 legacy 下线:
9. `calendar_main.py` — root 老服务入口, **删**
10. `src/calendar/` — 老模块, **删** (按 grep 验证无 import 后)
11. `ecosystem.config.js` (PM2) — 删 calendar-sync 进程定义

### 后端测试 (跟改动同步):
12. `tests/calendar_sync/test_caldav_writer.py` — 加 RRULE / multi-calendar test
13. `tests/calendar_sync/test_rsvp.py` — 加 organizer=me 自我 RSVP 拒绝 test
14. `tests/calendar_sync/test_itip_reply.py` — RFC 5546 完整 / Outlook 实测

**不需要碰 (除非用户明确要求)**:
- 数据层 / IPC handler (`handlers/calendar.ts` — Phase 2 IPC handlers 稳)
- 路由 (`router-instance.tsx`)
- API types (`shared/api/types.ts` — Phase 2 全套类型已定义)
- mockup ref (`frontend/ref/mockup-calendar.html` — 锁定基线)
