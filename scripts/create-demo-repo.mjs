#!/usr/bin/env node
/**
 * Materialize a small demo repository with two commits, staged so the pipeline's
 * session-state payoff is visible: the first commit teaches the Impact Mapper
 * where the `--output` flag is documented; the second commit touches the same
 * area and should reuse that mapping instead of re-deriving it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Flags are not the target. `npm run demo -- --force` put `--force` in argv[2],
// so the script built the demo repository in a directory literally named
// `--force`, recreated it there on every run, and printed a `--repo --force`
// hint that could not work.
const positional = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const target = resolve(positional ?? '.demo-repo');

if (existsSync(target)) {
  if (process.argv.includes('--force')) rmSync(target, { recursive: true, force: true });
  else {
    console.error(`${target} already exists. Pass --force to recreate it.`);
    process.exit(1);
  }
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: target,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Demo Author',
      GIT_AUTHOR_EMAIL: 'demo@example.com',
      GIT_COMMITTER_NAME: 'Demo Author',
      GIT_COMMITTER_EMAIL: 'demo@example.com',
    },
  });

const write = (path, content) => {
  const full = join(target, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
};

mkdirSync(target, { recursive: true });
git('init', '-q', '-b', 'main');

// ---- commit 1: the baseline the docs already describe -----------------------
write(
  'src/report.js',
  `export function formatReport(rows, options = {}) {
  const output = options.output ?? 'table';
  if (output === 'json') return JSON.stringify(rows);
  return rows.map((r) => \`\${r.name}\\t\${r.value}\`).join('\\n');
}
`,
);
write(
  'src/cli.js',
  `import { formatReport } from './report.js';

export function run(argv) {
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex === -1 ? 'table' : argv[outputIndex + 1];
  return formatReport(load(), { output });
}
`,
);
write(
  'docs/cli.md',
  `# CLI reference

The \`report\` command prints a summary of the current dataset.

## Configuration

Pass \`--output json\` to get machine-readable output. The default is
\`--output table\`, which prints an aligned text table.

| Flag | Default | Description |
| --- | --- | --- |
| \`--output\` | \`table\` | Output format: \`table\` or \`json\` |

See the [getting started guide](./guide.md) for a full walkthrough.
`,
);
write(
  'docs/guide.md',
  `# Getting started

Install the package, then run the report:

\`\`\`bash
npx demo-report --output json
\`\`\`

## Next steps

Read the [CLI reference](./cli.md) for every available flag.
`,
);
write(
  'README.md',
  `# demo-report

A tiny reporting tool used to exercise Docxy.

\`\`\`bash
npx demo-report --output json
\`\`\`

See [docs/cli.md](./docs/cli.md).
`,
);
write(
  'CHANGELOG.md',
  `# Changelog

All notable changes to this project are documented here.

## [1.0.0]

### Added

- Initial release with the \`report\` command
`,
);
git('add', '.');
git('commit', '-q', '-m', 'feat: initial report command with --output flag');

// ---- commit 2: a breaking rename the docs now contradict --------------------
write(
  'src/report.js',
  `export function formatReport(rows, options = {}) {
  const format = options.format ?? 'table';
  if (format === 'json') return JSON.stringify(rows);
  if (format === 'csv') return rows.map((r) => \`\${r.name},\${r.value}\`).join('\\n');
  return rows.map((r) => \`\${r.name}\\t\${r.value}\`).join('\\n');
}
`,
);
write(
  'src/cli.js',
  `import { formatReport } from './report.js';

export function run(argv) {
  const formatIndex = argv.indexOf('--format');
  if (argv.includes('--output')) {
    throw new Error('--output was renamed to --format in 2.0.0');
  }
  const format = formatIndex === -1 ? 'table' : argv[formatIndex + 1];
  return formatReport(load(), { format });
}
`,
);
git('add', '.');
git(
  'commit',
  '-q',
  '-m',
  'feat!: rename --output to --format and add csv\n\nThe --output flag is gone. Callers must pass --format instead.\nAlso adds a csv format alongside table and json.',
);

const log = execFileSync('git', ['log', '--oneline'], { cwd: target, encoding: 'utf8' });
console.log(`Demo repository created at ${target}\n`);
console.log(log);
console.log(`Run the pipeline against it:

  npx tsx src/cli.ts run HEAD~1 --repo ${target}
  npx tsx src/cli.ts run HEAD   --repo ${target}

The second run should report "session reused" for every role, and the Impact
Mapper should reuse the symbol map the first run built.
`);
