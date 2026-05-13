import { useState, useRef, useEffect } from "react";
import { clsx } from "clsx";
import { apiFetch } from "@/lib/api";

interface Props {
  emailId: number | null;
  body: string | null;
  subject: string | null;
  onClose: () => void;
}

type ContextMode = "email" | "global";

interface Message {
  role: "user" | "assistant";
  content: string;
  action?: string;
}

const QUICK_ACTIONS = [
  { id: "translate", label: "翻译", icon: "🌐" },
  { id: "summarize", label: "总结", icon: "📋" },
  { id: "draft_reply", label: "起草回复", icon: "✍️" },
] as const;

export function AgentPanel({ emailId, body, subject, onClose }: Props) {
  const [mode, setMode] = useState<ContextMode>("email");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevEmailIdRef = useRef<number | null>(null);

  // 切换邮件时清空对话
  useEffect(() => {
    if (emailId !== prevEmailIdRef.current) {
      prevEmailIdRef.current = emailId;
      setMessages([]);
      setMode("email");
    }
  }, [emailId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendAction(action: string, prompt?: string) {
    if (loading) return;

    const userText =
      action === "custom"
        ? prompt || ""
        : QUICK_ACTIONS.find((a) => a.id === action)?.label || action;

    setMessages((prev) => [...prev, { role: "user", content: userText, action }]);
    setLoading(true);

    try {
      if (mode === "global") {
        const resp = await apiFetch<{ result: string; sources?: number }>("/agent/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt || userText }),
        });
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: resp.result + (resp.sources ? `\n\n_（检索了 ${resp.sources} 封相关邮件）_` : ""),
          },
        ]);
      } else {
        if (!emailId) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: "请先选择一封邮件" },
          ]);
          setLoading(false);
          return;
        }
        const resp = await apiFetch<{ result: string }>(`/emails/${emailId}/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            prompt: action === "custom" ? prompt : undefined,
            context: { subject, body: body?.slice(0, 4000) },
          }),
        });
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: resp.result },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "请求失败，请稍后重试" },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendAction("custom", text);
  }

  const hasEmail = emailId !== null && body !== null;

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      {/* 头部 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
        <span className="text-xs font-medium text-fg-secondary">AI 助手</span>
        <div className="flex-1" />

        {/* 上下文模式切换 */}
        <div className="flex bg-bg-tertiary rounded p-0.5">
          <button
            onClick={() => setMode("email")}
            className={clsx(
              "px-2 py-0.5 rounded text-[10px] transition-colors",
              mode === "email"
                ? "bg-accent text-white"
                : "text-fg-muted hover:text-fg-secondary"
            )}
          >
            当前邮件
          </button>
          <button
            onClick={() => setMode("global")}
            className={clsx(
              "px-2 py-0.5 rounded text-[10px] transition-colors",
              mode === "global"
                ? "bg-accent text-white"
                : "text-fg-muted hover:text-fg-secondary"
            )}
          >
            全局检索
          </button>
        </div>

        <button
          onClick={onClose}
          className="text-fg-faint hover:text-fg-secondary text-sm ml-1"
        >
          ✕
        </button>
      </div>

      {/* 上下文提示 */}
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-border bg-bg-secondary">
        {mode === "email" ? (
          hasEmail ? (
            <div className="text-[10px] text-fg-muted truncate">
              上下文: <span className="text-fg-tertiary">{subject || "(无主题)"}</span>
            </div>
          ) : (
            <div className="text-[10px] text-status-caution">未选择邮件，请先在左侧选择</div>
          )
        ) : (
          <div className="text-[10px] text-fg-muted">
            全局模式: 跨邮件搜索与分析
          </div>
        )}
      </div>

      {/* 邮件模式快捷操作 */}
      {mode === "email" && hasEmail && (
        <div className="flex-shrink-0 px-3 py-2 border-b border-border flex gap-1.5 flex-wrap">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.id}
              onClick={() => sendAction(a.id)}
              disabled={loading}
              className={clsx(
                "px-2 py-1 rounded text-[11px] transition-colors",
                loading
                  ? "opacity-50 cursor-wait"
                  : "bg-bg-tertiary text-fg-secondary hover:bg-accent-dim hover:text-accent"
              )}
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-3 min-h-0 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="text-[11px] text-fg-faint text-center mt-8 space-y-2">
            {mode === "email" ? (
              <>
                <p>点击上方快捷按钮或输入问题</p>
                <p className="text-fg-faint">支持翻译、总结、起草回复等</p>
              </>
            ) : (
              <>
                <p>输入问题进行全局邮件检索</p>
                <p className="text-fg-faint">例: "最近关于项目延期的邮件有哪些"</p>
              </>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={clsx(
              "text-[13px] leading-relaxed",
              msg.role === "user"
                ? "text-right"
                : ""
            )}
          >
            {msg.role === "user" ? (
              <span className="inline-block bg-accent/20 text-accent px-3 py-1.5 rounded-lg text-xs max-w-[85%] text-left">
                {msg.content}
              </span>
            ) : (
              <div className="bg-bg-secondary border border-border rounded-lg px-3 py-2">
                <pre className="text-[13px] text-fg-secondary whitespace-pre-wrap font-sans leading-relaxed">
                  {msg.content}
                </pre>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="bg-bg-secondary border border-border rounded-lg px-3 py-2">
            <span className="text-xs text-fg-muted animate-pulse">AI 处理中...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区 */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-border">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={mode === "email" ? "输入指令..." : "搜索或提问..."}
            className="flex-1 bg-bg-tertiary rounded px-2.5 py-1.5 text-xs text-fg-primary placeholder:text-fg-faint outline-none focus:ring-1 focus:ring-accent/50"
          />
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="px-3 py-1.5 rounded text-[11px] bg-accent text-white disabled:opacity-40 flex-shrink-0"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
