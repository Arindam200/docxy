import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type {
  ApprovalRequest,
  ApprovalScope,
  Classification,
  ChangelogProposal,
  RunRecord,
} from '../types.js';

/**
 * How much scrutiny a change was judged to need.
 *
 * The gate that held proposals for that many human sign-offs is gone; this
 * survives it because the judgement is still worth recording and still worth
 * putting in the pull request body. A reviewer opening a docs change is served
 * by knowing the pipeline thought it touched public API.
 *
 * The Coordinator also proposes a scope. We take the stricter of the two: a
 * model is allowed to escalate, never to relax.
 */
/** What scope a change needs, and the sentence explaining why it needs it. */
export interface ScopeDecision {
  scope: ApprovalScope;
  rationale: string;
}

/** How long a request has been waiting, and whether that is now too long. */
export interface Staleness {
  stale: boolean;
  waitingMinutes: number;
}

export function decideScope(
  classification: Classification,
  changelog: ChangelogProposal | undefined,
  coordinatorScope: ApprovalScope | undefined,
): ScopeDecision {
  const reasons: string[] = [];

  if (classification.kind === 'breaking') reasons.push('the change is classified breaking');
  if (classification.surface === 'public-api') reasons.push('it touches documented public API');
  if (changelog?.semverBump === 'major') reasons.push('it proposes a major version bump');
  if (coordinatorScope === 'elevated') reasons.push('the Coordinator asked for a second look');

  if (reasons.length > 0) {
    return {
      scope: 'elevated',
      rationale: `Elevated because ${reasons.join(', and ')}. Two sign-offs required.`,
    };
  }
  return {
    scope: 'routine',
    rationale:
      `Routine: a ${classification.kind} on ${classification.surface} surface, ` +
      `proposing a ${changelog?.semverBump ?? 'no'} bump. One sign-off required.`,
  };
}

/**
 * Satisfy a request without a human, for the default unattended mode.
 *
 * The gate is not bypassed - it is filled in, with `by` naming the pipeline
 * rather than a person, so a run that landed automatically is distinguishable
 * from one somebody actually read. The review still happens: it happens on the
 * pull request, which is the artifact this whole pipeline exists to produce.
 */
export function autoApprove(request: ApprovalRequest, by = 'docxy (unattended)'): void {
  request.signoffs = [{ by, at: new Date().toISOString() }];
  request.status = 'approved';
}

/**
 * The approval request for a run, created or refreshed.
 *
 * `existing` is passed when a run is resumed and already has one. A run holds
 * at most one approval - the database says so with a unique index on `run_id` -
 * so minting a second id for the same run is not a new request, it is a
 * constraint violation that silently loses the whole save. Its id is therefore
 * kept, and so are any sign-offs already given: someone who approved a run
 * before it was interrupted has not withdrawn that.
 *
 * Everything else is refreshed, because the verdict it describes was produced
 * again and may differ.
 */
export function createApprovalRequest(
  runId: string,
  scope: ApprovalScope,
  scopeRationale: string,
  summary: string,
  existing?: ApprovalRequest,
): ApprovalRequest {
  const required = scope === 'elevated' ? 2 : 1;
  const signoffs = existing?.signoffs ?? [];
  return {
    id: existing?.id ?? randomUUID(),
    runId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    scope,
    scopeRationale,
    requiredSignoffs: required,
    signoffs,
    // A run that was already denied stays denied; otherwise the count decides,
    // so a sign-off given before the interruption is not silently discarded.
    status: existing?.status === 'denied'
      ? 'denied'
      : signoffs.length >= required
        ? 'approved'
        : 'pending',
    summary,
  };
}

/**
 * There is no auto-approve and no auto-discard. A request that nobody answers
 * stays pending and is reported stale - visibly waiting, never silently
 * resolved in either direction.
 */
export function staleness(
  request: ApprovalRequest,
  config: Config,
): Staleness {
  const waitingMinutes = Math.floor(
    (Date.now() - new Date(request.createdAt).getTime()) / 60_000,
  );
  return {
    stale: request.status === 'pending' && waitingMinutes >= config.approval.staleAfterMinutes,
    waitingMinutes,
  };
}

export function describeGate(run: RunRecord, config: Config): string {
  const request = run.approval;
  if (!request) return 'no approval request on this run';
  const { stale, waitingMinutes } = staleness(request, config);
  const progress = `${request.signoffs.length}/${request.requiredSignoffs} sign-off(s)`;
  const staleNote = stale ? ` - STALE, waiting ${waitingMinutes} min, still pending` : '';
  return `${request.scope} scope, ${progress}, status ${request.status}${staleNote}`;
}
