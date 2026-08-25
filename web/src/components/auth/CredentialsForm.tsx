"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Email and password with the OAuth pair beneath it — the whole credentials
 * block for both routes. Sign-in and sign-up differ by one field, one call, and
 * two strings, so they share a component rather than diverging into two that
 * drift apart.
 *
 * Better Auth runs with `autoSignIn`, so a successful sign-up lands with a
 * session already set and both paths can push straight to `next`.
 */

type Mode = "signin" | "signup";

const FIELD =
  "focus-ring w-full rounded-md border border-rule bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted";

const LABEL = "mb-1.5 block text-sm font-medium text-foreground";

/**
 * Better Auth reports a failed sign-in and a taken email with a status rather
 * than copy worth showing, so those two get sentences of their own.
 */
function message(mode: Mode, status: number | undefined, fallback: string | undefined): string {
  if (mode === "signin" && status === 401) return "Wrong email or password.";
  if (mode === "signup" && status === 422) {
    return "That email already has an account. Try signing in instead.";
  }
  return (
    fallback ??
    (mode === "signup"
      ? "Could not create the account. Please try again."
      : "Could not sign in. Please try again.")
  );
}

export function CredentialsForm({
  mode,
  next,
  google,
  github,
}: {
  mode: Mode;
  next: string;
  google: boolean;
  github: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signup = mode === "signup";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "").trim();

    const { error } = signup
      ? await signUp.email({ name: name || email, email, password, callbackURL: next })
      : await signIn.email({ email, password, callbackURL: next });

    if (error) {
      setPending(false);
      setError(message(mode, error.status, error.message));
      return;
    }

    router.push(next);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {/* noValidate: the messages below are more specific than the browser's. */}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {signup && (
          <div>
            <label htmlFor="name" className={LABEL}>
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              placeholder="Ada Lovelace"
              className={FIELD}
            />
          </div>
        )}

        <div>
          <label htmlFor="email" className={LABEL}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="name@example.com"
            className={FIELD}
          />
        </div>

        <div>
          <label htmlFor="password" className={LABEL}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            required
            minLength={8}
            placeholder={signup ? "At least 8 characters" : "••••••••"}
            className={FIELD}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="focus-ring w-full rounded-md bg-accent-deep py-3 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-60"
        >
          {pending
            ? signup
              ? "Creating account…"
              : "Signing in…"
            : signup
              ? "Create account"
              : "Sign in"}
        </button>
      </form>

      <OAuthButtons google={google} github={github} next={next} />
    </div>
  );
}
