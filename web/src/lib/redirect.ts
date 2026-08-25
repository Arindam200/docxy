/**
 * Where to land after signing in.
 *
 * The proxy puts the blocked path in `?next=`, which means it arrives as user
 * input and cannot be trusted: anything that is not a plain in-app path — an
 * absolute URL, a protocol-relative `//host` — would turn the sign-in page into
 * an open redirect. Anything suspect falls back to the dashboard.
 */
export function safeNext(value: string | undefined, fallback = "/dashboard"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
