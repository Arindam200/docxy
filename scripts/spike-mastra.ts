/**
 * Phase 0 of the Mastra migration: prove the four risky assumptions before any
 * production code is written. See `.docxy/plans/mastra-migration.md`.
 *
 * Each probe is independent and reports its own verdict, so one failure does
 * not hide the other three - the point of the spike is to learn all four
 * answers in one run, not to stop at the first surprise.
 *
 *   npx tsx scripts/spike-mastra.ts
 *   npx tsx scripts/spike-mastra.ts model storage   # a subset, by name
 *
 * This file is throwaway. It is deleted at the end of phase 1.
 */
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { PostgresStore } from '@mastra/pg';
import { DaytonaSandbox } from '@mastra/daytona';
import { MastraServer } from '@mastra/hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

interface Probe {
  name: string;
  question: string;
  run: () => Promise<string>;
}

/**
 * The Change Analyst's contract as Zod, transcribed from the prose schema in
 * `src/agents/roles.ts`. If Nebius honours this, every role's `OUTPUT_CONTRACT`
 * block and the whole of `src/agents/parse.ts` can go.
 */
const classification = z.object({
  kind: z.enum(['breaking', 'feature', 'fix', 'chore']),
  surface: z.enum(['public-api', 'internal', 'config', 'test-only', 'docs-only']),
  summary: z.string().describe('what changed and why, 1-3 sentences, no diff jargon'),
  changedSymbols: z.array(z.string()).describe('public symbols whose shape moved; empty when none'),
  breakingRationale: z.string().describe('one or two sentences framed around the consumer'),
  confidence: z.number().min(0).max(1),
});

/** A diff with an unambiguous answer, so a wrong verdict is obviously wrong. */
const SAMPLE_DIFF = `
diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -12,7 +12,7 @@ export interface ClientOptions {
   baseUrl: string;
-  timeout?: number;
+  timeoutMs: number;
 }

-export function createClient(options: ClientOptions) {
+export function createClient(options: ClientOptions, signal?: AbortSignal) {
   return new Client(options);
 }
`.trim();

const MODEL = config.models['change-analyst'].includes('/')
  ? `nebius/${config.registeredModels[0]?.modelId ?? 'deepseek-ai/DeepSeek-V4-Pro'}`
  : config.models['change-analyst'];

/**
 * Ask one question under one structured-output strategy, and report whether the
 * answer both parsed and made sense.
 *
 * `jsonPromptInjection: undefined` is the native `response_format` path, which
 * is what we want if Nebius supports it - it is the strategy that does not
 * spend prompt tokens restating the schema on every turn.
 */
async function askUnder(injection: undefined | 'auto'): Promise<string> {
  const agent = new Agent({
    id: `spike-change-analyst-${injection ?? 'native'}`,
    name: 'Spike Change Analyst',
    instructions:
      'You are the Change Analyst on a documentation pipeline. You read one commit ' +
      'diff and decide what kind of change it is. Being calibrated matters more than ' +
      'being decisive.',
    model: MODEL,
  });

  // Omitted rather than passed as `undefined`: absent means the provider's
  // native response format, which is the strategy under test.
  const base = { schema: classification };
  const structuredOutput = injection ? { ...base, jsonPromptInjection: injection } : base;

  const started = Date.now();
  const result = await agent.generate(
    `Classify the following commit.\n\n## Commit diff\n\n${SAMPLE_DIFF}`,
    { structuredOutput, modelSettings: { temperature: 0.1, maxOutputTokens: 4000 } },
  );

  const object = result.object;
  if (!object) throw new Error('the model returned no object');

  const elapsed = Date.now() - started;
  // Renaming a required field and reordering a signature is breaking on a
  // public export. A model that says "chore" parsed fine and still failed.
  const sane = object.kind === 'breaking' && object.surface === 'public-api';
  return (
    `${sane ? 'parsed and correct' : `parsed but called it ${object.kind}/${object.surface}`}` +
    ` in ${elapsed}ms - ${object.changedSymbols.length} symbol(s), confidence ${object.confidence}`
  );
}

