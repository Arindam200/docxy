import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { PromptInjectionDetector, RegexFilterProcessor } from '@mastra/core/processors';
import type { InputProcessor } from '@mastra/core/processors';
import { SECRET_RULES } from '../guardrails/secrets.js';
import { pipelineWorkflows } from '../pipeline/workflow.js';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import type { MemoryConfig } from '@mastra/core/memory';
import type { MastraStorage } from '@mastra/core/storage';
import {
  emptyProjectMemory,
  parseProjectMemory,
  projectMemorySchema,
  serializeProjectMemory,
  type ProjectMemory,
} from '../pipeline/project-memory.js';
import type { Config, RoleName } from '../config.js';
import { mastraModelFor } from '../config.js';
import type { RoleDefinition } from '../agents/roles.js';
import { extractJson } from '../agents/parse.js';
import type { SessionStorage } from '../pipeline/stores.js';
import { databaseConfigured } from '../db/index.js';
import {
  classifyTurnError,
  emptyUsage,
  type AgentRuntime,
  type ResolveSessionOptions,
  type ResolvedSession,
  type RunTurnOptions,
  type TraceEvent,
  type TurnFailureKind,
  type TurnResult,
  type TurnUsage,
} from './types.js';

/**
 * The harness: five agents, in this process, against Nebius through Mastra's
 * model router.
 *
 * The provider enforces each role's schema, so `runTurn` returns a parsed
 * `object` and a turn cannot come back as unparseable prose.
 *
 * A "session" is a Mastra thread. The id carries the spec hash
 * (`hash-repo-role-serial`), so changing a prompt, a model, or a schema yields
 * a different thread by construction rather than by an invalidation step
 * somebody has to remember to run.
 *
 * Rotation and turn counting stay in `SessionStorage`, which knows nothing
 * about threads - it records an id and a count, and that is what makes the
 * no-database path work identically to the Postgres one.
 */
/**
 * The role the injection check runs on.
 *
 * The Change Analyst is the first to see the diff, and a block there stops the
 * run before the Impact Mapper or the Docs Updater are asked anything - so one
 * call protects all three.
 */
const FIRST_READER_OF_THE_DIFF: RoleName = 'change-analyst';

/** What both shapes of turn pass to `generate`, whatever else they add to it. */
interface SharedTurnOptions {
  modelSettings: { temperature: number; maxOutputTokens: number };
  memory?: { thread: string; resource: string };
  abortSignal?: AbortSignal;
}

/**
 * The answer a tool turn produced, or `undefined` when there is not one.
 *
 * Tries the model's own text first - a turn that did write a closing message
 * should be taken at its word - and falls back to the schema's defaults for the
 * common case where the program ran, the tools recorded the work, and the model
 * simply stopped. A schema with no defaults rejects the empty object, so this
 * never manufactures an answer for a role whose output actually matters.
 */
function objectFrom<T>(role: RoleDefinition<T>, text: string): T | undefined {
  if (text.trim()) {
    try {
      return role.schema.parse(extractJson<unknown>(role.title, text));
    } catch {
      // Prose where JSON was expected. The defaults below still apply: the
      // work is in the tool calls either way.
    }
  }
  const empty = role.schema.safeParse({});
  return empty.success ? empty.data : undefined;
}

/** Chunks that say one of this turn's own tools has finished, one way or another. */
const TOOL_ENDINGS = new Set(['tool-result', 'tool-error', 'tool-output-denied']);

/**
 * A turn's pulse, and what happens when it stops.
 *
 * The per-attempt deadline is the only other bound on a turn, and it has to be
 * long: a reasoning model writing a sixteen-thousand-token answer is minutes of
 * honest work. So a provider that accepted a request and then went silent held
 * the role for all of it, three attempts over - about twenty minutes before
 * anything gave up on it. A stream says something every few hundred
 * milliseconds while it is working, which makes silence the signal, and it can
 * be acted on in seconds rather than minutes.
 *
 * Every chunk Mastra hands `onChunk` counts as life: text, reasoning, a tool
 * call being written. The clock stops while one of this turn's own tools is
 * running, because that silence is ours - a sandboxed program is bounded by its
 * own timeout, and a model cannot be expected to speak while it waits for the
 * result. It starts again when the last running tool reports back.
 *
 * Expiry aborts the call through the same signal the caller's deadline uses,
 * and is remembered here, so the turn is reported as `stalled` rather than
 * mistaken for the caller giving up on it.
 */
