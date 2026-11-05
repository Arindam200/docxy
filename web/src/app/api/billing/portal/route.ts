/**
 * A link into Dodo's customer portal, for the billing owner.
 *
 * Cards, invoices and cancellation live there rather than here. Rebuilding them
 * would mean holding payment details this deployment has no reason to see.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getMemberOrganizationId, getSessionUser } from "@/lib/auth";
import { findBillingAccount, isBillingOwner } from "@/lib/billing/accounts";
import { getDodo } from "@/lib/billing/client";
import { billingConfig, billingOrigin } from "@/lib/billing/config";

export async function POST(request: NextRequest): Promise<Response> {
  if (!billingConfig()) {
    return NextResponse.json({ error: "billing is not configured here" }, { status: 503 });
  }

  const user = await getSessionUser(request.headers).catch(() => null);
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const organizationId = await getMemberOrganizationId(request.headers);
  if (!organizationId) {
    return NextResponse.json({ error: "this account has no organization yet" }, { status: 409 });
  }

  const account = await findBillingAccount(organizationId);
  if (!account || !isBillingOwner(account, user.id)) {
    return NextResponse.json({ error: "only the billing owner can open the portal" }, { status: 403 });
  }

  // No provider customer means nothing has ever been bought, so there is no
  // portal to open. Said plainly rather than as a provider error.
  if (!account.dodoCustomerId) {
    return NextResponse.json({ error: "this organization has no billing history yet" }, { status: 409 });
  }

  try {
    const session = await getDodo().customers.customerPortal.create(account.dodoCustomerId, {
      // The portal's "back to Docxy" button lands where they came from.
      return_url: `${billingOrigin()}/dashboard/billing`,
    });
    return NextResponse.json({ url: session.link });
  } catch {
    return NextResponse.json({ error: "Dodo could not open the portal just now" }, { status: 502 });
  }
}
