"use client";

import { useState } from "react";
import { ButtonLink, CellGrid, Rule, Section } from "./primitives";

type Scope = "routine" | "elevated";

const REVIEWERS = ["arindam", "priya", "sam"] as const;

const rules = [
  { label: "Routine", detail: "docs-only fix, 1 approval" },
  { label: "Elevated", detail: "breaking change, 2 people" },
  { label: "Stricter wins", detail: "it can escalate, never relax" },
  { label: "No expiry", detail: "open until someone answers" },
  { label: "No double dipping", detail: "you cannot approve twice" },
  { label: "Protected env", detail: "GitHub holds the job open" },
] as const;

function GateMock() {
  const [scope, setScope] = useState<Scope>("routine");
  const [signed, setSigned] = useState<string[]>([]);

  const required = scope === "routine" ? 1 : 2;
  const satisfied = signed.length >= required;

  function toggle(name: string) {
    setSigned((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function pickScope(next: Scope) {
    setScope(next);
    setSigned([]);
  }

  return (
    <div className="border border-zinc-200">
      <div className="px-5 py-3 border-b border-zinc-100 flex items-center gap-2">
        <span className="w-2 h-2 bg-zinc-200" />
        <span className="w-2 h-2 bg-zinc-200" />
        <span className="w-2 h-2 bg-zinc-200" />
        <span className="ml-2 text-xs text-zinc-400 font-mono">
          acme/payments-api › PR #218
        </span>
      </div>

      <div className="p-6 space-y-5">
        <div>
          <p className="text-[10px] font-semibold text-zinc-400 mb-2 tracking-wide">
            SCOPE
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(["routine", "elevated"] as const).map((s) => (
              <button
                key={s}
                onClick={() => pickScope(s)}
                aria-pressed={scope === s}
                className={`border px-3 py-2 text-center text-xs font-medium capitalize transition-colors ${
                  scope === s
                    ? "border-zinc-900 text-zinc-900 bg-zinc-50"
                    : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-600"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            {scope === "routine"
              ? "A docs fix. Nothing public changed shape."
              : "Breaking, or asking for a major version bump."}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-semibold text-zinc-400 mb-2 tracking-wide">
            APPROVALS · {signed.length} of {required}
          </p>
          <div className="flex gap-2 flex-wrap">
            {REVIEWERS.map((name) => {
              const on = signed.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => toggle(name)}
                  aria-pressed={on}
                  className={`border px-3 py-1.5 text-xs font-mono transition-colors ${
                    on
                      ? "border-zinc-900 text-zinc-900 bg-zinc-50"
                      : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-600"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="text-[10px] font-semibold text-zinc-400 mb-2 tracking-wide">
            STATUS
          </p>
          <div className="flex items-center border border-zinc-200 bg-zinc-50 px-3 py-2 gap-2">
            <span className="text-xs text-zinc-500 font-mono truncate">
              {satisfied ? "ready to merge" : "waiting for review"}
            </span>
            <span
              className={`ml-auto shrink-0 text-[10px] px-2 py-0.5 font-medium ${
                satisfied
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-amber-50 text-amber-600"
              }`}
            >
              {satisfied ? "Approved" : "Pending"}
            </span>
          </div>
          {!satisfied && (
            <p className="text-[11px] text-zinc-400 mt-2">
              Nothing expires. It sits here until someone answers.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function Approval() {
  return (
    <>
      <Section id="approval" className="pt-14 pb-12">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-start">
          <div>
            <h2 className="text-3xl lg:text-[42px] font-semibold text-zinc-900 tracking-tight leading-[1.1]">
              Nothing merges without you
            </h2>
            <div className="mt-3 mb-6">
              <Rule />
            </div>
            <p className="text-lg text-zinc-500 leading-relaxed mb-8">
              Bigger changes need more eyes, and nothing times out in either
              direction. Try it: switch the scope and watch what the pull
              request starts asking for.
            </p>

            <div className="mb-8">
              <CellGrid cols="sm:grid-cols-2">
                {rules.map((r) => (
                  <div key={r.label} className="bg-white px-5 py-4">
                    <p className="text-sm font-semibold text-zinc-900">
                      {r.label}
                    </p>
                    <p className="text-xs text-zinc-400 mt-0.5">{r.detail}</p>
                  </div>
                ))}
              </CellGrid>
            </div>

            <ButtonLink href="#setup">Set up your rules</ButtonLink>
          </div>

          <GateMock />
        </div>
      </Section>
      <Rule />
    </>
  );
}