class IdleWatch {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private toolsRunning = 0;
  private stopped = false;

  constructor(private readonly limitMs: number) {
    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True once the turn went quiet for the whole limit and was aborted for it. */
  get expired(): boolean {
    return this.controller.signal.aborted;
  }

  /** One chunk arrived; `kind` is Mastra's name for it. */
  saw(kind: string): void {
    if (kind === 'tool-call') this.toolsRunning += 1;
    else if (TOOL_ENDINGS.has(kind)) this.toolsRunning = Math.max(0, this.toolsRunning - 1);
    this.arm();
  }

  /** The call is over. A chunk that straggles in afterwards must not start the clock again. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.stopped || this.expired || this.toolsRunning > 0) return;
    this.timer = setTimeout(() => {
      this.controller.abort(
        new DOMException(`no progress for ${this.limitMs / 1000}s`, 'TimeoutError'),
      );
    }, this.limitMs);
  }
}

/**
 * The error an aborted call is raised as.
 *
 * Mastra does not throw when a call is aborted. It finishes the turn early -
 * as a tripwire with no processor behind it when the model was mid-answer - and
 * the runtime used to read that as a guardrail refusing the diff: every
 * attempt deadline was reported as `blocked`, never retried, and blamed on
 * whoever wrote the commit. The abort is raised here instead, as the caller's
 * own reason when it is one of the two `RunContext` interprets, so a spent
 * attempt is retried and a spent run is not, exactly as that code intends.
 */
function abortOf(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && (reason.name === 'AbortError' || reason.name === 'TimeoutError')) {
    return reason;
  }
  return new DOMException('the turn was aborted', 'AbortError');
}

/**
 * Where a provider's HTTP status lives on a failed call.
 *
 * The AI SDK raises an `APICallError` carrying `statusCode`, and Mastra may
 * wrap it, so `cause` is followed a few links down. An SDK's error object is
 * external data like any other, and parsed rather than probed; a link that
 * does not fit is no status rather than an exception.
 */
const providerFailureSchema = z.object({
  statusCode: z.number().int().optional().catch(undefined),
  cause: z.instanceof(Error).optional().catch(undefined),
});

function httpStatusOf(err: Error, depth = 0): number | undefined {
  const parsed = providerFailureSchema.safeParse(err);
  if (!parsed.success) return undefined;
  if (parsed.data.statusCode !== undefined) return parsed.data.statusCode;
  return parsed.data.cause && depth < 3 ? httpStatusOf(parsed.data.cause, depth + 1) : undefined;
}

/** A failed call, named for the retry policy and worded for whoever reads the trace. */
interface DescribedFailure {
  message: string;
  kind: TurnFailureKind;
}

/**
 * Classify a failed call by what the provider actually answered.
 *
 * The status is read off the error object rather than out of its text: the
 * message is whatever the provider chose to say - "Unauthorized" from one, a
 * sentence about keys from another - and a pattern for `404` in free text is
 * one bad error message away from refusing to retry a timeout. A refusal is
 * reworded to say what to check, because the provider's own words name the
 * symptom and an operator needs the setting.
 */
function describeFailure(err: Error, model: string): DescribedFailure {
  const status = httpStatusOf(err);
  const kind = classifyTurnError(err.message, status);
  if (kind !== 'provider-rejected') return { message: err.message, kind };
  const answered = status === undefined ? '' : ` with HTTP ${status}`;
  return {
    kind,
    message:
      `the provider refused ${model}${answered}: ${err.message}. Check NEBIUS_API_KEY and ` +
      'the model configured for this role (DOCXY_MODEL_*); asking again would be refused ' +
      'the same way',
  };
}

/**
 * One Mastra store per database per process, shared by every runtime.
 *
 * A runtime is built per run, because it is bound to that run's checkout and
 * configuration - but its store was being built per run too, and a store is a
 * connection pool plus `init()`, which issues Mastra's whole schema setup over
 * the network before the first role can start. Nothing in the server ever
 * closed one, so each run also left its pool behind. The store depends on
 * nothing but where it points, so it is opened once and handed to whichever
 * runtime asks.
 *
 * A failed open is forgotten rather than cached, so the next run tries again
 * instead of inheriting the failure.
 */
const sharedStores = new Map<string, Promise<MastraStorage>>();

function sharedStorage(key: string, open: () => Promise<MastraStorage>): Promise<MastraStorage> {
  const existing = sharedStores.get(key);
  if (existing) return existing;
  const opened = open();
  sharedStores.set(key, opened);
  opened.catch(() => {
    if (sharedStores.get(key) === opened) sharedStores.delete(key);
  });
  return opened;
}

export class MastraRuntime implements AgentRuntime {
  readonly name = 'mastra' as const;

