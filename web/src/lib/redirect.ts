/**
 * Where to land after signing in.
 *
 * The proxy puts the blocked path in `?next=`, which means it arrives as user
 * input and cannot be trusted: anything that is not a plain in-app path would
 * turn the sign-in page into an open redirect.
 *
 * A single leading slash is not enough on its own. Both `//evil.com` and
 * `/\evil.com` are read as protocol-relative URLs by browsers, so the second
 * character has to be rejected too - that backslash case is the one a
 * `startsWith("//")` check quietly lets through. Resolving against a throwaway
 * origin then confirms nothing else in the value escapes it.
 *
 * And the *resolved* path is checked again, because resolving is what makes a
 * safe-looking input unsafe: dot segments collapse, so `/.//evil.com`,
 * `/a/..//evil.com` and `/%2e//evil.com` all pass the first test and resolve
 * to the path `//evil.com` - which the redirect then reads as a host.
 */
export function safeNext(value: string | undefined, fallback = "/dashboard"): string {
  if (!value || !/^\/[^/\\]/.test(value)) return fallback;

  try {
    const resolved = new URL(value, "http://localhost");
    if (resolved.origin !== "http://localhost") return fallback;
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return /^\/[^/\\]/.test(path) || path === "/" ? path : fallback;
  } catch {
    return fallback;
  }
}
