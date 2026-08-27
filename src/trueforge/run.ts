import { isEventDelta, mergeEventDelta, type TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface TraceEvent {
  at: string;
  kind: string;
  text: string;
}

/**
 * Token counts for one turn.
 *
 * `inputBreakdown` splits the input side into the harness's own categories —
 * `harness`, `instructions`, `messages`, `skills`, `tool_definitions` — which is
 * what makes it possible to show what the skill packs actually cost per run.
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
  | 'stalled';

export interface TurnResult {
  turnId?: string;
  /** Concatenated assistant text from the root (`main`) thread. */
  text: string;
  events: TraceEvent[];
  /** Subagent threads the harness spawned during this turn. */
  subthreads: string[];
  status: string;
  usage: TurnUsage;
  /** Set when the harness ended the turn in an error state. */
  error?: string;
  /** Set alongside `error`, and the field callers branch on. */
  errorKind?: TurnFailureKind;
  /** The model stopped because it hit its output budget, not because it finished. */
  truncated: boolean;
}

/**
 * A stream event in its wire form.
 *
 * The stream is consumed raw rather than through the SDK's deserializer, so
 * every event arrives as a plain object and is read field by field, each read
 * guarded. `mergeEventDelta` and `isEventDelta` want the deserialized types,
 * which is what the casts at their call sites are for — the SDK's own contract
 * is that both operate on events it emitted, and these are exactly those.
 */
type AnyEvent = Record<string, any>;

/** SAFETY: see `AnyEvent` — the value came off the SDK's own stream. */
function asSdkEvent(event: AnyEvent): TrueForgeApi.ModelMessageEvent {
  return event as TrueForgeApi.ModelMessageEvent;
}

/** SAFETY: see `AnyEvent` — the value came off the SDK's own stream. */
function asSdkDelta(event: AnyEvent): TrueForgeApi.ModelMessageDeltaEvent {
  return event as TrueForgeApi.ModelMessageDeltaEvent;
}

/** SAFETY: each literal at the call sites is written to match one `TurnInputItem` variant. */
function asTurnInput(item: AnyEvent): TrueForgeApi.TurnInputItem {
  return item as TrueForgeApi.TurnInputItem;
}

/**
 * Read a count that may arrive in either casing.
 *
 * The stream is consumed as a raw event rather than through the SDK's
 * deserializer, so usage fields arrive in their wire form (`input_tokens`) and
 * not the typed camelCase shape (`inputTokens`). Reading only one of the two is
 * how every run recorded 0 in / 0 out.
 */
function count(source: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return Number(value) || 0;
  }
  return 0;
}

/** Fold one `model.message` event's usage into the running totals. */
function addUsage(totals: TurnUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return;

  totals.inputTokens += count(raw, 'inputTokens', 'input_tokens');
  totals.outputTokens += count(raw, 'outputTokens', 'output_tokens');
  totals.cacheReadTokens += count(raw, 'cacheReadTokens', 'cache_read_tokens');
  totals.cacheWriteTokens += count(raw, 'cacheWriteTokens', 'cache_write_tokens');

  const breakdown = raw['inputTokensBreakdown'] ?? raw['input_tokens_breakdown'];
  if (breakdown && typeof breakdown === 'object') {
    for (const [key, value] of Object.entries(breakdown as Record<string, unknown>)) {
      totals.inputBreakdown[key] = (totals.inputBreakdown[key] ?? 0) + (Number(value) || 0);
    }
  }
}

/**
 * Assistant content, which the wire format gives as either a string or an array
 * of parts depending on the provider. Both shapes are read; anything else
 * yields the empty string rather than throwing on a stream that has already
 * cost tokens.
 */
