import type { RunRecord } from '../types.js';
import { SCORERS } from './scorers.js';

export { SCORERS } from './scorers.js';

/** One scorer's verdict on one run. */
export interface Score {
  scorer: string;
  score: number;
}

export interface ScoredRun {
  runId: string;
  commit: string;
  subject: string;
  startedAt: string;
  scores: Score[];
}

/** A scorer's average across the runs scored, and how many it applied to. */
export interface ScoreSummary {
  scorer: string;
  description: string;
  mean: number;
  /** Runs scoring below 1, which is where the interesting ones are. */
  imperfect: number;
  runs: number;
}

/** One scorer, before and after some point in time. */
export interface Trend {
  scorer: string;
  /** Mean over the newer half of the runs scored. */
  recent: number;
  /** Mean over the older half. */
  earlier: number;
}

export interface Scorecard {
  runs: ScoredRun[];
  summary: ScoreSummary[];
  /**
   * Newer runs against older ones.
   *
   * The question this tool exists to answer is "did that change make it worse",
   * and an average over everything cannot answer it - a fix that works is
   * invisible next to the failures it replaced. Absent when there are too few
   * runs to say anything, because a trend drawn through four points is a
   * decoration.
   */
  trend?: Trend[];
  /**
   * The runs worth opening, worst first.
   *
   * A scorecard whose only output is an average tells you something changed and
   * not where, so the run ids come with it.
   */
  worst: ScoredRun[];
}

/**
 * Score the runs that already happened.
 *
 * Nothing here calls a model, so this is free and repeatable: the same runs
 * score the same way every time, which is what makes a comparison across a
 * prompt change mean anything. Runs that failed before producing an output are
 * skipped rather than scored zero - a harness that fell over is not the
 * documentation being wrong, and averaging the two together hides both.
 *
 * The records must be **fully hydrated**, as `RunStorage.load` returns them.
 * `list` omits `proposedFiles` for speed, and scoring those instead reported
 * that not one run in fifteen had ever proposed anything - a confident, precise
 * and completely wrong number, which is the worst thing a metric can be.
 */
export async function scoreRuns(records: RunRecord[]): Promise<Scorecard> {
  const scorable = records.filter((run) => run.classification !== undefined);

  const runs: ScoredRun[] = [];
  for (const run of scorable) {
    const scores: Score[] = [];
    for (const scorer of SCORERS) {
      const result = await scorer.run({ input: run, output: run });
      scores.push({ scorer: scorer.id, score: result.score });
    }
    runs.push({
      runId: run.id,
      commit: run.commit.shortSha,
      subject: run.commit.subject,
      startedAt: run.startedAt,
      scores,
    });
  }

  const summary: ScoreSummary[] = SCORERS.map((scorer) => {
    const values = runs
      .map((r) => r.scores.find((s) => s.scorer === scorer.id)?.score)
      .filter((v): v is number => v !== undefined);
    const mean = values.length === 0 ? 1 : values.reduce((a, b) => a + b, 0) / values.length;
    return {
      scorer: scorer.id,
      description: scorer.description,
      mean,
      imperfect: values.filter((v) => v < 1).length,
      runs: values.length,
    };
  });

  /** A run's weakest score, since one broken thing is what makes it worth reading. */
  const weakest = (run: ScoredRun): number => Math.min(...run.scores.map((s) => s.score));
  const worst = [...runs].filter((r) => weakest(r) < 1).sort((a, b) => weakest(a) - weakest(b));

  const card: Scorecard = { runs, summary, worst };

  // Newest first, so the first half is the recent one.
  const MIN_FOR_A_TREND = 6;
  if (runs.length >= MIN_FOR_A_TREND) {
    const half = Math.floor(runs.length / 2);
    const meanOf = (rows: ScoredRun[], id: string): number => {
      const values = rows
        .map((r) => r.scores.find((s) => s.scorer === id)?.score)
        .filter((v): v is number => v !== undefined);
      return values.length === 0 ? 1 : values.reduce((a, b) => a + b, 0) / values.length;
    };
    card.trend = SCORERS.map((scorer) => ({
      scorer: scorer.id,
      recent: meanOf(runs.slice(0, half), scorer.id),
      earlier: meanOf(runs.slice(half), scorer.id),
    }));
  }

  return card;
}
