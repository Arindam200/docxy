import type { Config, RoleName } from '../config.js';
import type { RoleFailure, RoleTrace, RoleUsage, RunRecord } from '../types.js';
import type { RoleDefinition } from '../agents/roles.js';
import type { AgentRuntime, RunTurnOptions, TurnUsage } from '../runtime/index.js';
import { extractJson } from '../agents/parse.js';
import { costOf, priceFor, round, type PriceTable } from '../pricing.js';
import { planRetry, sleep, type AttemptFailure } from './retry.js';
import type { Stores } from './stores.js';

/** Callbacks a caller supplies to watch a run as it happens. */
export interface PipelineHooks {
  onRunUpdate?: (run: RunRecord) => void;
  onRoleEvent?: (role: RoleName, event: { at: string; kind: string; text: string }) => void;
}

/**
 * Prompts and raw outputs are recorded verbatim, and a diff-heavy prompt can be
 * large. This bounds a single field rather than the record as a whole; the tail
 * is where truncation shows, and the head is what explains a bad answer.
 */
const BODY_LIMIT = 100_000;
function truncate(text: string): string {
  if (text.length <= BODY_LIMIT) return text;
  return `${text.slice(0, BODY_LIMIT)}\n\n… truncated, ${text.length - BODY_LIMIT} more characters`;
}
/**
 * Fold one turn's input-side breakdown into a role's running totals.
 *
 * The categories are the harness's own - `harness`, `instructions`, `messages`,
 * `skills`, `toolDefinitions` - and it owns the list, so this stays a map keyed
 * by whatever it reports rather than a shape this side would have to keep in
 * step with it.
 */
function mergeBreakdown(into: RoleUsage['inputBreakdown'], from: TurnUsage['inputBreakdown']) {
  const out = { ...into };
  for (const [key, value] of Object.entries(from)) out[key] = (out[key] ?? 0) + value;
  return out;
}
/**
 * Whether a rejection is one of the two aborts, rather than a fault.
 *
 * Takes the thrown value as `Error | unknown` because that is genuinely what a
 * `catch` binding is: the question this answers is precisely "is this an Error,
 * and is it one of those two", so there is nothing to parse at a boundary that
 * would not be this check itself.
 */
