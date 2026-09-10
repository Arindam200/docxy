"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LuBuilding2, LuCheck, LuChevronDown, LuPlus } from "react-icons/lu";

import { CreateOrganizationDialog } from "./CreateOrganizationDialog";

import { organization } from "@/lib/auth-client";
import type { DashboardOrganization } from "@/lib/dashboard-organization";

function OrganizationMark({ value }: { value: DashboardOrganization }) {
  if (value.logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={value.logo}
        alt=""
        referrerPolicy="no-referrer"
        className="h-5 w-5 shrink-0 rounded border border-rule object-cover"
      />
    );
  }

  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-rule bg-surface-2 text-muted">
      <LuBuilding2 className="h-3 w-3" aria-hidden />
    </span>
  );
}

/**
 * Names the organization whose data is on screen and changes the session's
 * active organization. Refreshing after Better Auth updates the session is
 * load-bearing: every dashboard page is a Server Component scoped from that
 * session value, so all of them need a fresh server render together.
 */
export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
}: {
  organizations: DashboardOrganization[];
  activeOrganizationId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = organizations.find((value) => value.id === activeOrganizationId);

  useEffect(() => {
    if (!open) return;

    // Narrowed rather than asserted. `EventTarget` is not a `Node` - a click can
    // originate somewhere `contains` cannot answer for - and the assertion said
    // otherwise without checking. Matches how `Select` dismisses itself.
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function switchTo(next: DashboardOrganization) {
    if (next.id === activeOrganizationId) {
      setOpen(false);
      return;
    }

    setPendingId(next.id);
    setError(null);

    try {
      const result = await organization.setActive({ organizationId: next.id });
      if (result.error) {
        setError(result.error.message ?? "Could not switch organizations.");
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not switch organizations. Please try again.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          setError(null);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? `Organization: ${active.name}` : "Select organization"}
        className="focus-ring flex h-8 max-w-64 items-center gap-2 rounded-md border border-rule bg-surface px-2.5 text-xs font-medium transition-colors hover:bg-surface-2"
      >
        {active ? (
          <OrganizationMark value={active} />
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-rule bg-surface-2 text-muted">
            <LuBuilding2 className="h-3 w-3" aria-hidden />
          </span>
        )}
        <span className="truncate">{active?.name ?? "Select organization"}</span>
        <LuChevronDown className="h-3 w-3 shrink-0 text-muted" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Switch organization"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-72 rounded-md border border-rule bg-surface py-1 shadow-xl shadow-black/40"
        >
          <p className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Organizations
          </p>
          {organizations.map((value) => {
            const selected = value.id === activeOrganizationId;
            const pending = value.id === pendingId;

            return (
              <button
                key={value.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={pendingId !== null}
                onClick={() => switchTo(value)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
              >
                <OrganizationMark value={value} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {pending ? "Switching…" : value.name}
                  </span>
                  <span className="block truncate text-[10px] text-muted">{value.slug}</span>
                </span>
                {selected && <LuCheck className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
              </button>
            );
          })}

          <div className="mt-1 border-t border-rule px-2 py-2">
            <button
              type="button"
              role="menuitem"
              disabled={pendingId !== null}
              onClick={() => { setOpen(false); setCreating(true); }}
              className="focus-ring flex w-full items-center gap-2 rounded px-2 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-60"
            >
              <LuPlus className="h-4 w-4" aria-hidden />
              Create organization
            </button>
          </div>

          {error && (
            <p role="alert" className="mx-3 my-2 border-t border-rule pt-2 text-[11px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      {creating && (
        <CreateOrganizationDialog
          onDismiss={() => { setCreating(false); trigger.current?.focus(); }}
          onCreated={() => {
            setCreating(false);
            trigger.current?.focus();
            // Detail pages in the previous organization do not belong to the
            // new one. Open its overview and refresh the shared switcher.
            router.replace("/dashboard");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
