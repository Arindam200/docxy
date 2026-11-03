import type { Mastra } from '@mastra/core';
import type { ToolsInput } from '@mastra/core/agent';
import type { RoleDefinition } from '../agents/roles.js';
import type { ProjectMemory } from '../pipeline/project-memory.js';

/**
 * The vocabulary the agent runtime answers in.
 *
 * Mastra is the only implementation. The interface stays because the pipeline
 * should depend on the shape of "a harness that runs a turn and reports what it
 * cost" rather than on Mastra specifically - which is what lets a test drive a
 * whole run without a model, and what kept this migration to a constructor
 * change rather than a rewrite.
 */

export type RuntimeName = 'mastra';

export interface TraceEvent {
  at: string;
  kind: string;
  text: string;
}

/**
 * Token counts for one turn.
 *
 * `inputBreakdown` splits the input side into whatever categories the runtime
 * reports - Mastra names `noCache` and `cacheRead`. The map is keyed by
 * whatever arrives rather than by a shape this side would have to keep in step
 * with the provider's accounting.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputBreakdown: Record<string, number>;
}

/**
 * Why a turn did not produce a usable answer.
 *
 * The distinction is what the caller retries on. `max-tokens` is worth another
 * attempt on a *fresh* session, because a session that has carried a dozen
 * commits is usually the reason the budget ran out; `transient` is worth the
 * same attempt again; `cancelled` is worth a longer deadline. Collapsing all of
 * them into "the harness errored" is what made every failure terminal.
 */
export type TurnFailureKind =
  | 'max-tokens'
  | 'context'
  | 'cancelled'
  | 'rate-limit'
  | 'transient'
  | 'harness'
  /**
   * The model went quiet mid-turn for longer than `agent.idleTimeoutMs` and
   * the turn was abandoned. Retried on a fresh session: a provider that hung
   * once usually answers the next request, and a long transcript is what
   * makes the wait for a first token longest.
   */
  | 'stalled'
  /**
   * A guardrail refused the input. Never retried: the diff will be the same
   * diff on the second attempt, so asking again only spends another model call
   * to be told the same thing.
   */
  | 'blocked'
  /**
   * The provider refused the call outright - a missing or wrong key, an
   * account or key without access, a model id it does not serve. Never
   * retried, for the same reason as `blocked`: nothing about the second
   * request differs, and the fix is a setting an operator has to change.
   */
  | 'provider-rejected';

export interface TurnResult<T = unknown> {
  turnId?: string;
  /** Concatenated assistant text from the root thread. */
  text: string;
  /**
   * The parsed answer, validated by the provider against the role's schema.
   *
   * A turn that produces one cannot have produced unparseable prose, which is
   * why the pipeline's `parse-error` retry path no longer fires. It stays
   * optional because a failed turn has no answer to carry.
   */
  object?: T;
  events: TraceEvent[];
  /** Subagent threads spawned during this turn. */
  subthreads: string[];
  status: string;
  usage: TurnUsage;
  /** Set when the runtime ended the turn in an error state. */
  error?: string;
  /** Set alongside `error`, and the field callers branch on. */
  errorKind?: TurnFailureKind;
  /** The model stopped because it hit its output budget, not because it finished. */
  truncated: boolean;
}

export interface ResolvedSession {
  id: string;
  /** True when an existing session was reused - this is the accumulating state. */
  reused: boolean;
  /** Turns the session had already carried before this one. */
  priorTurns: number;
  /** Set when an existing session was deliberately retired to make this one. */
  rotatedBecause?: 'turn-limit' | 'requested';
}

export interface ResolveSessionOptions {
  /**
   * Retire whatever is stored and build a new session.
   *
   * The retry path sets this after a role runs out of budget: the accumulated
   * transcript is the likeliest cause, and asking the same overfull session the
   * same question again is the one thing guaranteed not to help.
   */
  fresh?: boolean;
}

export interface RunTurnOptions {
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
  /**
   * Tools for this turn only, and the instructions that describe them.
   *
   * Per turn rather than per role because the tools are built per invocation -
   * they close over one commit's worktree and one run's collector - while the
   * agent behind a role is constructed once and cached. Mastra takes both as
   * call-time arguments (`toolsets` and an `instructions` override), so nothing
   * about the cached agent has to change for a turn to be given a tool.
   *
   * When present the turn becomes agentic: the model may call tools over
   * several rounds before it answers, bounded by `maxSteps`.
   */
  toolset?: {
    tools: ToolsInput;
    /** Appended to the role's own instructions for this call. */
    instructions: string;
    /** Tool-calling rounds before the turn is cut off. */
    maxSteps: number;
  };
}