function abortedBy(err: Error | unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * The two vocabularies line up almost one to one; the exceptions are the ones
 * worth naming. `transient` is reported as `harness-error` because from a
 * reader's side a dropped connection and a harness fault are the same event,
 * and `context` keeps its own name because the fix for it is different.
 */
function asRoleFailure(kind: AttemptFailure): RoleFailure {
  switch (kind) {
    case 'blocked':
      return 'blocked';
    case 'parse-error':
      return 'parse-error';
    case 'max-tokens':
      return 'max-tokens';
    case 'context':
      return 'context';
    case 'rate-limit':
      return 'rate-limit';
    case 'cancelled':
      return 'cancelled';
    case 'stalled':
      return 'stalled';
    default:
      return 'harness-error';
  }
}
/**
 * Roll the traces up onto the run, so the run list needs no per-role arithmetic
 * and a run that fails half way still reports what it spent getting there.
 */
function rollUp(run: RunRecord, config: Config, prices: PriceTable): void {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let costUsd = 0;
  let priced = false;

  for (const trace of run.traces) {
    totals.inputTokens += trace.usage?.inputTokens ?? 0;
    totals.outputTokens += trace.usage?.outputTokens ?? 0;
    totals.cacheReadTokens += trace.usage?.cacheReadTokens ?? 0;

    // Roles can run on different models, so each is priced against its own.
    const cost = costOf(trace.usage, priceFor(trace.model, config, prices));
    if (cost !== undefined && trace.usage) {
      trace.usage.costUsd = cost;
      costUsd += cost;
      priced = true;
    }
  }

  // Left absent rather than zero when no rate was known: a run that cost
  // nothing and a run nobody could price are different facts.
  run.totals = priced ? { ...totals, costUsd: round(costUsd) } : totals;

  const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
  run.durationMs = end.getTime() - new Date(run.startedAt).getTime();
}

/**
 * Everything one run needs to drive a role, in a form a workflow step can hold.
 *
 * This was a closure inside `runPipeline`, which was fine while the run was one
 * function. A durable workflow executes each step separately - possibly in a
 * different process, after a restart - so the retry policy, the persistence
 * discipline and the trace bookkeeping have to be reachable from outside that
 * function.
 *
 * It is a move, not a rewrite. The behaviour here is the behaviour that was
 * earned by the failures described throughout: retry classified by kind,
 * serialized coalescing writes, turns counted on submission, two deadlines with
 * the earlier one winning. None of it is Mastra's to provide, and none of it
 * changed on the way out.
 */
export class RunContext {
  private writing: Promise<void> | null = null;
  private pendingWrite: Promise<void> | null = null;

  constructor(
    readonly config: Config,
    readonly runtime: AgentRuntime,
    readonly stores: Stores,
    readonly run: RunRecord,
    readonly prices: PriceTable,
    /** The whole run's budget, started at the door. */
    readonly deadline: AbortSignal,
    readonly hooks: PipelineHooks,
  ) {}

  /**
   * Serialized, coalescing, and never fatal.
   *
   * Three properties, each earning its place:
   *
   * *Serialized*, because the Docs Updater and Changelog Author run
   * concurrently and both write the same `RunRecord`. Against Postgres a save
   * rewrites the run's roles and events in one transaction, and two of those in
   * flight at once either deadlock or lose a role's trace.
   *
   * *Coalescing*, because the record is saved nineteen times in a run and
   * seventeen of those are progress updates on a record that is about to change
   * again. Callers that arrive while a write is in flight collapse into a
   * single follow-up write of the record as it stands when that write starts -
   * so a burst of role events costs one save, not one each. `flush` forces the
   * write for the points that must be durable.
   *
   * *Never fatal*, because losing the audit trail for a moment is bad and
   * killing a run that is otherwise going fine is worse.
   */
  private async writeNow(): Promise<void> {
    rollUp(this.run, this.config, this.prices);
    try {
      await this.stores.runs.save(this.run);
    } catch (err) {
      console.error(
        `could not this.persist this.run ${this.run.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.hooks.onRunUpdate?.(this.run);
  }

  persist(): Promise<void> {
    if (!this.writing) {
      this.writing = this.writeNow().finally(() => {
        this.writing = null;
      });
      return this.writing;
    }
    // A write is already going. Ride the one already queued behind it rather
    // than adding another: they would both save the same final state.
    this.pendingWrite ??= this.writing
      .then(() => {
        this.pendingWrite = null;
        return this.persist();
      })
      .catch(() => {});
    return this.pendingWrite;
  }

  /**
   * Wait for the record on disk to reflect everything written so far.
   *
   * Bounded rather than looping until quiet: at every point this is called the
   * run is between roles and nothing else is writing, so two passes is already
   * one more than needed - but a `while` here would be a spin waiting on a
   * writer that never stops, and a durability barrier must not be able to hang
   * the run it is protecting.
   */
  async flush(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      await this.persist();
      const inFlight = this.writing ?? this.pendingWrite;
      if (!inFlight) return;
      await inFlight;
    }
  }


  /**
   * Run one role to completion, retrying on its own terms, and record one trace
   * either way.
   *
   * Every failure used to be terminal, which is how a single `max_tokens`
   * breach in the Changelog Author threw away three other roles' finished work.
   * Each attempt is classified and answered differently - see `planRetry` - and
   * the trace keeps every attempt's events so a run that needed three tries
   * says so instead of looking like a clean pass.
   */
  /**
   * @param options.toolset Tools for this role's turn, when it drafts by
   * running a program rather than by answering in one message. Forwarded
   * verbatim to the runtime; everything else here - retry, session rotation,
   * turn counting, the two deadlines, the trace - is unchanged by it.
   */
  async invoke<T>(
    role: RoleDefinition<T>,
    basePrompt: string,
    options: { toolset?: RunTurnOptions['toolset'] } = {},
  ): Promise<T> {
    const startedAt = new Date();

    /**
     * One trace per role per run, continued rather than replaced.
     *
     * A resumed run already carries a trace for the role its dead process was
     * part-way through. Pushing a second gave the run two traces for one role -
     * the abandoned one first - and every view that reads "the trace for this
     * role" showed the dead attempt, so a resumed run looked like it had lost
     * the roles it had just finished.
     *
     * The earlier attempt's usage stays on the trace, because it was really
     * spent, and `attempts` already accumulates the same way across the retries
     * within a single invocation.
     */
    const existing = this.run.traces.find((t) => t.role === role.name);
    const trace: RoleTrace = existing ?? {
      role: role.name,
      sessionId: '',
      startedAt: startedAt.toISOString(),
      status: 'running',
      events: [],
      reusedSession: false,
      // Captured up front so a role that never returns still shows what it was
      // asked and which model was meant to answer.
      prompt: truncate(basePrompt),
      // What actually answers, as the runtime names it - not the configured
      // string, which under Mastra names a model that never ran.
      model: this.runtime.modelFor(role),
      attempts: 0,
    };
    if (existing) {
      trace.status = 'running';
      trace.prompt = truncate(basePrompt);
      trace.model = this.runtime.modelFor(role);
      delete trace.error;
      delete trace.failure;
      delete trace.finishedAt;
    } else {
      this.run.traces.push(trace);
    }
    await this.persist();

    const note = (kind: string, text: string): void => {
      const event = { at: new Date().toISOString(), kind, text };
      trace.events.push(event);
      this.hooks.onRoleEvent?.(role.name, event);
    };

    /** Stamp the outcome onto the trace. Runs on every path, success or not. */
    const finish = (status: RoleTrace['status'], failure?: RoleFailure): void => {
      const finishedAt = new Date();
      trace.status = status;
      trace.finishedAt = finishedAt.toISOString();
      trace.durationMs = finishedAt.getTime() - startedAt.getTime();
      if (failure) trace.failure = failure;
    };

    const maxAttempts = this.config.agent.maxAttempts;
    let fresh = false;
    let nudge = '';
    let lastError: Error = new Error(`[${role.title}] never ran`);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      trace.attempts = attempt;
      const prompt = nudge ? `${basePrompt}\n\n${nudge}` : basePrompt;

      let session;
      try {
        session = await this.runtime.resolveSession(role, { fresh });
      } catch (err) {
        // Cannot even get a session: the harness is down or rejecting the spec.
        // Retrying a fresh session cannot help if creation is what failed.
        lastError = err instanceof Error ? err : new Error(String(err));
        note('error', `could not open a session: ${lastError.message}`);
        finish('failed', 'harness-error');
        trace.error = lastError.message;
        await this.persist();
        throw lastError;
      }

      trace.sessionId = session.id;
      // Only the first attempt speaks to reuse honestly; a rotated session is a
      // new one no matter what was stored before it.
      if (attempt === 1) trace.reusedSession = session.reused;
      note(
        'session',
        // A role that carries no thread has no session to report, and saying
        // "created session X" twice with the same visible id - the id leads
        // with the spec hash, which does not change - read as a bug.
        !role.carriesMemory
          ? 'asked in isolation; this role carries no memory across commits'
          : session.reused
            ? `reusing session ${session.id.slice(0, 8)} (${session.priorTurns} turn(s) of history)`
            : session.rotatedBecause === 'turn-limit'
              ? `retired the previous session after ${this.config.agent.sessionMaxTurns} turns; created ${session.id.slice(0, 8)}`
              : session.rotatedBecause === 'requested'
                ? `started over on a fresh session ${session.id.slice(0, 8)}`
                : `created session ${session.id.slice(0, 8)}`,
      );
      if (attempt > 1) note('retry', `attempt ${attempt} of ${maxAttempts}`);
      await this.persist();

      // A hung turn used to hang the whole run: `runTurn` accepted a signal and
      // nothing ever passed one. Two deadlines apply - this attempt's, and
      // whatever is left of the run's - and the earlier one wins.
      const timeout = AbortSignal.timeout(this.config.agent.attemptTimeoutMs);
      const deadline = AbortSignal.any([timeout, this.deadline]);
      let failure: AttemptFailure | undefined;
      let raw = '';

      try {
        const turnOptions: RunTurnOptions = {
          signal: deadline,
          onEvent: (event) => {
            trace.events.push(event);
            this.hooks.onRoleEvent?.(role.name, event);
            this.hooks.onRunUpdate?.(this.run);
          },
        };
        if (options.toolset) turnOptions.toolset = options.toolset;

        const result = await this.runtime.runTurn<T>(role, session.id, prompt, turnOptions);

        if (result.turnId) trace.turnId = result.turnId;
        raw = result.text;

        // Counted here, not after a successful parse.
        //
        // The count exists to retire a session before its transcript overflows,
        // and the transcript grows the moment a turn is *submitted* - whether
        // or not the answer came back usable. Counting only successes meant a
        // session that kept failing never reached the limit, so it never
        // rotated, so it kept growing: precisely the spiral rotation was built
        // to stop. A `max_tokens` failure is the worst case of all, because the
        // model generated its whole budget into the transcript before failing.
        await this.stores.sessions.recordTurn(role.name).catch(() => {});
        // Recorded before anything can throw. The raw text is the field that
        // explains a failure - a `max_tokens breached` error has as often meant
        // a repetition loop as a budget that was too small - and it is what
        // makes a successful run auditable rather than merely rendered.
        trace.rawOutput = truncate(result.text);
        // Accumulated across attempts: a role that burned two budgets before
        // succeeding cost all three, and the run's totals should say so.
        trace.usage = {
          inputTokens: (trace.usage?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens: (trace.usage?.outputTokens ?? 0) + result.usage.outputTokens,
          cacheReadTokens: (trace.usage?.cacheReadTokens ?? 0) + result.usage.cacheReadTokens,
          cacheWriteTokens: (trace.usage?.cacheWriteTokens ?? 0) + result.usage.cacheWriteTokens,
          inputBreakdown: mergeBreakdown(trace.usage?.inputBreakdown, result.usage.inputBreakdown),
        };

        if (result.error) {
          failure = result.errorKind ?? 'harness';
          lastError = new Error(
            `[${role.title}] the harness ended the turn in an error state: ${result.error}`,
          );
        } else {
          try {
            // A runtime whose provider enforced the schema has already parsed
            // and validated this. The text scanner is the path for a runtime
            // that cannot enforce a schema, and is the only one that can fail
            // here - kept because removing the sole handler for a malformed
            // answer is how it stops being handled when one arrives.
            const parsed =
              result.object !== undefined
                ? result.object
                : extractJson<T>(role.title, result.text);
            finish('done');
            note(
              'result',
              `produced ${result.text.length} characters ` +
                `(${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)` +
                (attempt > 1 ? ` on attempt ${attempt}` : ''),
            );
            await this.persist();
            return parsed;
          } catch (cause) {
            failure = 'parse-error';
            lastError = cause instanceof Error ? cause : new Error(String(cause));
          }
        }
      } catch (err) {
        if (abortedBy(err)) {
          // Three ways to get here, and they are not the same event. The run's
          // own deadline is terminal - retrying cannot fit inside a budget that
          // is already spent. This attempt's deadline is worth another try. A
          // caller-side abort is a decision, not a fault.
          if (this.deadline.aborted) {
            lastError = new Error(
              `[${role.title}] the this.run exceeded its ${Math.round(this.config.agent.runTimeoutMs / 1000)}s budget`,
            );
            finish('failed', 'timeout');
            trace.error = lastError.message;
            await this.persist();
            throw lastError;
          }
          if (!timeout.aborted) {
            lastError = new Error(`[${role.title}] the this.run was cancelled`);
            finish('failed', 'aborted');
            trace.error = lastError.message;
            await this.persist();
            throw lastError;
          }
          lastError = new Error(
            `[${role.title}] no answer within ${Math.round(this.config.agent.attemptTimeoutMs / 1000)}s`,
          );
          // Abandoned here, but the harness still has it and the transcript
          // still grew, so it counts against the session like any other turn.
          await this.stores.sessions.recordTurn(role.name).catch(() => {});
          failure = 'transient';
          note('error', lastError.message);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
          failure = 'harness';
        }
      }

      trace.error = lastError.message;
      const plan = planRetry(failure, attempt, maxAttempts, raw);
      note(plan.retry ? 'retry' : 'error', `${failure}: ${plan.reason}`);
      await this.persist();

      if (!plan.retry) {
        finish('failed', asRoleFailure(failure));
        await this.persist();
        throw lastError;
      }

      fresh = plan.freshSession;
      nudge = plan.nudge ?? '';
      if (plan.delayMs > 0) {
        // Backing off spends the run's budget like everything else does. A
        // rate-limited role that sleeps past the deadline has spent it
        // sleeping, and waking to try again would only spend more - so this
        // ends the same way an exhausted budget ends anywhere else.
        try {
          await sleep(plan.delayMs, this.deadline);
        } catch {
          lastError = new Error(
            `[${role.title}] the this.run exceeded its ` +
              `${Math.round(this.config.agent.runTimeoutMs / 1000)}s budget while backing off`,
          );
          finish('failed', 'timeout');
          trace.error = lastError.message;
          await this.persist();
          throw lastError;
        }
      }
    }

    finish('failed', 'harness-error');
    await this.persist();
    throw lastError;
  }
}
