"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { LuCheck, LuChevronDown } from "react-icons/lu";

/** A themed, single-choice listbox for dashboard controls. */
export function Select({
  label,
  value,
  options,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function show() {
    setActiveIndex(selectedIndex);
    search.current = { text: "", time: 0 };
    setOpen(true);
  }

  function choose(index: number) {
    onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (!open) show();
        else setActiveIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        return;
      case "Home":
      case "End":
        event.preventDefault();
        setOpen(true);
        setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(activeIndex);
        else show();
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
        return;
      case "Tab":
        setOpen(false);
        return;
    }

    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const now = Date.now();
      const text = (now - search.current.time < 500 ? search.current.text : "") + event.key.toLowerCase();
      search.current = { text, time: now };
      const index = options.findIndex((option) => option.label.toLowerCase().startsWith(text));
      if (index !== -1) {
        setOpen(true);
        setActiveIndex(index);
      }
    }
  }

  return (
    <div ref={container} className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${activeIndex}` : undefined}
        onClick={() => { if (open) setOpen(false); else show(); }}
        onKeyDown={handleKeyDown}
        className={`focus-ring flex w-full items-center justify-between border bg-surface text-foreground transition-colors hover:border-muted hover:bg-surface-2 ${open ? "border-accent" : "border-rule"} ${compact ? "min-w-16 gap-3 px-2 py-1.5 text-xs" : "min-w-44 gap-6 px-3 py-2 text-sm"}`}
      >
        <span>{options[selectedIndex]?.label}</span>
        <LuChevronDown size={14} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label={label}
          className={`absolute left-0 z-50 min-w-full border border-rule bg-surface p-1 shadow-lg shadow-black/15 ${compact ? "bottom-[calc(100%+6px)] text-xs" : "top-[calc(100%+6px)] text-sm"}`}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option.value === value}
              onPointerMove={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              className={`flex cursor-pointer items-center justify-between gap-4 whitespace-nowrap px-2 py-2 transition-colors ${index === activeIndex ? "bg-surface-2 text-foreground" : "text-muted"}`}
            >
              {option.label}
              <LuCheck size={13} aria-hidden className={`shrink-0 text-accent ${option.value === value ? "" : "invisible"}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
