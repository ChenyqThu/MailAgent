import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type { EmailFilter, EmailListItem, EmailView } from "@/lib/types";
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

/* ── 三列可拖拽布局常量 ── */
const COL_MIN = { list: 240, detail: 280, ai: 240 };
const COL_DEFAULT_PCT = { list: 0.25, ai: 0.3 };
/* 视口过窄时（如 F12 占用空间），自动收 AI 边栏 */
const AI_AUTO_HIDE_BELOW = 1000;

export interface ThreadGroup {
  representative: EmailListItem;
  threadId: string | null;
  count: number;
  /** 同线程内所有邮件（仅当前页内的） */
  members: EmailListItem[];
}

/** 按 thread_id 分组，同线程只保留最新一封作为代表 */
function buildGroups(emails: EmailListItem[]): ThreadGroup[] {
  const seen = new Map<string, ThreadGroup>();
  const result: ThreadGroup[] = [];

  for (const email of emails) {
    const tid = email.thread_id;
    if (!tid || email.thread_count <= 1) {
      result.push({ representative: email, threadId: null, count: 1, members: [email] });
      continue;
    }
    const existing = seen.get(tid);
    if (existing) {
      existing.members.push(email);
      continue;
    }
    const group: ThreadGroup = {
      representative: email,
      threadId: tid,
      count: email.thread_count,
      members: [email],
    };
    seen.set(tid, group);
    result.push(group);
  }
  return result;
}

