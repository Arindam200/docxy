"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SiGithub } from "react-icons/si";
import { LuCheck, LuGitPullRequest, LuLoaderCircle, LuPause, LuPlay, LuRotateCcw } from "react-icons/lu";
import styles from "./RunPreview.module.css";

const steps = [
  { active: "Reviewing code", done: "Code reviewed", result: "Public API changed" },
  { active: "Finding docs", done: "Docs identified", result: "3 sections affected" },
  { active: "Drafting updates", done: "Updates drafted", result: "4 edits ready" },
  { active: "Writing notes", done: "Release note", result: "Minor version suggested" },
  { active: "Running checks", done: "Checks passed", result: "Ready for your review" },
];

const motionQuery = "(prefers-reduced-motion: reduce)";
function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia(motionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function prefersReducedMotion() {
  return window.matchMedia(motionQuery).matches;
}
// Render the completed example on the server, including for visitors without JS.
function serverMotionPreference() {
  return true;
}

export function RunPreview() {
  const container = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);
  const reducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, serverMotionPreference);
  const current = reducedMotion ? steps.length : step;
  const complete = current === steps.length;
  const playing = visible && !paused && !complete;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting && entry.intersectionRatio >= 0.3);
    }, { threshold: 0.3 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setStep((previous) => Math.min(previous + 1, steps.length));
    }, 1100);
    return () => window.clearInterval(timer);
  }, [playing]);

  function replay() {
    setStep(0);
    setPaused(false);
  }

  return (
    <div ref={container} className={`${styles.preview} border border-zinc-200 bg-zinc-950 overflow-hidden`} data-playing={playing}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
        <SiGithub size={14} className="text-zinc-400 shrink-0" aria-hidden />
        <span className="text-xs text-zinc-400 font-mono truncate">docxy · push to main</span>
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400 border border-zinc-700 px-1.5 py-px font-mono">example run</span>
      </div>

      <div className="p-4 sm:p-5 font-mono text-xs leading-6">
        <p className="text-zinc-400 truncate">▸ acme/payments-api · 8f2a1c9</p>
        <p className="text-zinc-500 mt-1">6 files changed · +142 −37</p>

        <ol className="mt-4 space-y-0" aria-label="Example documentation update">
          {steps.map((item, index) => {
            const state = index < current ? "done" : index === current ? "active" : "pending";
            return (
              <li key={item.done} className={styles.step} data-state={state}>
                <span className={styles.indicator} aria-hidden>
                  {state === "done" ? <LuCheck key="done" size={15} className={styles.check} />
                    : state === "active" ? <LuLoaderCircle key="active" size={15} className={styles.spinner} />
                    : <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />}
                </span>
                <span className={styles.label}>{state === "active" ? item.active : item.done}</span>
                <span className={styles.result} aria-hidden={state !== "done"}>{item.result}</span>
                <span className="sr-only">{state === "done" ? "Complete" : state === "active" ? "In progress" : "Waiting"}</span>
              </li>
            );
          })}
        </ol>

        <div className="mt-4 h-px bg-zinc-800 overflow-hidden" aria-hidden>
          <div className={styles.progress} style={{ transform: `scaleX(${current / steps.length})` }} />
        </div>

        <div className={`${styles.publication} mt-3`}>
          <div className={styles.pullRequest} data-visible={complete} aria-hidden={!complete}>
            <p className="flex items-center gap-2 text-[var(--accent)]">
              <LuGitPullRequest size={15} className="shrink-0" aria-hidden />
              <span className="truncate" title="PR #218 opened · docs: update webhook retry limits">PR #218 opened · docs: update webhook retry limits</span>
            </p>
          </div>
          {!complete && <p className={`${styles.waiting} text-zinc-500`}>Preparing your pull request…</p>}
        </div>

        <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-zinc-500">
          <span>{complete ? "Review and merge in GitHub" : `${current + 1} of ${steps.length} steps${paused ? " · paused" : ""}`}</span>
          {!reducedMotion && (
            <button
              type="button"
              onClick={complete ? replay : () => setPaused((value) => !value)}
              className="inline-flex items-center gap-1.5 px-2 py-1 text-zinc-400 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              aria-label={complete ? "Replay example run" : paused ? "Resume example run" : "Pause example run"}
            >
              {complete ? <LuRotateCcw size={12} aria-hidden /> : paused ? <LuPlay size={12} aria-hidden /> : <LuPause size={12} aria-hidden />}
              {complete ? "Replay" : paused ? "Resume" : "Pause"}
            </button>
          )}
        </div>
        <p className="sr-only" role="status">{complete ? "Example complete. Pull request 218 is ready for review." : "Example run in progress."}</p>
      </div>
    </div>
  );
}
