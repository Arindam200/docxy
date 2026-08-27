/**
 * Where to land after signing in.
 *
 * The proxy puts the blocked path in `?next=`, which means it arrives as user
 * input and cannot be trusted: anything that is not a plain in-app path would
 * turn the sign-in page into an open redirect.
 *
 * A single leading slash is not enough on its own. Both `//evil.com` and
 * `/\evil.com` are read as protocol-relative URLs by browsers, so the second
 * character has to be rejected too — that backslash case is the one a
 * `startsWith("//")` check quietly lets through. Resolving against a throwaway
 * origin then confirms nothing else in the value escapes it.
 */
export function safeNext(value: string | undefined, fallback = "/dashboard"): string {
  if (!value || !/^\/[^/\\]/.test(value)) return fallback;

  try {
    const resolved = new URL(value, "http://localhost");
    if (resolved.origin !== "http://localhost") return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
