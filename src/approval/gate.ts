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
 * Graduated scope. A docs-only fix needs one sign-off; anything touching
 * documented public API or proposing a major bump needs two.
 *
 * The Coordinator also proposes a scope. We take the stricter of the two: a
 * model is allowed to escalate, never to relax.
 */
export function decideScope(
  classification: Classification,
  changelog: ChangelogProposal | undefined,
  coordinatorScope: ApprovalScope | undefined,
): { scope: ApprovalScope; rationale: string } {
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
 * The gate is not bypassed — it is filled in, with `by` naming the pipeline
 * rather than a person, so a run that landed automatically is distinguishable
 * from one somebody actually read. The review still happens: it happens on the
 * pull request, which is the artifact this whole pipeline exists to produce.
 */
export function autoApprove(request: ApprovalRequest, by = 'docxy (unattended)'): void {
  request.signoffs = [{ by, at: new Date().toISOString() }];
  request.status = 'approved';
}

export function createApprovalRequest(
  runId: string,
  scope: ApprovalScope,
  scopeRationale: string,
  summary: string,
): ApprovalRequest {
  return {
    id: randomUUID(),
    runId,
    createdAt: new Date().toISOString(),
    scope,
    scopeRationale,
    requiredSignoffs: scope === 'elevated' ? 2 : 1,
    signoffs: [],
    status: 'pending',
    summary,
  };
}

export class ApprovalError extends Error {}

/**
 * Record one sign-off. Returns whether the request is now fully approved.
 *
 * A single reviewer cannot satisfy an elevated request twice — that would make
 * the second sign-off decorative.
 */
export function signOff(request: ApprovalRequest, by: string): { approved: boolean } {
  if (request.status === 'denied') throw new ApprovalError('This request was already denied.');
  if (request.status === 'approved') return { approved: true };
  if (request.signoffs.some((s) => s.by === by)) {
    throw new ApprovalError(
      `${by} has already signed off. An elevated request needs a second, different reviewer.`,
    );
  }

  request.signoffs.push({ by, at: new Date().toISOString() });
  if (request.signoffs.length >= request.requiredSignoffs) {
    request.status = 'approved';
    return { approved: true };
  }
  return { approved: false };
}

export function deny(request: ApprovalRequest, by: string, reason: string): void {
  if (request.status === 'approved') {
    throw new ApprovalError('This request was already approved.');
  }
  request.status = 'denied';
  request.deniedReason = `${reason} (denied by ${by})`;
}

/**
 * There is no auto-approve and no auto-discard. A request that nobody answers
 * stays pending and is reported stale — visibly waiting, never silently
 * resolved in either direction.
 */
export function staleness(
  request: ApprovalRequest,
  config: Config,
): { stale: boolean; waitingMinutes: number } {
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
  const staleNote = stale ? ` — STALE, waiting ${waitingMinutes} min, still pending` : '';
  return `${request.scope} scope, ${progress}, status ${request.status}${staleNote}`;
}
