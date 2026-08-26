import { LuExternalLink } from "react-icons/lu";

import type { Integration } from "@/lib/docxy";
import { site } from "@/lib/site";

/**
 * The pipeline's own dependencies — the harness, the model provider, the
 * database, the App it publishes as.
 *
 * These are not integrations a team chooses; they are what has to be true for a
 * run to happen at all, which is why they sit with the rest of the machinery
 * rather than in the catalogue. Every row that is not connected names the
 * variables that would connect it, so the page doubles as the setup checklist.
 */
export function ServiceStatus({ integrations }: { integrations: Integration[] }) {
  return (
    <section aria-labelledby="synced-services" className="border border-rule bg-surface">
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-3">
        <h2
          id="synced-services"
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
        >
          Platform services
        </h2>
        <span className="text-xs text-muted">
          {integrations.filter((item) => item.connected).length} of {integrations.length} connected
        </span>
      </div>

      <ul className="divide-y divide-rule">
        {integrations.map((service) => (
          <li key={service.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                    service.connected
                      ? "bg-ok"
                      : service.required
                        ? "bg-danger"
                        : "bg-zinc-500"
                  }`}
                />
                <span className="text-sm font-medium">{service.name}</span>
                {service.required && !service.connected && (
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-danger">
                    required
                  </span>
                )}
              </div>

              <span className="truncate font-mono text-[11px] text-muted" title={service.detail}>
                {service.detail}
              </span>
            </div>

            <p className="mt-1 text-xs leading-relaxed text-muted">{service.summary}</p>

            {!service.connected && service.missing.length > 0 && (
              <ul className="mt-2 flex flex-wrap items-center gap-1.5">
                {service.missing.map((item) => (
                  <li key={item}>
                    {/* Some entries are variable names, some are a sentence. A
                        name has no spaces, which is enough to tell them apart. */}
                    {item.includes(" ") ? (
                      <span className="text-xs text-muted">{item}</span>
                    ) : (
                      <code className="border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                        {item}
                      </code>
                    )}
                  </li>
                ))}
                <li>
                  <a
                    href={`${site.repo}/blob/main/${service.docs}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
                  >
                    {service.docs}
                    <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
                      <LuExternalLink />
                    </span>
                  </a>
                </li>
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