  private readonly agents = new Map<RoleName, Agent>();
  private store: MastraStorage | null = null;
  private storeKey: string | null = null;
  private instance: Mastra | null = null;
  private memory: Memory | null = null;
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStorage,
  ) {}

  /**
   * Postgres when `DATABASE_URL` is set, a LibSQL file under the state
   * directory otherwise.
   *
   * The second is not a degraded mode. `docxy run` against a fresh clone with
   * no infrastructure is a supported path - it is what the demo uses - and
   * Mastra falls back to a volatile in-memory store when given nothing, which
   * would silently drop every role's memory between commits.
   *
   * Imported lazily so a run with no database never loads the Postgres driver,
   * and vice versa.
   */
  /**
   * The Mastra instance the workflow runs on.
   *
   * Built lazily and once, because it owns the storage handle the workflow
   * snapshots into - the same store the agents' threads live in, so a run's
   * memory and its progress are durable together or not at all.
   */
  async mastra(): Promise<Mastra> {
    if (this.instance) return this.instance;
    this.instance = new Mastra({
      storage: await this.storage(),
      workflows: pipelineWorkflows(),
      // The agents are constructed per role on first use and reach the model
      // router directly; registering them here as well would only give Mastra a
      // second, divergent copy of each.
      logger: false,
    });
    return this.instance;
  }

  async storage(): Promise<MastraStorage> {
    if (this.store) return this.store;

    const connectionString = databaseConfigured() ? process.env.DATABASE_URL : undefined;
    const file = join(this.config.stateDir, 'mastra.db');
    const key = connectionString ? `pg:${connectionString}` : `libsql:${file}`;

    this.store = await sharedStorage(key, async () => {
      let store: MastraStorage;
      if (connectionString) {
        const { PostgresStore } = await import('@mastra/pg');
        store = new PostgresStore({ id: 'docxy', connectionString });
      } else {
        const { LibSQLStore } = await import('@mastra/libsql');
        store = new LibSQLStore({ id: 'docxy', url: `file:${file}` });
      }
      await store.init();
      return store;
    });
    this.storeKey = key;
    return this.store;
  }

  /**
   * What a role is allowed to be sent, and what it is allowed to be told.
   *
   * A commit diff is not trusted input. It is written by whoever opened the
   * pull request, it can carry a committed key straight to a model provider,
   * and it can carry a sentence addressed to the agent that reads it - an
   * instruction to add a link, to describe a change that did not happen, to
   * quote something into a file. Docxy then writes that up and opens a pull
   * request under a bot account, which is exactly the outcome worth spending a
   * little to avoid.
   *
   * The two guards sit in different places for a reason. Redaction is a regex
   * and costs nothing, so every role gets it and no future prompt can forget
   * it. Injection detection is a model call, so it goes on the first role that
   * reads the diff and nowhere else: blocking there ends the run before any
   * other role is asked anything.
   */
  private processorsFor(role: RoleDefinition): InputProcessor[] {
    const processors: InputProcessor[] = [];

    if (this.config.guardrails.redactSecrets) {
      processors.push(
        new RegexFilterProcessor({
          // Mastra's own `secrets` preset is three patterns and let a Stripe
          // key and a GitHub token through in a probe; `SECRET_RULES` is the
          // set that matters for a commit diff. The preset is kept alongside
          // it because its `Bearer` and `api_key =` rules are worth having.
          presets: ['secrets'],
          rules: SECRET_RULES,
          // Redact rather than block. A diff that touches a line which merely
          // looks like a key is ordinary work, and refusing to document it
          // would make the guard the thing that breaks the pipeline.
          strategy: 'redact',
          phase: 'input',
        }),
      );
    }

    if (this.config.guardrails.detectPromptInjection && role.name === FIRST_READER_OF_THE_DIFF) {
      processors.push(
        new PromptInjectionDetector({
          model: this.config.guardrails.injectionModel,
          threshold: this.config.guardrails.injectionThreshold,
          // Blocked, not rewritten. A rewrite would hand the next role a diff
          // that no longer matches the commit, and every anchor it quoted would
          // be from text that was never in the repository.
          strategy: 'block',
        }),
      );
    }

    return processors;
  }

