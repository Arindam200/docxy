"use client";

import { useState } from "react";
import { SiGithub } from "react-icons/si";
import { ButtonLink, CellGrid, Rule, Section } from "./primitives";

const rules = [
  { label: "Clear summary", detail: "see what changed and why" },
  { label: "Check results", detail: "see what passed or failed" },
  { label: "Your review rules", detail: "keep your GitHub approval process" },
  { label: "Your decision", detail: "merge when you are ready" },
] as const;

function ReviewMock() {
  const [failed, setFailed] = useState(false);

  return (
    <div className="border border-zinc-200">
      <div className="px-5 py-3 border-b border-zinc-100 flex items-center gap-2">
        <SiGithub size={15} className="text-zinc-500" />
        <span className="text-xs text-zinc-400 font-mono">
          Example PR · acme/payments-api
        </span>
      </div>
      <div className="p-6 space-y-5">
        <div>
          <p className="text-[10px] font-semibold text-zinc-400 mb-2 tracking-wide">
            VALIDATION RESULT
          </p>
          <div className="grid grid-cols-2 gap-2">
            {[false, true].map((value) => (
              <button
                key={String(value)}
                onClick={() => setFailed(value)}
                aria-pressed={failed === value}
                className={`border px-3 py-2 text-center text-xs font-medium transition-colors ${
                  failed === value
                    ? "border-zinc-900 text-zinc-900 bg-zinc-50"
                    : "border-zinc-200 text-zinc-400 hover:border-zinc-400 hover:text-zinc-600"
                }`}
              >
                {value ? "Build failed" : "Checks passed"}
              </button>
            ))}
          </div>
        </div>
        <div aria-live="polite" className="space-y-4">
          <p className="text-sm font-semibold text-zinc-900">
            docs: update webhook retry limits
          </p>
          <span className={`inline-block text-xs px-2 py-1 ${failed ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
            {failed ? "Draft pull request" : "Open for review"}
          </span>
          <div className="border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs leading-6 text-zinc-600">
            <p>4 doc edits · 1 release note</p>
            <p>Public API changed · needs careful review</p>
            <p>Docs build: {failed ? "failed" : "passed"}</p>
          </div>
          <p className="text-sm text-zinc-500 leading-relaxed">
            {failed
              ? "The docs build failed. Review the errors on the draft pull request."
              : "Checks passed. Review the changes and merge when ready."}
          </p>
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
              You review. You merge.
            </h2>
            <div className="mt-3 mb-6"><Rule /></div>
            <p className="text-lg text-zinc-500 leading-relaxed mb-8">
              Every pull request includes the changes, a summary, and check
              results. Try the example to see what happens when a check fails.
            </p>
            <div className="mb-8">
              <CellGrid cols="sm:grid-cols-2">
                {rules.map((rule) => (
                  <div key={rule.label} className="bg-white px-5 py-4">
                    <p className="text-sm font-semibold text-zinc-900">{rule.label}</p>
                    <p className="text-xs text-zinc-400 mt-0.5">{rule.detail}</p>
                  </div>
                ))}
              </CellGrid>
            </div>
            <ButtonLink href="#setup">See setup</ButtonLink>
          </div>
          <ReviewMock />
        </div>
      </Section>
      <Rule />
    </>
  );
}
