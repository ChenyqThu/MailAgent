---
name: deploy
description: 部署并验证 MailAgent 服务
user_invocable: true
---

# /deploy — 部署并验证服务

根据参数决定部署目标，默认部署本地 mail-sync 服务。

## 使用方式

- `/deploy` — 重启本地 mail-sync 并验证
- `/deploy webhook` — 部署 webhook-server 到远程服务器并验证
- `/deploy all` — 两者都部署

## 本地 mail-sync 部署流程

1. 检查是否有未提交的代码变更，提醒用户
2. 安装依赖：`source venv/bin/activate && pip install -r requirements.txt`
3. 重启服务：`pm2 restart mail-sync`
4. 等待 5 秒，执行验证检查清单：
   - `pm2 status` 确认 online
   - `pm2 logs mail-sync --lines 20 --nostream` 检查无 error
   - 确认关键组件启动：Redis consumer、SQLite radar、reverse sync
5. 报告部署结果

## 远程 webhook-server 部署流程

1. 运行部署脚本：`./scripts/deploy-webhook.sh`
2. SSH 到远程验证：
   - `ssh ubuntu@170.106.181.89 "pm2 status mailagent-webhook"`
   - `ssh ubuntu@170.106.181.89 "pm2 logs mailagent-webhook --lines 15 --nostream"`
3. 报告部署结果

## 失败处理

如果验证失败：
- 显示完整错误日志
- 分析失败原因（依赖缺失？配置错误？端口占用？）
- 建议修复方案但不自动回滚
