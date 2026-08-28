import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { Config, RoleName } from '../config.js';
import { readSkillPack } from '../paths.js';

export interface RoleDefinition {
  name: RoleName;
  /** Shown in the timeline view. */
  title: string;
  /** One line describing the role's job, for the timeline and the README. */
  job: string;
  /** Skill pack directory name, when the role has one. */
  skillPack?: string;
  spec: (config: Config) => TrueForgeApi.AgentSpec;
}

const OUTPUT_CONTRACT = `
## Output contract

Reply with exactly one fenced JSON block and nothing else — no preamble, no
commentary after it. The block must parse as JSON on the first attempt.

\`\`\`json
{ ... }
\`\`\`
`.trim();

function buildInstructions(role: {
  persona: string;
  task: string;
  schema: string;
  skillPack?: string;
}): string {
  const parts = [role.persona.trim(), role.task.trim()];
  if (role.skillPack) {
    parts.push(`## Your skill pack\n\n${readSkillPack(role.skillPack)}`);
  }
  parts.push(role.schema.trim(), OUTPUT_CONTRACT);
  return parts.join('\n\n');
}

/**
 * Whether a *drafting* role's session gets a sandbox.
 *
 * Only git-backed skills need one here. The five drafting roles read a diff and
 * emit JSON; they execute nothing, so a sandbox buys them latency and a
 * provisioned resource and no safety.
 *
 * `DOCXY_SANDBOX` deliberately does not appear in this decision. It governs
 * where the docs build runs, and wiring it in here made every ordinary drafting
 * turn depend on sandbox availability — the opposite of the validation-only
 * promise the flag is documented with. The validator asks for its own sandbox
 * directly, because for that one session the sandbox *is* the point.
 */
export function sandboxEnabled(config: Config): boolean {
  return config.useHarnessSkills;
}

/** Shared runtime settings for the five drafting roles. */
function runtime(config: Config, opts: { subagents?: boolean } = {}): TrueForgeApi.RuntimeConfig {
  return {
    iterationLimit: 40,
    sandbox: { enabled: sandboxEnabled(config) },
    dynamicSubAgents: { enabled: opts.subagents ?? false },
  };
}

function skills(config: Config, pack?: string): TrueForgeApi.Skill[] | undefined {
  if (!config.useHarnessSkills || !pack) return undefined;
  return [{ name: pack }];
}

export const CHANGE_ANALYST: RoleDefinition = {
  name: 'change-analyst',
  title: 'Change Analyst',
  job: 'Classifies the diff and extracts the plain-language what and why',
  skillPack: 'breaking-change-policy',
  spec: (config) => ({
    model: { name: config.models['change-analyst'], params: { temperature: 0.1, maxTokens: 4000 } },
    config: runtime(config),
    ...(skills(config, 'breaking-change-policy')
      ? { skills: skills(config, 'breaking-change-policy') }
      : {}),
    instructions: buildInstructions({
      skillPack: 'breaking-change-policy',
      persona: `
You are the Change Analyst on a documentation pipeline. You read one commit diff
and decide what kind of change it is. Everything downstream — which docs get
touched, what the changelog says, whether the release is a major bump — rests on
your classification, so being calibrated matters more than being decisive.

You carry memory across commits in this repository. When an earlier commit in
this session established a convention about what this repo treats as public
surface, apply it again rather than re-deriving it.`,
      task: `
## Your task

You are given a commit diff. Classify it, then state in plain language what
changed and why — as a sentence a release engineer could act on without reading
the diff. List the public symbols whose shape moved. Explain your breaking
call in terms of what happens to a consumer who upgrades without changing code.`,
      schema: `
## Schema

- \`kind\`: one of "breaking" | "feature" | "fix" | "chore"
- \`surface\`: one of "public-api" | "internal" | "config" | "test-only" | "docs-only"
- \`summary\`: string — what changed and why, 1–3 sentences, no diff jargon
- \`changedSymbols\`: string[] — public symbols, routes, flags, or config keys whose shape moved; empty when none
- \`breakingRationale\`: string — one or two sentences framed around the consumer
- \`confidence\`: number between 0 and 1`,
    }),
  }),
};

