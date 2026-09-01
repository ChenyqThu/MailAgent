# DavMail 上游复查记录（2026-09-01）

> 过程产物。待 `docs/reference/architecture/roadmap-post-cutover.md` §5.1 的在途改动落地后，把本文「可贴进 §5.1 的记录」一节合入；本文保留为当日实证快照。
> 执行：只读调研 agent（Opus），一手来源全部带 URL。事实 / 推断分开标注。

## 结论

**那一行仍未修。** master HEAD `ced5bc3`（2026-09-01）的 `O365Token.java` 第 254–257 行与 7 月完全一致，`refreshToken()` 里 `resource` 仍写死 `Settings.getOutlookUrl()`。行号因 8-18 加了一个 import 从 255 漂到 **256**。自 6.8.1 起 trunk 已 **149 commit**（8-26 复查时 115）。`O365Token.java` 最后一次改动是 8-18 `746e680f`，改的就是 `refreshToken()` 本身、在 bug 下方几行加了 `UnknownHostException` catch，**没碰那一行**。

**重大变化**：另外两条触发条件对应的 issue（#500 / #501 / #506 / #509）在 8-29 同日集体关闭，修复仍只在 trunk；SourceForge 与 GitHub tag 均无 6.9。上游 README 已提供 Appveyor trunk 构建（含 OSX .app，版本号 `6.8.1-trunk`）。

## 可贴进 §5.1 的记录

> **2026-09-01 复查更新**：仍无 6.9，最新正式版仍是 6.8.1（SourceForge / GitHub tag 均无 6.9）。trunk 已从 115 涨到 **149 commit**。三条触发条件里，两条对应的 issue 在 8-29 集体关闭（修复仍只在 trunk），而**那一行 refresh resource bug 依旧零改动**。

**判据核验（事实）**