function textOf(content: AnyEvent['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: AnyEvent) => (part && part.type === 'text' ? String(part.text ?? '') : ''))
    .join('');
}

/**
 * Name the failure from whatever the harness said.
 *
 * The message is free text from the model provider by way of the harness, so
 * this matches on substrings rather than pretending there is an error code.
 * Anything unrecognised stays `harness`, which the caller retries conservatively.
 */
export function classifyTurnError(message: string): TurnFailureKind {
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
  return 'harness';
}

/** Guard against an agent that keeps asking; each resume costs another round trip. */
const MAX_RESUMES = 6;

export interface RunTurnOptions {
  onEvent?: (event: TraceEvent) => void;
  /**
   * Approve harness-internal tool calls (subagent spawning, sandbox use).
   * The human gate that matters sits in front of the pull request, not here.
   */
  autoApproveHarnessTools?: boolean;
  signal?: AbortSignal;
}

/**
 * Drive one turn to completion, following approval and question pauses so the
 * caller gets a finished answer rather than a suspended stream.
 *
 * Never throws for a failure the harness reported: a turn that breached its
 * budget, was cancelled, or dropped its connection comes back as a result with
 * `error` and `errorKind` set, carrying whatever text and usage it did produce.
 * That partial trace is the evidence a failed run is debugged from, and
 * throwing it away is what made three consecutive runs unexplainable.
 */
export async function runTurn(
  client: TrueForge,
  sessionId: string,
  prompt: string,
  options: RunTurnOptions = {},
): Promise<TurnResult> {
  const { onEvent, autoApproveHarnessTools = true } = options;

  const events = new Map<string, AnyEvent>();
  /**
   * Deltas whose base `model.message` has not arrived yet. The SDK merges by
   * shared id and no-ops when the base is missing, so an out-of-order delta
   * used to drop its content and — because usage overwrites rather than adds —
   * its token counts with it.
   */
  const orphanDeltas = new Map<string, AnyEvent[]>();
  const trace: TraceEvent[] = [];
  const subthreads = new Set<string>();
  const announcedTools = new Set<string>();
  /** Tool calls already answered. Being asked twice means the turn is looping. */
  const answered = new Set<string>();

  let turnId: string | undefined;
  let status = 'unknown';
  let errorMessage: string | undefined;
  let errorKind: TurnFailureKind | undefined;
  let truncated = false;

  const emit = (kind: string, text: string): void => {
    const entry: TraceEvent = { at: new Date().toISOString(), kind, text };
    trace.push(entry);
    onEvent?.(entry);
  };

  const fail = (kind: TurnFailureKind, message: string): void => {
    // First failure wins: it is the one that explains the rest.
    errorMessage ??= message;
    errorKind ??= kind;
  };

  const absorb = (event: AnyEvent): void => {
    events.set(event.id, event);
    const pending = orphanDeltas.get(event.id);
    if (!pending) return;
    orphanDeltas.delete(event.id);
    for (const delta of pending) {
      try {
        mergeEventDelta(asSdkEvent(event), asSdkDelta(delta));
      } catch {
        // A delta the SDK cannot merge is not worth losing the turn over.
      }
    }
  };

  let input: TrueForgeApi.TurnInputItem[] = [
    asTurnInput({ type: 'user.message', content: prompt }),
  ];

  let resume = 0;
  for (; resume <= MAX_RESUMES; resume += 1) {
    const pendingApprovals: AnyEvent[] = [];
    const pendingResponses: AnyEvent[] = [];

    try {
      const stream = await client.sessions.createTurnStream(
        sessionId,
        { input },
        options.signal ? { abortSignal: options.signal } : undefined,
      );

      for await (const { data } of stream.withMetadata()) {
        // SAFETY: see `AnyEvent` — this is the SDK's own event, read field by
        // field with every read guarded, rather than through its deserializer.
        const event = data as AnyEvent;

        if (isEventDelta(asSdkDelta(event))) {
          const base = events.get(event.id);
          if (base) {
            try {
              mergeEventDelta(asSdkEvent(base), asSdkDelta(event));
            } catch {
              // see `absorb`
            }
          } else {
            const queued = orphanDeltas.get(event.id) ?? [];
            queued.push(event);
            orphanDeltas.set(event.id, queued);
          }
          // A delta is where `finishReason` and the final tool-call names land.
          if (event.finishReason === 'length') truncated = true;
          for (const call of event.toolCalls ?? []) {
            const name = call?.toolInfo?.name ?? call?.function?.name;
            if (name && !announcedTools.has(`${event.id}:${name}`)) {
              announcedTools.add(`${event.id}:${name}`);
              emit('tool', `called ${name}`);
            }
          }
          continue;
        }
        if (event.id) absorb(event);

        switch (event.type) {
          case 'turn.created':
            turnId = event.turnId ?? turnId;
            break;

          case 'thread.created':
            if (event.threadId && event.threadId !== 'main') {
              subthreads.add(event.threadId);
              emit('subagent', `spawned: ${event.title ?? event.threadId}`);
            }
            break;

          case 'thread.done':
            if (event.state?.status === 'error' && event.state?.error) {
              const message = String(event.state.error);
              // A subagent thread failing is not automatically fatal — the root
              // thread may still answer — but it is recorded either way.
              emit('error', `thread ${event.threadId ?? 'main'}: ${message}`);
              if ((event.threadId ?? 'main') === 'main') {
                fail(classifyTurnError(message), message);
              }
            }
            if (event.threadId && event.threadId !== 'main') {
              emit('subagent', `finished: ${event.threadId}`);
            }
            break;

          case 'sandbox.created':
            emit('sandbox', 'sandbox ready');
            break;

          case 'model.message': {
            if (event.finishReason === 'length') truncated = true;
            for (const call of event.toolCalls ?? []) {
              const name = call?.toolInfo?.name ?? call?.function?.name ?? 'tool';
              if (announcedTools.has(`${event.id}:${name}`)) continue;
              announcedTools.add(`${event.id}:${name}`);
              emit('tool', `called ${name}`);
            }
            break;
          }

          case 'tool.approval_required':
            pendingApprovals.push(event);
            emit(
              'approval',
              `harness asked to approve ${(event.toolCalls ?? []).length} tool call(s)`,
            );
            break;

          case 'tool.response_required':
            pendingResponses.push(event);
            break;

          case 'mcp.auth_required':
            // Nobody is attached to authorize it, and the turn will hang
            // waiting. Say so rather than letting it time out unexplained.
            emit('mcp', 'an MCP server needs authorization');
            fail(
              'harness',
              'an MCP server asked for authorization, and this run is unattended',
            );
            break;

          case 'turn.done':
            status = event.state?.status ?? 'unknown';
            if (status === 'error') {
              const message = String(event.state?.message ?? 'the harness reported an error');
              fail(classifyTurnError(message), message);
              emit('error', message);
            } else if (status === 'cancelled') {
              // Never handled before: a cancelled turn returned `status:
              // "cancelled"` with no error, so an empty answer reached the JSON
              // parser and surfaced as "returned an empty response".
              const reason = String(event.state?.reason ?? 'unknown');
              const message = `the harness cancelled the turn (${reason})`;
              fail(reason === 'server-execution-timeout' ? 'transient' : 'cancelled', message);
              emit('error', message);
            }
            break;

          default:
            break;
        }
      }
    } catch (err) {
      // The stream itself broke — a dropped socket, a harness restart, an
      // abort. Whatever was collected before the break is still worth keeping,
      // so this records the failure and stops rather than throwing the turn's
      // partial trace away.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      fail(classifyTurnError(message), message);
      emit('error', `the turn stream failed: ${message}`);
      break;
    }

    if (truncated && !errorMessage) {
      fail('max-tokens', 'the model stopped at its output budget (finish reason: length)');
      emit('error', 'the model stopped at its output budget');
    }

    if (pendingApprovals.length === 0 && pendingResponses.length === 0) break;

    const next: TrueForgeApi.TurnInputItem[] = [];
    let repeated = 0;

    for (const pending of pendingApprovals) {
      for (const ref of pending.toolCalls ?? []) {
        if (answered.has(ref.id)) {
          repeated += 1;
          continue;
        }
        answered.add(ref.id);
        next.push(
          asTurnInput({
            type: 'user.tool_approval',
            threadId: pending.threadId,
            toolCallId: ref.id,
            approval: autoApproveHarnessTools
              ? { status: 'allow' }
              : { status: 'deny', reason: 'Docxy gates changes at the pull request, not here.' },
          }),
        );
      }
    }

    // The pipeline runs unattended; a role that stops to ask a question is told
    // to proceed on its best judgement and record the uncertainty in its output.
    for (const pending of pendingResponses) {
      for (const ref of pending.toolCalls ?? []) {
        if (answered.has(ref.id)) {
          repeated += 1;
          continue;
        }
        answered.add(ref.id);
        next.push(
          asTurnInput({
            type: 'user.tool_response',
            threadId: pending.threadId,
            toolCallId: ref.id,
            content:
              'No human is attached to this run. Proceed with your best judgement and ' +
              'record any uncertainty in the confidence field of your output.',
          }),
        );
      }
    }

    if (repeated > 0 && next.length === 0) {
      // Every pending call was one we already answered. Resuming again would
      // send the identical input and get the identical pause back.
      fail('stalled', `the harness re-asked ${repeated} tool call(s) already answered`);
      emit('error', 'the turn is repeating tool calls it was already given answers for');
      break;
    }
    if (next.length === 0) break;

    input = next;
    emit('resume', `resumed after ${next.length} pending item(s)`);
  }

  if (resume > MAX_RESUMES) {
    // Falling out of the loop used to look identical to finishing: the caller
    // got whatever partial text existed and tried to parse it.
    fail('stalled', `the turn was still pausing after ${MAX_RESUMES} resumes`);
    emit('error', `gave up after ${MAX_RESUMES} resumes without a final answer`);
  }

  // Usage is folded up here, not while streaming. `mergeEventDelta` *overwrites*
  // usage on the base event, and the final counts arrive on the closing delta —
  // so adding them as the base event went past recorded the empty usage that was
  // there at the time. Every run reading 0 in / 0 out came from that.
  const usage: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputBreakdown: {},
  };
  for (const event of events.values()) {
    if (event.type === 'model.message') addUsage(usage, event.usage);
  }

  const text = [...events.values()]
    .filter((e) => e.type === 'model.message' && (e.threadId ?? 'main') === 'main')
    .map((e) => textOf(e.content))
    .join('\n')
    .trim();

  const result: TurnResult = {
    text,
    events: trace,
    subthreads: [...subthreads],
    status,
    usage,
    truncated,
  };
  if (turnId) result.turnId = turnId;
  if (errorMessage) result.error = errorMessage;
  if (errorKind) result.errorKind = errorKind;
  return result;
}
