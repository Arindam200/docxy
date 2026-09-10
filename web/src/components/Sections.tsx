import Image from "next/image";
import { SiGithub } from "react-icons/si";
import { why, roles, integrations, validations, author } from "@/lib/site";
import { ButtonLink, CellGrid, Rule, Section, SectionHead } from "./primitives";
import { brandIcons } from "./icons";

export function Quote() {
  return (
    <>
      <Section className="py-20">
        <p className="text-xs font-semibold tracking-widest text-zinc-400 mb-5">
          WHY I BUILT THIS
        </p>
        <div className="max-w-xl">
          <p className="text-lg font-medium text-zinc-900 leading-relaxed">
            <span className="text-zinc-300">“</span>
            {author.quote.map((run, i) =>
              "hl" in run && run.hl ? (
                <span key={i} className="text-[var(--accent-deep)]">
                  {run.t}
                </span>
              ) : (
                <span key={i}>{run.t}</span>
              ),
            )}
            <span className="text-zinc-300">”</span>
          </p>
          <div className="flex items-center gap-3 mt-6">
            <Image
              src={author.avatar}
              alt={author.name}
              width={36}
              height={36}
              className="w-9 h-9 rounded-full object-cover shrink-0"
            />
            <div>
              <p className="text-sm font-semibold text-zinc-900">
                {author.name}
              </p>
              <p className="text-xs text-zinc-400 mt-0.5">{author.title}</p>
            </div>
          </div>
        </div>
      </Section>
      <Rule />
    </>
  );
}

export function Why() {
  return (
    <>
      <Section className="pt-14 pb-12">
        <SectionHead
          title="Spend less time maintaining docs"
          lede="Keep your documentation current while your team focuses on building."
        />
        <CellGrid>
          {why.map((item) => (
            <div key={item.title} className="bg-white p-7">
              <h3 className="text-sm font-semibold text-zinc-900 mb-2">
                {item.title}
              </h3>
              <p className="text-sm text-zinc-500 leading-relaxed">
                {item.body}
              </p>
            </div>
          ))}
        </CellGrid>
        <div className="mt-8">
          <ButtonLink href="#setup">
            <SiGithub size={15} />
            Add it to your repo
          </ButtonLink>
        </div>
      </Section>
      <Rule />
    </>
  );
}

const flow = [
  { stage: "You push code", kind: "event" },
  { stage: "Docxy finds affected docs", kind: "step" },
  { stage: "Updates and release notes are drafted", kind: "step" },
  { stage: "Checks run", kind: "step" },
  { stage: "You review the pull request", kind: "review" },
] as const;

const kindStyle = {
  event: "bg-zinc-50 text-zinc-500 border-zinc-200 font-mono text-xs",
  step: "bg-white text-zinc-900 border-zinc-300 text-sm font-semibold",
  review: "bg-zinc-950 text-white border-zinc-950 text-sm font-semibold",
} satisfies Record<string, string>;

export function HowItWorks() {
  return (
    <>
      <Section id="how-it-works" className="pt-14 pb-12">
        <SectionHead
          title="From code change to docs update"
          lede="Push code. Get suggested updates. Review them in GitHub."
        />

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-10 lg:gap-16">
          <ol className="space-y-2">
            {flow.map((node, i) => (
              <li key={node.stage}>
                <div
                  className={`border px-5 py-3 text-center ${kindStyle[node.kind]}`}
                >
                  {node.stage}
                </div>
                {i < flow.length - 1 && (
                  <div
                    aria-hidden
                    className="mx-auto w-px h-4 bg-zinc-300 my-1"
                  />
                )}
              </li>
            ))}
          </ol>

          <div>
            <h3 className="text-sm font-semibold text-zinc-900 mb-3">
              Checked before review
            </h3>
            <p className="text-sm text-zinc-500 leading-relaxed mb-6">
              Docxy checks edits, links, and version suggestions.
              Add your docs build and test commands for additional checks.
            </p>

            <CellGrid cols="sm:grid-cols-2">
              {validations.map((v) => (
                <div key={v.label} className="bg-white px-5 py-4">
                  <p className="text-sm font-semibold text-zinc-900">
                    {v.label}
                  </p>
                  <p className="text-xs text-zinc-400 mt-0.5">{v.detail}</p>
                </div>
              ))}
            </CellGrid>

            <div className="mt-6 border border-zinc-200 bg-zinc-50 px-5 py-4">
              <p className="text-xs text-zinc-500 leading-relaxed">
                Failed checks appear on a draft pull request, with the reasons attached.
              </p>
            </div>
          </div>
        </div>
      </Section>
      <Rule />
    </>
  );
}

export function Roster() {
  return (
    <>
      <Section id="roster" className="pt-14 pb-12">
        <SectionHead
          title="What you get"
          lede="Focused updates to the docs your team already uses."
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-zinc-200 border border-zinc-200">
          {roles.map((role) => (
            <div key={role.title} className="bg-white p-7 flex flex-col">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-xs font-mono text-zinc-300">
                  {role.step}
                </span>
                <h3 className="text-base font-semibold text-zinc-900">
                  {role.title}
                </h3>
              </div>
              <p className="text-sm text-zinc-600 leading-relaxed mb-3">
                {role.job}
              </p>

            </div>
          ))}

          <div className="bg-zinc-50 p-7 flex flex-col justify-center">
            <h3 className="text-base font-semibold text-zinc-900 mb-2">
              Builds on previous runs
            </h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Docxy remembers which code relates to which docs and reuses that
              context on the next update.
            </p>
          </div>
        </div>
      </Section>
      <Rule />
    </>
  );
}

export function Integrations() {
  return (
    <>
      <Section className="pt-14 pb-12">
        <SectionHead
          title="Built with"
          lede="Works with GitHub and your existing Markdown or MDX docs."
        />
        <CellGrid cols="sm:grid-cols-2 lg:grid-cols-4">
          {integrations.map((item) => (
            <div
              key={item.name}
              className="bg-white p-6 flex flex-col gap-3 hover:bg-zinc-50 transition-colors"
            >
              <div className="w-10 h-10 bg-zinc-100 flex items-center justify-center">
                {brandIcons[item.name]}
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-900">
                  {item.name}
                </p>
                <p className="text-xs text-zinc-400 mt-0.5">{item.detail}</p>
              </div>
            </div>
          ))}
        </CellGrid>
      </Section>
      <Rule />
    </>
  );
}
