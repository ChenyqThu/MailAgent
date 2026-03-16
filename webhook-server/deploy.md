# MailAgent Webhook Server 部署指南

## 环境信息

| 项目 | 详情 |
|------|------|
| 服务器 | 腾讯云 Ubuntu (170.106.181.89) |
| IP | 170.106.181.89 |
| 域名 | mailagent.chenge.ink |
| SSL | Cloudflare Proxied (Full 模式) + 服务端自签证书 |
| Python | 3.9+ |
| 应用端口 | 8100 (Nginx 反代) |
| 项目路径 | `/opt/MailAgent/webhook-server` |
| 同服务器 | Notion2JIRA (notion-webhook, port 7654) |

**Redis 共用（不同 DB）：**

| DB | 用途 |
|----|------|
| 0-1 | Notion2JIRA |
| 2 | MailAgent 事件队列 |

## 1. 部署代码

```bash
cd /opt
git clone https://github.com/ChenyqThu/MailAgent.git
cd MailAgent/webhook-server

# Python 3.9 虚拟环境
/usr/local/bin/python3.9 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 2. 配置 .env

```bash
cp .env.example .env
vim .env
```

```env
REDIS_URL=redis://:VHBMaW5rUmVkaXNTZWN1cmUyMDI1@localhost:6379
REDIS_DB=2
WEBHOOK_SECRET=<openssl rand -hex 32 生成>
QUEUE_TTL_DAYS=7
```

## 3. PM2 启动

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
```

验证：
```bash
pm2 status                             # mailagent-webhook: online
pm2 logs mailagent-webhook --lines 20
curl http://127.0.0.1:8100/health      # {"status":"ok","redis":"connected"}
```

## 4. Nginx 配置

配置文件：`/etc/nginx/sites-available/mailagent.chenge.ink.conf`

```nginx
server {
    listen 80;
    server_name mailagent.chenge.ink;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name mailagent.chenge.ink;

    ssl_certificate /etc/nginx/ssl/mailagent.crt;
    ssl_certificate_key /etc/nginx/ssl/mailagent.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;

    add_header X-Content-Type-Options nosniff always;

    access_log /var/log/nginx/mailagent.access.log;
    error_log /var/log/nginx/mailagent.error.log;

    client_max_body_size 1M;

    location / {
        proxy_pass http://127.0.0.1:8100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }

    location ~ /\. { deny all; }
}
```

```bash
ln -sf /etc/nginx/sites-available/mailagent.chenge.ink.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 5. SSL 说明

服务器使用自签证书（10 年有效），Cloudflare 负责公网 SSL 终止：

- **Cloudflare DNS**：`mailagent` A 记录 → 170.106.181.89，**Proxied（橙色云）**
- **Cloudflare SSL/TLS**：模式 **Full**（不要 Full Strict，服务端为自签证书）

生成自签证书（已完成，路径 `/etc/nginx/ssl/`）：
```bash
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/mailagent.key \
  -out /etc/nginx/ssl/mailagent.crt \
  -subj '/CN=mailagent.chenge.ink'
```

## 6. Notion Automation 配置

在 Notion 邮件数据库中创建 Automation（详见下方「Notion 配置步骤」）。

**Webhook 端点：**
- Flag 变化：`https://mailagent.chenge.ink/webhook/notion?event=flag_changed`
- AI Review：`https://mailagent.chenge.ink/webhook/notion?event=ai_reviewed`
- Auth Header：`Authorization: Bearer <WEBHOOK_SECRET>`

## 7. 本地 MailAgent .env 配置

macOS 端 MailAgent `.env` 添加：

```env
# Redis 事件消费（Notion → Mail 方向）
REDIS_URL=redis://:VHBMaW5rUmVkaXNTZWN1cmUyMDI1@170.106.181.89:6379
REDIS_DB=2
REDIS_EVENTS_ENABLED=true
```

> Redis 6379 端口需要在腾讯云安全组对本地 IP 放行。

## 8. 验证

```bash
# 健康检查
curl https://mailagent.chenge.ink/health

# 推送测试事件
curl -X POST "https://mailagent.chenge.ink/webhook/notion?event=flag_changed" \
  -H "Authorization: Bearer <WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "test-page-id",
    "parent": {"database_id": "<your-database-id>"},
    "properties": {
      "Message ID": {"rich_text": [{"text": {"content": "test@example.com"}}]},
      "Is Read": {"checkbox": true}
    }
  }'

# 检查 Redis 队列
redis-cli -a <REDIS_PASSWORD> -n 2 LLEN "mailagent:<database_id>:events"
```

---

## 运维指南

### 日常监控

```bash
# 服务状态
pm2 list
pm2 monit

# 实时日志
pm2 logs mailagent-webhook

# 队列状态（需 WEBHOOK_SECRET）
curl -H "X-Webhook-Token: <SECRET>" https://mailagent.chenge.ink/admin/stats
```

### 服务管理

```bash
pm2 restart mailagent-webhook    # 重启
pm2 stop mailagent-webhook       # 停止
pm2 delete mailagent-webhook     # 删除
pm2 start ecosystem.config.js    # 重新注册并启动
pm2 save                         # 保存进程列表（开机自启）
```

### 代码更新

```bash
cd /opt/MailAgent
git pull
cd webhook-server
source venv/bin/activate
pip install -r requirements.txt   # 依赖有变化时
pm2 restart mailagent-webhook
```

### 日志管理

日志位于 `webhook-server/logs/`：
```bash
# 查看错误日志
tail -f logs/pm2-error.log

# PM2 自带日志轮转
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
```

### Redis 队列排查

```bash
# 连接 Redis DB 2
redis-cli -a <REDIS_PASSWORD> -n 2

# 查看所有 MailAgent 队列
KEYS mailagent:*:events

# 查看队列长度
LLEN mailagent:<database_id>:events

# 查看队列头部事件（不消费）
LRANGE mailagent:<database_id>:events 0 0

# 清空队列（慎用）
DEL mailagent:<database_id>:events
```

### 故障排查

| 症状 | 排查方向 |
|------|----------|
| health 返回 503 | `pm2 logs` 查看 Redis 连接，检查 .env 中 REDIS_URL 密码 |
| webhook 返回 401 | 检查 Authorization header 或 X-Webhook-Token 是否匹配 .env 中 WEBHOOK_SECRET |
| webhook 返回 400 | 请求 body 缺少 `parent.database_id`，检查 Notion Automation 配置 |
| 本地 MailAgent 收不到事件 | 检查 Redis 6379 端口安全组、本地 .env 中 REDIS_URL 密码、REDIS_EVENTS_ENABLED=true |
| Nginx 502 | `pm2 list` 确认 mailagent-webhook 是否 online，`curl 127.0.0.1:8100/health` 测试本地 |
