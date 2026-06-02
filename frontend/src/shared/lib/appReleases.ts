// 应用更新下载页 —— ad-hoc 签名下不做应用内自动安装 (quitAndInstall 装不上更新),
// 改为「检查到新版本 → 跳转 GitHub Releases 手动下载、覆盖安装」。
//
// URL 须与 electron-builder.yml 的 publish (owner: chenyqthu / repo: MailAgent) 一致;
// `/releases/latest` 自动重定向到最新一个**已发布** (非 draft) 版本。
export const RELEASE_DOWNLOAD_URL = 'https://github.com/chenyqthu/MailAgent/releases/latest'
