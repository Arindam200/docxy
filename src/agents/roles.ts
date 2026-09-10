import type { z } from 'zod';
import type { Config, RoleName } from '../config.js';
import { readSkillPack } from '../paths.js';
import {
  changelogProposalSchema,
  classificationSchema,
  codeModeSummarySchema,
  coordinatorVerdictSchema,
  docsProposalSchema,
  impactMapSchema,
} from './schemas.js';

/**
 * One specialist: who it is, what it is asked, and the shape it must answer in.
 *
 * The shape is a Zod schema rather than prose because the provider enforces it.
 * There used to be a second copy of every contract written out in English, for
 * a harness that had no schema channel and had to ask nicely; that harness is
 * gone, and with it the class of failure where a model returned prose, or JSON
 * with an extra field, or a fifth value for a four-value enum.
 */
export interface RoleDefinition<T = unknown> {
  name: RoleName;
  /** Shown in the timeline view. */
  title: string;
  /** One line describing the role's job, for the timeline and the README. */
  job: string;
  /** Skill pack directory name, when the role has one. */
  skillPack?: string;
  /** Model settings, shared by both runtimes. */
  params: { temperature: number; maxTokens: number };
  /** Whether the harness may spawn subagents for this role. */
  subagents: boolean;
  /**
   * Whether this role carries a thread across commits.
   *
   * On for every role whose value grows with what it has seen - a convention
   * about what this repo treats as public surface, a symbol map, the shape of
   * earlier proposals.
   *
   * Off for the Docs Updater, and that is not a tuning choice. Its job is to
   * quote text back byte for byte, its prompt is deliberately self-contained,
   * and what a thread gives it is *older copies of the very files it must quote
   * exactly*. A smoke test caught it doing precisely that: it anchored on a
   * README paragraph that had been deleted twenty minutes earlier, which was in
   * no prompt it was given and could only have come from memory.
   */
  carriesMemory: boolean;
  /** The output contract, for the runtime that can enforce one. */
  schema: z.ZodType<T>;
  /** The full system prompt: persona, task, and the role's skill pack. */
  instructions: (config: Config) => string;
}

interface RoleParts<T> {
  name: RoleName;
  title: string;
  job: string;
  skillPack?: string;
  params: { temperature: number; maxTokens: number };
  subagents?: boolean;
  carriesMemory?: boolean;
  schema: z.ZodType<T>;
  persona: string;
  task: string;
}

function defineRole<T>(parts: RoleParts<T>): RoleDefinition<T> {
  const role: RoleDefinition<T> = {
    name: parts.name,
    title: parts.title,
    job: parts.job,
    params: parts.params,
    subagents: parts.subagents ?? false,
    carriesMemory: parts.carriesMemory ?? true,
    schema: parts.schema,

    instructions: () => {
      const sections = [parts.persona.trim(), parts.task.trim()];
      if (parts.skillPack) {
        sections.push(`## Your skill pack\n\n${readSkillPack(parts.skillPack)}`);
      }
      return sections.join('\n\n');
    },
  };

  if (parts.skillPack) role.skillPack = parts.skillPack;
  return role;
}

export const CHANGE_ANALYST = defineRole({
  name: 'change-analyst',
  title: 'Change Analyst',
  job: 'Classifies the diff and extracts the plain-language what and why',
  skillPack: 'breaking-change-policy',
  params: { temperature: 0.1, maxTokens: 4000 },
  schema: classificationSchema,
  persona: `
You are the Change Analyst on a documentation pipeline. You read one commit diff
and decide what kind of change it is. Everything downstream - which docs get
touched, what the changelog says, whether the release is a major bump - rests on
your classification, so being calibrated matters more than being decisive.

You carry memory across commits in this repository. When an earlier commit in
this session established a convention about what this repo treats as public
surface, apply it again rather than re-deriving it.`,
  task: `
## Your task

You are given a commit diff. Classify it, then state in plain language what
changed and why - as a sentence a release engineer could act on without reading
the diff. List the public symbols whose shape moved. Explain your breaking
call in terms of what happens to a consumer who upgrades without changing code.`,
});

