# MailAgent 安装与首次配置指南

> 面向最终用户的安装手册。开发者文档见 [README.md](./README.md);
> Sprint 8 ship: macOS .dmg + auto-updater + GitHub Releases。

---

## 0. 适配范围

| 项 | 说明 |
|---|---|
| 操作系统 | macOS 12 Monterey 及以上(Apple Silicon + Intel x64 双架构) |
| 后端 | 同一台机器需先跑通 `mail-sync` 主同步服务(see `../CLAUDE.md`) |
| 邮件客户端 | macOS 自带 Mail.app(已添加邮箱账户) |
| 网络 | 首次启动需联网验证 LLM 网关 + Notion API |

签名:**ad-hoc 签名**(没有 Apple Developer ID)。首次打开 .dmg 时
macOS Gatekeeper 会拦,需 **右键 → 打开 → 信任**。后续版本通过 in-app
auto-updater 静默升级。

---

## 1. 后端 (`mailagent` CLI + mail-sync) 准备

前端是后端服务的 GUI。安装前先确保后端跑通。

### 1.1 克隆仓库 + 虚拟环境

```bash
git clone https://github.com/chenyqthu/MailAgent.git ~/Documents/MailAgent
cd ~/Documents/MailAgent
python3 -m venv venv
source venv/bin/activate
pip install -e ".[cli,dev]"
```

`pip install -e .[cli]` 把 `mailagent` 命令装到 venv,`-e` 让代码改动立刻生效。

```bash
which mailagent     # 应该指向 venv/bin/mailagent
mailagent --version # 3.0.0
```

如果 `mailagent` 找不到:激活 venv 或显式设 `MAILAGENT_BIN` 环境变量。

### 1.2 配置 `.env`

参考 `.env.example`,至少填:

- `NOTION_TOKEN` / `EMAIL_DATABASE_ID` / `CALENDAR_DATABASE_ID` — Notion 集成
- `USER_EMAIL` / `MAIL_ACCOUNT_NAME` — Mail.app 账户
- `LLM_API_KEY` — LLM 网关(本地 `crs.chenge.ink` 或自托管)
- 可选:`FEISHU_*` 飞书通知、`REDIS_URL` Notion webhook

详细字段语义看根目录 `CLAUDE.md` §配置项。

### 1.3 Mail.app 自动化权限

MailAgent 通过 AppleScript 操作 Mail.app(标已读/旗标/创建草稿)。首次跑会
被 macOS 拦,需手动放行:

1. 打开 **系统设置 → 隐私与安全性 → 自动化**
2. 找 `MailAgent`(首次跑后会出现),勾选下方的 `Mail` 子项
3. 同样勾选 `osascript` 下的 `Mail`(命令行调用路径)

若 macOS 没自动弹出权限提示:运行一次 `mailagent debug mail-structure`
触发权限请求,然后到上述位置勾选。

### 1.4 启动后端

```bash
# 前台跑(开发模式)
python3 main.py

# PM2 后台跑(推荐生产)
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3
pm2 logs mail-sync --lines 30 --nostream
```

确认日志里没有 `ERROR` 行,SQLite 雷达每 5s 跑一次。

---

## 2. 安装 MailAgent 桌面 App

### 2.1 下载 .dmg

