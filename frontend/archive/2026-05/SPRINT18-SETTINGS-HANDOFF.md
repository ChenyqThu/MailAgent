# Sprint 18 — Settings 页面重做

## 任务目标

重新规划并实现 Settings 页面：根据真实配置项（后端 `.env` + 前端 state）决定要支持什么，按 `DESIGN.md` 风格组件化实现。**不照搬** mockup 设置项，**照搬**视觉语言与组件库。

## 起点资源（按顺序读）

| 路径 | 行 | 用途 |
|---|---|---|
| `frontend/ref/mockup-settings.html` | 1245 | 视觉参考（不照搬选项，照搬 token / 间距 / 卡片节奏） |
| `frontend/DESIGN.md` | 1618 | **必读**：§2 color、§4 spacing/radius/shadow、§5 component catalog、§11 tailwind config、§14 non-negotiables |
| `frontend/ref/DESIGN.md` | 1975 | 源版（含 mockup 同源章节），diff 看哪些 frontend/ 还没落地 |
| `frontend/src/shared/components/settings/SettingsPage.tsx` | **1174** | **已存在**，不是空白！先 audit 决定 refactor / partial-rewrite / 全重写 |
| `.env.example` | 298 | 24 个显式 ENV 项，但 CLAUDE.md 列了 40+，差额在 .env.example 没列全 |
| `CLAUDE.md` "配置项" 段 | — | 完整 ENV 清单（飞书 / Redis / 看板 / 告警 / Office / 保活 / Webhook 看板 / LLM / 项目周报） |

## 建议工作路径

### Phase 1 — 调研（不要跳）

1. **读 mockup-settings.html 一遍**：抓 layout 骨架（侧栏 nav?顶部 tabs?）、卡片节奏、单条 row 的 label + control + helper 三段式
2. **审计现有 SettingsPage.tsx**：列出已实现 sections / 哪些是 stub / state 从哪来。grep `useEffect / useQuery / useMutation` 看读写绑定
3. **收集完整配置清单**（关键产出）：
   - 后端: `.env.example` + `CLAUDE.md` 配置章节合并去重
   - 前端: `frontend/src/shared/state/` 各 store（mailbox / batch / email-filter / group-collapse / thread-collapse / pinned / active-email / ai-chat-panel）— 看哪些是用户偏好（要 expose 到 Settings），哪些是 runtime state（不动）
4. **决定哪些进 Settings UI**：不是所有 .env 都需要 UI；token / db path / 内部参数（如 `RADAR_POLL_INTERVAL` 默认值就够）不该让用户改；高频开关（`KEEP_ALIVE_ENABLED` / `FEISHU_NOTIFY_ENABLED` / `LLM_AGENT_ENABLED` / `BODY_DUAL_WRITE_ENABLED`）应该有

### Phase 2 — 规划（产出 design doc）

按域分组，每组列出 fields + control type + read/write 路径：

```
Sync           - SYNC_START_DATE / SYNC_MAILBOXES / RADAR_POLL_INTERVAL / HEALTH_CHECK_INTERVAL
LLM Agent      - LLM_AGENT_ENABLED / LLM_API_KEY / LLM_MODEL / LLM_FALLBACK_MODELS / LLM_CONTEXT_PAGE_ID
Notifications  - FEISHU_NOTIFY_ENABLED / FEISHU_APP_ID / ALERT_FEISHU_WEBHOOK_URL / ALERT_LEVELS
Reverse sync   - REDIS_URL / REDIS_EVENTS_ENABLED / STATS_REPORT_URL
Office attach  - OFFICE_CONVERT_ENABLED
Keep alive     - KEEP_ALIVE_ENABLED / KEEP_ALIVE_DIM
Project        - PROJECT_PROGRESS_SYNC_ENABLED / *_AUTO_SYNC_ENABLED / *_DATABASE_ID / *_FILTER_BU / *_SENDER / *_SUBJECT_PATTERN
Frontend prefs - theme / language / 列表密度 / batch confirm threshold / SSE 开关
Advanced       - SYNC_STORE_DB_PATH / ATTACHMENT_STORAGE_DIR / LOG_LEVEL（多数 readonly + 显示路径）
```

不要把 NOTION_TOKEN / FEISHU_APP_SECRET 这种 secret 明文显示，要用 masked input + reveal toggle。

### Phase 3 — 实现

- 优先 shadcn/ui patterns（DESIGN.md §12 提到），目前已有 lucide-react。需要的话补 `Switch / Input / Select / Textarea / Card / Tabs / Dialog`（确认 `frontend/src/shared/components/ui/` 现状）
- 后端 IPC：检查 `frontend/src/electron/main/handlers/` 看有没有 settings handler；多数 `.env` 是 process-launch 时读，runtime 写要触发 `pm2 restart mail-sync` 或显示 "Restart required" badge
- **i18n** — 所有新 row 走 `useTranslation` + 在 `frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json` 同步 key（最近 commit `90f80e4` 已经设了这个先例）

## 关键约束（non-negotiables）

1. **遵循 `frontend/DESIGN.md`**：color tokens 用 `--ink-* / --c-accent / --c-{crit,urg,impt,norm,low}`，不要引入新 hex
2. **几何参数走 `:root` 变量**（Sprint 17 已设先例：EmailRow 几何 SSoT）— Settings row 也用同样 pattern
3. **组件库优先**：shadcn/ui + lucide-react。不要手写 SVG icon、不要 inline styles
4. **process-restart 提示**：改 .env-backed 字段后要 surface "需重启后端" 提示（toast / banner / button）
5. **secret masking**：API key / token / secret 用 `<input type="password">` + reveal toggle
6. **i18n 覆盖**：每个新 label / helper / button 都加 i18n key

## 不要做

- ❌ 不要照搬 mockup 全部 sections — 抽真实配置驱动
- ❌ 不要从零写 SettingsPage.tsx，先 audit 现有 1174 行
- ❌ 不要写 settings 持久化的双写（cache + .env）—  `.env` 是后端 SSoT，前端读后端 IPC（如果不存在就先建 handler）
- ❌ 不要混入与 settings 无关的 refactor（保持 atomic commits，每个 phase 单独 commit）

## 验证条件（commit 前）

- [ ] vitest 全过 + tsc 0 errors
- [ ] 视觉走 Electron 窗口实测（HMR 不一定 reload Settings route）
- [ ] i18n zh + en 两套 key 同步
- [ ] 改的每个 row 都能 read & write & 验证生效（或 surface restart 提示）

## Sprint 17 遗留

- `EmailList.tsx` 1057 行未拆（曾考虑抽 `email-pipeline.ts`，跟 Settings 无关，可单独排）
- Inbox 整体收尾 = 上一 commit `471b532`（EmailRow 几何 SSoT + 删旧 fixed BatchActionBar），后续不应再 touch EmailRow 几何除非视觉 bug
