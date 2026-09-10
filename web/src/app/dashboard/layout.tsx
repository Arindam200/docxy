import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Breadcrumb } from "@/components/dashboard/Breadcrumb";
import { HeaderActions } from "@/components/dashboard/HeaderActions";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { fetchProjects } from "@/lib/docxy";
import { projectTitle } from "@/lib/projects";
import {
  authRequired,
  getActiveOrganizationId,
  getSessionUser,
  getUserOrganizations,
} from "@/lib/auth";
import type { DashboardOrganization } from "@/lib/dashboard-organization";
import { resolveOrganization } from "@/lib/onboarding";
import { authReady } from "@/lib/env";
import type { DashboardUser } from "@/lib/user";

export const metadata: Metadata = {
  title: "Dashboard · Docxy",
};

/**
 * The proxy's cookie check is optimistic; this is the check that decides.
 *
 * What it decides is only whether somebody is signed in and has an
 * organization. It is no longer what keeps one account out of another's data:
 * the pages below are server components that read the pipeline API directly
 * through `lib/docxy`, never passing through the /api/docxy proxy, so a check
 * made in one place could never have covered them both. Each read now names the
 * organization it is for, and the API refuses one that does not.
 */
interface DashboardIdentity {
  user: DashboardUser;
  organizations: DashboardOrganization[];
  activeOrganizationId: string;
  /**
   * Enough of every project to name the one the chrome is inside.
   *
   * The rail and the breadcrumb both read the project out of the path, which
   * gives them an id and no name. Neither can fetch one: they render above the
   * project layout, and both are client components. So the layout that already
   * has the organization does the read once and hands both the list.
   */
  projects: Array<{ id: string; label: string }>;
}

async function currentIdentity(): Promise<DashboardIdentity | null> {
  if (!authRequired()) return null;

  // Required but impossible: missing DATABASE_URL or BETTER_AUTH_SECRET. The
  // login page is where that gets explained; silently rendering the dashboard
  // would be showing the data to whoever asked.
  if (!authReady()) redirect("/login?next=/dashboard");

  const requestHeaders = await headers();
  const user = await getSessionUser(requestHeaders);
  if (!user) redirect("/login?next=/dashboard");

  const organizations = await getUserOrganizations(user.id);
  const route = resolveOrganization(
    organizations,
    await getActiveOrganizationId(requestHeaders),
  );

  // Belonging to nothing is an account that has not finished onboarding: every
  // page below reads per-organization data, so there is nothing here for them
  // yet, and an empty dashboard reads as a broken one rather than as a step not
  // taken.
  if (route.kind === "create") redirect("/onboarding");
  // Belonging to something the session does not name is not onboarding - there
  // is nothing to create. The session needs writing, which a Server Component
  // may not do, so a route handler does it and the browser comes back here.
  if (route.kind === "activate") redirect("/api/organization/activate?next=/dashboard");

  // Fails soft, like every other read here: the pipeline being down should
  // render an offline page rather than a dashboard with no chrome on it.
  const projects = await fetchProjects(route.activeOrganizationId);

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    },
    organizations,
    activeOrganizationId: route.activeOrganizationId,
    projects: (projects?.projects ?? []).map((project) => ({
      id: project.id,
      label: projectTitle(project),
    })),
  };
}

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const identity = await currentIdentity();

  return (
    <div className="theme-dark h-screen flex overflow-hidden bg-background text-foreground">
      <Sidebar user={identity?.user ?? null} projects={identity?.projects} />

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between border-b border-rule px-5">
          <div className="flex min-w-0 items-center gap-3 text-sm">
            <span className="font-semibold tracking-tight">docxy</span>
            {identity && (
              <>
                <span aria-hidden className="text-muted">/</span>
                <OrganizationSwitcher
                  organizations={identity.organizations}
                  activeOrganizationId={identity.activeOrganizationId}
                />
              </>
            )}
            <Breadcrumb projects={identity?.projects ?? []} />
          </div>

          <HeaderActions />
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