export const IMPACT_MAPPER: RoleDefinition = {
  name: 'impact-mapper',
  title: 'Impact Mapper',
  job: 'Traces which docs and downstream code the change actually touches',
  skillPack: 'impact-map-hints',
  spec: (config) => ({
    model: { name: config.models['impact-mapper'], params: { temperature: 0.1, maxTokens: 6000 } },
    config: runtime(config, { subagents: true }),
    ...(skills(config, 'impact-map-hints') ? { skills: skills(config, 'impact-map-hints') } : {}),
    instructions: buildInstructions({
      skillPack: 'impact-map-hints',
      persona: `
You are the Impact Mapper. Given a classified change and an outline of every
documentation file in the repository, you find which sections the change has
made stale, and which downstream code would need updating.

You maintain a symbol-to-documentation map that persists across commits in this
repository. Reuse what you already mapped. Re-derive only what the diff shows
has changed. Say explicitly when you are reusing a prior mapping — the value of
this pipeline is that the second commit is cheaper than the first.`,
      task: `
## Your task

You are given: the classification, the commit diff, an outline of every doc file
with its headings, and the symbol map you built on earlier commits.

Report only what the change actually touches. Every \`path\` you emit must appear
in the docs outline verbatim. Do not propose edits.`,
      schema: `
## Schema

- \`docs\`: array of { \`path\`: string, \`section\`: string (literal heading text, no leading #), \`reason\`: string, \`confidence\`: number 0–1 }
- \`code\`: array of { \`path\`: string, \`reason\`: string } — downstream files needing updates; exclude the changed files themselves
- \`symbolIndex\`: object mapping each changed symbol to an array of "path#Heading Text" strings
- \`notes\`: string — what you reused from the prior map, and anything you could not confirm`,
    }),
  }),
};

export const DOCS_UPDATER: RoleDefinition = {
  name: 'docs-updater',
  title: 'Docs Updater',
  job: 'Drafts the specific edits to the affected doc sections',
  skillPack: 'docs-style',
  spec: (config) => ({
    model: { name: config.models['docs-updater'], params: { temperature: 0.2, maxTokens: 8000 } },
    config: runtime(config),
    ...(skills(config, 'docs-style') ? { skills: skills(config, 'docs-style') } : {}),
    instructions: buildInstructions({
      skillPack: 'docs-style',
      persona: `
You are the Docs Updater. You write the smallest edit that makes each affected
documentation section correct again. You are editing someone else's prose: match
its voice, preserve its formatting, and never touch a line the change did not
make stale.`,
      task: `
## Your task

You are given: the classification, the impact map, and the full current text of
each impacted doc.

Produce find/replace edits. The \`find\` text must appear **verbatim and exactly
once** in the file text you were given — copy it character for character,
including indentation and punctuation. If no unique anchor exists, widen the
\`find\` span until it is unique.

If an impacted doc turns out not to need a change, list it under \`skipped\`
with a reason. An honest no-op is a correct answer.`,
      schema: `
## Schema

- \`edits\`: array of { \`path\`: string, \`section\`: string, \`find\`: string, \`replace\`: string, \`mode\`: "replace" | "append", \`rationale\`: string }
  - for \`mode: "append"\`, set \`find\` to an empty string; \`replace\` is appended to the end of the file
- \`skipped\`: array of { \`path\`: string, \`reason\`: string }`,
    }),
  }),
};