  private async agentFor(role: RoleDefinition): Promise<Agent> {
    const existing = this.agents.get(role.name);
    if (existing) return existing;

    const memory = await this.memoryHandle();

    const base = {
      id: `docxy-${role.name}`,
      name: role.title,
      instructions: role.instructions(this.config),
      model: mastraModelFor(this.config, role.name),
      inputProcessors: this.processorsFor(role),
    };
    // A role that must quote the prompt back verbatim is given no thread; see
    // `RoleDefinition.carriesMemory`.
    const agent = role.carriesMemory ? new Agent({ ...base, memory }) : new Agent(base);

    this.agents.set(role.name, agent);
    return agent;
  }

  async assertReady(): Promise<void> {
    if (!this.config.nebius.apiKey) {
      throw new Error(
        'NEBIUS_API_KEY is not set. Get a key at https://tokenfactory.nebius.com and put it in .env',
      );
    }
    // The model router reads the key from the environment by provider id, so a
    // key that only ever reached `Config` would not be found.
    process.env.NEBIUS_API_KEY = this.config.nebius.apiKey;
    await this.storage();
  }

  modelFor(role: RoleDefinition): string {
    return mastraModelFor(this.config, role.name);
  }

  /**
   * Identify the agent configuration a thread was built from.
   *
   * The schema is fingerprinted alongside the prompt and the model because it
   * is now part of the contract the model answers under: widening an enum
   * changes what a valid answer is, and a thread carrying a dozen commits'
   * worth of answers in the old shape is not the place to ask under the new one.
   */
  private specHash(role: RoleDefinition): string {
    const spec = {
      instructions: role.instructions(this.config),
      model: mastraModelFor(this.config, role.name),
      params: role.params,
      schema: z.toJSONSchema(role.schema),
    };
    return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
  }

  private repoKey(): string {
    return createHash('sha256').update(this.config.repoPath).digest('hex').slice(0, 16);
  }

  /**
   * How project memory is stored, passed per call rather than set on `Memory`.
   *
   * Two properties matter here and both are deliberate.
   *
   * `scope: 'resource'` makes the repository the thing remembered. The resource
   * is already `repoKey()` - the same id every role's thread is filed under -
   * so one record spans all five roles, every thread they rotate through, and
   * every commit. Nothing new has to be keyed, and two repositories cannot read
   * each other's memory.
   *
   * `agentManaged: false` is what keeps the model out of it. Mastra registers
   * an `updateWorkingMemory` tool only when this is not false, so with it off no
   * role is handed the tool and no role can write a word of this. The record is
   * written by `saveProjectMemory` from counters a finished run already
   * recorded, and reaches a role only as prompt text the trace shows verbatim.
   * Model-written memory reaching a role that must quote exactly is the bug
   * this repository already paid for once; see `RoleDefinition.carriesMemory`.
   *
   * Because it is passed here and never to `agent.generate`, an ordinary turn
   * neither loads nor stores it.
   */
  private projectMemoryConfig(): MemoryConfig {
    return {
      workingMemory: {
        enabled: true,
        scope: 'resource',
        schema: projectMemorySchema,
        agentManaged: false,
      },
    };
  }

  private async memoryHandle(): Promise<Memory> {
    if (!this.memory) {
      this.memory = new Memory({
        storage: await this.storage(),
        // See `agent.memoryLastMessages`: the default re-sends old diffs.
        options: { lastMessages: this.config.agent.memoryLastMessages },
      });
    }
    return this.memory;
  }

