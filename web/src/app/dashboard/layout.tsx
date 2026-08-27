import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { getSessionUser } from "@/lib/auth";
import { authReady } from "@/lib/env";
import type { DashboardUser } from "@/lib/user";

export const metadata: Metadata = {
  title: "Dashboard · Docxy",
};

/** The proxy's cookie check is optimistic; this is the check that decides. */
async function currentUser(): Promise<DashboardUser | null> {
  if (process.env.DOCXY_REQUIRE_AUTH === "0" || !authReady()) return null;

  const user = await getSessionUser(await headers());
  if (!user) redirect("/login?next=/dashboard");

  return { id: user.id, name: user.name, email: user.email, image: user.image };
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

          {user && (
            <div className="hidden sm:flex items-center gap-2.5">
              {user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.image}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-6 w-6 rounded-full border border-rule"
                />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-deep text-[10px] font-semibold">
                  {(user.name[0] ?? "?").toUpperCase()}
                </span>
              )}
              <span className="text-xs text-muted">{user.email}</span>
            </div>
          )}
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
