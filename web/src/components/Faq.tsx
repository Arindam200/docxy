"use client";

import { useState } from "react";
import { faqs, site } from "@/lib/site";
import { Rule, Section } from "./primitives";

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <>
      <Section className="py-12 lg:py-16">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12 lg:gap-16">
          <div>
            <h2 className="text-3xl lg:text-4xl font-bold text-zinc-900 tracking-tight leading-snug">
              Frequently asked questions
            </h2>
            <p className="mt-4 text-sm text-zinc-500 leading-relaxed">
              Still wondering about something? Open an issue on{" "}
              <a
                href={site.repo}
                className="text-zinc-700 underline underline-offset-2 hover:text-zinc-900 transition-colors"
              >
                GitHub
              </a>
              .
            </p>
          </div>

          <div className="lg:col-span-2 divide-y divide-zinc-100">
            {faqs.map((item, i) => {
              const isOpen = open === i;
              return (
                <div key={item.q}>
                  <button
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start justify-between py-5 text-left gap-4"
                  >
                    <span className="text-sm font-semibold text-zinc-900 leading-relaxed">
                      {item.q}
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      className={`w-4 h-4 text-zinc-400 shrink-0 mt-0.5 transition-transform duration-200 ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  {isOpen && (
                    <p className="pb-5 -mt-1 text-sm text-zinc-500 leading-relaxed max-w-2xl">
                      {item.a}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Section>
      <Rule />
    </>
  );
}