  /**
   * The thread id the working-memory calls take.
   *
   * Resource-scoped reads and writes never touch a thread - Mastra goes
   * straight to the resource row - but the parameter is required, so this names
   * what it is instead of passing something that looks like a real thread.
   */
  private projectMemoryThread(): string {
    return `project-memory-${this.repoKey()}`;
  }

  async loadProjectMemory(): Promise<ProjectMemory> {
    try {
      const memory = await this.memoryHandle();
      const raw = await memory.getWorkingMemory({
        threadId: this.projectMemoryThread(),
        resourceId: this.repoKey(),
        memoryConfig: this.projectMemoryConfig(),
      });
      return parseProjectMemory(raw);
    } catch {
      // Recall is an optimisation. A store that cannot answer costs this run
      // its hints, and nothing else.
      return emptyProjectMemory();
    }
  }

  /**
   * Throws on a storage fault, deliberately.
   *
   * Reading is different - a memory that cannot be recalled costs the run its
   * hints and nothing else, so `loadProjectMemory` reports empty. A write that
   * failed is a fact about the store, and the two callers want opposite things
   * from it: the pipeline swallows it, because a counter is not worth
   * discarding a finished proposal over, and `docxy reset --memory` must not
   * print that it cleared something it did not.
   */
  async saveProjectMemory(memory: ProjectMemory): Promise<void> {
    const handle = await this.memoryHandle();
    await handle.updateWorkingMemory({
      threadId: this.projectMemoryThread(),
      resourceId: this.repoKey(),
      workingMemory: serializeProjectMemory(memory),
      memoryConfig: this.projectMemoryConfig(),
    });
  }

  async resolveSession(
    role: RoleDefinition,
    options: ResolveSessionOptions = {},
  ): Promise<ResolvedSession> {
    const hash = this.specHash(role);

    // A role that carries no thread has nothing to resolve and nothing to
    // rotate. It gets a fresh id so its trace reads honestly - every run is a
    // new conversation, because that is what it is.
    if (!role.carriesMemory) {
      return {
        id: `${hash}-${this.repoKey()}-${role.name}-${randomUUID().slice(0, 8)}`,
        reused: false,
        priorTurns: 0,
      };
    }

    const existing = await this.sessions.get(role.name, hash);
    const limit = this.config.agent.sessionMaxTurns;

    // Rotation is preventive, not reactive. A thread that has carried a dozen
    // commits is one commit away from breaching its budget, and the cost of a
    // cold thread is one uncached turn - far less than a failed run.
    const overLimit = Boolean(existing && limit > 0 && existing.turns >= limit);
    const rotatedBecause = options.fresh ? 'requested' : overLimit ? 'turn-limit' : undefined;

    if (existing && !rotatedBecause) {
      return { id: existing.sessionId, reused: true, priorTurns: existing.turns };
    }

    // Mastra creates a thread on first use, so there is nothing to call here.
    //
    // The spec hash leads because traces abbreviate an id to its first eight
    // characters, and the repository key is identical for every role - so
    // leading with it printed the same "session" for all five, which reads as a
    // bug and hides the one thing the line exists to tell you. The hash differs
    // per role (each has its own instructions and schema), so it distinguishes
    // them on sight.
    //
    // The repository key still has to be in the id: Mastra's threads are global
    // to a store, and two repositories running the same role at the same spec
    // would otherwise share one thread and read each other's memory.
    //
    // The suffix is random rather than a timestamp. A timestamp collides when a
    // thread is retired twice inside one millisecond - which the retry path
    // does, since a `max-tokens` failure rotates immediately - and a colliding
    // id hands back the very thread being retired, with all of the history
    // rotation exists to shed. It reads as a new session and behaves as the old
    // one, which is the worst of both.
    const threadId = `${hash}-${this.repoKey()}-${role.name}-${randomUUID().slice(0, 8)}`;
    await this.sessions.set(role.name, threadId, hash);

    const resolved: ResolvedSession = { id: threadId, reused: false, priorTurns: 0 };
    if (rotatedBecause) resolved.rotatedBecause = rotatedBecause;
    return resolved;
  }

