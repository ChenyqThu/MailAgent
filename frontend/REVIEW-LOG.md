# Frontend Review Log — 2026-05-16

> 对 `frontend/` SSoT 文档（10 份 / ~280KB）做的深度 review 决议日志。
>
> **Reviewers**
> - Claude Opus 4.7 (max + ultrathink) — 全文档扫读 + 跨文档一致性核查
> - Codex via OMC — 5 个独立深度 review agent，各审一个高密度章节
>
> **Scope**: 仅 review + 文档修订；不写实现代码。修订记录见 §6。
>
> **修订状态**: Critical/High 已修；Medium 视情况；Low 标注待 Sprint 0 启动前一次性扫尾。

---

## 0. Summary

| 严重度 | 数量 | 修订状态 |
|---|---|---|
| Critical (Sprint 0 之前必修) | 9 | 8 已修 / **C-09 false positive 撤回 ✓** |
| High (Sprint 0-1 内必修) | 18 | 18 全修 |
| Medium (有空就修) | 15 | 15 全修 |
| Low (typo / 引用 / 格式) | 8 | 5 已修 / 3 留 Sprint 0 启动前 |

✅ **C-09 false positive 撤回**：用户澄清 `notion-agent-cli` 是其自有项目（`~/Documents/notion-agent-cli`），所有 mockup + 文档假设全部 verified，sprint 0 前装 + smoke test 即可。

**关键 takeaway**
1. `Sprint 4 AI Chat panel` 工作量从 2-3 天重估为 **6-9 天**（4 个 codex 与 self review 共识）—— 总 V1 工作量需要从 12-16 天调整为 **16-21 天**。
2. **Cloudflare JWT 校验代码（REMOTE-ACCESS §6.3）当前实现跑不起来**（PyJWT API 误用 + JWKS 模块加载阻塞 + 无 key rotation 刷新）—— 必须重写后再 ship V2-Sprint 1。
3. **light mode 视觉细节无人出**（mockup 只有 dark），Sprint 0 完工 checklist 与 mockup 现实矛盾，需调整。
4. **`useMailApi()` 抽象 vs Electron IPC 直查 SQLite** 形成双源真相风险（Python EmailRepository 与 TypeScript IPC handler 不共享 schema），需要在 Sprint 1 端引入 codegen 或改走 CLI fork。
5. **三态主题 Sprint 0 ship 但 race condition + FOUC 未处理** —— `applyResolvedTheme()` 双触发 + 初次启动 nativeTheme desync。
6. **"4 层防御"实际只 2 层独立**（CF Access OAuth 与 FastAPI JWT 用同一 JWKS）；文案需修 + 加 WAF rate limit policy。

---

## 1. Critical findings — Sprint 0 之前必修

### C-09 — `notion-agent-cli` dependency verified ✓（false positive 撤回）

**Source**: self → 用户澄清（commit 前 dependency verification）

**初版误判**：以为 `notion-agent-cli` 是 npm 上 `henryreith/notion-cli`（Notion REST API CLI）。

**实际**：CLI 是用户自己开发的 `~/Documents/notion-agent-cli`（python pipx package，调 Notion 内部 `/api/v3/runInferenceTranscript` + token_v2 cookie）。所有 mockup + 文档假设都对得上:
- `notion-agent chat <prompt>` ✓
- `--agent-page-id <uuid>` ✓ (`agents list[].agent_page_id` 提供)
- `--json` / `--stream` / `--ndjson` ✓ (chat 命令支持四种输出形态)
- `binding_mode: "persona_overlay"` ✓ (DESIGN.md §6.1 直接 quote 该术语)
- `agents list` / `agents route` ✓ (DESIGN.md §6.3 ToolCallRow 示例直接 quote)
- `thread_id` 多轮复用 ✓ (`chat --thread-id`)

**Sprint 0 启动前 checklist 加**：
- [ ] `pipx install -e ~/Documents/notion-agent-cli`（或 `pipx install notion-agent-cli` 拿用户 PyPI 发布版）
- [ ] `notion-agent init --token-v2 ...` 跑通
- [ ] `notion-agent agents list --json` 拿到 `agent_page_id`
- [ ] `notion-agent chat "hi" --json --stream` 跑通流式输出

**残余风险**：
- 该 CLI 走 Notion 内部 API（非官方 public），Notion 改 endpoint 可能 break —— Sprint 4 留 fallback "Custom API only" 模式（已在 BackendSelector 设计中）
- token_v2 cookie 过期需要用户重 `init`，UI 应该有 health check + 提示

~~原 false positive 三方案分析见 git history~~

---

### ~~C-09 原版 false positive 草稿（已撤回，留作 lessons learned）~~

下面是初版 review 写的方案对比，**已经撤回不采纳**。保留作 commit 后 git history 之外的检索锚点：
**Source**: self（commit 前 dependency verification）
**位置**: `README.md:80,142,212,283` / `ARCHITECTURE.md:68` / `DESIGN.md:692-693,1165` / `PROJECT-PLAN.md:153,390,424` / `BACKEND-INTERFACES.md:430` / `mockup-inbox.html:1129,1182`

npm `notion-agent-cli@0.1.1` 描述："Zero-overhead CLI for the Notion API — for AI agents, scripts, and automation"，来自 `github.com/henryreith/notion-cli`。**这是 Notion REST API 命令行 wrapper（database query / page read），不是"Notion Custom Agent CLI"**。

claude design 出的 mockup + handoff 文档假想了一个不存在的 CLI：
- `notion-agent chat "<prompt>" --agent-page-id <id> --json --stream` —— **不存在**
- `surface = custom_agent` / `binding_mode = persona_overlay` —— **不是 Notion 官方 terminology**
- mockup 里 "ToolCallRow" 的 `notion-agent agents route` —— **假想的 tool 调用**

**这意味着**：Sprint 4 "Notion Agent · Jarvis 默认 backend" 路径需要重新决策。

**三个方案**（待你拍板）:

| 方案 | 内容 | V1 工作量 | 备注 |
|---|---|---|---|
| **A. 砍 Notion Agent，V1 只 Custom API** | BackendSelector 简化为 "claude-sonnet-4-6 / gpt-5.4 / claude-opus-4-7" 三选一（CRS 多模型）；mockup 里 "Notion Agent · Jarvis" 行删除；ai_chat_sessions.backend_kind 保留字段以备未来加 | **省 1-1.5 天** | 推荐 — 最干净。CRS 已经能跑 80% "Notion Agent" 想做的事（多模型 + cache + tool_use）|
| **B. 自己写 `notion-agent-cli`** | 新建 npm/pipx package：调 Notion API + 复用 `src/llm_agent/prompts/` + Anthropic Messages stream + tool_use（query Notion databases） | +1-2 天 | 与 mockup 完全对齐，但 Notion Custom Agent 的真实 "Read 用户 workspace" 能力其实是 token_v2 cookie 反向用 web internal API，**违反 Notion ToS**。不建议 |
| **C. 保留 backend 抽象，V1 仅 stub** | BackendSelector UI 完整出（保留 Notion Agent 行 + Custom API 行），但 Notion Agent 行点击 toast "V1.5 开放，请用 Custom API"；ai_chat_sessions.backend_kind 字段保留 | 同 A | 视觉与 mockup 对齐 + 工作量同 A。介于 A 和 B 之间 |

