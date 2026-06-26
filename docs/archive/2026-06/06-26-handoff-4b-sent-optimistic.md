# Handoff — #4b 发件箱乐观回显（send 后秒现 Sent）

> 上一轮（2026-06-26 dogfood UX 9 问批）的遗留单项。8 项已落地 + codex gpt-5.5 xhigh
> review 过，dogfood 已验收。本单项**故意 deferred** 到单独一轮专注做（碰真实 Sent
> 数据的管道特性，须 TDD + codex review，不在长 session 尾巴赶）。

## 现状
- **分支**：`fix/dogfood-ux-feedback`（worktree `.claude/worktrees/dogfood-ux-feedback`，
  基于 `88442e76`，**未合 main**）。10 个 commit（9 修 + codex 3 修），见 git log。
- **计划**：本轮做完 #4b → 一起把整个分支合入 main（用户拍板）。

## 任务：#4b 变体 C（in-process fetch-by-uid + 完整 ingest）
**为什么是 C**：`backend_lifecycle` 启 `serve`(watcher 主循环) 和 `serve-api`(send 所在)
**两个独立进程** → serve-api 不能直调 watcher 同步。send 是外部 SMTP 不写 SQLite，
watcher 轮询 Exchange Sent 进 `email_metadata` 有延迟。C 在 serve-api 进程内就地补一封，
不跨进程、不等轮询、是完整行（带正文/FTS）。比跨进程 B / 精简行 A 都干净。

**精确路径**（已摸清）：send 已 APPEND 到 Sent 并返 `sent_folder_uid`（`src/mail/backend/sender.py:219`）。
在 `MailWriteService.send`（`src/services/mail_write.py:1630`）`backend.send_email` 成功后：
1. **取单封**：`davmail_backend._fetch_new_in_folder(imap, sent_folder, "发件箱", ("UID", str(uid)))`
   —— watcher 拉 Sent 的同一方法，传单 UID → 返 ready-for-`save_email` 的 dict（已
   `allocate_davmail_internal_id()`≥1e9 + imap_uid/imap_uidvalidity/backend_origin='davmail'/mailbox）。
   建议新增薄封装 `backend.fetch_sent_message_by_uid(uid) -> Optional[dict]`（开 imap_session
   + 调 `_fetch_new_in_folder`，单独 try：取失败绝不能让已成功的 send 抛错）。
2. **落元数据**：`sync_store.save_email(dict)` —— 走 `_save_email_v3` 的**按 message_id
   cross-backend merge**：watcher 下轮再拉到同一 message_id 是 **merge 更新、不建重复行**
   （`message_id TEXT UNIQUE`）。**这是 C 的去重安全点，必须验证它确实 merge 不跳过。**
3. **落正文/FTS**：v4 双写 `build_storage_payloads → email_repo.commit_email_with_body`，
   参照 `src/mail/new_watcher.py:790-825` 的 `_dual_write_to_sqlite`（含 Office 预转换可选）。
4. （可选）发 SSE 让前端立即刷新发件箱（参照本批 #4 旗标 `email.flag_changed` 的做法，
   `email.synced` 已被 `useEventBridge` 监听 → invalidate `['emails']`）。

## 🔴 风险与纪律
- 复刻 watcher 整条 Sent-ingest 的 **merge + dual-write 语义**，处理错会留**正文缺失行 /
  重复行**，且直接动**真实发件箱数据**。
- **必先写复现测试**（TDD）：mock backend fetch 返已知 dict → 断言 `save_email` +
  `commit_email_with_body` 被以正确 internal_id/message_id 调用；断言 watcher 二次 ingest
  同 message_id 走 merge 不建重复行。参照 `tests/cli/test_service_parity.py`（真实 ctx +
  `_cli_actor`）的 set_flags SSE 测试写法。
- send 路径绝不能因 ingest 失败而抛错（send 已不可逆完成）。
- 跑 `venv/bin/python -m pytest tests/agent_eval -q` 不受影响（非 chat agent 改）。
- worktree 跑 Python 测试：main venv + `PYTHONPATH=<worktree>` + cwd=worktree（详见记忆
  `project_dogfood_ux_9issues_worktree`）。

## 做完后
1. codex gpt-5.5 xhigh review（`collaborating-with-codex` 桥，config 默认即 gpt-5.5 xhigh）。
2. 改完 review → 把整个 `fix/dogfood-ux-feedback`（含 #4b）合入 main（等 main 的 harness
   工作也落定）。

## 可直接粘贴的下轮起手 prompt
```
继续 worktree fix/dogfood-ux-feedback 上的遗留单项 #4b（发件箱乐观回显，变体 C：
serve-api send 成功后 in-process 用 sent_folder_uid 单次 fetch + 完整 ingest 进
email_metadata，靠 message_id merge 去重）。先读
docs/archive/2026-06/06-26-handoff-4b-sent-optimistic.md 和记忆
project_dogfood_ux_9issues_worktree 拿精确路径。要求 TDD：先写复现/契约测试再实现，
不失败 send，碰真实 Sent 数据务必稳。做完交 codex gpt-5.5 xhigh review，再把整个分支合 main。
```
