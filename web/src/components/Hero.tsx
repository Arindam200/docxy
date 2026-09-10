import { SiGithub } from "react-icons/si";
import { ButtonLink, Rule } from "./primitives";
import { site } from "@/lib/site";
import { RunPreview } from "./RunPreview";

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
            <ButtonLink href="/signup">
              <SiGithub size={15} />
              Get started
            </ButtonLink>
            <ButtonLink href="#how-it-works" variant="outline">
              See how it works
            </ButtonLink>
          </div>

          <p className="mt-6 text-xs text-zinc-400 font-mono">
            Docs + release notes · Reviewed in GitHub
          </p>
        </div>

        <RunPreview />
      </div>
      <Rule />
    </>
  );
}