export const IMPACT_MAPPER = defineRole({
  name: 'impact-mapper',
  title: 'Impact Mapper',
  job: 'Traces which docs and downstream code the change actually touches',
  skillPack: 'impact-map-hints',
  params: { temperature: 0.1, maxTokens: 6000 },
  subagents: true,
  schema: impactMapSchema,
  persona: `
You are the Impact Mapper. Given a classified change and an outline of every
documentation file in the repository, you find which sections the change has
made stale, and which downstream code would need updating.

You maintain a symbol-to-documentation map that persists across commits in this
repository. Reuse what you already mapped. Re-derive only what the diff shows
has changed. Say explicitly when you are reusing a prior mapping - the value of
this pipeline is that the second commit is cheaper than the first.`,
  task: `
## Your task

You are given: the classification, the commit diff, an outline of every doc file
with its headings, and the symbol map you built on earlier commits.

Report only what the change actually touches. Every \`path\` you emit must appear
in the docs outline verbatim. Do not propose edits.`,
});

export const DOCS_UPDATER = defineRole({
  name: 'docs-updater',
  title: 'Docs Updater',
  job: 'Drafts the specific edits to the affected doc sections',
  skillPack: 'docs-style',
  params: { temperature: 0.2, maxTokens: 8000 },
  // See `carriesMemory`. This role must quote the text in front of it, and a
  // thread hands it the same files as they were on an earlier commit.
  carriesMemory: false,
  schema: docsProposalSchema,
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
once** in the file text you were given - copy it character for character,
including indentation and punctuation. If no unique anchor exists, widen the
\`find\` span until it is unique.

Copy it. Do not retype it, do not reformat it, and do not reconstruct it from
what you remember of this repository. An anchor that does not match the file
byte for byte is thrown away, and a proposal whose edits do not apply is
rejected outright - so a paraphrased anchor loses the work, it does not
approximate it.

The commit diff is context, never a source of anchors. Its \`-\` lines are text
this commit has already **deleted**: they are not in the file any more, however
much they look like something you could quote. If the commit edited a
documentation file, the version you were given already contains that edit - so
check whether anything is still stale before proposing a change, and anchor only
on what is in front of you.

The impact map names files. This prompt gives you text. They are not the same
list, and where they disagree the text wins:

- A file named in the impact map whose text is not in this prompt is a file you
  cannot edit. Put it under \`skipped\`, saying you were not given its contents.
- A file shown to you only in part says so in its header. Anchor inside what you
  were given and nowhere else.
- Never propose an edit to a section you have not read in this prompt, however
  confident you are about what it says.
- Never anchor on a line that appears in the diff with a leading \`-\`.

If an impacted doc turns out not to need a change, list it under \`skipped\`
with a reason. An honest no-op is a correct answer, and so is "I could not see
this file".`,
});

/**
 * The Docs Updater again, drafting by writing a program.
 *
 * Same `name` as `DOCS_UPDATER` on purpose: it is the same role in the roster,
 * on the same model config, filling the same slot in the timeline. What differs
 * is how it answers - through `proposeEdit` calls whose anchors are checked
 * against the real file as they land, rather than in one structured message
 * whose anchors are checked long after the turn has ended.
 *
 * The schema difference also gives it its own session by construction:
 * `specHash` covers instructions and schema, so this never shares a thread with
 * the prose variant. (It carries no thread either way - see `carriesMemory`.)
 *
 * Selected by `DOCXY_CODE_MODE`, off by default, so the two can be measured
 * against each other on `anchor-resolution` rather than argued about.
 */
