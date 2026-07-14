// L0 — 全局文件拖拽导航守卫 (composer 拖拽附件的安全配套)。
//
// Chromium 默认行为: 往窗口任意非 drop-target 区域拖放文件 = 导航到 file://
// —— Electron 下等于把整个 app 换成本地文件页。composer 拖拽附件上线后是在
// 邀请用户往窗口拖文件, 脱靶一次就毁掉 app。这里在 document 层兜底:
//   - 仅当拖的是真实文件 (types 含 'Files') 时 preventDefault, 阻断默认导航;
//     drop 不做任何业务处理 (composer 的 onDrop 挂在其 <main> 上, 先于
//     document 冒泡处理, 不受影响)。
//   - 文本/HTML 拖拽不含 'Files' → 不拦, TipTap 编辑器原生拖放行为不变。
export function installFileDropGuard(doc: Document = document): () => void {
  const guard = (e: DragEvent): void => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  }
  doc.addEventListener('dragover', guard)
  doc.addEventListener('drop', guard)
  return () => {
    doc.removeEventListener('dragover', guard)
    doc.removeEventListener('drop', guard)
  }
}
