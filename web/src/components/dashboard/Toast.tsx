"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuX } from "react-icons/lu";

type Tone = "success" | "error" | "info";
type Notice = { id: number; message: string; tone: Tone };
type Notify = (message: string, tone?: Tone) => void;
const ToastContext = createContext<Notify>(() => {});

export const useToast = () => useContext(ToastContext);

function ToastItem({ notice, dismiss }: { notice: Notice; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    // Errors remain until dismissed so recovery instructions are not lost.
    if (paused || notice.tone === "error") return;
    const timer = window.setTimeout(() => dismiss(notice.id), 6000);
    return () => window.clearTimeout(timer);
  }, [dismiss, notice.id, notice.tone, paused]);

  const Icon = notice.tone === "success" ? LuCircleCheck : notice.tone === "error" ? LuCircleAlert : LuInfo;
  const color = notice.tone === "success" ? "text-ok" : notice.tone === "error" ? "text-danger" : "text-accent";
  return (
    <div
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      className="pointer-events-auto flex items-start gap-3 border border-rule bg-surface p-4 text-sm text-foreground shadow-lg shadow-black/20"
    >
      <Icon size={18} aria-hidden className={`mt-0.5 shrink-0 ${color}`} />
      <p role={notice.tone === "error" ? "alert" : "status"} className="min-w-0 flex-1 break-words leading-relaxed">{notice.message}</p>
      <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(notice.id)} className="focus-ring shrink-0 p-1 text-muted hover:text-foreground">
        <LuX size={15} aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const sequence = useRef(0);
  const notify = useCallback<Notify>((message, tone = "success") => {
    const id = ++sequence.current;
    setNotices((current) => [...current.filter((item) => item.message !== message), { id, message, tone }].slice(-4));
  }, []);
  const dismiss = useCallback((id: number) => setNotices((current) => current.filter((item) => item.id !== id)), []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <section aria-label="Notifications" className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[calc(100%-5.5rem)] max-w-sm flex-col gap-2">
        {notices.map((notice) => <ToastItem key={notice.id} notice={notice} dismiss={dismiss} />)}
      </section>
    </ToastContext.Provider>
  );
}

/** Callback notices are consumed once, including across refreshes and Back. */
export function ToastNotice({ message, tone, parameters = [] }: { message?: string; tone: Tone; parameters?: string[] }) {
  const notify = useToast();
  const shown = useRef(false);
  useEffect(() => {
    if (!message || shown.current) return;
    shown.current = true;
    notify(message, tone);
    const url = new URL(window.location.href);
    parameters.forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(window.history.state, "", url);
  }, [message, notify, parameters, tone]);
  return null;
}
