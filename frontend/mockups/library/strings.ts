// 全部界面文案集中在这里，便于落地时逐条换成 i18n key（`library.*`）。
// mockup 固定 zh-CN，不做语言切换；但结构按「一个 key 一条」写，落地时
// 直接搬进 locales/{zh-CN,en-US}/common.json 的 library 段。

export const S = {
  // ── 域与树 ────────────────────────────────────────────────
  domain: '资料库',
  domainSub: '本机受管的多根文件夹树',
  roots: {
    mail: '邮件附件',
    chat: '对话附件',
    agentDocs: 'Agents 文档',
    myDocs: '我的文档',
    mounts: '挂载的文件夹',
    trash: '废纸篓'
  },
  rootHint: {
    mail: '投影区 · 只读',
    chat: '发送即入库',
    agentDocs: 'agent 可读写',
    myDocs: 'agent 默认只读'
  },
  addFolder: '添加文件夹',
  projectionNotice: '投影区文件随邮件删除消失；要长期保留请「另存到资料库」。',
  readonlyRoot: '这是索引投影，不在磁盘上，不能写入。',
  trashNotice: '删除的文件在废纸箱保留 30 天，之后自动清理。',
  mountUnavailable: '目录不可用（外置卷已拔出或已移走）；索引保留，文件暂不可读。',

  // ── 节点菜单 ──────────────────────────────────────────────
  menu: {
    newFolder: '新建文件夹',
    newMarkdown: '新建 markdown',
    importFile: '导入文件…',
    rename: '重命名',
    moveTo: '移到…',
    delete: '删除',
    renameLabel: '重命名标签',
    toReadonly: '设为只读',
    toWritable: '设为可写',
    revealInFinder: '在访达中显示',
    unmount: '卸载',
    unmountHint: '只删索引，磁盘上的文件一个都不动',
    emptyTrash: '清空废纸篓',
    restore: '恢复'
  },

  // ── 内容区 ────────────────────────────────────────────────
  view: { grid: '网格', list: '列表' },
  col: {
    name: '名称',
    size: '大小',
    mtime: '修改时间',
    kind: '类型',
    source: '来源',
    creator: '创建者'
  },
  sort: { name: '按名称', size: '按大小', type: '按类型', date: '按时间' },
  folderFilter: '在当前文件夹中过滤',
  librarySearch: '搜索整个资料库',
  emptyFolder: '这个文件夹还没有文件',
  emptyFolderHint: '把文件拖进来，或用右上角「新建 markdown」。',
  dropHere: (folder: string): string => `复制到「${folder}」`,
  scanning: (done: number, total: number): string => `正在建立索引 ${done} / ${total}`,

  // ── 文件动作 ──────────────────────────────────────────────
  act: {
    edit: '编辑',
    openWith: (app: string): string => `用${app}打开`,
    openSystem: '用系统应用打开',
    reveal: '在访达中显示',
    keepToLibrary: '另存到资料库',
    saveParsedMd: '另存解析版为 markdown',
    moveTo: '移到…',
    delete: '删除',
    history: '历史',
    chat: '对话',
    save: '保存',
    cancel: '取消',
    retry: '重试',
    rollback: '回滚到这一版',
    viewSnapshot: '查看快照',
    restore: '恢复',
    confirm: '确定',
    close: '关闭'
  },
  changeNote: '变更说明（可选）',
  changeNotePlaceholder: '例：补充 Q3 渠道数据',

  // ── 预览 ──────────────────────────────────────────────────
  preview: {
    parsed: '解析视图',
    original: '原件',
    text: '文字',
    image: '图片',
    parsedHint: '这是解析出来的 markdown，供预览、检索与 agent 阅读；原件请用对应应用打开。',
    pdfParsedHint: 'PDF 解析版是带页分隔的纯文本（anydoc 的 pdf lane 默认不开）。',
    originalUnavailable: '原件在这台机器上暂时读不到，只能看解析视图。',
    htmlSandbox: '预览已禁用脚本；要看完整效果请用系统浏览器打开。',
    noInline: '这类文件不在应用内预览。',
    ocrBadge: 'OCR 文字',
    pending: '正在解析…',
    failed: '解析失败',
    unsupported: '这个类型暂不支持解析',
    pageSep: (n: number): string => `第 ${n} 页`
  },
  textStatus: {
    pending: '解析中',
    extracted: '已解析',
    failed: '解析失败',
    unsupported: '不支持解析'
  },
  fileStatus: {
    present: '正常',
    missing: '文件已不在磁盘上',
    missingHint: '引用保留（事项 / 会话里的链接不会悬空）；重新放回原位后可恢复。',
    trashed: '在废纸篓里',
    trashedHint: (days: number): string => `${days} 天后自动清理`
  },
  conflict: {
    title: '文件已被改动',
    body: '你打开之后，这个文件被别人改过了。下面是当前版本；你的文本仍在编辑框里。',
    keepMine: '用我的覆盖',
    discard: '放弃我的修改',
    changedBy: (who: string): string => `改动来自 ${who}`
  },
  relatedMatters: '关联的事项',
  sourceJump: { mail: '打开来源邮件', chat: '打开来源会话' },

  // ── 挂载与设置 ────────────────────────────────────────────
  mount: {
    add: '添加文件夹',
    pickHint: '选一个本机目录挂进资料库；文件留在原地，我们只建索引。',
    label: '显示名',
    mode: '权限',
    ro: '只读',
    rw: '可写',
    estimate: (n: number): string => `预估 ${n.toLocaleString('zh-CN')} 个文件`,
    skipHint: '跳过 .git / node_modules / 隐藏目录。',
    tooManyTitle: '这个文件夹太大了',
    tooMany: (n: number): string =>
      `预估 ${n.toLocaleString('zh-CN')} 个文件，超过 20,000 的上限。请选一个更小的子目录。`,
    refusedTitle: '这个目录不能挂载',
    absPathNote: '绝对路径只在这里显示；界面其他地方和 agent 看到的都是 @标签 开头的虚拟路径。'
  },
  settings: {
    title: '资料库',
    mounted: '挂载的文件夹',
    usage: '库占用',
    rescan: '重扫资料库',
    rescanHint: '按需对账：核对磁盘与索引，补记外部改动。没有文件监听。',
    trashPolicy: '废纸篓保留 30 天',
    chatArchiveTitle: '对话附件会保存到资料库',
    chatArchiveHint: '发送时写入 chat-attachments/{年-月}/；删会话不会删这些文件。',
    semanticTitle: '语义检索',
    semanticNotReady: '当前为纯关键词检索（FTS5）。下载语义模型后可混合检索。',
    downloadModel: '下载语义模型（614 MB）',
    downloading: '正在下载模型',
    modelReady: '模型已就绪 · Qwen3-Embedding-0.6B（int8 ONNX）',
    rebuildIndex: '重建索引',
    indexProgress: (done: number, total: number): string => `已嵌入 ${done} / ${total} 个文件`
  },

  // ── 搜索 ──────────────────────────────────────────────────
  search: {
    placeholder: '搜索文件名与正文',
    tooShort: '至少输入 2 个字',
    empty: '没有匹配的文件',
    emptyHint: '试试更短的关键词，或换成文件名的一段。',
    matchFts: '关键词',
    matchVec: '语义',
    matchBoth: '关键词+语义',
    noSemantic: '语义检索未启用（模型未下载），当前只按关键词匹配。',
    groupTitle: '资料库'
  },

  // ── agent 侧 ──────────────────────────────────────────────
  agent: {
    capabilityTitle: '资料库',
    capabilityDesc: '读取、检索与写入资料库里的文件。',
    tierOff: '关闭',
    tierRead: '只读',
    tierWrite: '可写',
    writeScope: '可写 Agents 文档与「可写」挂载根，不含「我的文档」。',
    readScope: '可读全部根（含邮件附件投影）。',
    filesCardTitle: '命令与本机文件',
    filesCardDesc: '执行命令、读写任意本机路径（恒需确认）。',
    headlessNote: '无人值守时只有 Agents 文档免卡；挂载根恒只读，移动 / 删除恒弹卡。',
    toolPrefTitle: '资料库工具',
    approve: '允许',
    reject: '拒绝',
    expectedHash: '基于版本',
    conflictRetry: '文件已被改动，工具会读回当前版本再试一次。'
  },
  chip: {
    archived: '已存入资料库',
    notArchived: '未归档',
    notArchivedHint: '入库失败（后端未启动或磁盘满），这次只把抽取文本发给了模型。',
    composerNotice: '对话附件会保存到资料库',
    attachedRefs: '附带资料'
  },
  mention: { group: '资料库', groupShort: '资料', recent: '最近文件' },
  notify: { libraryTitle: 'Agent 写了资料库文件' },

  // ── 跨模块 ────────────────────────────────────────────────
  picker: {
    title: '从资料库选择',
    tabTree: '按文件夹',
    tabSearch: '搜索',
    selectedCount: (n: number): string => `已选 ${n} 个`,
    confirmLink: '关联',
    confirmAttach: '添加为附件'
  },
  matter: {
    tabLibrary: '资料库',
    proposalTitle: '未确认的 agent 建议',
    accept: '确认',
    ignore: '忽略'
  },
  compose: { pickFromLibrary: '从资料库选附件' },
  deeplink: {
    missingToast: '文件已不在资料库',
    trashedToast: '文件在废纸篓里，已为你打开废纸篓'
  },
  report: { exportToLibrary: '导出到资料库' },

  // ── 通用 ──────────────────────────────────────────────────
  systemDialogPlaceholder: '系统对话框（不 mock）',
  sourceLabel: { user: '我', mail: '邮件', chat: '对话', agent: 'Agent', derived: '解析版' }
} as const
