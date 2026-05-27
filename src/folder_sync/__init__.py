"""folder_sync — Archive / Drafts IMAP 文件夹 → SQLite 独立表的同步模块.

对标 src/calendar_sync/: 独立表 (folder_email, DB v17) + 独立 repository
(FolderEmailRepository) + 进程内 worker (FolderSyncWorker) + 独立 IPC/CLI.
davmail-only (依赖 IMAP/SMTP); AppleScript fallback 模式下 worker 不启动.

详见 plan mailagent-davmail-zesty-eclipse.md。
"""
