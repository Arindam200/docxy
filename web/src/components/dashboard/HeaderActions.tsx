"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  LuChevronDown,
  LuMonitor,
  LuMoon,
  LuSparkles,
  LuSun,
  LuX,
} from "react-icons/lu";

import { site } from "@/lib/site";

/**
 * The header's right-hand controls: the theme switch, and the upgrade pill.
 *
 * The theme is applied by toggling one class on <html> — the same class the
 * inline script in the root layout sets before first paint — so switching is
 * instant and survives a reload without a flash of the wrong shell.
 */

type Choice = "light" | "dark" | "system";

const CHOICES: Array<{ value: Choice; label: string; icon: React.ReactNode }> = [
  { value: "light", label: "Light", icon: <LuSun /> },
  { value: "dark", label: "Dark", icon: <LuMoon /> },
  { value: "system", label: "System", icon: <LuMonitor /> },
];

const STORAGE_KEY = "docxy-theme";

/** Storage can throw outright (private mode, blocked cookies); default instead. */
function readChoice(): Choice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/**
 * The saved preference read as an external store rather than copied into
 * state: the server renders "system", the client subscribes, and the label
 * corrects itself on hydration without an effect writing state.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changing the preference should move this one too.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function apply(choice: Choice): void {
  const light =
    choice === "light" ||
    (choice === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.classList.toggle("theme-light", light);
}

/** Closes on an outside click or Escape, which is what a stuck popover needs. */
function useDismiss(open: boolean, close: () => void) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return container;
}

const CONTROL =
  "flex h-8 items-center gap-1.5 border border-rule px-2 text-xs font-medium transition-colors hover:bg-surface-2";

function ThemeMenu() {
  const choice = useSyncExternalStore(subscribe, readChoice, () => "system" as Choice);
  const [open, setOpen] = useState(false);
  const container = useDismiss(open, useCallback(() => setOpen(false), []));

  // "System" keeps following the OS after the choice is made.
  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => apply("system");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [choice]);

  function pick(value: Choice) {
    setOpen(false);
    apply(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // A preference that cannot be saved still applies for this session.
    }
    for (const listener of listeners) listener();
  }

  const active = CHOICES.find((item) => item.value === choice) ?? CHOICES[2];

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${active.label}`}
        className={CONTROL}
      >
        <span aria-hidden className="[&>svg]:h-3.5 [&>svg]:w-3.5">
          {active.icon}
        </span>
        <span aria-hidden className="text-muted [&>svg]:h-3 [&>svg]:w-3">
          <LuChevronDown />
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-36 rounded-md border border-rule bg-surface py-1 shadow-xl shadow-black/40"
        >
          {CHOICES.map((item) => (
            <button
              key={item.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === item.value}
              onClick={() => pick(item.value)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-2 ${
                choice === item.value ? "text-foreground" : "text-muted"
              }`}
            >
              <span aria-hidden className="[&>svg]:h-3.5 [&>svg]:w-3.5">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Upgrade.
 *
 * There is no paid tier to send anyone to yet, and a pill that silently does
 * nothing is worse than one that says so — this opens a short note and points
 * at the deploy guide, which is how you run it today.
 */
function UpgradeButton() {
  const [open, setOpen] = useState(false);
  const container = useDismiss(open, useCallback(() => setOpen(false), []));

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 bg-foreground px-3 text-xs font-semibold text-background transition-opacity hover:opacity-90"
      >
        <span aria-hidden className="[&>svg]:h-3.5 [&>svg]:w-3.5">
          <LuSparkles />
        </span>
        Upgrade
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Upgrade"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 rounded-md border border-rule bg-surface p-4 shadow-xl shadow-black/40"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-tight">Hosted plans are coming</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="text-muted transition-colors hover:text-foreground [&>svg]:h-3.5 [&>svg]:w-3.5"
            >
              <LuX />
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Docxy is open source and free to run yourself — the pipeline, the dashboard, and every
            skill pack. A managed tier is being built for teams who would rather not.
          </p>
          <a
            href={`${site.repo}/blob/main/guides/DEPLOY.md`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block border border-rule bg-surface-2 px-3 py-1.5 text-center text-xs font-medium transition-colors hover:border-accent hover:text-accent"
          >
            Run it yourself
          </a>
        </div>
      )}
    </div>
  );
}

export function HeaderActions() {
  return (
    <div className="flex items-center gap-2">
      <ThemeMenu />
      <UpgradeButton />
    </div>
  );
}
