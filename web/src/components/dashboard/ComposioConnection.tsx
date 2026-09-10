"use client";

import { useEffect, useState } from "react";
import { InfoTip } from "./InfoTip";
import { useToast } from "./Toast";
import { useRouter } from "next/navigation";
import type { ComposioToolkit, IntegrationAccount } from "@/lib/composio-contract";

function rememberConnection(key: string) {
  try { sessionStorage.setItem(key, String(Date.now())); } catch { /* Storage is optional. */ }
}

export function ComposioConnection({ toolkit, organizationId, accounts, canManage, configured, unavailable }: {
  toolkit: ComposioToolkit;
  organizationId: string;
  accounts: IntegrationAccount[];
  canManage: boolean;
  configured: boolean;
  unavailable: boolean;
}) {
  const router = useRouter();
  const notify = useToast();
  const name = { slack: "Slack", notion: "Notion", linear: "Linear", jira: "Jira" }[toolkit];
  const attemptKey = `docxy-connect:${organizationId}:${toolkit}`;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connected = accounts.some((account) => account.active);
  const disabled = !configured || !canManage || unavailable || pending;

  useEffect(() => {
    // Provider redirects reload the document. Confirm the outcome from fresh
    // server account data, never from the provider's query-string status.
    try {
      const started = sessionStorage.getItem(attemptKey);
      if (!started) return;
      sessionStorage.removeItem(attemptKey);
      if (Date.now() - Number(started) > 30 * 60 * 1000) return;
      if (unavailable) notify(`Could not verify the ${name} connection. Refresh to check its status.`, "error");
      else if (connected) notify(`${name} account connected.`);
      else notify(`${name} connection is not complete. Try connecting again.`, "info");
    } catch {
      // Browser storage may be disabled; the card still shows server status.
    }
  }, [attemptKey, connected, name, notify, unavailable]);

  async function update(action: "connect" | "disconnect", accountId?: string) {
    if (disabled) return;
    setPending(true);
    setError("");
    try {
      const form = new FormData();
      form.set("toolkit", toolkit);
      form.set("organizationId", organizationId);
      form.set("action", action);
      if (accountId) form.set("accountId", accountId);
      const response = await fetch("/api/integrations/composio", { method: "POST", body: form });
      // SAFETY: this app's endpoint returns only these fields; errors are rendered as text.
      const result = await response.json() as { error?: string; redirectUrl?: string };
      if (!response.ok) throw new Error(result.error || "Could not update the connection.");
      if (result.redirectUrl) {
        rememberConnection(attemptKey);
        notify(`Opening ${name} authorization…`, "info");
        window.location.assign(result.redirectUrl);
      } else {
        notify(`${name} account disconnected.`);
        router.refresh();
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not update the connection.";
      setError(message);
      notify(message, "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      {accounts.map((account, index) => (
        <div key={account.id} className="flex items-center justify-between gap-2 text-xs text-muted">
          <span>Account {index + 1} · {account.active ? "Connected" : account.status.toLowerCase()}</span>
          {canManage && (
            <button type="button" disabled={disabled} onClick={() => update("disconnect", account.id)}
              className="focus-ring border border-rule px-2 py-1 hover:text-foreground disabled:opacity-50">
              Disconnect
            </button>
          )}
        </div>
      ))}
      {!connected && (
        <button type="button" disabled={disabled} onClick={() => update("connect")}
          className="focus-ring w-full border border-transparent bg-accent-deep px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-deep/85 disabled:cursor-not-allowed disabled:opacity-50">
          {pending ? "Updating…" : "Connect account"}
        </button>
      )}
      {(!configured || unavailable || !canManage) && (
        <div className="flex items-center gap-1 text-xs text-muted">
          <span>{!configured ? "Setup required" : unavailable ? "Status unavailable" : "Admin access required"}</span>
          <InfoTip label={`About ${name} connection access`}>
            {!configured ? "Connection setup is not enabled yet."
              : unavailable ? "Connection status is unavailable. Refresh to try again."
                : "An organization owner or admin can manage this connection."}
          </InfoTip>
        </div>
      )}
      {pending && connected && <p role="status" className="text-xs text-muted">Updating connection…</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
