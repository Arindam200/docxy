import type { Metadata } from "next";
import { SignInPanel } from "@/components/auth/SignInPanel";
import { authReady, githubConfigured, googleConfigured, missingEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Sign in · Docxy",
};

export const dynamic = "force-dynamic";

/** Only same-origin paths, so `?next=` cannot be used as an open redirect. */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const missing = missingEnv();

  return (
    <main className="theme-dark min-h-screen flex items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <span className="text-2xl font-semibold text-foreground tracking-tight">docxy</span>
          <span className="text-xs font-mono uppercase tracking-widest text-muted mt-1">
            dashboard
          </span>
        </div>

        <h1 className="text-3xl font-semibold text-foreground tracking-tight leading-tight">
          Sign in to your dashboard
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Track runs, approvals, and the docs your agents keep in sync — from one place.
        </p>

        {params.error && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
          >
            Sign-in did not complete: <span className="font-mono text-xs">{params.error}</span>.
            Please try again.
          </div>
        )}

        <div className="mt-8">
          {authReady() ? (
            <SignInPanel google={googleConfigured()} github={githubConfigured()} next={next} />
          ) : (
            <NotConfigured missing={missing} />
          )}
        </div>

        <div className="rule-h my-8" />
        <p className="text-xs leading-relaxed text-muted">
          By continuing you agree that Docxy stores your name, email, and avatar to identify
          reviews and sign-offs.
        </p>
      </div>
    </main>
  );
}

/**
 * A deployment missing its environment should say which variables are missing,
 * not present a sign-in form that can only fail.
 */
function NotConfigured({ missing }: { missing: Array<{ key: string; hint: string }> }) {
  return (
    <div role="alert" className="rounded-md border border-rule bg-surface px-4 py-4">
      <p className="text-sm font-medium text-foreground">Sign-in is not configured yet</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        Set the following in <code className="font-mono text-xs">web/.env.local</code>, then
        restart the dev server.
      </p>
      <ul className="mt-4 space-y-3">
        {missing.map((item) => (
          <li key={item.key}>
            <code className="font-mono text-xs text-foreground">{item.key}</code>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
