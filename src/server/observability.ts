import type { RoleName } from '../config.js';
import type { RoleFailure, RunRecord, RunStatus } from '../types.js';
import { round } from '../trueforge/pricing.js';

/**
 * Cross-run aggregates — the view a single run cannot give you.
 *
 * `guides/OBSERVABILITY.md` §7 calls this "the report that makes the tool feel
 * like infrastructure rather than a script": which role fails most, which docs
 * go stale most often, whether classification confidence is drifting, and what
 * the skill packs actually cost. Everything here is derived from run records
 * already on disk, so it adds no capture and no new storage.
 */

/** Pipeline order, which is the order every view reads in. */
const ROLE_ORDER: RoleName[] = [
  'change-analyst',
  'impact-mapper',
  'docs-updater',
  'changelog-author',
  'coordinator',
];

export interface RoleStats {
  role: RoleName;
  runs: number;
  failed: number;
  /** Counts per failure kind, so a flaky harness reads differently from bad JSON. */
  failures: Partial<Record<RoleFailure, number>>;
  /** Share of this role's turns that reused an existing session, 0..1. */
  reuseRate?: number;
  medianMs?: number;
  p95Ms?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface RunPoint {
  id: string;
  startedAt: string;
  status: RunStatus;
  shortSha: string;
  subject: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** The Change Analyst's own confidence, 0..1. */
  confidence?: number;
}

export interface ObservabilityReport {
  window: { runs: number; from?: string; to?: string };
  outcomes: Partial<Record<RunStatus, number>>;
  /** Runs that finished with a proposal, over runs that finished at all, 0..1. */
  successRate?: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd?: number;
    costPerRunUsd?: number;
    medianRunMs?: number;
  };
  /** The input side split by what asked for it, summed across every role. */
  inputBreakdown: Record<string, number>;
  roles: RoleStats[];
  /** Docs the pipeline proposes edits to most often. */
  staleDocs: Array<{ path: string; edits: number; runs: number }>;
  series: RunPoint[];
}

function percentile(sorted: number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[index];
}

/** A run reached a proposal a human could act on. */
function succeeded(status: RunStatus): boolean {
  return status === 'done' || status === 'approved' || status === 'awaiting-approval';
}

/** A run is over, one way or the other. */
function settled(status: RunStatus): boolean {
  return status !== 'running';
}

export function buildReport(runs: RunRecord[]): ObservabilityReport {
  const ordered = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const outcomes: Partial<Record<RunStatus, number>> = {};
  const inputBreakdown: Record<string, number> = {};
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const runDurations: number[] = [];
  const docEdits = new Map<string, { edits: number; runs: number }>();
  const series: RunPoint[] = [];

  let costUsd = 0;
  let priced = false;

  const byRole = new Map<
    RoleName,
    { durations: number[]; reused: number; stats: RoleStats; priced: boolean; cost: number }
  >();
  const roleBucket = (role: RoleName) => {
    let bucket = byRole.get(role);
    if (!bucket) {
      bucket = {
        durations: [],
        reused: 0,
        priced: false,
        cost: 0,
        stats: {
          role,
          runs: 0,
          failed: 0,
          failures: {},
          inputTokens: 0,
          outputTokens: 0,
        },
      };
      byRole.set(role, bucket);
    }
    return bucket;
  };

  for (const run of ordered) {
    outcomes[run.status] = (outcomes[run.status] ?? 0) + 1;

    totals.inputTokens += run.totals?.inputTokens ?? 0;
    totals.outputTokens += run.totals?.outputTokens ?? 0;
    totals.cacheReadTokens += run.totals?.cacheReadTokens ?? 0;
    if (run.totals?.costUsd !== undefined) {
      costUsd += run.totals.costUsd;
      priced = true;
    }
    if (run.durationMs !== undefined && settled(run.status)) runDurations.push(run.durationMs);

    // One count per doc per run, so a run proposing four edits to one page does
    // not make that page look like it goes stale four times as often.
    const touched = new Set<string>();
    for (const edit of run.docs?.edits ?? []) {
      const entry = docEdits.get(edit.path) ?? { edits: 0, runs: 0 };
      entry.edits += 1;
      if (!touched.has(edit.path)) {
        entry.runs += 1;
        touched.add(edit.path);
      }
      docEdits.set(edit.path, entry);
    }

    for (const trace of run.traces) {
      const bucket = roleBucket(trace.role);
      bucket.stats.runs += 1;
      if (trace.status === 'failed') {
        bucket.stats.failed += 1;
        const kind = trace.failure ?? 'harness-error';
        bucket.stats.failures[kind] = (bucket.stats.failures[kind] ?? 0) + 1;
      }
      if (trace.reusedSession) bucket.reused += 1;
      if (trace.durationMs !== undefined) bucket.durations.push(trace.durationMs);

      bucket.stats.inputTokens += trace.usage?.inputTokens ?? 0;
      bucket.stats.outputTokens += trace.usage?.outputTokens ?? 0;
      if (trace.usage?.costUsd !== undefined) {
        bucket.cost += trace.usage.costUsd;
        bucket.priced = true;
      }

      for (const [key, value] of Object.entries(trace.usage?.inputBreakdown ?? {})) {
        inputBreakdown[key] = (inputBreakdown[key] ?? 0) + value;
      }
    }

    series.push({
      id: run.id,
      startedAt: run.startedAt,
      status: run.status,
      shortSha: run.commit.shortSha,
      subject: run.commit.subject,
      durationMs: run.durationMs,
      inputTokens: run.totals?.inputTokens ?? 0,
      outputTokens: run.totals?.outputTokens ?? 0,
      costUsd: run.totals?.costUsd,
      confidence: run.classification?.confidence,
    });
  }

  const roles: RoleStats[] = [...byRole.values()]
    .map((bucket) => {
      const sorted = [...bucket.durations].sort((a, b) => a - b);
      return {
        ...bucket.stats,
        reuseRate: bucket.stats.runs > 0 ? bucket.reused / bucket.stats.runs : undefined,
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        costUsd: bucket.priced ? round(bucket.cost) : undefined,
      };
    })
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  const finished = ordered.filter((run) => settled(run.status));
  const sortedRunDurations = [...runDurations].sort((a, b) => a - b);

  return {
    window: {
      runs: ordered.length,
      from: ordered[0]?.startedAt,
      to: ordered[ordered.length - 1]?.startedAt,
    },
    outcomes,
    successRate:
      finished.length > 0
        ? finished.filter((run) => succeeded(run.status)).length / finished.length
        : undefined,
    totals: {
      ...totals,
      costUsd: priced ? round(costUsd) : undefined,
      costPerRunUsd: priced && ordered.length > 0 ? round(costUsd / ordered.length) : undefined,
      medianRunMs: percentile(sortedRunDurations, 0.5),
    },
    inputBreakdown,
    roles,
    staleDocs: [...docEdits.entries()]
      .map(([path, entry]) => ({ path, ...entry }))
      .sort((a, b) => b.runs - a.runs || b.edits - a.edits)
      .slice(0, 10),
    series,
  };
}