到 [GitHub Releases](https://github.com/chenyqthu/MailAgent/releases)
找最新版本,下载对应架构:

- **Apple Silicon**(M1/M2/M3/M4 Mac):`MailAgent-x.y.z-arm64.dmg`
- **Intel Mac**:`MailAgent-x.y.z-x64.dmg`

不确定?**苹果菜单 → 关于本机 → 处理器**:写 `Apple M*` 是 ARM,
`Intel Core` 是 x64。

### 2.2 装到 Applications

1. 双击下载到的 `.dmg` 文件
2. 把 `MailAgent` 图标拖到 `Applications` 文件夹
3. 第一次启动:**右键 → 打开 → 仍然打开**(ad-hoc 签名 Gatekeeper 提示)
4. 弹出 macOS 权限请求时点 **允许**:Documents 文件夹访问、自动化权限

后续从 Launchpad 或 Spotlight (⌘Space → "MailAgent") 直接启动。

### 2.3 完全磁盘访问(可选但推荐)

`sync_store.db` 默认在 `~/Documents/MailAgent/data/`,Documents 权限弹窗
已经够用。如果你把 db 路径改到了 `~/Library/...` 等受保护目录,要手动加:

**系统设置 → 隐私与安全性 → 完全磁盘访问权限 → +** 加 `MailAgent.app`

---

## 3. 首次配置(应用内)

启动 MailAgent 后侧边栏点 **设置**(or `⌘,` 快捷键)。

### 3.1 Appearance(外观)

- **主题模式**:Light / 跟随系统 / Dark — 默认跟随系统
- **强调色**:6 种 swatch(coral 默认 / cobalt / teal / rose / slate / olive)

### 3.2 Inbox(收件箱)

- **轮询频率**:5s(默认)/ 10s / 30s / off。轮询关掉时仍能手动刷新。

### 3.3 AI Backends(AI 后端)

| 字段 | 怎么填 |
|---|---|
| Notion Agent page_id | `notion-agent agents list` 输出的 UUID;空着也行,Custom API 兜底 |
| Notion Agent 显示名 | 自定义(例 `Jarvis`),仅 UI 显示 |
| Custom API 端点 | OpenAI 兼容网关 base URL,例 `https://crs.chenge.ink` |

`notion-agent` CLI 需另外装:

```bash
pipx install notion-agent-cli
notion-agent init      # 首次登录 Notion OAuth
notion-agent agents list
```

### 3.4 Secrets(密钥)

三个槽位,值经 `keytar` 写入 macOS 钥匙串,**不进任何文件**:

| 槽位 | 用途 | 来源 |
|---|---|---|
| **CLI API Key** | 写命令(重传 Notion / AI 重跑 / 标记)鉴权 | 后端 `.env` 里 `MAILAGENT_CLI_API_KEY` |
| **LLM API Key** | 一键翻译 + Custom API chat backend | LLM 网关 key(例 CRS `cr_xxx`) |
| **Custom API Key** | 自托管 OpenAI 兼容端点(与 LLM 同 key 时复用) | 网关 key |

填好 LLM 密钥后点 **测试网关** 验证联通。

### 3.5 Storage(存储)

- **数据库路径**:默认 `~/Documents/MailAgent/data/sync_store.db`。
  改路径会重启读取链;只支持绝对路径,`..` 段会被拒。
- **附件根目录**:默认 `~/Documents/MailAgent/data/attachments`。

### 3.6 应用更新

About 旁边的 **应用更新** 区:

- 当前版本:`v0.0.1`(实时从 `app.getVersion()` 读)
- 渠道:GitHub Releases · ad-hoc 签名
- **检查更新** 手动触发;有新版本时按 **下载更新** → **重启并安装**

启动后 10 秒自动检查一次。打包后(`pnpm build:mac`)走真 release feed;
dev 模式禁用,显示 `Auto-updater disabled in dev` 灰示。

---

## 4. 日常使用

| 快捷键 | 行为 |
|---|---|
| `?` | 全局 — 打开快捷键帮助 |
| `⌘K` | 全局 — 命令面板(切邮箱 / 搜邮件 / 跳路由) |
| `⌘,` | 全局 — 打开设置 |
| `J` / `K` | 收件箱 — 上/下一封 |
| `R` | 邮件行 — AI 起草回复 |
| `T` | 邮件行 — 翻译当前邮件 |

完整快捷键表 `?` 弹窗里看,Sprint 7 起 keymap 是 SSoT,
即时显示全部 binding + "soon" pill 标未接通项。

---

## 5. 故障排查

### 5.1 App 启动后窗口空白 / 报 `mailagent CLI not on PATH`

- venv 没激活就启动了 .app。两种修法:
  - 在 venv 激活的 shell 里 `open /Applications/MailAgent.app`
  - 或者设系统级 `MAILAGENT_BIN`:`launchctl setenv MAILAGENT_BIN "$(which mailagent)"`,然后重启 app

### 5.2 `sync_store.db not found`

- 后端 mail-sync 还没跑过,`data/sync_store.db` 不存在。先按 §1.4 启动后端。

### 5.3 Mail.app 自动化失败 / `macOS 自动化权限被拒`

- 看 §1.3 第二步,设置 → 隐私与安全性 → 自动化,勾上 MailAgent + Mail。
- 如果列表里没 MailAgent,先在 app 内点一次 **起草回复**(任意邮件),
  权限请求会弹。

### 5.4 LLM 网关测试失败

- LLM API Key 未填或失效。从 `crs.chenge.ink` 重发 key,粘进设置 →
  Secrets → LLM API Key → 保存 → 测试网关。

### 5.5 想完全重置

```bash
# 关 app
osascript -e 'tell application "MailAgent" to quit'

# 清前端独立数据(AI Chat 会话历史 + 用户 settings)
rm -rf ~/.mailagent/frontend/
rm -rf ~/Library/Application\ Support/MailAgent/

# 清钥匙串里 keytar 写的 3 个 secret
security delete-generic-password -s mailagent-cli-api-key 2>/dev/null || true
security delete-generic-password -s mailagent-llm-api-key 2>/dev/null || true
security delete-generic-password -s mailagent-custom-api-key 2>/dev/null || true
```

后端的 `~/Documents/MailAgent/data/sync_store.db` 是 mail-sync 拥有,
**不要在重置前端时碰它**(碰了 = 6 万封邮件得重跑初始化)。

---

## 6. 升级

桌面 app 默认走 in-app updater(electron-updater):

1. App 启动 10s 后自动检查 → 状态栏右下 `更新就绪` 提示
2. **设置 → 应用更新 → 下载更新**
3. 下完点 **重启并安装**,app 自动重启完成升级

也可以手动:

```bash
# 关 app
osascript -e 'tell application "MailAgent" to quit'

# 重新下载 .dmg 安装(会替换 Applications/MailAgent.app)
open ~/Downloads/MailAgent-x.y.z-arm64.dmg
```

后端 `mailagent` CLI 单独升级:

```bash
cd ~/Documents/MailAgent
git pull
source venv/bin/activate
pip install -e ".[cli]" --upgrade
pm2 restart mail-sync
```

---

## 7. 卸载

```bash
# 1. 关 app
osascript -e 'tell application "MailAgent" to quit'

# 2. 删 .app
rm -rf /Applications/MailAgent.app

# 3. 清前端数据(同 §5.5)
rm -rf ~/.mailagent/frontend/
rm -rf ~/Library/Application\ Support/MailAgent/
security delete-generic-password -s mailagent-cli-api-key 2>/dev/null || true
security delete-generic-password -s mailagent-llm-api-key 2>/dev/null || true
security delete-generic-password -s mailagent-custom-api-key 2>/dev/null || true

# 4. 后端可选(留着邮件归档很有用,只想下桌面 GUI 这步跳过)
pm2 stop mail-sync && pm2 delete mail-sync
rm -rf ~/Documents/MailAgent
```

---

> 问题反馈:[GitHub Issues](https://github.com/chenyqthu/MailAgent/issues)。
> 开发者文档(架构 / 设计系统 / Sprint 计划):见同目录 `ARCHITECTURE.md` /
> `DESIGN.md` / `PROJECT-PLAN.md`。
