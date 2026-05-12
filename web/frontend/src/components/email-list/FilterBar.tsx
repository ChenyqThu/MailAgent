import { useState, useRef, useEffect } from "react";
import { clsx } from "clsx";
import type { EmailFilter } from "@/lib/types";

type ViewMode = "pending" | "all";

const QUICK_FILTERS: { label: string; key: keyof EmailFilter; value: string }[] = [
  { label: "紧急", key: "priority", value: "🔴 紧急" },
  { label: "重要", key: "priority", value: "🟡 重要" },
  { label: "需要回复", key: "action_type", value: "需要回复" },
  { label: "需要决策", key: "action_type", value: "需要决策" },
  { label: "仅供参考", key: "action_type", value: "仅供参考" },
];

interface Props {
  filter: EmailFilter;
  onFilterChange: (f: EmailFilter) => void;
  total: number;
  searchOpen?: boolean;
  onSearchToggle?: (open: boolean) => void;
}

export function FilterBar({ filter, onFilterChange, total, searchOpen: externalSearchOpen, onSearchToggle }: Props) {
  const [internalSearchOpen, setInternalSearchOpen] = useState(false);
  const searchOpen = externalSearchOpen ?? internalSearchOpen;
  const setSearchOpen = onSearchToggle ?? setInternalSearchOpen;
  const [searchText, setSearchText] = useState(filter.search ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // pending_only 默认 true（后端默认值），undefined 等同 true
  const viewMode: ViewMode = filter.pending_only === false ? "all" : "pending";

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  function handleSearchChange(value: string) {
    setSearchText(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onFilterChange({ ...filter, search: value || undefined });
    }, 300);
  }

  function clearSearch() {
    setSearchText("");
    onFilterChange({ ...filter, search: undefined });
    setSearchOpen(false);
  }

  function switchView(mode: ViewMode) {
    setSearchText("");
    if (mode === "pending") {
      onFilterChange({ pending_only: true });
    } else {
      onFilterChange({ pending_only: false });
    }
  }

  const isActive = (key: keyof EmailFilter, value: string) =>
    filter[key] === value;

  function toggle(key: keyof EmailFilter, value: string) {
    if (filter[key] === value) {
      onFilterChange({ ...filter, [key]: undefined });
    } else {
      onFilterChange({ ...filter, [key]: value });
    }
  }

  return (
    <div className="border-b border-border">
      {/* 视图切换 + 搜索 */}
      <div className="px-3 py-2 flex items-center gap-1.5 border-b border-border">
        <button
          onClick={() => switchView("pending")}
          className={clsx(
            "px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors",
            viewMode === "pending"
              ? "bg-accent text-white"
              : "text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
          )}
        >
          待处理
        </button>
        <button
          onClick={() => switchView("all")}
          className={clsx(
            "px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors",
            viewMode === "all"
              ? "bg-accent text-white"
              : "text-gray-500 hover:text-gray-300 hover:bg-bg-hover"
          )}
        >
          全部
        </button>
        <span className="text-[11px] text-gray-600 ml-1">{total}</span>
        <button
          onClick={() => setSearchOpen(!searchOpen)}
          className={clsx(
            "px-2 py-0.5 rounded text-[11px] border transition-colors ml-auto",
            searchOpen || filter.search
              ? "border-accent bg-accent-dim text-accent"
              : "border-border text-gray-500 hover:border-accent hover:text-accent"
          )}
        >
          🔍
        </button>
      </div>

      {/* 搜索栏 */}
      {searchOpen && (
        <div className="px-3 py-2 flex gap-2 items-center border-b border-border">
          <input
            ref={inputRef}
            type="text"
            value={searchText}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") clearSearch(); }}
            placeholder="搜索主题或发件人..."
            className="flex-1 bg-transparent text-xs text-gray-200 placeholder:text-gray-600 outline-none"
          />
          {searchText && (
            <button onClick={clearSearch} className="text-gray-600 hover:text-gray-400 text-xs">
              ✕
            </button>
          )}
        </div>
      )}

      {/* 快捷过滤标签 */}
      <div className="px-3 py-1.5 flex gap-1.5 flex-wrap items-center">
        {QUICK_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => toggle(f.key, f.value)}
            className={clsx(
              "px-2 py-0.5 rounded-xl text-[10px] border transition-colors",
              isActive(f.key, f.value)
                ? "border-accent bg-accent-dim text-accent"
                : "border-border text-gray-600 hover:border-accent hover:text-accent"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