| 项 | 结论 | 依据 |
|---|---|---|
| refresh resource bug | ❌ **仍未修** | master HEAD [`ced5bc3`](https://github.com/mguessan/davmail/commit/ced5bc344c) 的 [`O365Token.java`](https://raw.githubusercontent.com/mguessan/davmail/master/src/java/davmail/exchange/auth/O365Token.java) 第 256 行仍是 `Settings.getOutlookUrl()`；🔴 行号已从 255 漂到 **256**（8-18 加了一个 import），复查命令的 `sed -n '245,260p'` 仍能覆盖 |
| 该文件最后改动 | 2026-08-18 [`746e680f`](https://github.com/mguessan/davmail/commit/746e680ffe) | 「UnknownException means network is down in O365 refresh token handling」——改的就是 `refreshToken()`，在 bug **下方几行**加 `UnknownHostException` catch，**未碰 resource 那行** ⇒ 作者仍未跑过 Graph refresh 这条路 |
| 105 行 vs 256 行默认值不一致 | 仍在 | `buildTokenUrl:105` 用 `Settings.isGraphEnabled()`，`refreshToken` 用 `true` |
| 6.9 发版 | ❌ 无 | [SourceForge files](https://sourceforge.net/projects/davmail/files/davmail/) 最新仍是 6.8.1（2026-06-30）；GitHub tags 最新 6.8.1 |
| [#506](https://github.com/mguessan/davmail/issues/506) 草稿 APPEND | ✅ **已关闭**（8-29） | mguessan「Fixed regression => closing ticket」；修复（8-14 datereceived 映射）仍**只在 trunk** |
| [#500](https://github.com/mguessan/davmail/issues/500) 大文件夹 SELECT | ✅ **已关闭**（8-29） | 「Performance now greatly improved with delta sync and adjusting retrieved attributes」；delta sync 8-16 起 trunk 默认开，仍**未发版** |
| [#501](https://github.com/mguessan/davmail/issues/501) ErrorRestrictionTooComplex | ✅ **已关闭**（8-29） | 真因与标题无关：「mailbox unable to materialize search」，由 [#509](https://github.com/mguessan/davmail/issues/509) 一并修 |

**新增的 O365Graph 相关情报（事实）**

- [#509](https://github.com/mguessan/davmail/issues/509)（8-27 报，8-29 关）：用户从 EWS 切 6.8.x Graph 后**某个特定邮箱**报 400 `ErrorRestrictionTooComplex`。修法是 [`0fe60664`](https://github.com/mguessan/davmail/commit/0fe6066498) 把 `messageheaders` / `changeKey` / `outlookmessageclass` 从 `IMAP_MESSAGE_ATTRIBUTES` 删掉。报告者用 trunk build 确认已解决。
- [#510](https://github.com/mguessan/davmail/issues/510)（8-27 报，8-29 关，判定为微软侧）：`O365DeviceCode` 认证被 Entra ID Security Defaults 全租户阻断，token 响应不含 refresh_token。**微软 2026-07-01 起对所有新租户默认阻断 device code flow**。⚠️ 我们走 `O365Manual` + `urn:oob`，**不受此影响**，但这是微软持续收紧认证流的信号。
- token 相关的其余 trunk 改动：8-16 [`71e85a63`](https://github.com/mguessan/davmail/commit/71e85a634f) 把 Graph 的 `isExpired()` 改成恒 false，8-25 [`17991dcf`](https://github.com/mguessan/davmail/commit/17991dcf03) 又改回来；8-18 [`07e9fd50`](https://github.com/mguessan/davmail/commit/07e9fd50b3) 新增 `HttpTokenExpiredException`。⇒ 作者这段时间**反复在动 Graph token 过期处理**，却始终没碰 resource 那行。
- SourceForge [bug #751](https://sourceforge.net/p/davmail/bugs/751/)（8-13 报，**仍 open**）：`setJsonToken` 的 scope 校验用 `optString()` 拿到空串不是 null，`scope != null` 判据形同虚设。trunk 已打补丁（[`6e9c94a6`](https://github.com/mguessan/davmail/commit/6e9c94a65b)），作者复现不了、票未关。
- 上游 README 提供 **Appveyor trunk 构建**（含 OSX .app，版本号 `6.8.1-trunk`）：https://github.com/mguessan/davmail#trunk-builds ——作者已在 issue 里直接让用户下 trunk 包测试。
- 端点属性名更正：当前 trunk 是 `davmail.graphVersion`（默认 `beta`），不是 §5.1 旧文写的 `davmail.graphPrefix`（[`GraphRequestBuilder.java:58`](https://github.com/mguessan/davmail/blob/master/src/java/davmail/exchange/graph/GraphRequestBuilder.java)）。

**推断（未实测，需 PoC 验证）**

- 🔴 **#501 / #509 关闭不代表我们的 `uid search HEADER Message-ID` 安全**。master 的 `GraphExchangeSession.HeaderCondition.appendTo()` 生成的仍是 `singleValueExtendedProperties/any(ep:ep/id eq 'String 0x007D' and contains(ep/value,'message-id: ...'))`，正是「未索引扩展属性上做 contains」这类会打爆 materialized search 的形态。8-27 修的是**取数的 select 列表**，不是搜索过滤器。⇒ Message-ID 头搜索仍是回归清单头号项。
- bug #751 说明 token 响应里 `scope` 可能是空串。结合 `O365Token.java:190-195` 的 `scope != null` 判据 ⇒ v1 resource-based 流程里 scope 实际形态更不可预测，PoC 第一必测项仍是记下 `Obtained token for scopes:` 的确切形态（短名列表 / 含 outlook URI / 空串，三条完全不同的分支）。
- 8-29 四张票同日集体关闭形态像发版前清票 ⇒ 6.9 **可能**临近，但无任何公开时间表（[#404](https://github.com/mguessan/davmail/issues/404) 最后更新停在 2026-06-06）。

## 建议（待 owner 拍板）

**停止「等 6.9」，按 §5.1 那道半天的闸开跑影子 PoC，jar 用自建 trunk + 一行 patch。** 理由：距 10-01 只剩 30 天；另外两个阻塞项已在 trunk 修好且上游有现成 trunk 构建；唯一剩下的 refresh 那行在 5 周内被证明「作者改到旁边都不会顺手修」，继续等它进 6.9 没有依据。这一行只要自己 patch 就不再是外部依赖。

PoC 两条纪律照 §5.1 原文：独立端口 + **独立 token 目录**；放置 65 分钟观察 refresh 是否 401 / 是否清空 token.dat。回归清单把 `uid search HEADER Message-ID` 提到最高优先级。