**Self 推荐 A**：
- CRS 多模型已覆盖 "用户切 backend" 的真实需求（claude-* / gpt-* / gemini-*）
- "Read 用户 Notion workspace" 走 Notion 官方 API（前端可以加 `<NotionContextPicker>` 让用户挑要参考的 Notion page 显式注入 prompt），不靠假想 CLI
- V1 后用户用了真觉得缺 Notion Agent 再加 V1.5（B 方案，付得起 Notion 官方 API 鉴权工夫）

**修订动作（待你拍板后执行）**:
- 方案 A: 修 `README.md / DESIGN.md §6.1 / ARCHITECTURE.md §2.2 / PROJECT-PLAN.md Sprint 4 / BACKEND-INTERFACES.md §4.5.1` 删除 Notion Agent 路径；保留 `backend_kind` 字段为 future-proof
- 方案 C: 同 A 但 UI 保留行（点击 toast V1.5 提示）
- 方案 B: PROJECT-PLAN.md Sprint 4 加 "Sprint 4.1 - 自写 notion-agent-cli wrapper（1-2 天）"

---

### C-01 — Cloudflare JWT 校验代码跑不起来（REMOTE-ACCESS.md §6.3）
**Source**: codex 2 (Cloudflare 安全 review) + self
**位置**: `REMOTE-ACCESS.md:248-265`

```python
_jwks = httpx.get(f"https://{CF_TEAM_DOMAIN}/cdn-cgi/access/certs").json()
# 1. 模块加载时同步阻塞 — uvicorn 启动若 CF 慢，整服务 hang
# 2. 永不刷新 — CF key rotation 后所有请求 403 直到重启
# 3. jwt.decode(token, key=_jwks, ...) 把 JWKS dict 整个当 key 传 — PyJWT 不接受这种形态
# 4. 仅校 audience，未校 iss / nbf
```

**Fix**（已写入文档）:
```python
from jwt import PyJWKClient
_jwk_client = PyJWKClient(f"https://{CF_TEAM_DOMAIN}/cdn-cgi/access/certs", cache_keys=True, lifespan=3600)

async def verify_cf_access(request: Request):
    token = request.headers.get("Cf-Access-Jwt-Assertion")
    if not token: raise HTTPException(401, "no access JWT")
    try:
        signing_key = _jwk_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token, key=signing_key.key, algorithms=["RS256"],
            audience=CF_AUDIENCE,
            issuer=f"https://{CF_TEAM_DOMAIN}",
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
        request.state.user_email = claims.get("email")
    except jwt.PyJWTError as e:
        raise HTTPException(403, f"access JWT invalid: {e}")
```
`PyJWKClient` 自动按 `kid` 缓存 + unknown kid 时 refresh，covers rotation。

---

### C-02 — CLI runner 退出码分发不完整 + stdout 既流又解析（BACKEND-INTERFACES.md §1.6）
**Source**: codex 1 (CLI runner review)
**位置**: `BACKEND-INTERFACES.md:121-141`

问题：
1. `execa()` 默认非 0 退出 reject Promise，`if (exitCode !== 0) throw` 分支不可达。
2. `catch` 仅识别 `exitCode === 9`，未分发 1/2/4/5/6/7/8/130。
3. 同一 `stdout` 既 streaming 转发又最后 `JSON.parse(stdout)` —— stdout 混入非 JSON 日志或被截断时无 fallback。
4. 每次调用立即 fork，无限流；SQLite WAL 读并发未在 runner 层保护。
5. macOS venv 启动延迟（Spotlight）未缓解；`mailagent` 应缓存绝对路径。

**Fix**（已重写 §1.6 代码示例）: 引入 `CliQueue` + `AbortController` + 分类限流 + 全退出码分发 + stderr/stdout 分流 + path cache。详见 BACKEND-INTERFACES.md §1.6 修订后代码。

---

### C-03 — `useMailApi()` 抽象 vs Electron IPC handler 直查 SQLite 双源真相
**Source**: self
**位置**: `BACKEND-INTERFACES.md:282-300` + `ARCHITECTURE.md:182-204`

问题：Electron main 进程直 `db.prepare('SELECT * FROM email_metadata ...').all(...)` 返回 raw rows；Python 端 `EmailRepository` 同样 SELECT 但走 dataclass 转换 + AI 字段映射。后端 mail-sync 加列（如新 AI 字段 / DB_VERSION 升级）时 TypeScript 端 IPC handler 不会同步 —— 真实数据形状漂移。

**Fix**（已加进 ARCHITECTURE.md §6 契约边界 + Sprint 0 checklist）:
- Sprint 0 加任务：从 `docs/cli-schema/email-list.schema.json` codegen `EmailMeta` TypeScript interface（用 `json-schema-to-typescript`），与 Python `EmailRepository` 共 SoT。
- Electron IPC handler 不直接返 raw rows；通过 thin DAO 层映射为 schema-validated EmailMeta。
- V1 末期评估 "全部走 CLI fork" 替代直读 better-sqlite3（牺牲 ~4ms 命中换 schema 一致性）。

---

### C-04 — Sprint 4 AI Chat panel 估算严重低估（2-3 天 → 6-9 天）
**Source**: codex 3 (AI Chat panel review) + self
**位置**: `PROJECT-PLAN.md:119-141`

漏掉的子任务（codex 3 揭示）:
1. **Electron main IPC bridge** — API key 不能进 renderer bundle；CRS 直连需走 main process subprocess pipe + IPC stream chunks。
2. **新写 chat LLM 层** — 现有 `src/llm_agent/processor.py:LLMProcessor.process_email` 是批处理 tool_use（Anthropic 非流式 + OpenAI 仅累积 tool args），不能直接复用做 chat stream。需新写 chat wrapper + IPC stream handler + 取消/重试 + React `useEmailChat` hook。
3. **状态机粒度** — `ai_sessions(messages_json)` 太粗（PROJECT-PLAN.md 提案）；应改 `ai_chat_messages(session_id, email_id, role, content, tokens, cost, model, status, error, created_at)` + 处理：长线程截断/摘要、切邮件中断、网络断开、quota exceeded 四个 case。

