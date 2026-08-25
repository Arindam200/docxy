import { isEventDelta, mergeEventDelta, type TrueForge } from '@truefoundry/trueforge-sdk';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface TraceEvent {
  at: string;
  kind: string;
  text: string;
}

export interface TurnResult {
  turnId?: string;
  /** Concatenated assistant text from the root (`main`) thread. */
  text: string;
  events: TraceEvent[];
  /** Subagent threads the harness spawned during this turn. */
  subthreads: string[];
  status: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Set when the harness ended the turn in an error state. */
  error?: string;
}

function isStringContent(
  content: TrueForgeApi.ModelMessageEventContent | null | undefined,
): content is string {
  return typeof content === 'string';
}

function textOf(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (isStringContent(content)) return content;
  if (!content) return '';
  return content
    .map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
    .join('');
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
 */
export async function runTurn(
  client: TrueForge,
  sessionId: string,
  prompt: string,
  options: RunTurnOptions = {},
): Promise<TurnResult> {
  const { onEvent, autoApproveHarnessTools = true } = options;

  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const trace: TraceEvent[] = [];
  const subthreads = new Set<string>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let turnId: string | undefined;
  let status = 'unknown';
  let errorMessage: string | undefined;

  const emit = (kind: string, text: string): void => {
    const entry: TraceEvent = { at: new Date().toISOString(), kind, text };
    trace.push(entry);
    onEvent?.(entry);
  };

  let input: TrueForgeApi.TurnInputItem[] = [
    { type: 'user.message', content: prompt },
  ];

  for (let resume = 0; resume <= MAX_RESUMES; resume += 1) {
    const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
    const pendingResponses: TrueForgeApi.ToolResponseRequiredEvent[] = [];

    const stream = await client.sessions.createTurnStream(
      sessionId,
      { input },
      options.signal ? { abortSignal: options.signal } : undefined,
    );

    for await (const { data: event } of stream.withMetadata()) {
      if (isEventDelta(event)) {
        const base = events.get(event.id);
        if (base) mergeEventDelta(base, event);
        continue;
      }
      if (event.id) events.set(event.id, event);

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
          if (event.state.status === 'error' && event.state.error) {
            errorMessage ??= String(event.state.error);
          }
          if (event.threadId && event.threadId !== 'main') {
            emit('subagent', `finished: ${event.threadId}`);
          }
          break;

        case 'sandbox.created':
          emit('sandbox', 'sandbox ready');
          break;

        case 'model.message': {
          if (event.usage) {
            usage.inputTokens += Number(event.usage.inputTokens ?? 0);
            usage.outputTokens += Number(event.usage.outputTokens ?? 0);
          }
          for (const call of event.toolCalls ?? []) {
            const name = call?.toolInfo?.name ?? call?.function?.name ?? 'tool';
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
          emit('mcp', 'an MCP server needs authorization');
          break;

        case 'turn.done': {
          status = event.state.status;
          if (event.state.status === 'error' && event.state.message) {
            errorMessage = String(event.state.message);
            emit('error', errorMessage);
          }
          break;
        }

        default:
          break;
      }
    }

    if (pendingApprovals.length === 0 && pendingResponses.length === 0) break;

    const next: TrueForgeApi.TurnInputItem[] = [];

    for (const pending of pendingApprovals) {
      for (const ref of pending.toolCalls ?? []) {
        next.push({
          type: 'user.tool_approval',
          threadId: pending.threadId,
          toolCallId: ref.id,
          approval: autoApproveHarnessTools
            ? { status: 'allow' }
            : { status: 'deny', reason: 'Docxy gates changes at the pull request, not here.' },
        });
      }
    }

    // The pipeline runs unattended; a role that stops to ask a question is told
    // to proceed on its best judgement and record the uncertainty in its output.
    for (const pending of pendingResponses) {
      for (const ref of pending.toolCalls ?? []) {
        next.push({
          type: 'user.tool_response',
          threadId: pending.threadId,
          toolCallId: ref.id,
          content:
            'No human is attached to this run. Proceed with your best judgement and ' +
            'record any uncertainty in the confidence field of your output.',
        });
      }
    }

    if (next.length === 0) break;
    input = next;
    emit('resume', `resumed after ${next.length} pending item(s)`);
  }

  const text = [...events.values()]
    .filter((e): e is TrueForgeApi.ModelMessageEvent => e.type === 'model.message')
    .filter((e) => (e.threadId ?? 'main') === 'main')
    .map((e) => textOf(e.content))
    .join('\n')
    .trim();

  const result: TurnResult = {
    text,
    events: trace,
    subthreads: [...subthreads],
    status,
    usage,
  };
  if (turnId) result.turnId = turnId;
  if (errorMessage) result.error = errorMessage;
  return result;
}
