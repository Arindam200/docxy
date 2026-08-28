import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { HeaderActions } from "@/components/dashboard/HeaderActions";
import { authRequired, getSessionUser, operatorVerdict } from "@/lib/auth";
import { authReady } from "@/lib/env";
import type { DashboardUser } from "@/lib/user";

export const metadata: Metadata = {
  title: "Dashboard · Docxy",
};

/**
 * The proxy's cookie check is optimistic; this is the check that decides.
 *
 * It also decides for every page below it. These are server components that
 * read the pipeline API directly through `lib/docxy`, carrying the shared
 * credential — they never pass through the /api/docxy proxy, so the proxy's
 * operator check does not cover them. Enforcing only there would leave runs,
 * logs, prompts, raw model output and standing instructions readable by any
 * account that could sign in.
 */
async function currentUser(): Promise<DashboardUser | null> {
  if (!authRequired()) return null;

  // Required but impossible: missing DATABASE_URL or BETTER_AUTH_SECRET. The
  // login page is where that gets explained; silently rendering the dashboard
  // would be showing the data to whoever asked.
  if (!authReady()) redirect("/login?next=/dashboard");

  const user = await getSessionUser(await headers());
  const verdict = operatorVerdict(user);
  if (verdict === "unauthenticated") redirect("/login?next=/dashboard");
  if (verdict === "not-configured") redirect("/login?error=no_operators");
  if (verdict === "not-an-operator") redirect("/login?error=not_an_operator");

  // SAFETY: any verdict other than "unauthenticated" was reached with a user.
  const operator = user as NonNullable<typeof user>;
  return {
    id: operator.id,
    name: operator.name,
    email: operator.email,
    image: operator.image,
  };
}

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await currentUser();

  return (
    <div className="theme-dark h-screen flex overflow-hidden bg-background text-foreground">
      <Sidebar user={user} />

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between border-b border-rule px-5">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold tracking-tight">docxy</span>
            <span aria-hidden className="text-muted">/</span>
            <span className="text-muted">Dashboard</span>
          </div>

          <HeaderActions />
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
