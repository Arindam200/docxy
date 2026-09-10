/**
 * The organization fields the dashboard shell needs.
 *
 * Kept free of server imports so the same shape can cross the Server Component
 * boundary into the client-side switcher without pulling Drizzle into its
 * bundle.
 */
export interface DashboardOrganization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}