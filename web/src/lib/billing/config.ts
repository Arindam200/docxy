/**
 * Billing configuration, readable without contacting Dodo.
 *
 * Follows `lib/env.ts`: no side effects, no throwing, no network. A deployment
 * that has not been given payment credentials should render a billing page that
 * says so, not a stack trace - and, more importantly, a build that has never
 * seen a Dodo key should still build.
 *
 * Two switches, not one. `DOCXY_BILLING_ENABLED` stops new purchases; event
 * processing keeps running regardless, because a subscription bought yesterday
 * still renews, cancels and refunds while purchases are paused.
 */

import type { BillingEnvironment, PlanKey } from "@billing";
import { isPaidPlan, planKeys } from "@billing";

function read(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

function flag(key: string, fallback: boolean): boolean {
  const value = read(key);
  if (value === undefined) return fallback;
  return value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Which Dodo account this deployment talks to.
 *
 * Explicit, and defaulting to test mode. The SDK's own default is `live_mode`,
 * which is the wrong way round for a mistake to fall: an unset variable should
 * fail to take real money, not succeed at it.
 */
export function billingEnvironment(): BillingEnvironment {
  return read("DODO_PAYMENTS_ENVIRONMENT") === "live_mode" ? "live_mode" : "test_mode";
}

/** The provider product ids, one per sellable plan, for the current environment. */
export interface ProductIds {
  pro: string | undefined;
  team: string | undefined;
  /** The recurring add-on billed per Team seat beyond the base package. */
  teamSeat: string | undefined;
}

function productIds(): ProductIds {
  return {
    pro: read("DODO_PRODUCT_PRO_MONTHLY"),
    team: read("DODO_PRODUCT_TEAM_MONTHLY"),
    teamSeat: read("DODO_PRODUCT_TEAM_SEAT"),
  };
}

export interface BillingConfig {
  apiKey: string;
  webhookKey: string;
  environment: BillingEnvironment;
  products: ProductIds;
}

/**
 * The complete configuration, or null when this deployment has none.
 *
 * Null is an ordinary answer, not a failure: self-hosted installs and local
 * development run without payments, and everything that reads this treats null
 * as "purchases are unavailable here".
 */
export function billingConfig(): BillingConfig | null {
  const apiKey = read("DODO_PAYMENTS_API_KEY");
  const webhookKey = read("DODO_PAYMENTS_WEBHOOK_KEY");
  if (!apiKey || !webhookKey) return null;
  return { apiKey, webhookKey, environment: billingEnvironment(), products: productIds() };
}

/**
 * The product id to sell a plan with, or undefined if this deployment cannot.
 *
 * Free never has one and never should: a zero-dollar subscription is a
 * lifecycle bought for an entitlement a database row already grants.
 */
export function productIdFor(key: PlanKey): string | undefined {
  if (!isPaidPlan(key)) return undefined;
  const products = productIds();
  return key === "pro" ? products.pro : products.team;
}

export function seatProductId(): string | undefined {
  return productIds().teamSeat;
}

/**
 * Whether this deployment may sell a given plan right now.
 *
 * Every condition has to hold: credentials, the purchase switch, and a product
 * id for that specific plan. A deployment with Pro configured and Team not can
 * sell Pro; it must not offer Team a checkout that fails at the provider.
 */
export function canSell(key: PlanKey): boolean {
  if (!isPaidPlan(key)) return false;
  if (!billingConfig()) return false;
  if (!flag("DOCXY_BILLING_ENABLED", false)) return false;
  return Boolean(productIdFor(key)) && (key !== "team" || Boolean(seatProductId()));
}

/** The plans this deployment can actually take money for, in display order. */
export function sellablePlans(): PlanKey[] {
  return planKeys.filter(canSell);
}

/**
 * Whether new Free workspaces may be granted an allowance.
 *
 * Separate from paid purchases because it is a different budget: Free execution
 * is an acquisition expense with a monthly ceiling (guides/PRICING.md), and
 * exhausting it should pause new grants while existing ones keep working.
 */
export function freeEnrollmentOpen(): boolean {
  return flag("DOCXY_FREE_ENROLLMENT_ENABLED", true);
}

/** The monthly ceiling on Free execution, in USD cents. Zero means unbudgeted. */
export function freeAcquisitionBudgetMinor(): number {
  const value = Number(read("DOCXY_FREE_BUDGET_USD") ?? "");
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

export interface BillingRequirement {
  key: string;
  present: boolean;
  hint: string;
}

/**
 * What is missing, for an operator reading a configuration page.
 *
 * Names variables rather than judging them: this is the list a deployment works
 * through, and it should say what each one is for.
 */
export function billingRequirements(): BillingRequirement[] {
  const products = productIds();
  return [
    {
      key: "DODO_PAYMENTS_API_KEY",
      present: Boolean(read("DODO_PAYMENTS_API_KEY")),
      hint: "Server-side API key from the Dodo dashboard, for this environment.",
    },
    {
      key: "DODO_PAYMENTS_WEBHOOK_KEY",
      present: Boolean(read("DODO_PAYMENTS_WEBHOOK_KEY")),
      hint: "Signing secret for the webhook endpoint. Deliveries are refused without it.",
    },
    {
      key: "DODO_PAYMENTS_ENVIRONMENT",
      present: Boolean(read("DODO_PAYMENTS_ENVIRONMENT")),
      hint: "test_mode or live_mode. Defaults to test_mode when unset.",
    },
    {
      key: "DODO_PRODUCT_PRO_MONTHLY",
      present: Boolean(products.pro),
      hint: "Recurring product id for Pro, in this environment.",
    },
    {
      key: "DODO_PRODUCT_TEAM_MONTHLY",
      present: Boolean(products.team),
      hint: "Recurring product id for the Team base package, in this environment.",
    },
    {
      key: "DODO_PRODUCT_TEAM_SEAT",
      present: Boolean(products.teamSeat),
      hint: "Recurring add-on id billed per Team seat beyond the five included.",
    },
  ];
}

export function missingBillingConfig(): BillingRequirement[] {
  return billingRequirements().filter((item) => !item.present);
}
