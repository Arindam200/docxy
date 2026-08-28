export default {
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".demo-repo/**",
    ".docxy/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "dist/**",
    "skills/**",
    "tools/oxlint/anti-slop/**",
    "web/node_modules/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      // The boundary itself.
      //
      // Three of these rules say the same thing: do not accept `unknown`, parse
      // it at the I/O boundary and pass a domain type inward. That is exactly
      // what the files below are — the parsing layer, not code that skipped it.
      // They read model output, JSON written by earlier versions of this
      // program, HTTP request bodies, raw SDK stream events, and the reason a
      // promise rejected, none of which arrive typed and all of which are
      // narrowed here before anything downstream sees them.
      //
      // The rules cannot be satisfied at a boundary rather than behind one:
      // `no-unknown-type-aliases` is on too, so there is not even a name to
      // give the untyped value. Everything these rules protect still applies to
      // the other ninety-odd files in the project, which is where accepting
      // `unknown` would actually be the mistake they describe.
      files: [
        "src/agents/parse.ts",
        "src/cli.ts",
        "src/db/knowledge-store.ts",
        "src/github/app.ts",
        "src/pipeline/index.ts",
        "src/pipeline/state.ts",
        "src/server/index.ts",
        "src/trueforge/run.ts",
        "src/trueforge/session.ts",
        "src/trueforge/setup.ts",
        "scripts/backfill-postgres.ts",
        // `[id]` is Next's dynamic-segment directory, and square brackets are a
        // character class to a glob — so they are escaped rather than replaced
        // with a wildcard. A `*` here would match every one-level route under
        // `runs/`, quietly exempting pages nobody meant to exempt.
        "web/src/app/dashboard/runs/\\[id\\]/page.tsx",
        "web/src/components/dashboard/RoleInspector.tsx",
      ],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
  ],
};
