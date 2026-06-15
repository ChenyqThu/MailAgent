# Handoff: KOS consumer client 缺 `mailagent-emails` 源的 query 权限 ✅ RESOLVED

> **✅ RESOLVED (2026-06-13)**：KOS 侧查证 + MailAgent 侧实测——**权限本来就在**。consumer client `gbrain_cl_348583a3…` 的 `federated_read` 已含 `{default, mailagent-emails, omada}`。当初拿到 0 是**测试时点早于授权生效 / 邮件嵌入未完成**，并非缺权限。用**新 mint 的 token**（TTL 1h，401=过期非无权）重跑即命中：`query {"query":"Latigo","source_id":"mailagent-emails"}` → 命中并引用真实 `sources/email/*`。**保持现有 consumer client 设计，不走下方 bulk client 备选。**
>
> 用法要点：① 要原始邮件命中就带 `source_id:"mailagent-emails"`；不带则联邦检索（default 里 dream cycle 合成的实体页常排在原始邮件前面）。② 中文复合词一律用 `query`（含向量路径），勿用关键词 `search`（Postgres tsvector 不能 tokenize 4+ 连续汉字）。③ source 授权服务端实时判定、不写进 token，改授权即时生效、无需重 mint。

**给 KOS（gbrain）侧的 Claude Code。** MailAgent 这边已把邮件全量入 KOS，但 app 内 AI chat 查不到邮件——定位到是 consumer client 的检索权限问题。（↑ 见上方 RESOLVED：实为测试时点过早，权限本就在。）

## 背景
- MailAgent 把邮件 ingest 进 KOS 的 **isolated source `mailagent-emails`**，用的是 **bulk OAuth client**（`MAILAGENT_BULK_CLIENT_*`，绑定该 source）。slug 形如 `sources/email/{internal_id}`。目前已入库 **7471 封**。
- app 内 AI chat 的 `kos_query` 工具经 serve-api 用的是 **consumer OAuth client**（`KOS_OAUTH_CLIENT_*`）做跨源检索。

## 问题（实测）
| client | `list_pages`（看 `sources/email`） | `query`（检索/bm25 拿邮件 hit） |
|---|---|---|
| **consumer**（`gbrain_cl_348583a30da6b50808f8a0c2ad7333951dee5031c5ae4c3ce941b2d76bd40f03`） | ✅ 能列到（100/100 都是 sources/email） | ❌ **0 封邮件**（带不带 `source_id='mailagent-emails'` 都 0） |
| **bulk**（`gbrain_cl_222713ba31160b335618fbf63253955c3c1a58535c0174dfebb196f8eef7094b`） | ✅ 能列到 | ✅ 能查到（如 "Latigo" → `sources/email/53647`） |

→ consumer client 对 `mailagent-emails` 有 **list 权限但没有 query/retrieval 权限**（或该 source 不在它的 retrieval scope 内）。bulk client 两者都有。

## 请求
给 **consumer client `gbrain_cl_348583a3…`** 增加对 **`mailagent-emails` source 的 query/retrieval 只读权限**（写隔离保持不变——只读即可）。这样 app chat 用 consumer client 就能跨源检索到邮件 + 既有的共享源。

- KOS endpoint：`https://kos.chenge.ink`
- source_id：`mailagent-emails`
- 复现：用 consumer client token 调 `tools/call name=query {"query":"Latigo","source_id":"mailagent-emails","limit":5}` → 现在返 0 邮件 hit，期望返该 source 的命中。

## 若不便授权（MailAgent 侧备选）
我可以把 serve-api 的 `kos-call`（`src/api/routers/chat.py` `_get_kos_client`）+ electron KOSClient 改用 **bulk client** 做 chat 检索（bulk client 实测能查到邮件 + 共享源）。代价：语义上用「写绑定」client 做读，略糙，且需 MailAgent 重新打包。**优先走上面的 consumer 授权（更干净）。**