/**
 * The harness, behind the two operations the pipeline needs from it.
 *
 * Session resolution is separate from running a turn because the pipeline
 * records which session answered, and whether it was reused, on the trace -
 * before the turn is attempted, so a role that never returns still says what it
 * was talking to.
 */
export interface AgentRuntime {
  readonly name: RuntimeName;

  /** Confirm the runtime is usable before anything that costs tokens. */
  assertReady(): Promise<void>;

  /**
   * The workflow host, which owns the storage a run's progress snapshots into.
   *
   * On the interface rather than on the implementation because the pipeline
   * needs it to resume a run that died, and a test that drives a whole pipeline
   * has to be able to supply one - an in-memory store is enough, and costs
   * neither a network nor a model.
   */
  mastra(): Promise<Mastra>;

  /**
   * The model this runtime will actually send the role to.
   *
   * The configured string may be a short alias; the trace has to record the id
   * that answered. Recording the alias instead made a run claim a model that
   * had not run, and priced it against that claim.
   */
  modelFor(role: RoleDefinition): string;

  resolveSession(
    role: RoleDefinition,
    options?: ResolveSessionOptions,
  ): Promise<ResolvedSession>;

  runTurn<T>(
    role: RoleDefinition<T>,
    sessionId: string,
    prompt: string,
    options?: RunTurnOptions,
  ): Promise<TurnResult<T>>;

  /**
   * What docxy has learned about this repository, across every commit.
   *
   * On the runtime rather than in `Stores` because it is Mastra working memory,
   * resource-scoped to the repository - it lives in the same store the threads
   * do, and rebuilding it as a fourth persistence interface would mean two
   * backends to write and a table to migrate for something Mastra already
   * keeps. It stays behind the interface so a test can hand the pipeline a
   * runtime with no database and no model.
   *
   * A record that cannot be read is reported as empty rather than as a failure.
   * A run must not die because it could not recall a hint.
   */
  loadProjectMemory(): Promise<ProjectMemory>;

  /**
   * Record what a finished run taught.
   *
   * Throws if the store refused, unlike `loadProjectMemory` - a failed write is
   * a fact, and the callers disagree about what to do with it. The pipeline
   * swallows it, because losing a run's counters is not a reason to discard a
   * proposal every role has already been paid for; `docxy reset --memory` does
   * not, because a reset that reports success it cannot vouch for is worse than
   * one that fails.
   */
  saveProjectMemory(memory: ProjectMemory): Promise<void>;

  /** Release connections. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * HTTP statuses that mean the provider will not serve this request at all.
 *
 * 401 is a missing or wrong key, 402 an account that cannot pay for the call,
 * 403 a key without access to the model, and 404 a model id - or a base URL -
 * the provider does not know. Each of them used to fall through to `harness`
 * and be retried with backoff - refused identically on every attempt, with a
 * perfectly good session thrown away on the second - before the run reported
 * "the harness errored", which names nothing an operator can change.
 *
 * 400 is deliberately absent. It is what an overlong prompt comes back as, and
 * that has its own kind and its own fix; the rest of what it covers is too
 * mixed to call permanent on the status alone.
 */
const REJECTING_STATUSES = new Set([401, 402, 403, 404]);

/**
 * Name the failure from whatever the provider said.
 *
 * The message is free text from the model provider, so this matches on
 * substrings rather than pretending there is an error code - except where the
 * provider did answer with one. `status` is the HTTP status read off the error
 * object, never parsed out of the message: a `404` in free text is as likely to
 * be a file the model was talking about as a model the provider does not have.
 * Anything unrecognised stays `harness`, which the caller retries conservatively.
 */
export function classifyTurnError(message: string, status?: number): TurnFailureKind {
  if (status !== undefined && REJECTING_STATUSES.has(status)) return 'provider-rejected';
  const text = message.toLowerCase();
  if (/max[_ ]?tokens|max output tokens|output (limit|budget)|finish[_ ]?reason\b[^a-z]*length/.test(text)) {
    return 'max-tokens';
  }
  if (/context (length|window)|too many tokens|prompt is too long|exceeds .*context/.test(text)) {
    return 'context';
  }
  if (/rate.?limit|429|too many requests|quota/.test(text)) return 'rate-limit';
  if (/timeout|timed out|deadline|econnreset|socket hang up|network|fetch failed|econnrefused|eai_again/.test(text)) {
    return 'transient';
  }
  // Mastra's own wording when the model router has no key for the provider at
  // all, so there is no response and no status to read. The phrase is the
  // router's, not the model's, so it cannot arrive as something a model said.
  if (/could not find api key/.test(text)) return 'provider-rejected';
  return 'harness';
}

/** An empty set of counts, so a failed turn still reports usage of the right shape. */
export function emptyUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputBreakdown: {},
  };
}