/** 拖拽分隔条 */
function DragHandle({ onDrag, side }: { onDrag: (dx: number) => void; side: "left" | "right" }) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - lastX.current;
      lastX.current = ev.clientX;
      onDrag(dx);
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [onDrag]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={`w-1 flex-shrink-0 cursor-col-resize group relative hover:bg-accent/30 active:bg-accent/50 transition-colors ${side === "left" ? "border-r border-border" : "border-l border-border"}`}
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

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
  const [aiOpen, setAiOpen] = useState(true);

  /* ── 两列固定宽度（list / ai），detail 弹性撑满 ── */
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [colWidths, setColWidths] = useState<{ list: number; ai: number } | null>(null);

  // 用 ResizeObserver 观察容器尺寸变化（F12 docked 时 window resize 不一定触发）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setContainerWidth(w);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // 首次拿到 containerWidth 时初始化宽度；之后由用户拖拽决定
  useEffect(() => {
    if (containerWidth <= 0 || colWidths) return;
    const list = Math.max(COL_MIN.list, Math.round(containerWidth * COL_DEFAULT_PCT.list));
    const ai = Math.max(COL_MIN.ai, Math.round(containerWidth * COL_DEFAULT_PCT.ai));
    setColWidths({ list, ai });
  }, [containerWidth, colWidths]);

  // 视口窄时自动收起 AI
  useEffect(() => {
    if (containerWidth > 0 && containerWidth < AI_AUTO_HIDE_BELOW && aiOpen) {
      setAiOpen(false);
    }
  }, [containerWidth, aiOpen]);

  // 容器收窄到放不下 list+ai+detail_min 时，按比例压缩
  useEffect(() => {
    if (!colWidths || containerWidth <= 0) return;
    const aiW = aiOpen ? colWidths.ai : 0;
    const handles = aiOpen ? 2 : 1;
    const used = colWidths.list + aiW + handles + COL_MIN.detail;
    if (used <= containerWidth) return;
    // 把多余部分按比例从 list / ai 里扣
    const overflow = used - containerWidth;
    const totalShrinkable =
      Math.max(0, colWidths.list - COL_MIN.list) +
      Math.max(0, aiW - COL_MIN.ai);
    if (totalShrinkable <= 0) return;
    const listShrink = Math.round(
      overflow * (Math.max(0, colWidths.list - COL_MIN.list) / totalShrinkable),
    );
    const aiShrink = overflow - listShrink;
    setColWidths({
      list: Math.max(COL_MIN.list, colWidths.list - listShrink),
      ai: Math.max(COL_MIN.ai, colWidths.ai - aiShrink),
    });
  }, [containerWidth, aiOpen, colWidths]);

  const handleDragLeft = useCallback((dx: number) => {
    setColWidths((prev) => {
      if (!prev) return prev;
      const newList = Math.max(COL_MIN.list, prev.list + dx);
      // 边界：不能让 detail 小于 COL_MIN.detail
      const aiW = aiOpen ? prev.ai : 0;
      const handles = aiOpen ? 2 : 1;
      if (containerWidth > 0 && newList + aiW + handles + COL_MIN.detail > containerWidth) {
        return prev;
      }
      return { ...prev, list: newList };
    });
  }, [aiOpen, containerWidth]);

  const handleDragRight = useCallback((dx: number) => {
    setColWidths((prev) => {
      if (!prev) return prev;
      // 拖右把柄：右移 = AI 变小（dx 正方向是右）
      const newAi = Math.max(COL_MIN.ai, prev.ai - dx);
      if (containerWidth > 0 && prev.list + newAi + 2 + COL_MIN.detail > containerWidth) {
        return prev;
      }
      return { ...prev, ai: newAi };
    });
  }, [containerWidth]);

  const queryClient = useQueryClient();
  const { data, isLoading } = useEmails(filter, page, 50);
  const { data: viewCounts } = useViewCounts();
  const emails = data?.items ?? [];
  const total = data?.total ?? 0;

  const { data: activeEmail } = useEmailDetail(activeId);
  const { data: bodyData } = useEmailBody(activeId);

  const activeView = filter.view ?? "pending";

  // 线程分组 — 导航、advance、多选都基于 groups
  const groups = useMemo(() => buildGroups(emails), [emails]);

  // 当前 activeId 所在 group 的 index
  const activeGroupIndex = useMemo(() => {
    if (activeId === null) return -1;
    return groups.findIndex(
      (g) => g.representative.internal_id === activeId || g.members.some((m) => m.internal_id === activeId),
    );
  }, [groups, activeId]);

  const performAction = useCallback(async (action: string, emailId?: number) => {
    const id = emailId ?? activeId;
    if (!id) return;

    const currentEmail = activeEmail ?? emails.find((e) => e.internal_id === id);
    const isThread = !!currentEmail?.thread_id && currentEmail.thread_count > 1;

    // advance 基于 groups（线程级）
    const shouldAdvance =
      (action === "mark_done" && activeView === "pending") ||
      (action === "mark_browsed" && activeView === "browse");
    let nextId: number | null = null;
    if (shouldAdvance) {
      const gIdx = activeGroupIndex;
      if (gIdx >= 0) {
        const nextGroup = groups[gIdx + 1] ?? groups[gIdx - 1];
        nextId = nextGroup?.representative.internal_id ?? null;
      }
    }

    try {
      if (isThread) {
        const threadEmails = await apiFetch<Array<{ internal_id: number }>>(
          `/emails/thread/${encodeURIComponent(currentEmail.thread_id!)}`,
        );
        const ids = threadEmails.map((e) => e.internal_id);
        await apiFetch("/emails/batch-action", {
          method: "POST",
          body: JSON.stringify({ action, email_ids: ids }),
        });
      } else {
        await apiFetch(`/emails/${id}/action`, {
          method: "POST",
          body: JSON.stringify({ action }),
        });
      }
      if (shouldAdvance) setActiveId(nextId);
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["email-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["view-counts"] });
    } catch {
      // silent
    }
  }, [activeId, activeView, activeEmail, activeGroupIndex, groups, emails, queryClient]);

  const performBatchAction = useCallback(async (action: string) => {
    if (selectedIds.size === 0) return;

    // 展开线程成员：选中的 ID 如果是线程代表，把同线程所有成员都加上
    const allIds = new Set<number>();
    for (const id of selectedIds) {
      const group = groups.find(
        (g) => g.representative.internal_id === id || g.members.some((m) => m.internal_id === id),
      );
      if (group && group.threadId) {
        for (const m of group.members) allIds.add(m.internal_id);
      } else {
        allIds.add(id);
      }
    }

    await apiFetch("/emails/batch-action", {
      method: "POST",
      body: JSON.stringify({ action, email_ids: Array.from(allIds) }),
    }).catch(() => {});

    queryClient.invalidateQueries({ queryKey: ["emails"] });
    queryClient.invalidateQueries({ queryKey: ["view-counts"] });
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [selectedIds, groups, queryClient]);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // j/k 基于 groups 导航
  const handlers = useMemo(() => {
    return {
      j: () => {
        const next = activeGroupIndex < groups.length - 1 ? activeGroupIndex + 1 : activeGroupIndex;
        if (groups[next]) setActiveId(groups[next].representative.internal_id);
      },
      k: () => {
        const prev = activeGroupIndex > 0 ? activeGroupIndex - 1 : 0;
        if (groups[prev]) setActiveId(groups[prev].representative.internal_id);
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
  }, [groups, activeGroupIndex, activeView, performAction, showHelp, selectMode, searchOpen, aiOpen]);

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
    <div ref={containerRef} className="flex-1 flex overflow-hidden relative">
      {/* 左侧列表 */}
      <div
        className="flex flex-col flex-shrink-0"
        style={{ width: colWidths?.list ?? 380 }}
      >
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
            groups={groups}
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

      {/* 左分隔条 */}
      <DragHandle onDrag={handleDragLeft} side="left" />

      {/* 中间详情 — 弹性撑满剩余空间 */}
      <div className="flex flex-col flex-1 min-w-0">
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
      </div>

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

      {/* 右分隔条 */}
      {aiOpen && <DragHandle onDrag={handleDragRight} side="right" />}

      {/* AI 右侧边栏 */}
      {aiOpen && (
        <div
          className="flex-shrink-0"
          style={{ width: colWidths?.ai ?? 360 }}
        >
          <AgentPanel
            emailId={activeId}
            body={bodyData?.body ?? null}
            subject={activeEmail?.subject ?? null}
            sender={activeEmail?.sender ?? undefined}
            senderName={activeEmail?.sender_name ?? undefined}
            date={activeEmail?.date_received ?? undefined}
            mailbox={activeEmail?.mailbox ?? undefined}
            threadId={activeEmail?.thread_id ?? undefined}
            onClose={() => setAiOpen(false)}
          />
        </div>
      )}

      {/* 帮助面板 */}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}
