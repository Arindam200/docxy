import Image from "next/image";
import { SiGithub } from "react-icons/si";
import { why, roles, integrations, validations, site, author } from "@/lib/site";
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
          title="Your docs go stale the moment you ship"
          lede="Documentation is the first thing developers read and the last thing anyone wants to maintain. Docxy catches the drift on the commit that caused it, and never lets a fix land without you saying yes."
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
          <ButtonLink href={site.install}>
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
  { stage: "you push code", kind: "event" },
  { stage: "Change Analyst", kind: "role" },
  { stage: "Impact Mapper", kind: "role" },
  { stage: "Docs Updater  ·  Changelog Author", kind: "parallel" },
  { stage: "Automatic checks", kind: "check" },
  { stage: "Coordinator", kind: "role" },
  { stage: "your approval", kind: "gate" },
  { stage: "pull request merges", kind: "event" },
] as const;

const kindStyle = {
  event: "bg-zinc-50 text-zinc-500 border-zinc-200 font-mono text-xs",
  role: "bg-white text-zinc-900 border-zinc-300 text-sm font-semibold",
  parallel: "bg-white text-zinc-900 border-zinc-300 text-sm font-semibold",
  check: "bg-white text-zinc-900 border-zinc-300 text-sm font-semibold",
  gate: "bg-zinc-950 text-white border-zinc-950 text-sm font-semibold",
} satisfies Record<string, string>;

export function HowItWorks() {
  return (
    <>
      <Section id="how-it-works" className="pt-14 pb-12">
        <SectionHead
          title="One push, six steps, one pull request"
          lede="The order is fixed in code, not left to a prompt. Each agent hands a structured result to the next, and the run always ends at a pull request with your name on the reviewer list."
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
              What gets checked before you see it
            </h3>
            <p className="text-sm text-zinc-500 leading-relaxed mb-6">
              The usual way a model breaks your docs is by quoting a line that
              was never there. So the strictest check runs first, against a real
              checkout of your repository, before anything reaches a pull
              request.
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
                Ship a{" "}
                <span className="font-semibold text-zinc-700">breaking</span>{" "}
                change with anything less than a{" "}
                <span className="font-semibold text-zinc-700">major</span> bump
                and the run fails on the spot. Docxy would rather tell you
                nothing than tell you something contradictory.
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
          title="Meet the five agents"
          lede="Each one carries a skill pack: a plain SKILL.md file holding the judgment that would otherwise be buried in a prompt. Editing those files is how you teach Docxy the rules of your codebase."
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
              <p className="text-sm text-zinc-400 leading-relaxed flex-1">
                {role.detail}
              </p>
              {role.skill && (
                <p className="mt-4 text-xs font-mono text-zinc-400 border border-zinc-100 bg-zinc-50 px-2 py-1 self-start">
                  skills/{role.skill}
                </p>
              )}
            </div>
          ))}

          <div className="bg-zinc-50 p-7 flex flex-col justify-center">
            <p className="text-sm text-zinc-600 leading-relaxed">
              Every agent keeps its own session{" "}
              <span className="text-zinc-900 font-medium">
                for each repository
              </span>
              , so what it learns on one commit is still there on the next. Your
              tenth pull request is better than your first.
            </p>
            <p className="mt-4 text-xs font-mono text-zinc-400">
              5 agents · 4 skill packs · 1 reviewer
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
          title="Fits the stack you already have"
          lede="No dashboard to live in and no platform in the middle. Docxy runs inside GitHub, writes to a branch in your repo, and speaks the formats your project already uses."
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
