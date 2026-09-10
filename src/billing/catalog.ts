/**
 * The billing catalog: what may be sold, what it costs, and what it entitles.
 *
 * One file, no imports, no environment reads - because three separate things
 * have to agree about the same numbers and they do not run in the same process:
 * the marketing page prices the plans, checkout derives what to charge, and
 * admission decides whether another run is allowed. When those numbers live in
 * three places they drift, and the drift is somebody being charged for fifteen
 * runs and allowed three.
 *
 * Prices are integer minor units - cents. Never a float for money, for the same
 * reason `runs.cost_usd` is text: 19.00 does not exist in binary floating point
 * and a rounding error in a charge is not a rounding error, it is a refund.
 *
 * What is *not* here: provider product IDs. Those differ between test and live
 * mode and belong to deployment configuration, not to source - see
 * `web/src/lib/billing/config.ts`. This file says a Team subscription includes
 * five seats; it does not know what Dodo calls the thing that sells one.
 */

/** The catalog version stored on a subscription, so a later price change is legible. */
export const catalogVersion = '2026-09-10';

export const planKeys = ['free', 'pro', 'team'] as const;

export type PlanKey = (typeof planKeys)[number];

/** Which Dodo account a record belongs to. Chosen explicitly; never defaulted. */
export type BillingEnvironment = 'test_mode' | 'live_mode';

/**
 * What a plan allows, for one billing period.
 *
 * `runsPerMonth` is the whole allowance for the account, pooled across every
 * repository - a quiet project should not strand capacity a busy one needs.
 */
export interface Entitlements {
  /** People who may hold a seat in the workspace, the owner included. */
  seats: number;
  /** Repositories that may be connected at once. */
  repositories: number;
  /** Runs included in one period, pooled across repositories. */
  runsPerMonth: number;
  /**
   * Whether a push to a connected repository may start a run.
   *
   * False on Free, and not as a feature ladder: every push on every Free
   * account spends the acquisition budget, so Free runs start when somebody
   * asks for one. See guides/PRICING.md.
   */
  automaticRuns: boolean;
}

export interface Plan {
  key: PlanKey;
  name: string;
  /** One line, addressed to whoever is choosing. */
  description: string;
  /** USD cents per month, at the base package. */
  monthlyPriceMinor: number;
  /** What the base package includes before any seat expansion. */
  entitlements: Entitlements;
  /**
   * Whether buying this means a provider subscription.
   *
   * Free is false and must stay false: a zero-dollar subscription is a
   * subscription, with a lifecycle, webhooks and a way to fail, bought for an
   * entitlement this deployment can grant by writing a row.
   */
  purchasable: boolean;
  /** Highlighted on the pricing page as the default choice for one project. */
  featured: boolean;
}

/**
 * Team's per-seat expansion.
 *
 * A seat is one named person, and buying one also buys the capacity that person
 * arrives with: another repository and another share of the pool. The provider
 * side is a recurring add-on whose quantity is purchased seats *minus* the five
 * the base package already includes.
 */
export interface SeatAddOn {
  /** USD cents per month, per seat beyond the base package. */
  monthlyPriceMinor: number;
  repositoriesPerSeat: number;
  runsPerSeat: number;
  /** The base package's seats. Purchased capacity never falls below this. */
  minimumSeats: number;
  /** The pilot's ceiling - a bound on what checkout will accept, not a promise. */
  maximumSeats: number;
}

export const teamSeatAddOn: SeatAddOn = {
  monthlyPriceMinor: 2_500,
  repositoriesPerSeat: 1,
  runsPerSeat: 24,
  minimumSeats: 5,
  maximumSeats: 25,
};

/**
 * The plans, in the order they are shown.
 *
 * Prices and allowances come from guides/PRICING.md, which also records what
 * they cost to serve. Changing a number here without reading that file is how a
 * plan ends up sold below its own execution cost.
 */
