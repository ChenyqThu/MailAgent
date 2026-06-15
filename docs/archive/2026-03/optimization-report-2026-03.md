# MailAgent 优化报告（2026-03）

## 一、项目现状总结

### 核心架构
- **v3 SQLite-First 架构**已稳定运行，AppleScript 查询性能提升 127 倍
- 三大服务并行运行：邮件监听（NewWatcher）、反向同步（Notion→Mail.app）、Redis 事件消费
- 双向同步闭环已完成：Mail.app ↔ Notion ↔ 飞书通知

### 代码规模
| 指标 | 数值 |
|------|------|
| 核心模块 (`src/`) | ~7,900 行 |
| 脚本 (`scripts/`) | 30 个 |
| 文档 (`docs/`) | 11 个（136KB） |
| 最大文件 | `sync_store.py`（1,768 行） |

### 最近开发活跃度
近期 commit 集中在：飞书卡片交互增强、Rich Text 转换、query_mail API、草稿创建流程。

---

## 二、已完成的优化（本次）

### 0. 监控看板 [NEW FEATURE]
**新增**：远程监控看板，挂载在 `mailagent.chenge.ink/dashboard`。

**架构**：
```
本地 main.py → StatsReporter (每 60s POST) → 远程 webhook-server → Redis → Dashboard HTML
```

**涉及文件**：
| 文件 | 变更 |
|------|------|
| `webhook-server/app.py` | 新增看板端点（login/logout/dashboard/api） |
| `webhook-server/dashboard.html` | 新建，单页看板（dark theme, 948 行） |
| `src/stats_reporter.py` | 新建，统计上报模块 |
| `src/events/handlers.py` | 添加 `_stats` 计数器和 `get_stats()` |
| `src/config.py` | 新增 `stats_report_url/interval/token` 配置 |
| `main.py` | 集成 reporter 循环 + loguru ERROR 告警捕获 |

**看板内容**：同步概览、服务状态、反向同步漏斗、事件处理统计、Redis 队列、告警列表

**访问控制**：`DASHBOARD_PASSWORD` 环境变量 + Redis 支持的 cookie session（24h 过期）

### 1. Pydantic v2 兼容性修复 [HIGH]
**问题**：`src/config.py` 使用已废弃的 Pydantic v1 内部 `class Config` 语法，与 `pydantic>=2.9.0` 不兼容。

**修复**：
```python
# 旧（v1 风格，已废弃）
class Config:
    env_file = ".env"
    extra = "ignore"

# 新（v2 风格）
model_config = ConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
)
```

### 2. Python 版本兼容性 [HIGH]
**问题**：代码使用了 Python 3.9+ 的小写泛型 `tuple[...]` 语法，在 3.9 以下会报错。

**修复**：
- `src/mail/reader.py:349` — 类型注解加引号延迟求值
- `src/notion/sync.py:42` — 同上

**新增**：`pyproject.toml` 声明 `requires-python = ">=3.9"`

### 3. PM2 配置硬编码修复 [MEDIUM]
**问题**：`webhook-server/ecosystem.config.js` 中 interpreter 硬编码为 `./venv/bin/python3.9`，升级 Python 版本后会启动失败。

**修复**：改为 `./venv/bin/python3`（符号链接，自动跟随 venv 中的实际版本）。

### 4. 部署脚本增强 [MEDIUM]
**问题**：`scripts/deploy-webhook.sh` 缺少错误处理，不检查 venv 是否存在。

**修复**：
- 添加 `set -e` 失败即停
- 自动创建缺失的 venv
- 打印 Python 版本用于确认
- 使用 heredoc 避免多命令单行拼接

### 5. 配置模板完善 [LOW]
**问题**：`.env.example` 缺少飞书通知和 Redis 事件的配置段。

**修复**：补全 `FEISHU_*` 和 `REDIS_*` 配置段（注释状态），新用户可一眼看到所有可配置项。

### 6. 文档更新 [LOW]
- CLAUDE.md 技术栈：标注 Python 版本兼容范围 `>=3.9`
- CLAUDE.md 命令速查：添加部署环境对照表

---

## 三、发现的待完成事项

### 从 v2 实施清单（`docs/mailagent-v2-implementation-checklist.md`）