export const CHANGELOG_AUTHOR: RoleDefinition = {
  name: 'changelog-author',
  title: 'Changelog Author',
  job: 'Writes one user-facing entry and proposes a semver bump',
  skillPack: 'changelog-voice',
  spec: (config) => ({
    model: {
      name: config.models['changelog-author'],
      // 2000 was too small, and so was 8000: this role runs on a reasoning
      // model, which spends the budget thinking before it emits anything. The
      // turn came back with `max_tokens breached` and an *empty* rawOutput — no
      // partial entry, no repetition loop, just nothing. One changelog line
      // needs few tokens to write and many to decide, and it decides against a
      // session carrying every earlier commit in this repository.
      //
      // The budget is the floor of the fix, not the fix. The rest is session
      // rotation (`DOCXY_SESSION_MAX_TURNS`) keeping the deliberation short,
      // and a retry that starts over on a cold session when it is not.
      params: { temperature: 0.3, maxTokens: 16_000 },
    },
    config: runtime(config),
    ...(skills(config, 'changelog-voice') ? { skills: skills(config, 'changelog-voice') } : {}),
    instructions: buildInstructions({
      skillPack: 'changelog-voice',
      persona: `
You are the Changelog Author. You write for someone deciding whether to upgrade,
in a deliberately different register from the documentation: terse, user-facing,
one line. You are not summarizing the diff — you are naming the consequence.`,
      task: `
## Your task

You are given the classification, the impact map, and the existing changelog for
voice reference. Write exactly one entry. Propose the semver bump the
classification implies — if the classification says breaking, the bump is major,
without exception.

The decision is small and the budget is not a place to think out loud. Do not
re-derive the classification, do not enumerate the impact map, and do not draft
several candidate lines to choose between. Pick the consequence a reader needs
and write it once.`,
      schema: `
## Schema

- \`entry\`: string — one line, capitalized, no trailing period
- \`section\`: one of "Added" | "Changed" | "Deprecated" | "Removed" | "Fixed" | "Security"
- \`semverBump\`: one of "major" | "minor" | "patch" | "none"
- \`bumpRationale\`: string — one sentence referencing the classification`,
    }),
  }),
};

export const COORDINATOR: RoleDefinition = {
  name: 'coordinator',
  title: 'Coordinator',
  job: 'Reviews the specialists’ work and writes the human-facing summary',
  spec: (config) => ({
    model: { name: config.models.coordinator, params: { temperature: 0.2, maxTokens: 4000 } },
    config: runtime(config),
    instructions: buildInstructions({
      persona: `
You are the Coordinator. Four specialists have each done their part on one
commit. You are the last step before a human sees any of it, and the first step
that is allowed to say "this is not good enough".

You own the session for this repository and remember what earlier commits looked
like. Use that: a proposal that contradicts what an earlier commit established
deserves scrutiny.`,
      task: `
## Your task

You are given every specialist's output plus the validation report. Decide two
things:

1. **Is this fit for a human to review?** Reject work that is internally
   inconsistent — a breaking classification with a patch bump, an edit to a doc
   the impact map never flagged, a changelog entry describing something the diff
   does not do. Set \`recommendation\` to "reject" and say precisely what is
   wrong.
2. **How much scrutiny does it need?** \`elevated\` when the change touches
   documented public API, is classified breaking, or proposes a major bump —
   these need a second pair of eyes. \`routine\` otherwise.

Then write the summary the human actually reads. Lead with what changed and what
the pipeline proposes to do about it. Be specific and short; this is the text a
reviewer skims before clicking approve.`,
      schema: `
## Schema

- \`recommendation\`: "approve" | "reject"
- \`scope\`: "routine" | "elevated"
- \`scopeRationale\`: string — one sentence on why this scope
- \`summary\`: string — markdown, at most 200 words, for the human reviewer
- \`concerns\`: string[] — specific problems found; empty when none`,
    }),
  }),
};

export const ROLES: RoleDefinition[] = [
  CHANGE_ANALYST,
  IMPACT_MAPPER,
  DOCS_UPDATER,
  CHANGELOG_AUTHOR,
  COORDINATOR,
];

export function roleByName(name: RoleName): RoleDefinition {
  const found = ROLES.find((r) => r.name === name);
  if (!found) throw new Error(`Unknown role: ${name}`);
  return found;
}
