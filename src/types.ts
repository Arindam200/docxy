import type { RoleName } from './config.js';

export type ChangeKind = 'breaking' | 'feature' | 'fix' | 'chore';
export type ChangeSurface = 'public-api' | 'internal' | 'config' | 'test-only' | 'docs-only';

/** A single file's worth of diff, already trimmed for the model. */
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}

export interface CommitDiff {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/** Change Analyst output. */
export interface Classification {
  kind: ChangeKind;
  surface: ChangeSurface;
  /** Plain-language summary of what changed and why, for downstream roles. */
  summary: string;
  /** Symbols (functions, types, endpoints, flags) whose public shape moved. */
  changedSymbols: string[];
  /** Why this is or is not breaking, in the repo's own terms. */
  breakingRationale: string;
  confidence: number;
}

export interface ImpactedDoc {
  path: string;
  /** Heading or anchor within the doc that the change touches. */
  section: string;
  reason: string;
  confidence: number;
}

export interface ImpactedCode {
  path: string;
  reason: string;
}

/** Impact Mapper output. */
export interface ImpactMap {
  docs: ImpactedDoc[];
  code: ImpactedCode[];
  /** Symbol -> doc sections, merged into the running knowledge map. */
  symbolIndex: Record<string, string[]>;
  notes: string;
}

/** One concrete edit the Docs Updater proposes. */
export interface DocEdit {
  path: string;
  section: string;
  /** Exact text to find. Empty when `mode` is 'append'. */
  find: string;
  /** Replacement (or appended) text. */
  replace: string;
  mode: 'replace' | 'append';
  rationale: string;
}

export interface DocsProposal {
  edits: DocEdit[];
  skipped: Array<{ path: string; reason: string }>;
}

/** Changelog Author output. */
export interface ChangelogProposal {
  entry: string;
  section: 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';
  semverBump: 'major' | 'minor' | 'patch' | 'none';
  bumpRationale: string;
}

/**
 * One file as the reviewer will see it, with the proposal already applied in
 * memory. Recorded on the run so that opening the pull request replays exactly
 * what was approved instead of re-deriving it against a tree that may have moved.
 */
export interface ProposedFile {
  path: string;
  before: string;
  after: string;
  appliedEdits: number;
}

export interface ValidationCheck {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
  /**
   * Where the check ran. Absent on checks that execute nothing (link and anchor
   * resolution, semver consistency) and on records written before validation
   * could run anywhere but this machine.
   */
  where?: 'sandbox' | 'local';
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
}

export type ApprovalScope = 'routine' | 'elevated';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'superseded';

export interface ApprovalRequest {
  id: string;
  runId: string;
  createdAt: string;
  scope: ApprovalScope;
  /** Why this scope was chosen — shown to the human. */
  scopeRationale: string;
  /** Number of distinct sign-offs required. Elevated scope needs two. */
  requiredSignoffs: number;
  signoffs: Array<{ by: string; at: string }>;
  status: ApprovalStatus;
  deniedReason?: string;
  summary: string;
}

export type RunStatus = 'running' | 'awaiting-approval' | 'approved' | 'denied' | 'failed' | 'done';

/**
 * How a role failed, so the UI can choose what to put in front of the user.
 *
 * These are deliberately finer-grained than "it errored": the retry policy
 * branches on them, and a reader who sees `max-tokens` three runs running knows
 * to look at budgets rather than at the harness.
 */
export type RoleFailure =
  | 'harness-error'
  | 'parse-error'
  | 'timeout'
  | 'aborted'
  | 'max-tokens'
  | 'context'
  | 'rate-limit'
  | 'cancelled'
  | 'stalled';

export interface RoleUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** harness / instructions / messages / skills / tool_definitions */
  inputBreakdown?: Record<string, number>;
  /** Priced from the account's own rates; absent when they are unknown. */
  costUsd?: number;
}

export interface RoleTrace {
  role: RoleName;
  sessionId: string;
  turnId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  /** Short human-readable lines for the timeline view. */
  events: Array<{ at: string; kind: string; text: string }>;
  error?: string;
  /** True when this role reused a session created by an earlier run. */
  reusedSession: boolean;

  /**
   * Exactly what this role was asked. The single most useful field when a
   * classification comes back wrong. Truncated — see PROMPT_LIMIT.
   */
  prompt?: string;
  /**
   * Exactly what came back, before parsing. Kept on success too: it is what
   * makes a run auditable, and on failure it is usually the only thing that
   * explains it — a `max_tokens breached` error has as often meant a repetition
   * loop as a budget that was too small.
   */
  rawOutput?: string;
  /** Which model actually ran; roles can be pointed at different ones. */
  model?: string;
  durationMs?: number;
  usage?: RoleUsage;
  failure?: RoleFailure;
  /** Attempts spent, including the one that succeeded. 1 on a clean first pass. */
  attempts?: number;
}

/** How a proposal should be published, and what it must say when it is. */
export interface PublicationIntent {
  /** True when the pipeline itself objected, so the pull request opens unmergeable. */
  draft: boolean;
  /** The objections, verbatim, for the top of the pull request body. */
  concerns: string[];
}

export interface RunRecord {
  id: string;
  repoPath: string;
  commit: { sha: string; shortSha: string; subject: string };
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  traces: RoleTrace[];
  classification?: Classification;
  impact?: ImpactMap;
  docs?: DocsProposal;
  changelog?: ChangelogProposal;
  validation?: ValidationReport;
  /**
   * The exact file contents the approval applies to. Authoritative for pull
   * request creation. Absent on runs recorded before this field existed.
   */
  proposedFiles?: ProposedFile[];
  /** Branch the docs were read from, when they live on their own branch. */
  docsBranch?: string;
  approval?: ApprovalRequest;
  /**
   * What publishing this proposal should do, decided when the run finished
   * rather than when someone finally signs off.
   *
   * The gate can hold a run for days, and the reasons a proposal is unfit —
   * the Coordinator's rejection, a failed validation check — are known only
   * while the run is still in memory. Recording the decision here is what
   * keeps an approved-but-unsound proposal opening as a draft that says why,
   * instead of a clean pull request that says nothing.
   */
  publication?: PublicationIntent;
  pullRequestUrl?: string;
  error?: string;
  /**
   * Roles that failed but did not stop the run.
   *
   * A run where four of five roles did correct work is worth landing with a
   * note, not discarding. This names what is missing so the pull request, the
   * dashboard, and the Coordinator all say so rather than quietly shipping a
   * thinner proposal than the pipeline promises.
   */
  degraded?: Array<{ role: RoleName; reason: string }>;
  /** Knowledge-map symbols already known before this run started. */
  priorSymbolCount: number;
  newSymbolCount: number;

  durationMs?: number;
  /** Rolled up from the traces, so the run list needs no per-role arithmetic. */
  totals?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    costUsd?: number;
  };
}
