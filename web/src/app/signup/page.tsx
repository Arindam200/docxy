import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/components/auth/AuthShell";
import { CredentialsForm } from "@/components/auth/CredentialsForm";
import { SetupNotice } from "@/components/auth/SetupNotice";
import { authReady, githubConfigured, googleConfigured, missingEnv } from "@/lib/env";
import { safeNext } from "@/lib/redirect";

export const metadata: Metadata = {
  title: "Sign up · Docxy",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error
    ? "That sign-up could not be completed. Please try again."
    : undefined;

  return (
    <AuthShell
      eyebrow="New here"
      title="Create your Docxy account"
      lede="Connect a repo, push code, review the PR. That's the whole onboarding."
      error={error}
      alt={
        <>
          Already have an account?{" "}
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="font-medium text-foreground underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            Sign in
          </Link>
        </>
      }
    >
      {authReady() ? (
        <CredentialsForm
          mode="signup"
          next={next}
          google={googleConfigured()}
          github={githubConfigured()}
        />
      ) : (
        <SetupNotice missing={missingEnv()} />
      )}
      <p className="text-center text-xs leading-relaxed text-muted">
        Your name, email, and avatar are used only to identify your reviews and sign-offs.
      </p>
    </AuthShell>
  );
}
