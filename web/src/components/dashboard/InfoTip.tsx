"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LuInfo } from "react-icons/lu";

/** Hover, keyboard focus, and tap all expose the same supporting note. */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const container = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  function show() {
    clearTimeout(timer.current);
    const rect = container.current?.getBoundingClientRect();
    if (rect) setPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(rect.bottom > window.innerHeight - 180
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
    });
  }
  function hide() { timer.current = setTimeout(() => setPosition(null), 120); }

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [position]);

  return (
    <span ref={container} className="inline-flex align-middle" onMouseEnter={show} onMouseLeave={hide}>
      <button type="button" aria-label={label} aria-describedby={position ? id : undefined}
        onFocus={show} onBlur={() => setPosition(null)}
        onClick={show}
        className="focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-accent/10 hover:text-accent">
        <LuInfo size={14} aria-hidden />
      </button>
      {position && <span id={id} role="tooltip" style={position} className="fixed z-[80] w-72 max-w-[calc(100vw-24px)] border border-rule bg-surface-2 p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-foreground shadow-lg shadow-black/20">{children}</span>}
    </span>
  );
}
