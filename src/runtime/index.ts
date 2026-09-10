import type { Config } from '../config.js';
import type { SessionStorage } from '../pipeline/stores.js';
import { MastraRuntime } from './mastra.js';
import type { AgentRuntime } from './types.js';

export type {
  AgentRuntime,
  ResolveSessionOptions,
  ResolvedSession,
  RunTurnOptions,
  RuntimeName,
  TraceEvent,
  TurnFailureKind,
  TurnResult,
  TurnUsage,
} from './types.js';
export { classifyTurnError, emptyUsage } from './types.js';
export { MastraRuntime } from './mastra.js';

/**
 * Build the agent runtime.
 *
 * There is one, and this exists so the pipeline can be handed a different one
 * in a test without a model or a network behind it. There is no separate
 * harness service to deploy, reach, or fail to reach: the roles run in this
 * process and the docs build runs in a Daytona workspace.
 */
export function createRuntime(config: Config, sessions: SessionStorage): AgentRuntime {
  return new MastraRuntime(config, sessions);
}
