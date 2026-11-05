/**
 * Which organization a browser write was meant for.
 *
 * The proxy takes the tenant from the session, never from the request, and that
 * is right - but the session is shared by every tab. Switch organizations in
 * one and a page still open in another goes on showing the first, while its
 * writes land in the second: instructions typed for one team overwrite
 * another's, a repository chosen from one list is connected under a different
 * name. Nothing about that is an attack. It is a stale tab doing exactly what
 * it was told.
 *
 * So a page that writes says which organization it was rendered for, and the
 * proxy refuses a write whose page and session disagree. The value is a check
 * and never a source: the tenant is still the session's, and a header naming
 * some other organization can only get a write refused, never redirected.
 * `ComposioConnection` does the same thing with a form field, and gets the same
 * 409 and the same sentence back, because it is the same situation.
 *
 * No server imports, so the client components that send the header can import
 * its name from here.
 */

/** The header a dashboard write carries, naming the organization its page showed. */
export const ORGANIZATION_HEADER = "x-docxy-organization";

/** What a refused write says. Matches `composio-handlers.ts`, word for word. */
export const STALE_ORGANIZATION = "Your organization changed. Refresh this page and try again.";

/**
 * Whether a request is a write from a page rendered for another organization.
 *
 * Reads are never stale in this sense: a read returns the session's
 * organization, and the page that asked renders whatever came back. A write
 * with no header at all is treated as stale rather than waved through,
 * because an optional check is one that the next caller forgets - and every
 * dashboard write sends one.
 */
export function staleWrite(method: string, rendered: string | null, current: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return rendered !== current;
}
