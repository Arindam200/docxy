/**
 * The shape of a signed-in user as the dashboard UI needs it.
 *
 * Kept free of imports so client components can use it without pulling the
 * Better Auth server module into their module graph.
 */
export interface DashboardUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}