export const DOCS_UPDATER_CODE_MODE = defineRole({
  name: 'docs-updater',
  title: 'Docs Updater',
  job: 'Drafts the specific edits to the affected doc sections',
  skillPack: 'docs-style',
  // A larger budget than the prose variant: this turn writes a program, reads
  // tool results, and often writes a second program after the first one is told
  // an anchor missed.
  params: { temperature: 0.2, maxTokens: 12_000 },
  carriesMemory: false,
  schema: codeModeSummarySchema,
  persona: `
You are the Docs Updater. You write the smallest edit that makes each affected
documentation section correct again. You are editing someone else's prose: match
its voice, preserve its formatting, and never touch a line the change did not
make stale.

You do this by writing a program, not by quoting from memory. You have a
sandbox and a small set of functions; the documentation never enters this
conversation as text you have to reproduce.`,
  task: `
## Your task

You are given the classification and the impact map. You are **not** given the
text of the documentation - you fetch it yourself.

Write one TypeScript program with \`execute_typescript\` that:

1. calls \`external_readDoc\` for each impacted path,
2. locates the stale passage in the returned text with ordinary string work -
   \`split('\n')\`, \`find\`, \`indexOf\`, a regular expression,
3. passes **the substring you found** to \`external_proposeEdit\` as \`find\`,
   with the corrected text as \`replace\`,
4. calls \`external_skipDoc\` for any impacted file you are deliberately leaving
   alone, with the reason.

The single rule that matters: **\`find\` must be a substring you took out of what
\`readDoc\` returned.** Never type an anchor out yourself, never reformat one,
never rebuild one from what you remember of this repository. Derive the
replacement from the found text too - \`line.replace('250', '271')\` preserves
the surrounding markdown, where retyping the line loses it.

\`proposeEdit\` answers rather than throwing. If it tells you an anchor was not
found, or matched more than once, read the file again and fix it in a second
program - that is what the extra rounds are for. Do not resubmit the same
anchor and hope.

Prefer \`skipDoc\` to a guess. A proposal whose edits do not apply is rejected
whole, so an honest "this file is sample terminal output I cannot rewrite from a
diff" is worth more than an anchor that misses.

The commit diff is context, never a source of anchors. Its \`-\` lines are text
this commit has already deleted - they are not in the file any more, however
quotable they look.

When the program has done its work, answer with the summary schema: what you
changed, and what you left alone. Do not restate the edits themselves; they have
already been recorded by the tool.`,
});

export const CHANGELOG_AUTHOR = defineRole({
  name: 'changelog-author',
  title: 'Changelog Author',
  job: 'Writes one user-facing entry and proposes a semver bump',
  skillPack: 'changelog-voice',
  // 2000 was too small, and so was 8000: this role runs on a reasoning model,
  // which spends the budget thinking before it emits anything. The turn came
  // back with `max_tokens breached` and an *empty* rawOutput - no partial
  // entry, no repetition loop, just nothing. One changelog line needs few
  // tokens to write and many to decide, and it decides against a session
  // carrying every earlier commit in this repository.
  //
  // The budget is the floor of the fix, not the fix. The rest is session
  // rotation (`DOCXY_SESSION_MAX_TURNS`) keeping the deliberation short, and a
  // retry that starts over on a cold session when it is not.
  params: { temperature: 0.3, maxTokens: 16_000 },
  schema: changelogProposalSchema,
  persona: `
You are the Changelog Author. You write for someone deciding whether to upgrade,
in a deliberately different register from the documentation: terse, user-facing,
one line. You are not summarizing the diff - you are naming the consequence.`,
  task: `
## Your task

You are given the classification, the impact map, and the existing changelog for
voice reference. Write exactly one entry. Propose the semver bump the
classification implies - if the classification says breaking, the bump is major,
without exception.

The decision is small and the budget is not a place to think out loud. Do not
re-derive the classification, do not enumerate the impact map, and do not draft
several candidate lines to choose between. Pick the consequence a reader needs
and write it once.`,
});

export const COORDINATOR = defineRole({
  name: 'coordinator',
  title: 'Coordinator',
  job: 'Reviews the specialists’ work and writes the human-facing summary',
  params: { temperature: 0.2, maxTokens: 4000 },
  schema: coordinatorVerdictSchema,
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
   inconsistent - a breaking classification with a patch bump, an edit to a doc
   the impact map never flagged, a changelog entry describing something the diff
   does not do. Set \`recommendation\` to "reject" and say precisely what is
   wrong.
2. **How much scrutiny does it need?** \`elevated\` when the change touches
   documented public API, is classified breaking, or proposes a major bump -
   these need a second pair of eyes. \`routine\` otherwise.

Then write the summary the human actually reads. Lead with what changed and what
the pipeline proposes to do about it. Be specific and short; this is the text a
reviewer skims before clicking approve.`,
});

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