const PROBES: Probe[] = [
  {
    name: 'model',
    question: 'Does Nebius serve native structured output through Mastra’s model router?',
    run: async () => {
      if (!config.nebius.apiKey) throw new Error('NEBIUS_API_KEY is not set');
      // The router reads NEBIUS_API_KEY from the environment by provider id.
      process.env.NEBIUS_API_KEY = config.nebius.apiKey;

      let native: string;
      try {
        native = await askUnder(undefined);
      } catch (err) {
        // The answer we most need: if native response_format is refused, the
        // fallback decides whether phase 1 pays a per-turn prompt tax.
        const message = err instanceof Error ? err.message : String(err);
        const viaInjection = await askUnder('auto');
        return (
          `native response_format FAILED (${message.slice(0, 120)}); ` +
          `jsonPromptInjection:'auto' ${viaInjection} - phase 1 must set 'auto'`
        );
      }
      return `native response_format works: ${native} - no prompt tax`;
    },
  },

  {
    name: 'storage',
    question: 'Does @mastra/pg initialise against the production Neon database?',
    run: async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is not set');

      // `id` is required and is the store's logical name, not a connection
      // detail - it appears in Mastra's own bookkeeping, so production should
      // pick one deliberately rather than inherit a default.
      const store = new PostgresStore({ id: 'docxy', connectionString: url });
      await store.init();

      // Mastra creates its own tables. Naming them matters: they land in the
      // same database as the drizzle-managed schema, and phase 5 has to know
      // which tables belong to whom before anything is dropped.
      const rows = await store.db.manyOrNone<{ tablename: string }>(
        `select tablename from pg_tables
          where schemaname = 'public' and tablename like 'mastra%'
          order by tablename`,
      );
      await store.close();

      const names = rows.map((r) => r.tablename);
      return names.length
        ? `${names.length} table(s) created: ${names.join(', ')}`
        : 'connected, but created no mastra_* tables (check the schema search path)';
    },
  },

  {
    name: 'sandbox',
    question: 'Does a Daytona workspace return a real exit code, with no model in the loop?',
    run: async () => {
      if (!config.sandbox.daytonaApiKey) throw new Error('DAYTONA_API_KEY is not set');

      const sandbox = new DaytonaSandbox({
        id: `docxy-spike-${Date.now()}`,
        apiKey: config.sandbox.daytonaApiKey,
        language: 'typescript',
        ephemeral: true,
        timeout: 120_000,
      });

      const started = Date.now();
      await sandbox.start();
      const bootMs = Date.now() - started;

      try {
        await sandbox.writeFiles([
          { path: 'docs/guide.md', content: '# Guide\n\nThe timeout option is now `timeoutMs`.\n' },
          { path: 'check.sh', content: 'test -f docs/guide.md && grep -q timeoutMs docs/guide.md\n' },
        ]);

        const pass = await sandbox.executeCommand('bash', ['-c', 'bash check.sh && echo BUILD_OK']);
        // The negative case is the one that matters. Today a model reports the
        // exit code and can simply be wrong; this proves a real failure is
        // reported as a failure.
        const fail = await sandbox.executeCommand('bash', ['-c', 'exit 3']);

        if (pass.exitCode !== 0) {
          throw new Error(`the passing command exited ${pass.exitCode}: ${pass.stderr.slice(0, 200)}`);
        }
        if (fail.exitCode !== 3) {
          throw new Error(`the failing command reported ${fail.exitCode}, not 3`);
        }

        return (
          `booted in ${bootMs}ms; wrote 2 files; exit 0 on success ` +
          `(${pass.stdout.trim().split('\n').pop()}) and exit 3 on failure - both real`
        );
      } finally {
        await sandbox.destroy().catch(() => {});
      }
    },
  },

  {
    name: 'server',
    question: 'Does MastraServer mount behind the existing DOCXY_API_TOKEN guard?',
    run: async () => {
      const app = new Hono();
      let reachedMastra = false;

      // The ordering that matters: the token check is registered before the
      // Mastra routes, so it covers them. Registering it after would leave
      // every agent and workflow endpoint open on a 0.0.0.0 bind.
      app.use('/api/*', async (c, next) => {
        const header = c.req.header('authorization');
        if (header !== 'Bearer spike-token') return c.json({ error: 'unauthorized' }, 401);
        reachedMastra = true;
        await next();
      });

      const mastra = new Mastra({
        agents: {
          spike: new Agent({
            id: 'spike-mounted',
            name: 'Spike',
            instructions: 'You are a probe.',
            model: MODEL,
          }),
        },
      });

      const server = new MastraServer({ app, mastra });
      await server.init();

      const denied = await app.request('/api/agents', { method: 'GET' });
      const allowed = await app.request('/api/agents', {
        method: 'GET',
        headers: { authorization: 'Bearer spike-token' },
      });

      if (denied.status !== 401) {
        throw new Error(
          `an unauthenticated request to /api/agents returned ${denied.status}, not 401 - ` +
            'the guard does not cover the Mastra routes',
        );
      }
      if (!allowed.ok) {
        throw new Error(`the authenticated request returned ${allowed.status}`);
      }

      // SAFETY: only the keys of this payload are read, and `allowed.ok` above
      // establishes it is Mastra's own agent listing rather than an error body.
      const body = (await allowed.json()) as Record<string, { id?: string }>;
      const listed = Object.keys(body);
      return (
        `unauthenticated → 401, authenticated → ${allowed.status} ` +
        `listing ${listed.length} agent(s) [${listed.join(', ')}]` +
        `${reachedMastra ? '' : ' (warning: the guard never ran)'}`
      );
    },
  },
];

async function main(): Promise<void> {
  const selected = process.argv.slice(2);
  const probes = selected.length
    ? PROBES.filter((p) => selected.includes(p.name))
    : PROBES;

  if (probes.length === 0) {
    console.error(`No such probe. Available: ${PROBES.map((p) => p.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const results: Array<{ probe: Probe; ok: boolean; detail: string }> = [];

  for (const probe of probes) {
    process.stdout.write(`\n── ${probe.name}\n   ${probe.question}\n`);
    try {
      const detail = await probe.run();
      results.push({ probe, ok: true, detail });
      process.stdout.write(`   PASS  ${detail}\n`);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      results.push({ probe, ok: false, detail: detail.split('\n').slice(0, 4).join('\n         ') });
      process.stdout.write(`   FAIL  ${results[results.length - 1]!.detail}\n`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n── ${results.length - failed.length}/${results.length} probes passed\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`   blocked on: ${failed.map((r) => r.probe.name).join(', ')}\n`);
    process.exitCode = 1;
  }
}

void main();
