"use client";

import { useState } from "react";

import { GitHubIcon, GoogleIcon } from "@/components/auth/SocialIcons";
import { signIn } from "@/lib/auth-client";

/**
 * The OAuth pair under the credentials form. Providers this deployment cannot
 * complete a flow with are rendered disabled rather than hidden, so the layout
 * is stable and the missing setup is visible.
 */
export function OAuthButtons({
  google,
  github,
  next,
}: {
  google: boolean;
  github: boolean;
  next: string;
}) {
  const [pending, setPending] = useState<"google" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function oauth(provider: "google" | "github") {
    setError(null);
    setPending(provider);
    const result = await signIn.social({ provider, callbackURL: next });
    // On success Better Auth redirects; only a failure returns here.
    if (result?.error) {
      setPending(null);
      setError("Could not start the sign-in flow. Please try again.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          or continue with
        </span>
        <span className="h-px flex-1 bg-rule" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <OAuthButton
          label="Google"
          icon={<GoogleIcon />}
          onClick={() => oauth("google")}
          configured={google}
          hint="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable."
          pending={pending === "google"}
          busy={pending !== null}
        />
        <OAuthButton
          label="GitHub"
          icon={<GitHubIcon />}
          onClick={() => oauth("github")}
          configured={github}
          hint="Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable."
          pending={pending === "github"}
          busy={pending !== null}
        />
      </div>

      {error && (
        <p role="alert" className="text-center text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function OAuthButton({
  label,
  icon,
  onClick,
  configured,
  hint,
  pending,
  busy,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  configured: boolean;
  hint: string;
  pending: boolean;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!configured || busy}
      title={configured ? undefined : hint}
      className="focus-ring flex h-11 items-center justify-center gap-2.5 rounded-md border border-rule bg-surface text-sm font-medium text-foreground transition-colors hover:border-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
      {pending ? "Redirecting…" : label}
    </button>
  );
}
