"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { projectHref } from "@/lib/projects";
import { LuArrowRight, LuBookText, LuCode } from "react-icons/lu";

import { Select } from "@/components/dashboard/Select";
// `import type` only - erased at build, so the server-side module it lives in
// is never pulled into this client bundle.
import type { NewProjectInput } from "@/lib/docxy";

/**
 * Connect one repository as a project, and say where its documentation lives.
 *
 * Two choices, because two are genuinely different questions. The source
 * repository is what gets watched for commits; the documentation repository is
 * what gets the pull request. They are usually the same, and the form says so
 * by defaulting to it - but a docs site, a handbook, or one central
 * documentation repository fed by several services are all ordinary
 * arrangements, and assuming a monorepo quietly excluded every one of them.
 */

const LABEL = "mb-1.5 block text-sm font-medium";
const FIELD =
  "focus-ring w-full border border-rule bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted";

export function ConnectRepository({
  repositories,
  connected,
  initialSource = "",
}: {
  /** Everything the installation can reach. */
  repositories: string[];
  /** Already connected, so they cannot be chosen as a source twice. */
  connected: string[];
  initialSource?: string;
}) {
  const router = useRouter();
  const [source, setSource] = useState(repositories.includes(initialSource) && !connected.includes(initialSource) ? initialSource : "");
  const [separateDocs, setSeparateDocs] = useState(false);
  const [docs, setDocs] = useState("");
  const [roots, setRoots] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taken = new Set(connected);
  const available = repositories.filter((repo) => !taken.has(repo));

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source) {
      setError("Choose the repository whose code you want documented.");
      return;
    }
    if (separateDocs && !docs) {
      setError("Choose the repository the documentation lives in.");
      return;
    }

    setPending(true);
    setError(null);

    const payload: Omit<NewProjectInput, "organizationId"> = {
      sourceRepo: source,
      name: name.trim() || source.split("/")[1] || source,
    };
    // Only when they asked for one. Sending the source as the docs repository
    // would store the same fact twice and let the two drift apart.
    if (separateDocs && docs && docs !== source) payload.docsRepo = docs;
    if (roots.trim()) payload.docsRoots = roots.trim();

    // No organization in this payload, deliberately. The proxy writes the
    // session's one into the query string and the API reads it only from
    // there, so a value sent from the browser could not have counted anyway.
    const response = await fetch("/api/docxy/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    // SAFETY: only `error` is read, as an optional string, and the `??` below
    // supplies the message when the body is not that shape or not JSON at all.
    const body = (await response.json().catch(() => null)) as { error?: string; project?: { id?: string } } | null;
    if (!response.ok) {
      setPending(false);
      setError(body?.error ?? "Could not connect the repository. Please try again.");
      return;
    }

    router.push(body?.project?.id ? projectHref(body.project.id) : "/dashboard");
    router.refresh();
  }

  if (available.length === 0) {
    return (
      <div className="border border-dashed border-rule px-6 py-12 text-center">
        <p className="text-sm text-muted">
          {repositories.length === 0
            ? "The GitHub App is not installed on any repository yet."
            : "Every repository the App can reach is already connected."}
        </p>
        <a href="/api/github/install" className="focus-ring mt-5 inline-flex items-center gap-2 border border-accent-deep bg-accent-deep px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-deep/85">
          Connect GitHub <LuArrowRight size={15} aria-hidden />
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="border border-rule bg-surface p-5 space-y-4">
        <div className="flex items-center gap-2">
          <LuCode size={15} aria-hidden className="text-accent" />
          <h2 className="text-sm font-semibold">Source repository</h2>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          The code docxy watches. Every push to its default branch starts a run.
        </p>
        {/* The empty option is explicit: `Select` shows the first entry when the
            value matches nothing, so without it an unchosen control would look
            like a repository had already been picked. */}
        <Select
          label="Source repository"
          value={source}
          onChange={(value) => {
            setSource(value);
            if (!separateDocs) setDocs(value);
          }}
          options={[
            { value: "", label: "Choose a repository" },
            ...available.map((repo) => ({ value: repo, label: repo })),
          ]}
        />
      </div>

      <div className="border border-rule bg-surface p-5 space-y-4">
        <div className="flex items-center gap-2">
          <LuBookText size={15} aria-hidden className="text-accent" />
          <h2 className="text-sm font-semibold">Documentation repository</h2>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed">
          <input
            type="checkbox"
            checked={!separateDocs}
            onChange={(event) => {
              setSeparateDocs(!event.target.checked);
              if (event.target.checked) setDocs(source);
            }}
            className="mt-0.5"
          />
          <span className="text-muted">
            The documentation lives in the same repository as the code.
          </span>
        </label>

        {separateDocs && (
          <>
            <p className="text-xs leading-relaxed text-muted">
              Pull requests open here instead. The App has to be installed on it too.
            </p>
            {/* The source is a legitimate choice for a docs repository only via
                the checkbox above, so it is not offered twice. */}
            <Select
              label="Documentation repository"
              value={docs}
              onChange={setDocs}
              options={[
                { value: "", label: "Choose a repository" },
                ...repositories
                  .filter((repo) => repo !== source)
                  .map((repo) => ({ value: repo, label: repo })),
              ]}
            />
          </>
        )}

        {/* Asked in both cases, because "where are the docs" is a different
            question from "which repository". Left blank, docxy falls back to
            guessing at docs/, doc/, README.md and website/docs - which quietly
            finds nothing in a project that keeps them somewhere else, and
            produces an empty proposal rather than an error. */}
        <div className="border-t border-rule pt-4">
          <label htmlFor="docs-roots" className={LABEL}>
            Documentation folder{" "}
            <span className="font-normal text-muted">(recommended)</span>
          </label>
          <input
            id="docs-roots"
            value={roots}
            onChange={(event) => setRoots(event.target.value)}
            placeholder="docs"
            className={FIELD}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Where the documentation actually lives in{" "}
            {separateDocs && docs ? docs : "that repository"} - for example{" "}
            <code className="font-mono text-foreground">docs</code>,{" "}
            <code className="font-mono text-foreground">content/docs</code>, or{" "}
            <code className="font-mono text-foreground">apps/www/content</code>. Separate
            several with commas, and include{" "}
            <code className="font-mono text-foreground">README.md</code> if it should be
            kept up to date too. Leave blank and docxy guesses at the common locations.
          </p>
        </div>
      </div>

      <div className="border border-rule bg-surface p-5 space-y-3">
        <label htmlFor="project-name" className={LABEL}>
          Project name <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          placeholder={source ? source.split("/")[1] : "Named after the repository"}
          className={FIELD}
        />
      </div>

      {error && (
        <p role="alert" className="border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || !source}
        className="focus-ring inline-flex items-center justify-center gap-2 border border-accent-deep bg-accent-deep px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-deep/85 disabled:pointer-events-none disabled:opacity-50"
      >
        {pending ? "Connecting…" : "Connect repository"}
        {!pending && <LuArrowRight size={14} aria-hidden />}
      </button>
    </form>
  );
}
