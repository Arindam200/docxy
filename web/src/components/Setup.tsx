import { SiGithub, SiGithubactions } from "react-icons/si";
import { site } from "@/lib/site";
import { ButtonLink, Rule, Section, SectionHead } from "./primitives";

const steps = [
  "Install the app on your org and pick the repos it watches",
  "Tell it where your docs live, or let it find them",
  "Push code like you normally would",
  "Review the pull request it opens and merge",
];

export function Setup() {
  return (
    <>
      <Section id="setup" className="pt-14 pb-12">
        <SectionHead
          title="Two minutes, then it runs itself"
          lede="Most teams want the app. Drop to the Action if you need the pipeline inside a workflow you already control."
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-zinc-200 overflow-hidden flex flex-col">
            <div className="px-8 pt-8 pb-6 border-b border-zinc-100">
              <p className="text-[10px] font-semibold tracking-widest text-zinc-400 mb-3">
                RECOMMENDED
              </p>
              <h3 className="text-lg font-semibold text-zinc-900 mb-2">
                Install the GitHub App
              </h3>
              <p className="text-sm text-zinc-500 leading-relaxed">
                Nothing to host and nothing to configure. Add it to your org,
                choose your repositories, and the next push you make is the
                first one it watches.
              </p>
            </div>

            <div className="px-8 py-6 flex-1 space-y-3">
              {steps.map((step, i) => (
                <div key={step} className="flex items-start gap-3">
                  <span className="w-5 h-5 bg-zinc-100 text-zinc-500 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <p className="text-sm text-zinc-600 leading-relaxed">
                    {step}
                  </p>
                </div>
              ))}
            </div>

            <div className="px-8 pb-8 pt-2">
              <ButtonLink href={site.install}>
                <SiGithub size={15} />
                Install the GitHub App
              </ButtonLink>
            </div>
          </div>

          <div className="border border-zinc-200 overflow-hidden flex flex-col bg-zinc-950">
            <div className="px-8 pt-8 pb-6 border-b border-zinc-800">
              <p className="text-[10px] font-semibold tracking-widest text-zinc-500 mb-3">
                SELF HOSTED
              </p>
              <h3 className="text-lg font-semibold text-white mb-2">
                Or wire up the Action
              </h3>
              <p className="text-sm text-zinc-400 leading-relaxed">
                The same five agents as a workflow step, with your own keys and
                your own runner. Gate it on a protected environment and GitHub
                holds the job open until someone approves.
              </p>
            </div>

            <div className="px-8 py-6 flex-1">
              <div className="bg-zinc-900 border border-zinc-800 overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800">
                  <span className="text-[10px] text-zinc-500 font-mono">
                    .github/workflows/docxy.yml
                  </span>
                </div>
                <div className="p-4 font-mono text-xs leading-6 overflow-x-auto">
                  <p>
                    <span className="text-sky-300">on</span>
                    <span className="text-zinc-500">:</span>
                  </p>
                  <p className="pl-3">
                    <span className="text-sky-300">push</span>
                    <span className="text-zinc-500">:</span>
                  </p>
                  <p className="pl-6">
                    <span className="text-sky-300">branches</span>
                    <span className="text-zinc-500">: [</span>
                    <span className="text-emerald-400">main</span>
                    <span className="text-zinc-500">]</span>
                  </p>
                  <p className="mt-2">
                    <span className="text-sky-300">jobs</span>
                    <span className="text-zinc-500">:</span>
                  </p>
                  <p className="pl-3">
                    <span className="text-sky-300">docs</span>
                    <span className="text-zinc-500">:</span>
                  </p>
                  <p className="pl-6">
                    <span className="text-sky-300">uses</span>
                    <span className="text-zinc-500">: </span>
                    <span className="text-emerald-400">
                      Arindam200/docxy@v1
                    </span>
                  </p>
                  <p className="pl-6">
                    <span className="text-sky-300">environment</span>
                    <span className="text-zinc-500">: </span>
                    <span className="text-emerald-400">docs-review</span>
                  </p>
                  <p className="mt-2 text-zinc-600">
                    # opens a PR, waits for approval
                  </p>
                </div>
              </div>
            </div>

            <div className="px-8 pb-8 pt-2">
              <ButtonLink href={site.repo} variant="ghost">
                <SiGithubactions size={15} />
                View the workflow
              </ButtonLink>
            </div>
          </div>
        </div>
      </Section>
      <Rule />
    </>
  );
}

const hosted = [
  "Every repository in your org",
  "All five agents and their skill packs",
  "Docs and changelog in one pull request",
  "Approval rules per repository",
  "Runs on push or on pull request",
  "No infrastructure to keep alive",
];

const selfHosted = [
  "The same pipeline, your own runner",
  "Bring your own Nebius Token Factory key",
  "Swap in any model the harness can reach",
  "Editable skill packs in your repo",
  "Gate on a protected GitHub environment",
  "MIT licensed, fork it if you like",
];

export function Cost() {
  return (
    <>
      <Section className="py-12 lg:py-16">
        <div className="mb-8">
          <h2 className="text-3xl lg:text-[42px] font-semibold text-zinc-900 tracking-tight leading-[1.1]">
            What it costs
          </h2>
          <p className="mt-4 text-lg text-zinc-500 leading-relaxed max-w-md">
            Docxy is free and open source. Install the app, or run the whole
            thing yourself and pay only your model provider.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-3xl">
          <div className="p-8 flex flex-col bg-zinc-50">
            <div className="mb-8">
              <p className="text-sm font-semibold text-zinc-500 mb-4">
                GitHub App
              </p>
              <div className="flex items-end gap-1">
                <span className="text-5xl font-bold text-zinc-900">$0</span>
                <span className="text-zinc-400 mb-1.5">to install</span>
              </div>
              <p className="text-sm text-zinc-500 mt-2">
                Nothing to host. No card.
              </p>
            </div>

            <ul className="space-y-3 flex-1 mb-8">
              {hosted.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 text-sm text-zinc-600"
                >
                  <svg
                    className="w-4 h-4 text-zinc-400 shrink-0"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M3 8l3.5 3.5L13 5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>

            <ButtonLink href={site.install} variant="outline">
              <SiGithub size={15} />
              Install the app
            </ButtonLink>
          </div>

          <div className="bg-zinc-950 p-8 flex flex-col">
            <div className="mb-8">
              <p className="text-sm font-semibold text-zinc-400 mb-4">
                Self hosted
              </p>
              <div className="flex items-end gap-1">
                <span className="text-5xl font-bold text-white">MIT</span>
                <span className="text-zinc-500 mb-1.5">licensed</span>
              </div>
              <p className="text-sm text-zinc-500 mt-2">
                You pay Nebius, not us.
              </p>
            </div>

            <ul className="space-y-3 flex-1 mb-8">
              {selfHosted.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2.5 text-sm text-zinc-300"
                >
                  <svg
                    className="w-4 h-4 text-[var(--accent)] shrink-0"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M3 8l3.5 3.5L13 5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>

            <ButtonLink href={site.repo} variant="invert">
              <SiGithub size={15} />
              Clone the repo
            </ButtonLink>
          </div>
        </div>
      </Section>
      <Rule />
    </>
  );
}
