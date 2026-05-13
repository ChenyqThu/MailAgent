import { useState, useCallback, useMemo } from "react";
import type { EmailFilter, EmailView } from "@/lib/types";
import { useEmails } from "@/hooks/useEmails";
import { useEmailBody } from "@/hooks/useEmailBody";
import { useEmailDetail } from "@/hooks/useEmailDetail";
import { useViewCounts } from "@/hooks/useViewCounts";
import { useKeyboard } from "@/hooks/useKeyboard";
import { FilterBar } from "@/components/email-list/FilterBar";
import { EmailList } from "@/components/email-list/EmailList";
import { DetailPanel } from "@/components/email-detail/DetailPanel";
import { AgentPanel } from "@/components/email-detail/AgentPanel";
import { HelpPanel } from "@/components/layout/HelpPanel";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export default function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialId = searchParams.get("id");
  const initialView = (searchParams.get("view") as EmailView) || "pending";

  const [filter, setFilter] = useState<EmailFilter>({ view: initialView });
  const [activeId, setActiveId] = useState<number | null>(
    initialId ? Number(initialId) : null
  );
  const [page, setPage] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [aiOpen, setAiOpen] = useState(false);

  const queryClient = useQueryClient();
  const { data, isLoading } = useEmails(filter, page, 50);
  const { data: viewCounts } = useViewCounts();
  const emails = data?.items ?? [];
  const total = data?.total ?? 0;

  // AI 侧边栏需要当前邮件的 body 和 subject
  const { data: activeEmail } = useEmailDetail(activeId);
  const { data: bodyData } = useEmailBody(activeId);

  const activeView = filter.view ?? "pending";

  const performAction = useCallback(async (action: string, emailId?: number) => {
    const id = emailId ?? activeId;
    if (!id) return;

    // mark_done/mark_browsed 在对应视图下：先算下一封，再发请求
    const shouldAdvance =
      (action === "mark_done" && activeView === "pending") ||
      (action === "mark_browsed" && activeView === "browse");
    let nextId: number | null = null;
    if (shouldAdvance) {
      const idx = emails.findIndex((e) => e.internal_id === id);
      if (idx >= 0) {
        nextId = emails[idx + 1]?.internal_id ?? emails[idx - 1]?.internal_id ?? null;
      }
    }

    try {
      await apiFetch(`/emails/${id}/action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (shouldAdvance) setActiveId(nextId);
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["email-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["view-counts"] });
    } catch {
      // silent
    }
  }, [activeId, activeView, emails, queryClient]);

  const performBatchAction = useCallback(async (action: string) => {
    if (selectedIds.size === 0) return;
    const promises = Array.from(selectedIds).map((id) =>
      apiFetch(`/emails/${id}/action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }).catch(() => {})
    );
    await Promise.all(promises);
    queryClient.invalidateQueries({ queryKey: ["emails"] });
    queryClient.invalidateQueries({ queryKey: ["view-counts"] });
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [selectedIds, queryClient]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handlers = useMemo(() => {
    const currentIndex = emails.findIndex((e) => e.internal_id === activeId);
    return {
      j: () => {
        const next = currentIndex < emails.length - 1 ? currentIndex + 1 : currentIndex;
        if (emails[next]) setActiveId(emails[next].internal_id);
      },
      k: () => {
        const prev = currentIndex > 0 ? currentIndex - 1 : 0;
        if (emails[prev]) setActiveId(emails[prev].internal_id);
      },
      e: () => performAction(activeView === "browse" ? "mark_browsed" : "mark_done"),
      s: () => performAction("toggle_flag"),
      r: () => performAction("toggle_read"),
      x: () => {
        setSelectMode((prev) => {
          if (prev) setSelectedIds(new Set());
          return !prev;
        });
      },
      "/": (ev: KeyboardEvent) => { ev.preventDefault(); setSearchOpen(true); },
      "?": () => setShowHelp((prev) => !prev),
      i: () => setAiOpen((prev) => !prev),
      Escape: () => {
        if (showHelp) { setShowHelp(false); return; }
        if (aiOpen) { setAiOpen(false); return; }
        if (selectMode) { setSelectMode(false); setSelectedIds(new Set()); return; }
        setActiveId(null);
      },
    };
  }, [emails, activeId, activeView, performAction, showHelp, selectMode, searchOpen, aiOpen]);

  useKeyboard(handlers);

  const handleSelect = useCallback((id: number) => {
    setActiveId(id);
  }, []);

  const handleFilterChange = useCallback((f: EmailFilter) => {
    setFilter(f);
    setPage(1);
    setActiveId(null);
    const view = f.view ?? "pending";
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (view === "pending") next.delete("view");
      else next.set("view", view);
      next.delete("id");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* 左侧列表 */}
      <div className="w-[380px] flex flex-col border-r border-border flex-shrink-0">
        <FilterBar
          filter={filter}
          onFilterChange={handleFilterChange}
          viewCounts={viewCounts}
          searchOpen={searchOpen}
          onSearchToggle={setSearchOpen}
        />

        {/* 批量操作栏 */}
        {selectMode && (
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 bg-accent/5">
            <span className="text-[11px] text-accent font-medium">
              已选 {selectedIds.size} 封
            </span>
            {activeView === "browse" ? (
              <button
                onClick={() => performBatchAction("mark_browsed")}
                disabled={selectedIds.size === 0}
                className="px-2 py-0.5 rounded text-[11px] bg-accent text-white disabled:opacity-40"
              >
                批量已阅
              </button>
            ) : (
              <button
                onClick={() => performBatchAction("mark_done")}
                disabled={selectedIds.size === 0}
                className="px-2 py-0.5 rounded text-[11px] bg-accent text-white disabled:opacity-40"
              >
                批量完成
              </button>
            )}
            <button
              onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
              className="ml-auto text-[11px] text-fg-muted hover:text-fg-secondary"
            >
              取消
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-fg-faint text-sm">
            加载中...
          </div>
        ) : (
          <EmailList
            emails={emails}
            activeId={activeId}
            onSelect={handleSelect}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        )}
        {total > 50 && (
          <div className="px-3 py-2 border-t border-border flex items-center justify-between text-[11px] text-fg-muted">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2 py-0.5 rounded border border-border disabled:opacity-30 hover:border-accent"
            >
              上一页
            </button>
            <span>第 {page} 页</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={emails.length < 50}
              className="px-2 py-0.5 rounded border border-border disabled:opacity-30 hover:border-accent"
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* 中间详情 */}
      {activeId ? (
        <DetailPanel emailId={activeId} view={activeView} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-fg-faint text-sm gap-1">
          <span>选择一封邮件查看详情</span>
          <span className="text-[11px] text-fg-faint">
            快捷键: J/K 导航, E {activeView === "browse" ? "已阅" : "完成"}, S 旗标, I 打开AI, ? 帮助
          </span>
        </div>
      )}

      {/* AI 侧边栏切换按钮（收起状态） */}
      {!aiOpen && (
        <button
          onClick={() => setAiOpen(true)}
          className="absolute right-0 top-1/2 -translate-y-1/2 bg-accent text-white px-1.5 py-3 rounded-l-lg text-[11px] writing-vertical hover:bg-accent/80 transition-colors z-10 shadow-lg"
          style={{ writingMode: "vertical-rl" }}
        >
          AI 助手
        </button>
      )}

      {/* AI 右侧边栏 */}
      {aiOpen && (
        <div className="w-[360px] flex-shrink-0 border-l border-border">
          <AgentPanel
            emailId={activeId}
            body={bodyData?.body ?? null}
            subject={activeEmail?.subject ?? null}
            onClose={() => setAiOpen(false)}
          />
        </div>
      )}

      {/* 帮助面板 */}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}
