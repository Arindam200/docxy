"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn, signUp } from "@/lib/auth-client";
import { GitHubIcon, GoogleIcon } from "@/components/auth/SocialIcons";

/**
 * Sign-in and sign-up in one panel: the two forms differ by a single field, and
 * splitting them across routes would mean two round trips to discover which one
 * you wanted.
 *
 * Social buttons are rendered only for providers this deployment actually has
 * credentials for — an OAuth button that can only ever 503 is worse than none.
 */

type Mode = "signin" | "signup";

const FIELD =
  "focus-ring w-full rounded-md border border-rule bg-surface px-3 py-2.5 text-sm text-foreground placeholder:text-muted";

export function SignInPanel({
  google,
  github,
  next,
}: {
  google: boolean;
  github: boolean;
  next: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = pending !== null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending("email");

    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "").trim();

    const result =
      mode === "signup"
        ? await signUp.email({ email, password, name: name || email, callbackURL: next })
        : await signIn.email({ email, password, callbackURL: next });

    if (result.error) {
      setError(result.error.message ?? "That did not work. Please try again.");
      setPending(null);
      return;
    }

    // autoSignIn is on, so both paths land with a session already set.
    router.push(next);
    router.refresh();
  }

  async function handleSocial(provider: "google" | "github") {
    setError(null);
    setPending(provider);
    const result = await signIn.social({ provider, callbackURL: next });
    // A success here means a redirect is already in flight; only failures return.
    if (result?.error) {
      setError(result.error.message ?? `Could not start ${provider} sign-in.`);
      setPending(null);
    }
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Sign in or create an account"
        className="inline-flex rounded-md border border-rule bg-surface p-0.5 text-xs"
      >
        {(["signin", "signup"] as const).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={`rounded px-3 py-1.5 font-medium transition-colors ${
              mode === value ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {value === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-6 rounded-md border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-3">
        {mode === "signup" && (
          <div>
            <label htmlFor="name" className="mb-1.5 block text-xs font-medium text-muted">
              Name
            </label>
            <input id="name" name="name" autoComplete="name" placeholder="Ada Lovelace" className={FIELD} />
          </div>
        )}

        <div>
          <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-muted">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className={FIELD}
          />
        </div>

        <div>
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-muted">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder="At least 8 characters"
            className={FIELD}
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="focus-ring w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
        >
          {pending === "email"
            ? "Working…"
            : mode === "signup"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>

      {(google || github) && (
        <>
          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-rule" />
            <span className="text-[11px] uppercase tracking-widest text-muted">or</span>
            <span className="h-px flex-1 bg-rule" />
          </div>

          <div className="space-y-2">
            {google && (
              <SocialButton
                onClick={() => handleSocial("google")}
                disabled={busy}
                pending={pending === "google"}
                icon={<GoogleIcon />}
                label="Continue with Google"
              />
            )}
            {github && (
              <SocialButton
                onClick={() => handleSocial("github")}
                disabled={busy}
                pending={pending === "github"}
                icon={<GitHubIcon />}
                label="Continue with GitHub"
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SocialButton({
  onClick,
  disabled,
  pending,
  icon,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  pending: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring flex w-full items-center justify-center gap-3 rounded-md border border-rule bg-surface-2 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:border-accent disabled:opacity-60"
    >
      {icon}
      {pending ? "Redirecting…" : label}
    </button>
  );
}
