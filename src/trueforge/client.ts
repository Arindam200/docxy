import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config } from '../config.js';

export function createClient(config: Config): TrueForge {
  const options: TrueForge.Options = {
    baseUrl: config.trueforge.baseUrl,
    timeoutInSeconds: config.trueforge.timeoutInSeconds,
  };
  if (config.trueforge.token) options.token = config.trueforge.token;
  return new TrueForge(options);
}

export class TrueForgeUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    super(
      `Cannot reach the TrueForge harness at ${baseUrl}.\n` +
        `Start it with:  npx @truefoundry/trueforge@latest\n` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'TrueForgeUnreachableError';
  }
}

/** Confirm the harness is up before doing anything that costs tokens. */
export async function assertReachable(client: TrueForge, config: Config): Promise<void> {
  try {
    const res = await client.fetch('/api/v1/capabilities');
    if (!res.ok) throw new Error(`capabilities returned HTTP ${res.status}`);
  } catch (err) {
    throw new TrueForgeUnreachableError(config.trueforge.baseUrl, err);
  }
}
