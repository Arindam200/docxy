import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/components/auth/AuthShell";
import { CredentialsForm } from "@/components/auth/CredentialsForm";
import { SetupNotice } from "@/components/auth/SetupNotice";
import { authReady, githubConfigured, googleConfigured, missingEnv } from "@/lib/env";
import { safeNext } from "@/lib/redirect";

export const metadata: Metadata = {
  title: "Sign in · Docxy",
};

/** OAuth failures come back on the query string rather than in the response. */
const ERRORS: Record<string, string> = {
  unconfigured:
    "That provider is not configured on this deployment yet. Sign in with an email and password instead.",
  access_denied: "The sign-in was cancelled before it finished. Please try again.",
  state_mismatch: "That sign-in attempt expired or was tampered with. Please try again.",
  no_email: "That account did not share an email address, which Docxy requires.",
  account_not_linked:
    "An account already exists for that email with a different sign-in method. Use the one you signed up with.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error
    ? (ERRORS[params.error] ?? "Something went wrong signing you in. Please try again.")
    : undefined;

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in to Docxy"
      lede="One account for every run, approval, and instruction."
      error={error}
      alt={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href={`/signup?next=${encodeURIComponent(next)}`}
            className="font-medium text-foreground underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            Sign up
          </Link>
        </>
      }
    >
      {authReady() ? (
        <CredentialsForm
          mode="signin"
          next={next}
          google={googleConfigured()}
          github={githubConfigured()}
        />
      ) : (
        <SetupNotice missing={missingEnv()} />
      )}
    </AuthShell>
  );
}