**Fix**（已修 PROJECT-PLAN.md §2 Sprint 4 任务列表 + §0 总览工作量 + §6 风险表 + README.md §2.2）:
- Sprint 4 工作量从 2-3 天调整为 **6-9 天**
- V1 总工作量从 12-16 天调整为 **16-21 天**
- Sprint 4 任务列表加 "Electron main process IPC stream bridge" 独立项
- 推荐技术栈：自实现 `useEmailChat` hook，**不依赖** `vercel/ai`（除非自写 custom transport 对接 IPC）

---

### C-05 — AI Chat `ai_sessions` 表违反后端 DB_VERSION 升级流程
**Source**: self
**位置**: `PROJECT-PLAN.md:141` + `BACKEND-INTERFACES.md:256-257`

CLAUDE.md 写 `DB_VERSION=6` 由 mail-sync 拥有；前端不能直接 alter `data/sync_store.db` schema —— 若做了，mail-sync 启动 schema check 会失败。

**Fix**（已修 PROJECT-PLAN.md Sprint 4 + BACKEND-INTERFACES §4.1 注释 + ARCHITECTURE.md 加新章节）:
- 推荐方案 (a): **前端单独 SQLite DB** `~/.mailagent/frontend/ai_chat.db`，前端独立维护 schema_version，与 mail-sync 互不干扰。
- 备选方案 (b): mail-sync 升级 DB_VERSION 7 + ai_chat_messages migration（需后端配合，留 V1.5 议题）。
- Sprint 4 任务列表删 "SQLite 新建 `ai_sessions` 表 ... Sprint 4 末写 migration"，改为 "前端独立 SQLite（`ai_chat.db`）schema 设计 + 写入"。

---

### C-06 — 三态主题 `applyResolvedTheme()` race condition（DESIGN.md §17.3）
**Source**: codex 4 (三态主题 review)
**位置**: `DESIGN.md:1362-1383`

`setThemeMode()` 和 `matchMedia change` 监听器都调 `applyResolvedTheme()`，无 op-id / coalescing guard —— 用户手切的瞬间系统也变 dark/light 时双触发，state vs DOM 不一致。

**Fix**（已修 §17.3 + 配套加 §17.3.1）:
```typescript
let opCounter = 0;
function applyResolvedTheme() {
  const myOp = ++opCounter;
  requestAnimationFrame(() => {
    if (myOp !== opCounter) return;   // 较新 op 已 enqueue，丢弃旧
    const { themeMode } = useAppearance.getState();
    const resolved = themeMode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : themeMode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    useAppearance.setState({ resolvedTheme: resolved });
  });
}
```

---

### C-07 — 三态主题 FOUC / nativeTheme desync（DESIGN.md §17.3）
**Source**: codex 4
**位置**: `DESIGN.md:1386-1394`

初次启动 renderer 先 paint 默认 dark，再 IPC 给 main 设 `nativeTheme.themeSource` —— 存在 light flash 窗口（user 系统 light + localStorage 无值时 flash 30-100ms）。

**Fix**（已修 §17.3 + 加 §17.3.2 inline bootstrap）:
1. **Main process 启动顺序调整**：`BrowserWindow` 创建之前在 main process 读 localStorage proxy（用文件 fallback 或 Electron `settings`）→ 设 `nativeTheme.themeSource` → 再 createWindow。
2. **Renderer index.html 加 inline bootstrap script**:
   ```html
   <head>
     <script>
       (function() {
         var stored = localStorage.getItem('mailagent.themeMode') || 'system';
         var resolved = stored === 'system'
           ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
           : stored;
         document.documentElement.setAttribute('data-theme', resolved);
         document.documentElement.classList.toggle('dark', resolved === 'dark');
       })();
     </script>
     <style id="theme-bootstrap">html[data-theme="dark"]{background:#0E1013;color:#E8EAEE;}html[data-theme="light"]{background:#FAFAFA;color:#1A1D22;}</style>
   </head>
   ```
   首帧 DOM ready 之前就完成主题；与 next-themes 同思路但不引依赖。

---

### C-08 — light mode 视觉细节无人出 + Sprint 0 完工 checklist 与现实矛盾
**Source**: self
**位置**: `DESIGN.md:96-110, 1207` + `PROJECT-PLAN.md:81-83` + `mockup-inbox.html` (grep `data-theme="light"` 仅 1 处)

矛盾：
1. mockup-inbox.html 与 mockup-dynamic-island.html 都仅 dark 视觉（mockup 实测 grep 仅 1 处 light 痕迹，是 CSS 变量 fallback）。
2. DESIGN.md §15 第 5 点 "Open question: Light mode parity — when does it ship? Mockup is dark-only; light tokens are defined but not yet rendered. Sprint 1 candidate."
3. §17 三态升级为 V1 必做 + Sprint 0 完工 checklist 要求 "切换 themeMode = 'light' / 'dark' / 'system' 三态都能跑"
4. Sprint 7 才 `pnpm a11y:contrast` 验证 18 组合 —— 前 6 sprint 期间 light mode 视觉可能崩。

**Fix**（已修 DESIGN.md §15 第 5 点 + §17 + PROJECT-PLAN.md Sprint 0 checklist + Sprint 1 任务）:
- §15 第 5 点关闭，重写为 "light token 已就位但视觉验证滞后 —— Sprint 1 末必须出 light mode mockup spot-check（10-15 个核心组件截图对比）"
- Sprint 0 完工 checklist 中 "切三态都能跑" 重新表述为 **"切换 themeMode 三态 DOM 立即响应（data-theme attribute + html class 同步），允许 light 视觉 unpolished"**
- Sprint 1 加任务 "Light mode visual spot-check：EmailRow / AIBadge / Toolbar / Composer / Sidebar 5 个核心组件双 mode 截屏对比"
- Sprint 7 `pnpm a11y:contrast` 提前到 Sprint 3 末（FTS5 + 翻译 ship 之前）

---

## 2. High findings — Sprint 0-1 内必修

### H-01 — WCAG 18 组合 lint 脚本未落地实现（DESIGN.md §17.6）
**Source**: codex 4
**Fix**: §17.6 补：
```bash
# scripts/a11y_contrast.ts (Playwright + @axe-core/playwright)
for accent of [coral, cobalt, teal, rose, slate, olive]:
  for mode of [light, dark]:
    for route of [/inbox, /search, /admin, /llm]:
      page.goto(route)
      page.evaluate(({mode, accent}) => {
        document.documentElement.dataset.accent = accent;
        document.documentElement.dataset.theme = mode;
        document.documentElement.classList.toggle('dark', mode === 'dark');
      })
      const violations = await AxeBuilder({page}).withTags(['wcag2aa']).analyze()
      if (violations.length) process.exit(1)
```
**注**: 6 × 2 × N route = 真实组合数；DESIGN.md "18" 的口径仅 6 accent × 3 mode（含 system，但 system resolve 后等于 light 或 dark），实际验证 6 × 2 = 12 组合。文案改为"12 visual + 6 system fallback = 18 路径"或简化为 "12 必验组合"。

---

