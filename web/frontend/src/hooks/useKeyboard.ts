import { useEffect } from "react";

type KeyHandler = (e: KeyboardEvent) => void;

export function useKeyboard(handlers: Record<string, KeyHandler>) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // 忽略输入框内的按键
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      const handler = handlers[e.key];
      if (handler) {
        handler(e);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
