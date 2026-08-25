import { SiGithub } from "react-icons/si";
import { ButtonLink, Rule } from "./primitives";
import { site } from "@/lib/site";

const timeline = [
  { role: "Change Analyst", out: "feature · public-api", reused: true },
  { role: "Impact Mapper", out: "3 doc sections · 2 downstream", reused: true },
  { role: "Docs Updater", out: "4 anchored edits", reused: false },
  { role: "Changelog Author", out: "1 entry · minor bump", reused: false },
  { role: "Coordinator", out: "consistent · summary written", reused: false },
];

function RunMock() {
  return (
    <div className="border border-zinc-200 bg-zinc-950 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
        <SiGithub size={13} className="text-zinc-500 shrink-0" />
        <span className="text-xs text-zinc-500 font-mono truncate">
          Actions · docxy · push to main
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-emerald-400 border border-emerald-900 px-1.5 py-px font-mono">
          running
        </span>
      </div>

      <div className="p-5 font-mono text-xs leading-6">
        <p className="text-zinc-500">
          <span className="text-zinc-600">▸</span> acme/payments-api{" "}
          <span className="text-zinc-600">·</span> 8f2a1c9
        </p>
        <p className="text-zinc-600 mt-1">6 files changed · +142 −37</p>

        <div className="mt-4 space-y-2">
          {timeline.map((row) => (
            <div key={row.role} className="flex items-start gap-3">
              <span className="text-emerald-400 shrink-0">✓</span>
              <span className="text-zinc-200 shrink-0 w-[132px]">
                {row.role}
              </span>
              <span className="text-zinc-500 truncate">{row.out}</span>
              {row.reused && (
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600 border border-zinc-800 px-1.5 py-px">
                  remembers this repo
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-zinc-800">
          <p className="text-[var(--accent)]">
            ✓ opened PR #218 · docs: update webhook retry limits
          </p>
          <p className="text-zinc-600 mt-1">
            waiting on 1 approval before it merges
          </p>
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <>
      <div className="max-w-7xl mx-auto px-8 lg:px-14 py-16 lg:py-24 grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-12 lg:gap-16 items-center">
        <div>
          <h1 className="text-5xl lg:text-[62px] font-bold text-zinc-900 tracking-tight leading-[1.05]">
            Docs that write
            <br />
            <span className="text-[var(--accent)]">themselves</span>
          </h1>

          <p className="mt-6 text-lg text-zinc-500 leading-relaxed max-w-md">
            {site.description}
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-8">
            <ButtonLink href={site.install}>
              <SiGithub size={15} />
              Install the GitHub App
            </ButtonLink>
            <ButtonLink href="#how-it-works" variant="outline">
              See how it works
            </ButtonLink>
          </div>

          <p className="mt-6 text-xs text-zinc-400 font-mono">
            Free and open source · Any repo · You approve everything
          </p>
        </div>

        <RunMock />
      </div>
      <Rule />
    </>
  );
}
