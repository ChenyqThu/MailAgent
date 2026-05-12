interface Props {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "J / K", desc: "上下导航邮件" },
  { key: "E", desc: "标记已处理" },
  { key: "S", desc: "切换旗标" },
  { key: "R", desc: "切换已读" },
  { key: "X", desc: "进入/退出多选模式" },
  { key: "/", desc: "打开搜索" },
  { key: "?", desc: "显示/隐藏帮助" },
  { key: "Esc", desc: "关闭面板 / 退出多选" },
];

export function HelpPanel({ onClose }: Props) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-bg-secondary rounded-lg border border-border w-80 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium text-gray-200">快捷键</span>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-xs"
          >
            Esc 关闭
          </button>
        </div>
        <div className="px-4 py-3 space-y-2">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="flex items-center gap-3">
              <kbd className="min-w-[48px] text-center px-2 py-0.5 rounded bg-bg-tertiary border border-border text-[11px] font-mono text-gray-300">
                {s.key}
              </kbd>
              <span className="text-xs text-gray-400">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
