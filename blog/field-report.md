# I shipped an agent that ran model-written code on my laptop — and my README called it a feature

Agent safety reads fine on paper until you grep your own defaults.

I spent a week building [docxy](https://github.com/Arindam200/docxy) for the TrueForge hackathon — five agents that watch a repo, work out which docs a commit just falsified, rewrite them, draft the changelog, and open a pull request. It worked. 98 tests, a dashboard, real PRs landing on a real repo.

Then I read my own README against the rules, three days before the deadline, and found the safety story was backwards.

Not missing. **Backwards.** I had written a paragraph defending the thing that was wrong.

## What the pipeline actually does

Five specialists, each with its own long-lived session per repository, so what a role learns on one commit is still there for the next one.

| Role | Decides |
|---|---|
| Change Analyst | Is this breaking, and what does a consumer who upgrades hit? |
| Impact Mapper | Which doc sections did this falsify? |
| Docs Updater | The smallest edit that makes each section true again |
| Changelog Author | One user-facing line, and the semver bump it implies |
| Coordinator | Whether the four agree, and what to tell the human |

The interesting part isn't the drafting. It's what happens before a human sees any of it. Every proposed edit has to anchor to text that appears verbatim, exactly once, in the real file — that's the check that catches a model paraphrasing instead of quoting. Then links resolve, semver stays consistent, and your docs build runs.

That last one is the problem.

## The line I'd written and stopped seeing

The docs build is the only validation step that *executes* anything. It runs a command over prose a model finished writing about ninety seconds earlier.

Here's what my README said about that:

> Validation runs **against the working copy on disk**, not a remote sandbox, so it needs no third-party account.

And here's the code behind it:

```ts
sandbox: { enabled: config.useHarnessSkills },   // defaults to false
```

So: untrusted, model-authored content, executed against my own filesystem, on every run. With a paragraph in the README explaining why that was a deliberate convenience.

I'd written that sentence myself. I'd read it a dozen times. It reads like a feature until you ask what "the working copy on disk" means when the thing you're running was written by a language model ninety seconds ago.

The hackathon rules were blunt about it: *a judge has to see TrueForge reaching a tool, running code in the sandbox, and stopping for a person.* I wasn't going to squeak past that. I was arguing against it in my own docs.

## The docstring that cost me a working sandbox

Fixing it looked simple. Ask the harness whether a sandbox exists, run the build there, fall back if not.

The SDK told me exactly where to look:

```ts
export interface SandboxCapability {
    /** Whether a sandbox provider is configured for this tenant. */
    enabled: boolean;
}
```

Clear enough. I read `/api/v1/capabilities`, got `enabled: true`, shipped it.

Then I checked the other endpoint out of curiosity:

```
GET /api/v1/capabilities            → 200  {"data":{"sandbox":{"enabled":true}}}
GET /api/v1/settings/sandbox-providers → 404  {"error":{"message":"No sandbox provider configured"}}
```

One says yes. One says nothing is configured. **The docstring is wrong**, so I "fixed" my code to read the settings endpoint instead — the one that seemed to be telling the truth.

That was worse. I went digging in the harness bundle:

```js
sandboxEnabled = status === "ready" || status === void 0 && isLocalSandboxFallbackEnabled();
```

Capabilities was right the whole time. It answers `true` when *either* a remote provider is ready **or** the harness is running standalone with its own local sandbox. The settings endpoint only knows about the remote one.

My "fix" made docxy skip a working sandbox and run on the host instead. I'd introduced the exact bug I was trying to remove, and I'd done it by trusting a comment over the system.

I reverted it and kept both commits in the history. The wrong turn is more useful than the clean version.

## I never needed Daytona

The harness ships Daytona as its sandbox provider, so I got a key. Registration failed:

```
✗ Registering the Daytona sandbox provider failed (HTTP 422):
  {"error":{"message":"Daytona rejected the API key — check the credentials"}}
```

The key was fine. `GET /api/sandbox` returned 200 with my (empty) sandbox list. What failed was registration calling `provider.buildImage()`, which creates a *snapshot* — and that needs more than read access.

I could have chased permissions. Instead I checked whether I needed a remote provider at all:

```
[tool] called exec
[sandbox] sandbox ready
{"output": "Darwin\n/Users/…/trueforge/sandboxes/01m11mfa…/01m11mfc…\nSANDBOX_OK"}
```

It ran. No Daytona, no account, no key. A standalone harness carries its own sandbox — Seatbelt on macOS, bubblewrap on Linux, both with an allow-listed filesystem and allow-listed network egress. The allowlist is right there in the bundle: pypi, github, and not much else.

**Zero external accounts, and it's still real isolation.** That's a better claim than the one I set out to make, and I only found it because a key got rejected.

## The fallback that defeated the point

Every substantive change in this repo goes through a PR that [Qodo](https://www.qodo.ai) reviews first. It found eight bugs in the sandbox work. Seven were ordinary. One was the whole ballgame:

> Any sandbox-unavailable result—including session or turn errors, malformed model output, oversized model-authored payloads, and aborts—causes `runDocsBuild` to stage the proposed files and execute the docs command on the host, allowing untrusted content to bypass the isolation boundary.

It was right, and I want to be precise about why I got it wrong, because the reasoning sounded good.

My thinking was: a missing sandbox is a property of *the deployment*, not of *the documentation*. Failing someone's correct proposal because their harness lacks a provider is punishing the wrong thing. So when the sandbox was unavailable — for any reason — I staged the files and ran the command locally, and labelled the check `local` so the report stayed honest.

The first half of that is true. The conclusion doesn't follow.

An isolation boundary that disappears whenever it's least observed isn't a boundary. It's a boundary-shaped comment. And the conditions that trigger the fallback — malformed model output, oversized payloads, turn errors — are correlated with *exactly the content you'd most want isolated*.

Host execution is opt-in now:

```bash
DOCXY_SANDBOX_FALLBACK=local   # you have to ask for it
```

The default reports the build unvalidated and opens the proposal as a draft carrying the reason. Less coverage. Much better failure mode.

Qodo also caught that `exitCode: null` — the command never ran — became a `skipped` check, and `ValidationReport.ok` only rejects `fail`. So a configured docs build could go completely unexecuted and still publish a clean proposal. That one was just a bug, and it's the kind I'd never have found by reading my own diff.

## What I'd keep from this

**Grep your defaults, not your docs.** Every safety property I'd written about was true of the *configuration I ran locally* and false of the one that shipped. `DOCXY_SANDBOX` defaulting to `false` doesn't announce itself.

**A comment is not the system.** The SDK docstring was wrong, and I trusted it over an endpoint that was sitting right there returning contradictory JSON. Ten minutes with the harness bundle beat two rounds of guessing.

**Fallbacks are where safety properties go to die.** Nobody reviews the unhappy path with the same eyes. Mine was one `if` statement that quietly undid the entire feature, and I wrote it *while* building the feature.

**Let something else read your diff.** Qodo found a security hole in code I'd written that day, verified with tests, and felt good about. I wasn't going to catch it — I already believed the design was right.

I'll keep one thing honest, though: the sandbox receives the proposed markdown and nothing else. No repo, no `package.json`, no `node_modules`. So `mkdocs build` and `npm run docs:build` can't run there — you get a linter, a fence check, a link checker. Shipping the whole checkout into a sandbox on every commit costs more than the check is worth. That's a real limit, and it's in the README now instead of implied.

## Try it against your own repo

The pipeline is open source and runs against a local harness:

```bash
npx @truefoundry/trueforge@latest     # harness on :8790
npm install && cp .env.example .env   # add NEBIUS_API_KEY
npx tsx src/cli.ts setup
npx tsx src/cli.ts doctor             # tells you where validation will execute
npx tsx src/cli.ts run HEAD
```

`doctor` is the one worth running first. It answers the question I should have asked on day one: where does the code actually run?

Repo: [github.com/Arindam200/docxy](https://github.com/Arindam200/docxy) · Dashboard: [docxy-lilac.vercel.app](https://docxy-lilac.vercel.app)

If you're building agents that touch a filesystem, go read your own defaults before someone else does.