export const plans = {
  free: {
    key: 'free',
    name: 'Free',
    description: 'See your first docs update on a real project.',
    monthlyPriceMinor: 0,
    entitlements: { seats: 1, repositories: 1, runsPerMonth: 3, automaticRuns: false },
    purchasable: false,
    featured: false,
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    description: 'Keep your main project’s docs up to date.',
    monthlyPriceMinor: 1_900,
    entitlements: { seats: 1, repositories: 1, runsPerMonth: 15, automaticRuns: true },
    purchasable: true,
    featured: true,
  },
  team: {
    key: 'team',
    name: 'Team',
    description: 'Keep docs in sync across your active projects.',
    monthlyPriceMinor: 12_900,
    entitlements: { seats: 5, repositories: 5, runsPerMonth: 120, automaticRuns: true },
    purchasable: true,
    featured: false,
  },
} satisfies Record<PlanKey, Plan>;

/** The plans in display order, for a pricing table that should not restate them. */
export const planList: readonly Plan[] = [plans.free, plans.pro, plans.team];

/**
 * A plan key, or null.
 *
 * Anything arriving from a browser goes through here. The server derives price,
 * product and quantity from the key; it never reads them from the request - a
 * plan name is the most a checkout request is trusted to carry.
 */
export function parsePlanKey(value: string | null | undefined): PlanKey | null {
  return planKeys.find((key) => key === value) ?? null;
}

export function isPaidPlan(key: PlanKey): boolean {
  return plans[key].purchasable;
}

/** Whether a plan sells seats beyond its base package. Only Team does. */
export function hasSeatExpansion(key: PlanKey): boolean {
  return key === 'team';
}

/**
 * Purchased seats, clamped to what this plan can actually sell.
 *
 * A desired capacity is a number typed into a browser, so it is bounded here
 * rather than trusted: below the base package it is the base package, above the
 * pilot ceiling it is the ceiling, and on a plan without seat expansion it is
 * whatever that plan includes.
 */
export function normalizeSeats(key: PlanKey, desired: number | undefined): number {
  const base = plans[key].entitlements.seats;
  if (!hasSeatExpansion(key)) return base;
  if (desired === undefined || !Number.isFinite(desired)) return base;
  const whole = Math.trunc(desired);
  return Math.min(Math.max(whole, teamSeatAddOn.minimumSeats), teamSeatAddOn.maximumSeats);
}

/** The recurring add-on quantity for a purchased capacity: seats beyond the base. */
export function seatAddOnQuantity(key: PlanKey, seats: number): number {
  if (!hasSeatExpansion(key)) return 0;
  return Math.max(0, normalizeSeats(key, seats) - plans[key].entitlements.seats);
}

/**
 * What an account on this plan, at this purchased capacity, may do.
 *
 * This is the allowance snapshot a usage period stores. It is written down when
 * the period opens rather than recomputed on each run: a price change should
 * apply at renewal, not halfway through a period somebody already paid for.
 */
export function entitlementsFor(key: PlanKey, seats?: number): Entitlements {
  const plan = plans[key];
  const extra = seatAddOnQuantity(key, seats ?? plan.entitlements.seats);
  if (extra === 0) return { ...plan.entitlements };
  return {
    seats: plan.entitlements.seats + extra,
    repositories: plan.entitlements.repositories + extra * teamSeatAddOn.repositoriesPerSeat,
    runsPerMonth: plan.entitlements.runsPerMonth + extra * teamSeatAddOn.runsPerSeat,
    automaticRuns: plan.entitlements.automaticRuns,
  };
}

/** The monthly charge in USD cents: base package plus any purchased seats. */
export function monthlyPriceMinor(key: PlanKey, seats?: number): number {
  const plan = plans[key];
  return (
    plan.monthlyPriceMinor +
    seatAddOnQuantity(key, seats ?? plan.entitlements.seats) * teamSeatAddOn.monthlyPriceMinor
  );
}

/** Cents to dollars, for display only. Arithmetic stays in minor units. */
export function formatUsd(minor: number): string {
  const dollars = minor / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