  async runTurn<T>(
    role: RoleDefinition<T>,
    sessionId: string,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnResult<T>> {
    const agent = await this.agentFor(role);
    const events: TraceEvent[] = [];

    const emit = (kind: string, text: string): void => {
      const event: TraceEvent = { at: new Date().toISOString(), kind, text };
      events.push(event);
      options.onEvent?.(event);
    };

    // Watched only when asked to be, because watching means streaming, and a
    // stream through Mastra's model router comes back without its token
    // counts; see `agent.idleTimeoutMs`. Started after the agent is built, so a
    // cold store opening for the first time is not mistaken for a quiet model.
    const idleMs = this.config.agent.idleTimeoutMs;
    const watch = idleMs > 0 ? new IdleWatch(idleMs) : undefined;

    /** The turn went quiet and was abandoned: reported, not thrown, like any other failure. */
    const stalled = (usage: TurnUsage): TurnResult<T> => {
      const error =
        `the model went quiet: nothing arrived for ${idleMs / 1000}s, so the turn ` +
        'was abandoned rather than left to run out the attempt deadline';
      emit('error', error);
      return {
        text: '',
        events,
        subthreads: [],
        status: 'stalled',
        usage,
        error,
        errorKind: 'stalled',
        truncated: false,
      };
    };

    try {
      /**
       * A turn with tools does not ask for structured output at all.
       *
       * The provider's `response_format` and the tool loop are mutually
       * exclusive, and the failure is silent and confident rather than loud. A
       * probe against this exact setup answered a question about a document it
       * had never read, inventing the contents *and* reporting that it had
       * called the tool; the live Docs Updater did the same on its first
       * code-mode run - eighty-four output tokens, no program, and a summary
       * claiming all three files were already correct.
       *
       * Asking for the JSON in the prompt instead (`jsonPromptInjection`)
       * restores the tool loop, but then the *validation* becomes the failure:
       * a model that has run its program and made its tool calls very often
       * stops without a closing message, and the turn was rejected three times
       * over an empty string while its actual work sat complete in the
       * collector.
       *
       * So a tool turn's output is its tool calls, and the closing message is
       * optional. `objectFrom` below is what makes that true.
       */
      const modelSettings = {
        temperature: role.params.temperature,
        maxOutputTokens: role.params.maxTokens,
      };
      // One thread per role per repository; the resource is the repository, so
      // a role's memory is scoped to the codebase it learned it from. A role
      // that carries none is asked in isolation, every time.
      const memory = role.carriesMemory
        ? { thread: sessionId, resource: this.repoKey() }
        : undefined;

      /**
       * Two call sites rather than one options object, because the two turns
       * are genuinely different calls.
       *
       * Mastra's `generate` overloads make `structuredOutput` part of the
       * signature - present or absent selects a different return type - so a
       * union of the two option shapes matches neither. Branching at the call
       * is what keeps both typed without an assertion.
       *
       * `toolsets` is the call-time tool channel, so the agent cached for this
       * role is untouched; that matters, because these tools close over one
       * commit's worktree and must not outlive it. The instructions are
       * appended to the role's own rather than replacing them, so persona and
       * house style still apply. `maxSteps` is what makes the turn agentic:
       * without it the model gets one round, which is enough to run a program
       * and not enough to be told an anchor missed and try again - the round
       * trip that is most of the point.
       */
      const shared: SharedTurnOptions = { modelSettings };
      if (memory) shared.memory = memory;
      // The caller's deadline and the idle watch abort the same call. Which of
      // them fired is read back afterwards, because the two mean different
      // things to whoever decides whether to try again.
      const abortSignal =
        watch && options.signal
          ? AbortSignal.any([options.signal, watch.signal])
          : (watch?.signal ?? options.signal);
      if (abortSignal) shared.abortSignal = abortSignal;

      const result = await this.ask(agent, role, prompt, shared, options.toolset, watch);

      const usage = readUsage(result.usage);
      const truncated = result.finishReason === 'length';

      // Mastra does not throw when a call is aborted. It finishes the turn
      // early, as a tripwire with no processor behind it - which the check
      // below would read as a guardrail refusing the diff - so the signals are
      // read before anything takes the result at its word. The caller's abort
      // is theirs to interpret, as it is in the catch below; the watch's is a
      // stall, and is reported as one.
      if (options.signal?.aborted) throw abortOf(options.signal);
      if (watch?.expired) return stalled(usage);

      // A guardrail refused the input, so no model was ever asked. Reported
      // before the ordinary error paths because it is not a fault to retry
      // around - it is a decision, and the run should stop on it.
      if (result.tripwire) {
        const why = result.tripwire.reason || 'a guardrail refused the input';
        emit('blocked', `${result.tripwire.processorId ?? 'a guardrail'}: ${why}`);
        return {
          text: '',
          events,
          subthreads: [],
          status: 'blocked',
          usage,
          error:
            `${why}. The commit diff is written by whoever opened the pull request, ` +
            'and this one was refused before it reached a model.',
          errorKind: 'blocked',
          truncated: false,
        };
      }

      for (const call of result.toolCalls ?? []) {
        const name = call?.payload?.toolName;
        if (name) emit('tool', `called ${name}`);
      }

      const turn: TurnResult<T> = {
        text: result.text ?? '',
        events,
        subthreads: [],
        status: result.finishReason ?? 'unknown',
        usage,
        truncated,
      };

      // Errors are reported rather than thrown: the partial trace is the
      // evidence a failed run is debugged from, and throwing discards it.
      if (result.error) {
        const failure =
          result.error instanceof Error
            ? describeFailure(result.error, this.modelFor(role))
            : { message: String(result.error), kind: classifyTurnError(String(result.error)) };
        turn.error = failure.message;
        turn.errorKind = failure.kind;
        emit('error', failure.message);
        return turn;
      }

      if (truncated) {
        turn.error = 'the model stopped at its output budget (finish reason: length)';
        turn.errorKind = 'max-tokens';
        emit('error', 'the model stopped at its output budget');
        return turn;
      }

      if (result.object === undefined) {
        /**
         * A tool turn answers in its tool calls, so no closing message is a
         * finished turn. The text is parsed when there is any, and an empty one
         * falls back to the schema's own defaults - which is why every field of
         * `codeModeSummarySchema` has one. A schema without defaults still
         * fails here, so this cannot quietly invent an answer for a role that
         * needs a real one.
         */
        if (options.toolset) {
          const answered = objectFrom(role, result.text ?? '');
          if (answered !== undefined) {
            turn.object = answered;
            emit(
              'result',
              `finished after its tool calls ` +
                `(${usage.inputTokens} in / ${usage.outputTokens} out tokens)`,
            );
            return turn;
          }
        }
        // The provider enforces the schema, so this is not a model that wrote
        // prose - it is a turn that produced nothing at all.
        turn.error = 'the model returned no structured output';
        turn.errorKind = 'harness';
        emit('error', turn.error);
        return turn;
      }

      // SAFETY: the provider validated this against `role.schema`, and
      // `schemas.ts` asserts at compile time that each schema's inferred type
      // is exactly the `T` the role is declared with.
      turn.object = result.object as T;
      emit(
        'result',
        `produced a valid ${role.title} object ` +
          `(${usage.inputTokens} in / ${usage.outputTokens} out tokens)`,
      );
      return turn;
    } catch (err) {
      // The watch fired, and whatever broke after it is its consequence rather
      // than a fault of its own - unless the caller gave up as well, whose
      // reason outranks it.
      if (watch?.expired && !options.signal?.aborted) return stalled(emptyUsage());
      // An abort is the caller's decision and is theirs to interpret; every
      // other failure becomes a reported error carrying whatever was collected.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }
      const failure =
        err instanceof Error
          ? describeFailure(err, this.modelFor(role))
          : { message: String(err), kind: classifyTurnError(String(err)) };
      emit('error', `the turn failed: ${failure.message}`);
      return {
        text: '',
        events,
        subthreads: [],
        status: 'error',
        usage: emptyUsage(),
        error: failure.message,
        errorKind: failure.kind,
        truncated: false,
      };
    } finally {
      watch?.stop();
    }
  }

  /**
   * Put one turn to the model, streamed when it is being watched.
   *
   * `generate` and `stream` run the same agent loop - the same memory, input
   * processors, structured output, tool steps and tripwires - and hand back the
   * same `FullOutput`; what differs is the provider call underneath. `generate`
   * makes one request and hears nothing until the answer is complete, so a
   * provider that has gone silent and one writing a long answer look identical
   * from here. `stream` hears every chunk as it arrives, which is the only thing
   * an idle watch can be fed.
   *
   * It is not the default because of what it costs. Mastra's model router
   * builds the Nebius client without asking for usage on a stream, the provider
   * only sends token counts in a stream when asked, and so a streamed turn
   * reports zero tokens and no cost. `generate` is kept, unchanged, until that
   * is a trade someone chooses.
   *
   * The two shapes of turn are still two call sites each, for the reason given
   * in `runTurn`: `structuredOutput` selects an overload, so the options are
   * built where the call is made rather than as one union that fits neither.
   */
  private async ask<T>(
    agent: Agent,
    role: RoleDefinition<T>,
    prompt: string,
    shared: SharedTurnOptions,
    toolset: RunTurnOptions['toolset'],
    watch: IdleWatch | undefined,
  ) {
    if (toolset) {
      const call = {
        ...shared,
        toolsets: { docxy: toolset.tools },
        maxSteps: toolset.maxSteps,
        instructions: `${role.instructions(this.config)}\n\n${toolset.instructions}`,
      };
      if (!watch) return agent.generate(prompt, call);
      const output = await agent.stream(prompt, {
        ...call,
        onChunk: (chunk) => watch.saw(chunk.type),
      });
      return output.getFullOutput();
    }

    const call = { ...shared, structuredOutput: { schema: role.schema } };
    if (!watch) return agent.generate(prompt, call);
    const output = await agent.stream(prompt, {
      ...call,
      onChunk: (chunk) => watch.saw(chunk.type),
    });
    return output.getFullOutput();
  }

  /**
   * Release the shared store, for a process that is finished with it.
   *
   * Only the CLI calls this, once, at the end of a command - so closing the
   * store every runtime shares is the point rather than a hazard: an open pool
   * is what would keep the command from exiting. The server never closes a
   * runtime, so its runs keep reusing one store.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.storeKey) sharedStores.delete(this.storeKey);
    // SAFETY: `close` is optional on the storage interface - a LibSQL file has
    // nothing to release - so it is probed rather than assumed.
    const store = this.store as { close?: () => Promise<void> } | null;
    await store?.close?.().catch(() => {});
  }
}

/**
 * Mastra's usage payload, parsed rather than trusted.
 *
 * It crosses an SDK boundary and its shape has already moved once between
 * minor versions, so it is read the same way any other external payload is:
 * through a schema, with every field optional and a catch-all that yields the
 * empty result instead of throwing. A run must not fail because its token
 * counts arrived in an unexpected shape.
 */
const usageSchema = z
  .object({
    inputTokens: z.number().finite().optional(),
    outputTokens: z.number().finite().optional(),
    cachedInputTokens: z.number().finite().optional(),
    raw: z
      .object({
        inputTokens: z
          .object({
            noCache: z.number().finite().optional(),
            cacheRead: z.number().finite().optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

/**
 * What this side is willing to read off a usage payload.
 *
 * Named so the reader takes a domain type rather than `unknown`, and still
 * `safeParse`d inside: the SDK's own type says these are numbers, and a wire
 * payload is entitled to disagree. `raw` stays `unknown` because that is how
 * Mastra types it - it is the provider's own shape, and the schema is what
 * gives it one.
 */
interface MastraUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  raw?: unknown;
}

/**
 * Fold Mastra's usage into the shape both runtimes report.
 *
 * The breakdown categories are Mastra's own - `noCache` and `cacheRead` - and
 * are passed through under those names. A run's trace should say what was
 * actually measured rather than what a tidier vocabulary would have called it.
 */
export function readUsage(usage: MastraUsage): TurnUsage {
  const totals = emptyUsage();
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) return totals;

  totals.inputTokens = parsed.data.inputTokens ?? 0;
  totals.outputTokens = parsed.data.outputTokens ?? 0;
  totals.cacheReadTokens = parsed.data.cachedInputTokens ?? 0;
  // Mastra reports no cache-write count. Left at zero rather than guessed:
  // a rate applied to an invented number would price runs wrongly.

  const breakdown = parsed.data.raw?.inputTokens;
  if (breakdown) {
    totals.inputBreakdown = {
      noCache: breakdown.noCache ?? 0,
      cacheRead: breakdown.cacheRead ?? 0,
    };
  }
  return totals;
}
