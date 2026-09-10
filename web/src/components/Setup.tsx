import { hostedPlans } from "@/lib/site";
import { ButtonLink, Rule, Section, SectionHead } from "./primitives";

const steps = [
  { title: "Connect GitHub", detail: "Choose which repositories to connect." },
  { title: "Set your docs rules", detail: "Choose your docs and add writing instructions." },
  { title: "Start your first run", detail: "Run manually, or automate updates on a paid plan." },
  { title: "Review the pull request", detail: "Review the changes in GitHub." },
];

export function Setup() {
  return (
    <>
      <Section id="setup" className="pt-14 pb-12">
        <SectionHead
          title="Connect your repo. Keep shipping."
          lede="Connect GitHub, choose your docs, and review your first update."
        />
        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px border border-zinc-200 bg-zinc-200">
          {steps.map((step, i) => (
            <li key={step.title} className="bg-white p-6">
              <p className="text-xs font-mono text-zinc-400 mb-4">0{i + 1}</p>
              <h3 className="text-sm font-semibold text-zinc-900">{step.title}</h3>
              <p className="mt-2 text-sm text-zinc-500 leading-relaxed">{step.detail}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8 flex flex-wrap items-center gap-5">
          <ButtonLink href="/signup">Get started <span aria-hidden>→</span></ButtonLink>
        </div>
      </Section>
      <Rule />
    </>
  );
}

export function Cost() {
  return (
    <>
      <Section id="cost" className="py-12 lg:py-16">
        <SectionHead
          eyebrow="PRICING"
          title="Start free. Keep your docs growing."
          lede="Try it on one repo, automate your updates, then cover more projects. AI usage, validation, and hosting included."
        />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {hostedPlans.map((plan) => (
            <div key={plan.name} className={`p-7 border flex flex-col ${plan.featured ? "bg-zinc-950 border-zinc-950 text-white" : "bg-zinc-50 border-zinc-200 text-zinc-900"}`}>
              <h3 className="text-base font-semibold">{plan.name}</h3>
              <p className={`mt-2 text-sm ${plan.featured ? "text-zinc-400" : "text-zinc-500"}`}>{plan.description}</p>
              <p className="mt-6 flex items-baseline gap-1">
                <span className="text-5xl font-bold tracking-tight">{plan.price}</span>
                <span className="text-sm text-zinc-500">/ month</span>
              </p>
              <ul className={`my-7 space-y-3 text-sm flex-1 ${plan.featured ? "text-zinc-300" : "text-zinc-600"}`}>
                <li>{plan.repositories} {plan.repositories === 1 ? "repository" : "repositories"}</li>
                <li>{plan.runsPerMonth} runs per month</li>
                <li>{plan.trigger}</li>
                <li>Docs and changelog pull requests</li>
                <li>{plan.benefit}</li>
              </ul>
              <ButtonLink href="/signup" variant={plan.featured ? "invert" : "outline"}>
                Get started <span aria-hidden>→</span>
              </ButtonLink>
            </div>
          ))}
        </div>
      </Section>
      <Rule />
    </>
  );
}