| 分类 | 事项 | 状态 |
|------|------|------|
| **A. 巡检** | 工作日定时巡检（早/下午） | 未开始 |
| **B. Schema** | V2 统一字段契约 | 部分完成（AI Action/Priority 已有） |
| **C. 反向同步** | 调度接入主循环 | **已完成** |
| **C. 反向同步** | 触发条件升级（V2 条件） | 部分完成 |
| **D. 草稿回写** | AppleScript 创建草稿 MVP | **已完成**（create_draft 事件） |
| **D. 草稿回写** | Outlook 支持 / 模板签名 | 未开始 |
| **E. 观测** | 日志分层 | 部分（loguru 已分模块） |
| **E. 观测** | 关键指标看板 + 告警 | 未开始 |

### 架构层面

| 优化项 | 优先级 | 说明 |
|--------|--------|------|
| **CI/CD 缺失** | MEDIUM | 无自动化测试/部署流水线，依赖手动 `deploy-webhook.sh` |
| **单元测试缺失** | MEDIUM | `src/` 下无 `tests/` 目录，仅有 `scripts/test_*.py` 集成测试 |
| **sync_store.py 过大** | LOW | 1,768 行，可考虑拆分为 store/queries/migrations |
| **密码文件认证** | LOW | 部署用 `sshpass` + 明文密码文件，建议改用 SSH Key |

---

## 四、不同 Python 版本部署指南

### 兼容性矩阵

| Python 版本 | 主服务 (main.py) | Webhook Server | 说明 |
|------------|-----------------|----------------|------|
| 3.8 | 不支持 | 不支持 | `Pillow>=11.0` 和 `lxml>=5.2` 要求 3.9+ |
| **3.9** | 支持 | **支持** | 最低兼容版本（远程服务器推荐） |
| **3.10** | 支持 | 支持 | |
| **3.11** | **推荐** | 支持 | 本地开发推荐（asyncio 改进） |
| 3.12 | 支持 | 支持 | |
| 3.13 | 支持 | 支持 | 需 `lxml>=5.2.0`, `Pillow>=11.0.0` |

### 各环境部署步骤

#### 本地 macOS（Python 3.11+）
```bash
# 1. 创建虚拟环境
python3.11 -m venv venv
source venv/bin/activate

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置
cp .env.example .env
# 编辑 .env 填入 Notion Token 等

# 4. 初始化数据目录
mkdir -p data logs

# 5. 运行
python3 main.py

# 6. PM2 托管（可选）
pm2 start ecosystem.config.js
```

#### 远程 VPS（Python 3.9+，webhook-server）
```bash
# 1. 安装 Python 3.9+（如 Ubuntu）
sudo apt install python3.9 python3.9-venv

# 2. 克隆仓库
git clone <repo> /home/lighthouse/MailAgent
cd /home/lighthouse/MailAgent/webhook-server

# 3. 创建虚拟环境
python3 -m venv venv
source venv/bin/activate

# 4. 安装依赖
pip install -r requirements.txt

# 5. 配置
cp .env.example .env
# 编辑 .env 填入 Redis URL 和 Webhook Secret

# 6. PM2 启动
pm2 start ecosystem.config.js
pm2 save
```

#### Python 版本升级流程
```bash
# 1. 安装新版 Python（如 3.12）
brew install python@3.12  # macOS
# 或 apt install python3.12  # Ubuntu

# 2. 重建 venv
rm -rf venv
python3.12 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 3. 验证
python3 -c "from src.config import Config; print('OK')"

# 4. 重启服务
pm2 restart mail-sync  # 本地
# 或
pm2 restart mailagent-webhook  # 远程
```

---

## 五、后续建议优先级

| 优先级 | 事项 | 预估工作量 |
|--------|------|-----------|
| P1 | 添加基础单元测试（config、reader、html_converter） | 1-2 天 |
| P1 | 设置 GitHub Actions CI（lint + test） | 半天 |
| P2 | 部署改用 SSH Key 认证替代 sshpass | 半天 |
| P2 | sync_store.py 拆分重构 | 1 天 |
| P3 | 巡检提醒功能（定时任务） | 2-3 天 |
| P3 | 关键指标看板（SQLite 统计 + 简单 Web UI） | 2-3 天 |