### H-02 — CJK lint 仅 warning 且 i18n 字符串豁免（DESIGN.md §16.6）
**Source**: codex 4
**Fix**: §16.6 修订 lint 实现:
- ESLint plugin 解析 `t('key')` → 查 zh-CN/*.json 对应值 → 若该字符串在 JSX 节点用了 `text-micro`/`text-meta` className，CI **error**（非 warning）。
- Stylelint 阻 `@media (prefers-color-scheme)` 直接出现在组件 CSS（必须走 `data-theme` SoT）。

---

### H-03 — i18n Intl wrapper 边界未定义（DESIGN.md §16.5）
**Source**: codex 4 + self
**Fix**: §16.5 加 sub-section：
- **TZ 策略**: 用户端 macOS 本地时区显示；后端 ISO8601 with timezone offset 传输；wrapper `formatDate` 接受 ISO + locale，内部 `Intl.DateTimeFormat({timeZone: undefined})` 让浏览器/Electron 自动 resolve 本地。
- **相对时间**: `Intl.RelativeTimeFormat` + threshold table（< 1min → "刚刚"，< 1h → "X 分钟前"，< 24h → "X 小时前"，> 24h → 绝对日期）。
- **logical CSS props**: 用 `padding-inline-start` 替代 `padding-left`，预留 RTL；V3 RTL 实施时不用改组件。

---

### H-04 — "4 层防御"是误称（REMOTE-ACCESS.md §6.4）
**Source**: codex 2
**位置**: `REMOTE-ACCESS.md:269-282`

CF Access OAuth 与 FastAPI JWT 都依赖同一 CF Access JWT/JWKS —— bypass/misconfig 一边等于 bypass 两边。CF 边缘 HTTPS 与 bind 127.0.0.1 是网络配置不算"鉴权层"。

**Fix**（已修 §6.4 + §6.5 新增）:
- 改述为 "**纵深 2 层独立鉴权**（CF Access OAuth + FastAPI JWT 共享 JWKS 是同一 SoT，并不互相验证；2 层是为防 tunnel 误配 leak）" + "**3 层外围加固**（HTTPS / bind 127.0.0.1 / CF WAF rate limit policy）"。
- 新增 §6.5: CF WAF rate limit 配置 —— 每 IP `/api/*` 60 req/min；每 user_email 600 req/min。

---

### H-05 — SSE/WebSocket 鉴权过期未设计（REMOTE-ACCESS.md §11）
**Source**: codex 2
**Fix**: V2.1 SSE 实施时:
- EventSource 不能塞 header → 必须靠 cookie `CF_Authorization`；CF Access 默认 SameSite=Lax 跟随 same-origin OK。
- JWT 过期 5 min 前主动 close connection → client 走 Access OAuth 重新 issue cookie → 新 EventSource。
- 已加入 §11 "V2.1 议题" 说明。

---

### H-06 — CLI runner 缺并发限流 + WAL 读保护
**Source**: codex 1
**Fix**: 已重写 BACKEND-INTERFACES.md §1.6（见 C-02）:
```typescript
class CliQueue {
  private readSem = new Sem(4);   // 读最多 4 并发
  private writeSem = new Sem(1);  // 写串行
  // 同时 PM2 mail-sync online 时写命令 fail-fast (exitCode 9 检测)
}
```

---

### H-07 — CLI runner Spotlight 启动抖动
**Source**: codex 1
**Fix**: 已合并到 §1.6 重写代码 —— 启动时 `which mailagent` 一次缓存绝对路径，execa 直传绝对路径（避免 PATH 解析 + Spotlight 抓 venv）。

---

### H-08 — Sprint 0 ESLint 自定义 rule 任务缺失
**Source**: self
**位置**: `PROJECT-PLAN.md:75` Sprint 0 + `DESIGN.md:1175-1186` §14

§14 列了 8 条 lint 非协商项 + §16/§17 加 i18n + 主题第 9 / 10 条，但 Sprint 0 任务列表没有"搭 ESLint 自定义 rule 骨架"。Sprint 7 才检 `pnpm lint:design`，前 6 sprint 代码必然累积违规。

**Fix**（已修 PROJECT-PLAN.md Sprint 0）:
Sprint 0 加任务: "**搭 ESLint 自定义 rules 骨架（10 条非协商项每条至少 1 个 fixture test）**"，依赖 `eslint-plugin-local-rules` 或单独 npm workspace。Sprint 1 末 CI 引入。

---

### H-09 — ISLAND-PLUGIN 与 PROJECT-PLAN 模块布局不一致
**Source**: self
**位置**: `ISLAND-PLUGIN.md:286-301` vs `PROJECT-PLAN.md:215-221`

ISLAND-PLUGIN §4.1: 4 文件 `ping_island.py / island_dispatch.py / island_response.py / island_snooze.py`。
PROJECT-PLAN Island-Sprint 2 仅说 `island_plugin.py` 一个文件。

**Fix**（已修 PROJECT-PLAN.md §3 Island-Sprint 2）: 任务列表统一为 4 文件，每个独立列任务项。

---

### H-10 — ISLAND-PLUGIN §2.5 MailAgentSessionView "Sprint 1 不依赖" 乐观
**Source**: self
**位置**: `ISLAND-PLUGIN.md:131-148`

SwiftUI ~150 行新增 + 邮件专属 chip 字段差异（Mail session 跟 Claude/Codex session 字段集差很大），ping-island 默认 session view 显示 mail 字段会糊。

**Fix**（已修 ISLAND-PLUGIN.md §2 + PROJECT-PLAN.md §3 Island-Sprint 1）:
- "5 个文件 < 200 行 diff" 改为 **"6 个文件 ~150-300 行 diff"**
- Island-Sprint 1 工作量从 1.5-2 天调到 **2-3 天**（含 MailAgentSessionView 至少骨架）

---

### H-11 — `mailagent.notionPageId` envelope 字段 dash 不一致
**Source**: self
**位置**: `ISLAND-PLUGIN.md:208, 269`

§3.2 示例 `"31a15375830d81798e75fcfce933808b"` 是 32-hex 无 dash；§3.4 用 `page_id.replace('-', '')` 但没 dash 可 replace。

**Fix**（已修 §3.2）: envelope 字段统一为 UUID-with-dash 格式 `"31a15375-830d-8179-8e75-fcfce933808b"`，让 §3.4 的 `.replace('-', '')` 真起作用（`open notion://` URL 需要 dashless）。

---

### H-12 — ISLAND-PLUGIN §3.4 AppleScript 语法错误
**Source**: self（codex 5 review 中）
**位置**: `ISLAND-PLUGIN.md:266`

```python
subprocess.run(["osascript", "-e", f'tell app "Mail" to open message id {internal_id}'])
```
Mail.app AppleScript 用 `message id "<message-id-string>"`（字符串，不是 internal_id 整数）。参考 `src/mail/applescript_arm.py:fetch_email_content_by_id` 已经用 `whose id is <int>` —— 那是 `message` class 的 SQLite ROWID 整数属性，AppleScript 写法是：
```applescript
tell application "Mail"
  set m to first message of mailbox "收件箱" of account "..." whose id is <int>
  open m
end tell
```

**Fix**（已修 §3.4）: 改成完整正确的 AppleScript 调用；从 `src/mail/applescript_arm.py` 复用 helper 函数 + envelope metadata 加 `mailagent.accountName` / `mailagent.mailboxName` 字段。

---

### H-13 — L2 Island vs L1 Sprint 4 端到端联调依赖描述矛盾
**Source**: self
**位置**: `PROJECT-PLAN.md:21-23, 254-256`

§0 表 "L2 Island Hybrid与 L1 完全并行，Day 1 可起" 与 §3 "Island-Sprint 4 需要 V1 Electron 已 ship" 矛盾。

**Fix**（已修 §0 表 + §3 Island-Sprint 4 说明）:
"L2 Island-Sprint 1-3 与 L1 完全并行，Day 1 可起；Island-Sprint 4 联调依赖 L1 Sprint 5（Electron main + CLI runner 沉淀）"

---

### H-14 — "11 AI fields" 实际只 6-8 个（BACKEND-INTERFACES.md §8）
**Source**: self
**位置**: `BACKEND-INTERFACES.md:363-379`

11 个里仅 4 个是 LLM 真输出（AI Action / AI Priority / AI Review Status / Sentiment）；其余是 Notion property 或 V1.5 候选（Action Items / Tags）。"3×11 grid" 误称。

**Fix**（已修 §8 + DESIGN.md §5.0）:
表头改为 "**8 fields rendered in V1 grid + 3 候选 V1.5**"，并把 V1.5 候选清楚标出。mockup-inbox.html grep "AI Fields" 仅 1 处 —— Sprint 1 末 schema/mockup 对账时校对。

---

### H-15 — Notion Custom Agent (Email Agent) vs 本地 LLM 双跑撞车（CLAUDE.md）
**Source**: self（跨 backend + frontend）
**位置**: `CLAUDE.md` "LLM Agent" 段

CLAUDE.md 写："本地 LLM + Notion Custom Agent 都盯同一张页面，必须让其中一边退出，二选一"。前端 Sprint 4 的 AI Chat panel 一旦上线，**第三方**进入这张页面 —— Notion Custom Agent 已经按 `Processing Status = 未处理` 跳过本地 LLM 处理过的；但前端 AI Chat 会改 `messages_json` 不会改 Processing Status，理论上 Custom Agent 不会重复触发。

**Fix**（已加 PROJECT-PLAN.md §6 风险表）: 加 risk "AI Chat panel 写回 11 AI fields 时可能与 Notion Custom Agent 冲突 —— 验证 Sprint 4 用例：先关 Notion Email Agent（方案 B）再启用 AI Chat panel 双写回（更安全）"。

---

### H-16 — Island plugin socket send/EOF 无 timeout，fail-open 不成立（ISLAND-PLUGIN.md §3.1 + §4.4）
**Source**: codex 5
**位置**: `ISLAND-PLUGIN.md:180-189` + `:351-357`

`connect → write → shutdown(SHUT_WR) → read until EOF → close` 协议要求 Python 端等 Swift 端 EOF。`§4.4` 只列 ENOENT/ECONNREFUSED，没列 timeout。Swift 端如果 hang（例如 NIO event loop blocked），Python `recv()` 永久阻塞 —— `asyncio.create_task(fire-and-forget)` 实际变成"静默吞 task"。

**Fix**（已修 ISLAND-PLUGIN.md §3.1 + §4.4）:
```python
import socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(3.0)   # connect + send + recv 共享 3s deadline
try:
    sock.connect(SOCK_PATH)
    sock.sendall(envelope_bytes)
    sock.shutdown(socket.SHUT_WR)
    response = b""
    while chunk := sock.recv(4096):
        response += chunk
        if len(response) > 1 << 20: raise ProtocolError("response too large")
except (socket.timeout, FileNotFoundError, ConnectionRefusedError, OSError) as e:
    log.debug("island dispatch failed (fail-open): %s", e)
finally:
    sock.close()
```

---

### H-17 — Island socket sleep/wake/restart 无自动重连（ISLAND-PLUGIN.md §4.4）
**Source**: codex 5
**位置**: `ISLAND-PLUGIN.md:351-357`

macOS 睡眠 / ping-island restart 后 `/tmp/island.sock` 文件被清理。当前 `fire-and-forget` 单次失败就丢；用户睡眠醒来后第一封紧急邮件不通知。

**Fix**（已修 §4.4 + 新增 §4.5 重连策略）:
- 每 5 min 主进程检查 `os.path.exists(SOCK_PATH)`，若文件消失或上次 send fail 标记，触发 reconnect probe（轻量 `ping` envelope）。
- 内存维持 send queue（max 20 envelope）—— ping-island 重启期间 emit 入队，重连成功后 flush。
- Exponential backoff: 5s / 30s / 2min / 10min（上限），不无限重试避免日志炸。

---

### H-18 — Wire 协议缺 chunk framing + max-size（ISLAND-PLUGIN.md §3.1）
**Source**: codex 5
**位置**: `ISLAND-PLUGIN.md:180-189`

协议"双方都 buffer 到 EOF"假设 envelope < 1 MB，但 Swift NIO 默认 half-close 行为未文档化（NIO 1.x 与 SwiftNIO async API 不同；ping-island 用哪个）。理论上恶意巨大 envelope 可让 Python 端 OOM。

**Fix**（已修 §3.1 + 加 §3.1.1）:
- Python 端读 max 1 MiB 后强制 close + log warning。
- envelope size 设硬上限 64 KiB（足够覆盖正常邮件 metadata + subject）。
- 文档化 Swift NIO half-close 实现细节：`SwiftNIO 2.x` 用 `channel.flush()` + `channel.close(mode: .output)`，等价于 POSIX `shutdown(SHUT_WR)`。

---

## 3. Medium findings — 有空就修

### M-01 — `window.electron.send('appearance:theme')` 无 main handler（DESIGN.md §17.3）
**Fix**: 已加 IPC handler 转发到 Island plugin —— 见 ISLAND-PLUGIN.md §8 加 `ipcMain.on('appearance:theme', forwardToIsland)`。

### M-02 — i18n `mailagent.language` 值 "system" 不是有效 i18next locale
**Fix**: 已修 DESIGN.md §16.8 —— localStorage 仅存 user choice，i18n 实际 active language 由 resolver detect。

### M-03 — `text-aux` 14px vs `text-body` 14px 差异（DESIGN.md §16.6）
**Fix**: 已修 §16.6 表头加"语义"列 + §3.2 type scale 已含用途 —— 引用回 §3.2。

### M-04 — Island Sprint 1 工作量估算（"5 个文件 < 200 行 diff" → 实际 ~6 文件 ~150-300 行）
**Fix**: 见 H-10 已合并修。

### M-05 — Sprint 0 启动前 checklist 仅验 `notion-agent chat "hi" --json` 不验 stream + tool_use
**Fix**: 已修 README.md §5 + PROJECT-PLAN.md §8 启动前 checklist —— 加 "**`notion-agent chat <prompt> --json --stream` 跑通流式 + tool-call response 验证至少 1 个 tool 调用回执**"。

### M-06 — `ai_sessions` schema 跨文档不一致
**Fix**: 见 C-05 —— BACKEND-INTERFACES §4.1 删除 `ai_sessions`，改 `ai_chat_messages`（独立 SQLite `ai_chat.db`）。

### M-07 — Sprint 0 完工 checklist `useMailApi()` 与 Sprint 1 重复（PROJECT-PLAN.md:80）
**Fix**: 已修 Sprint 0 完工 checklist 表述 —— "useMailApi() 占位 throw 'not implemented'，组件能 import 不报错"。

### M-08 — Sprint 4 任务列表把 IPC bridge / CSP / API key 安全混在 "Notion Agent 后端实现" 一句话
**Fix**: 见 C-04 已重写 Sprint 4 任务列表（拆出 IPC bridge / API key 安全 / stream handler 独立项）。

### M-09 — Cloudflare Access "邮箱白名单只 1 邮箱" 多设备场景表述（REMOTE-ACCESS.md §6.2）
**Fix**: 已修 §6.2 step 4 —— "**Identity = Google OAuth 邮箱白名单**；同邮箱 session 30 天 per device（iPad/iPhone/借的电脑各自独立 session）"。

### M-10 — i18n 双语 review 在 Sprint 7 才做太晚
**Fix**: 已修 PROJECT-PLAN.md —— 每个 Sprint 完工 checklist 加 "i18n 字符串 review：扫存量 `[TODO en]` 并补 en-US 翻译"。

### M-11 — ISLAND-PLUGIN intervention.options 5 个 vs 灵动岛 UI 空间
**Fix**: 待 codex 5 Island review 回来确认 fork 上限；先在 §3.3 加 note "ping-island Phase 1 pill 单行最多显示 3 options；Phase 3 expand 后可显 5 options（按钮纵排）。MailAgent 5 个 option 全在 Phase 3 才点得到。"

### M-12 — V2.0 远端用户改完 Notion → 远端 polling 30s 才看到的体验问题（REMOTE-ACCESS.md §11）
**Fix**: 已修 V2 范围 §11 —— "V2.0 加入 light polling 5-10s（远端 web SPA 用 react-query refetchInterval）作为过渡，避免体验差；V2.1 引 SSE 实时推"。

### M-13 — Notion 桌面版未装时 `open notion://` deep-link fallback 未文档化（ISLAND-PLUGIN.md §3.4）
**Source**: codex 5
**Fix**: 已修 §3.4 —— 加 fallback `open https://www.notion.so/<workspace>/<page_id>` Web URL，并 try macOS Launch Services check 决定优先级。

### M-14 — i18n cache 切 locale 无失效机制（ISLAND-PLUGIN.md §7.3）
**Source**: codex 5
**Fix**: 已修 §7.3 —— `_cache[lang]` 改加 mtime 检查（或 ttl 5 min），切换 locale 时调 `_cache.clear()` 主动失效；同步加 `t.reload_locale(lang)` 公开 API。

### M-15 — `sentAt` Python 生成公式未在文档（ISLAND-PLUGIN.md §3.2）
**Source**: codex 5
**Fix**: 已修 §3.2 —— 在 `"sentAt": 770000123.456` 行下加 Python 公式 `sent_at = time.time() - 978307200  # 2001-01-01 00:00:00 UTC epoch`，IEEE 754 double 精度对 ±50 年范围毫秒级误差 < 0.1ms 足够。

---

## 4. Low findings — Sprint 0 启动前一次扫尾

| ID | 位置 | 问题 | Fix |
|---|---|---|---|
| L-01 | README.md §3 表 | "AI Chat panel 流式 token 指 DESIGN.md §6.2 §6.3" 但 §6.2 是 Message bubble shape 不是 stream | 改成 DESIGN.md §6.5 + §6.6 |
| L-02 | PROJECT-PLAN.md Sprint 2 | "list 340px" 没标 layout 总宽 | 加 "Sidebar 240 + List 340 + Detail flex-1 + AI 360 = 940px 最小窗宽" |
| L-03 | ARCHITECTURE.md §3.1 vs DESIGN.md §17.3 | `ipcMain.handle` vs `ipcMain.on` 用法不统一 | 明确每个 IPC channel 的语义：`handle` for request-response，`on` for fire-and-forget |
| L-04 | README.md §0 入口阅读顺序 | 顺序合理但 §3 表 "起 Sprint 0 工程脚手架" 引用比较杂 | 表头加 row 顺序号 |
| L-05 | README.md §7 跨文档相对链接 verify 脚本 | 写在 README 不在 CI | 加 GitHub Actions step `verify_links` |
| L-06 | README.md §5 启动前 checklist | v4 Phase 4 灰度切完未列 | 加 "`NOTION_READ_FROM_SQLITE=true` 灰度切完，至少 3 封实测验证" |
| L-07 | PROJECT-PLAN.md §3 Island-Sprint 工作量 | §0 表 "6-10 天 Swift + Python" 应明示各占多少 | "Swift ~3-4 天 + Python ~3-6 天" |
| L-08 | DESIGN.md §15 | 第 5 点 "Light mode parity" 关闭后未删 Open question | 关闭后从 Open questions 移除 / 标 RESOLVED |

---

## 5. Codex 独立 review 报告（全文摘录）

### 5.1 Codex CLI runner review（BACKEND-INTERFACES.md §1.6）— agent `a8704dd94d1aba386`

**Critical**:
- `frontend/BACKEND-INTERFACES.md:129-140`: `execa('mailagent', fullArgs)` 无 `AbortController` / `sub.kill()` / 窗口关闭 hook；Electron 关闭时在途子进程无清理路径，可能孤儿化。

**High（高风险边界）**:
- `:132-138`: execa 默认非 0 退出会 reject，`exitCode !== 0` 分支基本不可达；`catch` 仅处理退出码 `9`，未分发 `1/2/4/5/6/7/8/130`。
- `:130,133`: 同一 `stdout` 既被当日志流转发又整体做 `JSON.parse(stdout)`；stdout 混入日志或截断时无 fallback。
- `:126-129`: 每次调用立即 fork，无队列/限流；SQLite WAL 读并发未在 runner 层保护，写并发仅靠退出码 `9` 间接兜底。

**建议**: 改成集中 `CliQueue + AbortController`，按读/写分类限流，统一解析 `{stdout, stderr, exitCode}` 并覆盖全部退出码。Windows fork-bomb 风险未发现（`mailagent` 固定命令、无 `shell:true`/自递归）；macOS venv 风险未缓解，runner 未用绝对 venv 路径也无 timeout。

---

### 5.2 Codex Cloudflare 安全 review（REMOTE-ACCESS.md §6）— agent `ab66acf749410e433`

**Critical**: 文档级单看无确凿 critical（origin 是 `127.0.0.1:8200`，CORS 非 wildcard，JWT 限 RS256）。

**High**:
- JWKS 在 import 时拉取一次，CF key rotation 可导致服务中断直到重启；`jwt.decode(... audience=CF_AUDIENCE)` 无 `issuer=` 也无 kid miss 时 refresh。
- "4 layers" 夸大独立性：Access OAuth 与 FastAPI JWT 同依赖同一 CF Access JWT/JWKS，bypass/misconfig 一端等于 bypass 两端。
- 30 天 `CF_Authorization` 长 session 与长连接（SSE/WS）过期处理未设计：SameSite/refresh/re-auth/token-expiry behavior 缺失，SSE/WS 推到 V2.1 但无 token-expiry 设计。

**建议**:
- 用 `PyJWKClient`，按 `kid` 缓存，unknown key refresh 处理 CF rotation。
- 每次 JWT decode 要 `iss/aud/exp/nbf` + email claim 校验。
- 不要信任 `CF-Access-Authenticated-User-Email` header alone；都从 verified JWT claims 取 identity。
- FastAPI 保持 bind 127.0.0.1，加 startup assertion 让 misconfig 大声 fail。
- SSE/WS 在 JWT 过期前主动关闭 connection，让 client 走 Access 重新 auth，而不是 silently extend。

---

### 5.3 Codex AI Chat panel review（PROJECT-PLAN.md Sprint 4）— agent `abc65a7161b3e35be`

**漏掉的子任务**:
1. **Renderer 直连 CRS 风险未落地** — 计划只写"直连/pipe stdout 给 React"，但 API key 泄漏、CORS、CSP、证书、Abort 全部需要走 Electron main process IPC bridge，这是必须新写的一层。
2. **缺独立 Chat LLM 层** — 现有 `LLMProcessor.process_email` 只做 `classify_email` 工具调用，是批处理非流式路径；Anthropic 分支非流式，OpenAI 分支只累积 tool args，都不是 chat stream。需新写 chat wrapper + IPC stream handler + 取消/重试 + React hook，全部不在现有 `src/llm_agent/` 里。
3. **持久化与状态机粒度不足** — 计划的 `ai_sessions(messages_json)` 太粗；`llm_processing` 表是批处理审计表不应复用。需设计独立的 `ai_chat_messages(session_id, email_id, role, content, tokens, cost, model, status, error, created_at)`，加上长线程截断/摘要、切邮件中断、网络掉线、quota exceeded 四个状态机分支。

**重估工作量**: **6-9 天**（原估 2-3 天明显低估）。

**推荐技术栈**: Electron main 进程统一调用 CRS，用 IPC 推 token chunks 到 renderer。React 侧用自定义 `useEmailChat` hook；不建议直套 `vercel/ai`，除非自己实现 custom transport 对接 IPC。

---

### 5.4 Codex 三态主题 review（DESIGN.md §17）— agent `af3cfb328efb2f905`

**Critical bugs**:
- **Manual/OS race**: `setThemeMode()` 和 `matchMedia change` 都调 `applyResolvedTheme()`，无版本号/coalescing guard，瞬间双触发导致状态不一致。**Fix**: op-id + rAF 串行，只有最后一次 op 才 commit。
- **FOUC/native desync**: `resolvedTheme: 'dark'` 立即写 DOM，但 `nativeTheme.themeSource` 要等 renderer IPC，初次启动存在 light flash 窗口。**Fix**: 在 `BrowserWindow` 创建前设置 Electron `nativeTheme`，再用 inline bootstrap CSS 保证 renderer 首帧正确。

**High boundary gaps**:
- **WCAG 18 组合脚本未落地**: spec "18 = mode × accent"，不是 3 themes × 3 viewports × 2 langs，且只命名了 `pnpm a11y:contrast`，无 CI fail 逻辑。**Fix**: Playwright + `@axe-core/playwright` 循环 route/theme/viewport/lang，任一 violation 退出码非零 fail build。
- **CJK lint 仅 warning 且豁免 i18n 字符串**: `text-micro`/`text-meta` CJK 检测只是 CI warning，`t()` key 的 zh 值不被检查。**Fix**: ESLint/Stylelint 解析 `t()` key 到 zh JSON，对禁用字号报 error 而非 warning。
- **Intl wrapper 边界未定义**: 规范要求 wrapper 但无 TZ/相对时间/RTL 策略；`data-theme` 是 source-of-truth 但未禁止 `prefers-color-scheme` CSS 媒体查询与之混用。**Fix**: 明确 TZ 语义（macOS 本地 vs UTC+8）、RelativeTimeFormat 测试、logical CSS props、Stylelint ban `@media (prefers-color-scheme)`。

**Recommended libs**: `react-i18next` + `i18next-icu`（ICU plural/select，中文自动无复数）；`@axe-core/playwright`（CI WCAG 自动化）；避免 Electron 里用 `next-themes`，但可抄其 no-FOUC inline bootstrap 脚本逻辑。

---

### 5.5 Codex Island Bridge review（ISLAND-PLUGIN.md §2-§4）— agent `a419a1b89fd5cbb3c`（第二轮，第一轮 stub 失败）

**Critical**:
- `§3.1` 规定 `connect → write(<utf-8 JSON envelope>) → shutdown(SHUT_WR) → read until EOF → close`；§4.4 仅说 `socket 超时 → log.debug，不抛`，**没有显式设置 timeout/deadline**，EOF 等待可以永久阻塞而非 fail-open。→ 衍生 **H-16**
- `§4.4` 列举了 `ENOENT`/`ECONNREFUSED` 处理，但 **macOS sleep/wake 或 app 重启后 socket 文件被清理的场景没有提及**；`asyncio.create_task(...) fire-and-forget` 模式下 send 可被静默丢弃，无重连/退避保证。→ 衍生 **H-17**
- `§3.1` 说 Swift 端 `写完整个 BridgeResponse JSON → 关闭连接`，**没有 chunk framing 或 max-size 限制**，协议要求双方都 buffer 到 EOF，Swift NIO half-close 行为未文档化。→ 衍生 **H-18**

**High**:
- `§2` 列出了 5 文件，**`SessionLauncher.swift` 未列出**；并行 intent vs 劫持现有 intent 完全没说明（与 self H-10 重合，但 codex 进一步指出 `SessionLauncher` 这个具体文件未列）。
- `§3.4` 用 `tell app "Mail" to open message id {internal_id}`；**Mail.app 用 URL 而非整数 id 标识消息**（确认 self H-12），Notion 桌面未装时的 fallback 也没有文档 → 衍生 **M-13**。
- 跨文档矛盾：`PROJECT-PLAN.md` 只写 `src/notify/island_plugin.py`（1 个文件）；`ISLAND-PLUGIN.md §4.1` 列了 4 个文件，**谁是权威没说**（与 self H-09 重合）。§7.3 的 i18n cache 仅按 lang key 缓存，切换 locale 时缺少文件变更失效机制 → 衍生 **M-14**。`sentAt` double 精度对毫秒级没问题，但 Python 生成公式 (`time.time() - 978307200`) 在 §3.2 中并未提及 → 衍生 **M-15**。

**Suggested test cases**:
```python
def test_island_send_sets_timeout():
    assert fake_socket.gettimeout() is not None

def test_i18n_locale_switch_reloads_language():
    assert t("mail.received.title", sender="A", lang="zh") != t("mail.received.title", sender="A", lang="en")
```

**三条最高优先级行动项（codex 5）**:
1. **加显式 socket timeout**（H-16）: `socket.settimeout(3.0)` 或 `asyncio.wait_for(...)`，否则 Swift 端挂死会把 Python 线程永久 block。
2. **sleep/wake 自动重连**（H-17）: `/tmp/island.sock` 在 macOS 重启/睡眠后消失，fire-and-forget 不重试 = 静默丢通知 —— 需要 exponential backoff reconnect loop。
3. **AppleScript 语法错误**（confirm H-12）: Sprint 1 用真实 Mail.app 验证 `tell app "Mail" to open ...` 形态；正确 API 是 `open location "message://<message-id>"`（即 `message id` 走 URL scheme，不是 AppleScript Mail.app object accessor）。

---

## 6. 修订 commit 清单（准备 `git add` 的文件）

| 文件 | 修改类型 | 涉及 finding |
|---|---|---|
| `frontend/REVIEW-LOG.md` | 新建 | — |
| `frontend/REMOTE-ACCESS.md` | §6.3 重写 + §6.4 改述 + §6.5 新增 WAF + §11 加 SSE/light polling | C-01, H-04, H-05, M-12, M-09 |
| `frontend/BACKEND-INTERFACES.md` | §1.6 重写 + §4.1 改 ai_sessions → ai_chat_messages + §8 改 11 fields 描述 | C-02, C-03, C-05, H-06, H-07, H-14, M-06 |
| `frontend/PROJECT-PLAN.md` | §0/§2 Sprint 4 工作量重估 + Sprint 0 加 ESLint rule 任务 + §3 Island-Sprint 1 工作量 + §6 风险表 + §8 启动前 checklist + §5.4 i18n 每 Sprint review | C-04, C-05, C-08, H-08, H-09, H-10, H-13, H-15, M-05, M-07, M-08, M-10, L-07 |
| `frontend/DESIGN.md` | §15 第 5 点关闭 + §16.5/§16.6/§16.8 i18n 边界 + §17.3 race+FOUC fix + §17.6 WCAG lint | C-06, C-07, H-01, H-02, H-03, M-02, M-03 |
| `frontend/ISLAND-PLUGIN.md` | §2 fork 改 6 文件 + §3.1 wire framing/timeout + §3.2 sentAt 公式 + §3.4 osascript fix + Notion fallback + §3.3 options 空间说明 + §4.1 模块布局 + §4.4 timeout + §4.5 reconnect + §7.3 cache invalidation + §8 IPC handler | H-09, H-10, H-11, H-12, H-16, H-17, H-18, M-01, M-11, M-13, M-14, M-15 |
| `frontend/ARCHITECTURE.md` | §6 契约边界 + §2.2 codegen 说明 + §3 流图 Sprint 4 IPC bridge | C-03, C-04 |
| `frontend/README.md` | §2.2 工作量 + §3 引用修 + §5 checklist 补 v4 Phase 4 + §0 入口顺序 | C-04, L-01, L-06 |
| `frontend/archive/README.md` | 不动（archive 只读） | — |
| `frontend/mockup-*.html` | 不动 | — |

---

## 7. Rejected 建议

以下建议自己 review 或 codex 提了但 reject，附理由：

### R-01 — 改回 Postgres / 上 S3
**理由**: REMOTE-ACCESS.md §1 已论证。SQLite SSoT 不动 + cloudflared 性能足 + 离线 OK。Postgres 路径迁移代价远超收益。**Keep current 决策**。

### R-02 — Tauri 替代 Electron
**理由**: archive/frontend-v1-tech-tradeoffs.md 已评估。Tauri 在 macOS 跑稳，但 better-sqlite3 / keytar / execa 生态在 Electron 更成熟 + 团队熟。**Keep Electron**。

### R-03 — V1 也走 CLI fork（不直读 better-sqlite3）
**理由**: C-03 finding 提议候选方案。~4ms 命中 vs ~200ms CLI 启动有明显体验差。先用 codegen 同步 schema，未来若 Python schema 变更频繁再切。**先 codegen，不切 CLI**。

### R-04 — `vercel/ai` SDK 替代自写 useEmailChat
**理由**: codex 3 reject。Vercel AI 假定 Web fetch transport；Electron IPC 需要 custom transport adapter，工作量 ≈ 自写。**Keep 自写 hook**。

### R-05 — 主题持久化跨设备同步
**理由**: DESIGN.md §17.7 已 explicit 排除 —— 远端 Web 与本机 Electron 各自 localStorage，不强同步。同步引入跨进程 conflict resolution 复杂度。**Keep 各自独立**。

### R-06 — 灵动岛通知 fail-open 改 fail-loud
**理由**: ISLAND-PLUGIN.md §4.4 已论证。ping-island 是通知增强层，main mail-sync 不能因 island down 阻塞或告警。**Keep fail-open silent**。

### R-07 — Sprint 0 加更多脚手架检查（如 husky pre-commit / tsc strict 全设）
**理由**: Sprint 0 已紧（1-2 天），加 husky / strict 全设让 Sprint 0 拖到 3 天。这些项放 Sprint 1 一起做。**Keep Sprint 0 minimal**。

### R-08 — V1 加 mobile responsive layout
**理由**: V1 仅 Electron + V2 Web SPA 通过 iPad/iPhone 用，iPad 实际是大屏 + 桌面布局即可；mobile responsive 是 V2.1 议题不在 V2.0 范围。**Keep V1 desktop-only**。

---

> 本文档随后续 codex 5 Island Bridge review 回来追加 §5.5 详细。Sprint 0 启动当天起，**新发现的 issue 在 PR 评论 + commit message 处理**，不再回填本日志（一次性 review snapshot）。
